// C6-T06 service/assembly.service.ts: reads port outputs and returns the frozen ReportDocument (02-TRD §4.3 "Sources" table; AC-02.7, AC-03.1/03.6/03.7 data;
// 07-SECURITY: PHI minimisation, signatory misuse T15). The pure grouping/formatting is covered in domain/__tests__/document.test.ts; this file proves the PORT CALLS.
// Assumed API: assembleDocument(ctx, input): Promise<ReportDocument>
//   ctx   = { tenantId, actor, ports: { lab, catalog, frontdesk, identity } }  (same ctx.ports pattern as reports.service.ts)
//   input = { orderId, includeOrderItemIds, config, centre, qrVerifyUrl, reportedAt, complete, earlierReleased, regeneration? }
//   (centre arrives pre-resolved: ctx.core.centre lookup, the report-row snapshot refresh, QR token minting, smart section and instrument-PDF sanitising belong to C6-T08.)
// Not covered here (T08): lock/debounce/fingerprint/version insert, SmartReportPort, /internal/sanitize.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { assembleDocument } from '../service/assembly.service.js';
import { I, SIGNATORIES, TESTS, PANELS, id, makeInput } from '../domain/__tests__/document.fixtures.js';

const golden = (n: string) => JSON.parse(readFileSync(new URL(`../domain/__tests__/golden/${n}.json`, import.meta.url), 'utf8'));
const norm = (sections: any[]) => JSON.parse(JSON.stringify(sections, (k, v) => (k === 'comment' ? undefined : k === 'specimenLine' && typeof v === 'string' ? v.replace(/^Specimen:\s*/, '') : v)));

function rig(over: { orderSummary?: any; referrer?: any; failTest?: boolean; resolve?: (i: any) => any; mutate?: (orderResults: any) => void } = {}) {
  const base = makeInput(); over.mutate?.(base.orderResults);
  const summary = over.orderSummary ?? base.orderSummary;
  const ports = {
    lab: { getOrderResults: vi.fn(async () => base.orderResults) },
    frontdesk: { getOrderSummary: vi.fn(async () => summary), getPatientDemographics: vi.fn(async () => base.demographics) },
    catalog: {
      getTest: vi.fn(async (_c: unknown, i: { testId: string }) => { if (over.failTest) { const e: any = new Error('catalog down'); e.code = 'common.unavailable'; throw e; } return TESTS.find((t) => t.id === i.testId); }),
      getPanel: vi.fn(async (_c: unknown, i: { panelId: string }) => PANELS.find((p) => p.id === i.panelId)),
      getReferrer: vi.fn(async () => over.referrer),
      resolveCommentCodes: vi.fn(async (_c: unknown, i: any) => over.resolve?.(i) ?? ({ resolved: [{ code: 'SYN_CMT', commentCodeId: id(0x300), version: 1, text: 'Slide reviewed.' }], unknown: [] })),
    },
    identity: {
      getTenantSettings: vi.fn(async () => base.settings),
      getSignatories: vi.fn(async (_c: unknown, i: { membershipIds: string[] }) => SIGNATORIES.filter((s) => i.membershipIds.includes(s.membershipId))),
    },
  };
  const ctx: any = { tenantId: id(0xa), actor: { id: id(0xb) }, ports };
  const input = (o: Record<string, unknown> = {}): any => ({
    orderId: I.order, includeOrderItemIds: [I.itemPkg], config: base.config, centre: base.centre, qrVerifyUrl: base.qrVerifyUrl,
    reportedAt: base.reportedAt, complete: true, earlierReleased: false, ...o,
  });
  return { ports, ctx, input };
}
const callsOf = (fn: any) => fn.mock.calls as any[][];

describe('port reads (TRD §4.3 sources)', () => {
  it('LabPort.getOrderResults(scope approved) once; ctx is passed through to every port', async () => {
    const { ctx, ports, input } = rig(); await assembleDocument(ctx, input());
    expect(ports.lab.getOrderResults).toHaveBeenCalledTimes(1);
    expect(ports.lab.getOrderResults).toHaveBeenCalledWith(ctx, { orderId: I.order, scope: 'approved' });
    expect(ports.frontdesk.getOrderSummary).toHaveBeenCalledWith(ctx, { orderId: I.order });
  });
  it("demographics are read with purpose 'report_render'", async () => {
    const { ctx, ports, input } = rig(); await assembleDocument(ctx, input());
    const c = callsOf(ports.frontdesk.getPatientDemographics);
    expect(c.length).toBeGreaterThanOrEqual(1); expect(c.every(([, i]) => i.purpose === 'report_render' && i.patientId === I.patient)).toBe(true);
  });
  it('CatalogPort.getTest once per included test, asOf = that test\'s approval time; excluded items\' tests are never fetched', async () => {
    const { ctx, ports, input } = rig(); await assembleDocument(ctx, input({ includeOrderItemIds: [I.itemPkg] }));
    const c = callsOf(ports.catalog.getTest);
    expect(c.map(([, i]) => i.testId).sort()).toEqual([I.tGlu, I.tCbc].sort());
    expect(c.find(([, i]) => i.testId === I.tGlu)![1].asOf).toBe('2026-11-05T04:10:00.000Z');
    expect(c.find(([, i]) => i.testId === I.tCbc)![1].asOf).toBe('2026-11-05T04:15:00.000Z');
    expect(c.some(([, i]) => i.requireActive === true)).toBe(false); // deactivated tests must stay readable
  });
  it('CatalogPort.getPanel only for panel/package orderables of included items', async () => {
    const { ctx, ports, input } = rig(); await assembleDocument(ctx, input({ includeOrderItemIds: [I.itemUrine] }));
    expect(ports.catalog.getPanel).not.toHaveBeenCalled();
    await assembleDocument(ctx, input({ includeOrderItemIds: [I.itemPkg, I.itemLipid] }));
    expect(callsOf(ports.catalog.getPanel).map(([, i]) => i.panelId).sort()).toEqual([I.pkg, I.lipid].sort());
  });
  it("referrer: getReferrer({purpose:'display'}) only when the order has a referrerId; otherwise \"SELF\" and no call", async () => {
    const none = rig(); const d0: any = await assembleDocument(none.ctx, none.input());
    expect(none.ports.catalog.getReferrer).not.toHaveBeenCalled(); expect(d0.header.referredBy).toBe('SELF');
    const base = makeInput(); const withRef = rig({ orderSummary: { ...base.orderSummary, referrerId: I.referrer },
      referrer: { referrerId: I.referrer, canonicalReferrerId: I.referrer, code: 'R1', displayName: 'Dr. Synthetic Referrer', isVerified: true, isActive: true } });
    const d1: any = await assembleDocument(withRef.ctx, withRef.input());
    expect(withRef.ports.catalog.getReferrer).toHaveBeenCalledWith(withRef.ctx, { referrerId: I.referrer, purpose: 'display' });
    expect(d1.header.referredBy).toBe('Dr. Synthetic Referrer');
  });
  it('tenant settings: branding + calendarDisplay + timezone requested (and nothing outside the settings port)', async () => {
    const { ctx, ports, input } = rig(); await assembleDocument(ctx, input());
    const keys: string[] = callsOf(ports.identity.getTenantSettings).flatMap(([, i]) => i?.keys ?? []);
    expect(keys).toEqual(expect.arrayContaining(['branding', 'calendarDisplay', 'timezone']));
  });
  it('comment codes of the included results are resolved through CatalogPort (with the department and approval time)', async () => {
    const { ctx, ports, input } = rig(); const d: any = await assembleDocument(ctx, input());
    const c = callsOf(ports.catalog.resolveCommentCodes);
    expect(c.length).toBeGreaterThanOrEqual(1); expect(c.flatMap(([, i]) => i.codes)).toContain('SYN_CMT');
    const wbc = d.sections.flatMap((s: any) => s.blocks.flatMap((b: any) => b.subgroups.flatMap((g: any) => g.lines))).find((l: any) => l.name === 'WBC Count');
    expect(wbc.comment).toContain('Slide reviewed.');
  });
  it('same comment code in two departments resolves per department: each line prints its own department text (review item 3)', async () => {
    const text: Record<string, string> = { [I.deptBio]: 'Bio text.', [I.deptHaem]: 'Haem text.' };
    const { ctx, input } = rig({
      mutate: (or) => { or.items[0].results[0].commentCodes = ['SYN_CMT']; },   // Glucose (Biochemistry); WBC (Haematology) already carries SYN_CMT
      resolve: (i) => ({ resolved: i.codes.map((code: string) => ({ code, commentCodeId: id(0x300), version: 1, text: text[i.departmentId] })), unknown: [] }),
    });
    const d: any = await assembleDocument(ctx, input());
    const line = (n: string) => d.sections.flatMap((s: any) => s.blocks.flatMap((b: any) => b.subgroups.flatMap((g: any) => g.lines))).find((l: any) => l.name === n);
    expect(line('Glucose').comment).toContain('Bio text.'); expect(line('Glucose').comment).not.toContain('Haem text.');
    expect(line('WBC Count').comment).toContain('Haem text.'); expect(line('WBC Count').comment).not.toContain('Bio text.');
  });
});

describe('print_critical_label (C6 setting passed by the caller, TRD §4.4; review item 1)', () => {
  const trig = (d: any) => d.sections.flatMap((s: any) => s.blocks.flatMap((b: any) => b.subgroups.flatMap((g: any) => g.lines))).find((l: any) => l.name === 'Triglycerides');
  it('printCriticalLabel: true on the assembly input -> HH prints "Critical High"', async () => {
    const { ctx, input } = rig(); const d: any = await assembleDocument(ctx, input({ includeOrderItemIds: [I.itemLipid], printCriticalLabel: true }));
    expect(trig(d).flagLabel).toBe('Critical High'); expect(trig(d).valueBold).toBe(true);
  });
  it('absent / false -> "High"', async () => {
    const { ctx, input } = rig(); const d: any = await assembleDocument(ctx, input({ includeOrderItemIds: [I.itemLipid] }));
    expect(trig(d).flagLabel).toBe('High');
  });
});

describe('signatory lookup (07-SECURITY T15, AC-03.6/03.7)', () => {
  it('approvers mode: getSignatories asks only for the included results\' approvers (<= 20 ids, deduped, no non-approver)', async () => {
    const { ctx, ports, input } = rig(); const d: any = await assembleDocument(ctx, input({ includeOrderItemIds: [I.itemPkg, I.itemUrine] }));
    const asked: string[] = callsOf(ports.identity.getSignatories).flatMap(([, i]) => i.membershipIds);
    expect(new Set(asked)).toEqual(new Set([I.m1, I.m2])); expect(asked.length).toBe(new Set(asked).size); expect(asked.length).toBeLessThanOrEqual(20);
    expect(d.signatories.map((s: any) => s.membershipId)).toEqual([I.m1, I.m2]);
    expect(d.signatories[0].registrationNo).toBe('NMC-SYN-0001');
  });
  it('nominated mode: asks for nominees AND approvers (approvers still print per department); disclaimer passes through', async () => {
    const { ctx, ports, input } = rig(); const line = 'Authorized signatory nominated by Lab Director';
    const d: any = await assembleDocument(ctx, input({ config: { signatoryMode: 'nominated', maxSignatories: 2, nominatedMembershipIds: [I.m3], disclaimers: [line] } }));
    const asked: string[] = callsOf(ports.identity.getSignatories).flatMap(([, i]) => i.membershipIds);
    expect(asked).toEqual(expect.arrayContaining([I.m3, I.m1, I.m2]));
    expect(d.signatories.map((s: any) => [s.membershipId, s.role])).toEqual([[I.m3, 'nominated']]);
    expect(d.disclaimers).toContain(line);
    expect(d.sections.find((s: any) => s.departmentName === 'Haematology').approvedBy).toEqual(['Dr. Synthetic Signatory B']);
  });
  it('signature image bytes are never read at assembly (the render worker calls readSignatureImage)', async () => {
    const { ctx, ports, input } = rig(); (ports.identity as any).readSignatureImage = vi.fn();
    const d = await assembleDocument(ctx, input());
    expect((ports.identity as any).readSignatureImage).not.toHaveBeenCalled(); expect(JSON.stringify(d)).not.toMatch(/base64/i);
  });
});

describe('end to end through the ports (golden)', () => {
  it('cbc package: sections/kind/status equal the golden', async () => {
    const { ctx, input } = rig(); const d: any = await assembleDocument(ctx, input());
    const g = golden('cbc');
    expect(d.reportKind).toBe(g.reportKind); expect(d.statusLabel).toBe(g.statusLabel); expect(norm(d.sections)).toEqual(g.sections);
  });
  it('partial (lipid + urine of four items, complete=false): kind partial and only those sections', async () => {
    const { ctx, ports, input } = rig(); const d: any = await assembleDocument(ctx, input({ includeOrderItemIds: [I.itemLipid, I.itemUrine], complete: false }));
    expect(d.reportKind).toBe('partial'); expect(d.statusLabel).toBe('Partial');
    expect(norm(d.sections)).toEqual([...golden('lipid').sections, ...golden('urine').sections]);
    expect(callsOf(ports.catalog.getTest).map(([, i]) => i.testId)).not.toContain(I.tCbc);
  });
  it('header takes the order registration number, dates and centre; no phone/e-mail reaches the document', async () => {
    const { ctx, input } = rig(); const d: any = await assembleDocument(ctx, input());
    expect(d.header.regNo).toBe('0001SY000001'); expect(d.header.registeredAt).toBe('2026-11-05T02:17:00.000Z'); expect(d.header.collectedAtCentre.code).toBe('C000000099');
    expect(JSON.stringify(d)).not.toMatch(/\+9779800000042|patient0042@example\.invalid|SYNP-0042/);
  });
});

describe('failure handling', () => {
  it('a catalog failure rejects the assembly (the task retries); no partial document is returned', async () => {
    const { ctx, input } = rig({ failTest: true });
    await expect(assembleDocument(ctx, input())).rejects.toThrow();
  });
  it('an included order item that LabPort did not return results for rejects (never a silently shorter report)', async () => {
    const { ctx, input } = rig();
    await expect(assembleDocument(ctx, input({ includeOrderItemIds: [id(0x999)] }))).rejects.toThrow();
  });
  it('port outputs are not mutated', async () => {
    const { ctx, ports, input } = rig(); const before = JSON.stringify(makeInput().orderResults);
    await assembleDocument(ctx, input());
    expect(JSON.stringify(await ports.lab.getOrderResults())).toBe(before);
  });
});
