// C16.T-P4 — task engagement.fetch_smart_summary (+ automatic follow-up reminders from the stored summary)
// (06-PLAN row T-P4; 02-TRD §4.11 `follow_up` row, §6.2 table row "openReleasedReportFile -> smartSummary", §8.1 max 5 / job key smart:<report_id>:<version_no>, §7.2 report.released consumer enqueues it;
//  05-SCHEMA smart_summaries / reminders; 01-PRD US-EN-09.1, 09.3, 09.4, US-EN-24.1-3; 07-SECURITY rule 5 "stored only when approved ... never SmartReportPort", rule 2 "never in logs: smart-summary text, panel names";
//  08 A2.3 / A4.4: the snapshot rides on ReleasedReportFile.smartSummary). done_when: approved-only storage. tests: draft -> not stored; feature disabled -> hidden; newer version.
// Fails now: manifest task 'engagement.fetch_smart_summary' is the T-01 fail-closed stub (throws "... not implemented").
//
// SEAMS (spec fixes behaviour, not names; same convention as backfill_link.test.ts):
//   handler = manifest.tasks['engagement.fetch_smart_summary'] (TaskHandler); payload {tenant_id, report_id, version_no} (exactly what the report.released consumer enqueues); ctx = worker JobContext (system actor, tx, now(), ports{ReportingPort}, log).
//   Reads engagement.patient_reports (tenant_id + report_id + version_no) for patient_id / order_id / released_at, settings for smart_report_in_app (re-checked at run time: the tenant may have switched it off since the enqueue) and
//   auto_follow_up_reminders / follow_up_reminder_lead_days. Port: ctx.ports.ReportingPort.openReleasedReportFile(ctx, {reportId, versionNo}) as the SYSTEM actor (the C6 fake: packages/fakes ReportingPort.fake.ts, `smartSummary` fixture).
//   Stored row (05-SCHEMA smart_summaries): id, tenant_id, order_id, report_id, report_version_no, patient_id, summary (jsonb: the C6 snapshot as camelCase SmartSummary, EVERY key ending Id / Ids removed - "minus ids not exposed", TRD §5 SmartSummaryView),
//   template_library_version, approved_at (= snapshot.approvedAt), fetched_at (= ctx.now()), created_by (= system actor). `summary` may be bound as an object or as a JSON string (both read back here).
//   Stored only if the snapshot is present AND status === 'approved' (exact string). Absent / draft / common.not_found -> NO row and NO retry (the task resolves); any other port error -> the task rejects (retried) and nothing is stored.
//   Reminders (US-EN-24): when settings.auto_follow_up_reminders, one row per snapshot follow-up i (array order): kind 'follow_up', source 'smart_report', source_ref_id = the stored smart_summaries.id, source_ref_seq = i, patient_id,
//   due_at = patient_reports.released_at + intervalDays days - follow_up_reminder_lead_days days, status 'scheduled', reason_code a coded-set code (^[a-z0-9_]{1,64}$; which one is the writer's choice), created_by = system actor. Idempotent on (kind, source_ref_id, source_ref_seq):
//   plain SELECT-then-INSERT or a bare `ON CONFLICT DO NOTHING` (the world has no index-predicate conflict target).
// NOT pinned (spec silent): behaviour for an oversize snapshot (> 256 KiB CHECK), an approved snapshot without approvedAt, a due_at already in the past, whether v1 is touched when v2 is stored, reason_code value.
import '../../../../../api/src/__tests__/setup-env.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateManifests } from '../../../core/manifest.js';
import { manifest } from '../index.js';
import { createFakeReportingPort } from '../../../../../../packages/fakes/src/ReportingPort.fake';
import { REPO_ROOT } from '../../../../../api/src/core/module.js';
import { ID, SYSTEM_ACTOR, T0, TENANT_A, TENANT_B, makeLinkWorld, type LinkWorld } from '../../../../../api/src/modules/engagement/__tests__/link.world.js';

type Row = Record<string, any>;
const TASK = 'engagement.fetch_smart_summary';
const PHONE = '+99001000001';
const PAT = ID(0x700), OTHER_PAT = ID(0x701), ORD = ID(0x710), ORD2 = ID(0x711), RPT = ID(0x720);
const REL = '2026-11-05T04:35:00.000Z', DAY = 86_400_000;
const rejection = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } return undefined; };
const handler = (): ((p: any, c: any) => Promise<void>) => manifest.tasks![TASK]! as any;

// ---------------------------------------------------------------- the C6 snapshot (03-IC §4.10 SmartSummary + 08 display fields), synthetic
const T1 = 'Synthetic: your LDL is higher than the usual range.', A1 = 'Synthetic: eat more fibre.', F1 = 'Synthetic: repeat the lipid panel.', F2 = 'Synthetic: repeat the cholesterol check.', DISC = 'Synthetic disclaimer text.', PANEL = 'Synthetic Lipid Profile';
const summary = (o: Row = {}): Row => ({
  summaryId: ID(0xa01), orderId: ORD, reportVersionNo: 1, templateLibraryVersion: 'lib-2026.1', status: 'approved', approvedByMembershipId: ID(0xa02), approvedAt: '2026-11-05T05:00:00.000Z',
  healthScore: { value: 82, band: 'good', formulaVersion: 'hs-1', panelsScored: 2, explanationText: 'Synthetic explanation.' },
  panels: [{ panelCode: 'SYN_LIPID', status: 'borderline', resultIds: [ID(0xa11)], displayName: PANEL }, { panelCode: 'SYN_CBC', status: 'in_range', resultIds: [ID(0xa12)] }],
  deranged: [{ resultId: ID(0xa21), analyteId: ID(0xa22), direction: 'high', severity: 'borderline', templateBlockId: ID(0xa23), text: T1, analyteName: 'Synthetic LDL' }],
  advice: [{ templateBlockId: ID(0xa31), text: A1 }],
  followUps: [{ ruleId: ID(0xa41), suggestedTestCode: 'SYN_HBA1C', intervalDays: 90, text: F1, suggestedTestName: 'Synthetic HbA1c' }, { ruleId: ID(0xa42), suggestedTestCode: 'SYN_LIPID', intervalDays: 30, text: F2 }],
  trends: [{ analyteId: ID(0xa51), direction: 'improved', pointResultIds: [ID(0xa52)], analyteName: 'Synthetic LDL', unitCode: 'mg_dl', points: [{ resultId: ID(0xa52), approvedAt: '2026-05-05T04:00:00.000Z', valueNumeric: '130.0' }] }],
  disclaimerBlockId: ID(0xa61), language: 'en', builtAt: '2026-11-05T04:50:00.000Z', disclaimerText: DISC, ...o,
});
/** What the E24 view needs, nothing id-like: the part of the snapshot the stored copy must carry verbatim. */
const KEPT = (s: Row) => ({
  status: 'approved', templateLibraryVersion: s['templateLibraryVersion'], approvedAt: s['approvedAt'], healthScore: { value: s['healthScore'].value, band: s['healthScore'].band },
  panels: s['panels'].map((p: Row) => ({ panelCode: p['panelCode'], status: p['status'], ...(p['displayName'] ? { displayName: p['displayName'] } : {}) })),
  deranged: s['deranged'].map((d: Row) => ({ direction: d['direction'], severity: d['severity'], text: d['text'] })), advice: s['advice'].map((a: Row) => ({ text: a['text'] })),
  followUps: s['followUps'].map((f: Row) => ({ intervalDays: f['intervalDays'], text: f['text'] })), trends: s['trends'].map((t: Row) => ({ direction: t['direction'] })), disclaimerText: s['disclaimerText'],
});
const idKeys = (v: unknown, path = ''): string[] => (Array.isArray(v) ? v.flatMap((x, i) => idKeys(x, `${path}[${i}]`)) : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [...(/(Id|Ids|_id|_ids)$/.test(k) ? [`${path}.${k}`] : []), ...idKeys(x, `${path}.${k}`)]) : []);
const parsed = (r: Row): Row => (typeof r['summary'] === 'string' ? JSON.parse(r['summary']) : r['summary']);

// ---------------------------------------------------------------- world
interface Fx {
  w: LinkWorld; rp: any; calls: Array<{ actor: string | undefined; input: Row }>; smartCalls: string[];
  run: (payload?: any, over?: Row) => Promise<void>;
  addReport: (o?: Row) => Row; setFixture: (o?: Row) => void;
  summaries: () => Row[]; reminders: () => Row[];
}
interface Opt { snapshot?: Row | null; setting?: boolean; auto?: boolean; lead?: number; link?: boolean; reportRow?: boolean }
function setup(o: Opt = {}): Fx {
  const w = makeLinkWorld({ maxAccountsPerPatient: 10 });
  w.setSetting('smart_report_in_app', o.setting ?? true); w.setSetting('auto_follow_up_reminders', o.auto ?? false); w.setSetting('follow_up_reminder_lead_days', o.lead ?? 3); w.setSetting('reminders_enabled', true);
  if (o.link !== false) { const acct = w.seedAccount(PHONE); w.seedLink(acct['id'], PAT, { method: 'link_code' }); }
  let n = 0; // ruling T-P4: the fake deep-freezes opts.fixtures at build time, so rows are seeded through inner.__seed (02-CONVENTIONS §954)
  const inner: any = createFakeReportingPort({ seed: 7, fixtures: { reports: [] } as any });
  const calls: Fx['calls'] = []; const smartCalls: string[] = [];
  // tests may assign rp.openReleasedReportFile to inject a failure: keep it behind the recording wrapper so `calls` still sees the call
  let open: (ctx: any, input: Row) => Promise<any> = (ctx, input) => inner.openReleasedReportFile(ctx, input);
  const rp = new Proxy({ ...inner, async openReleasedReportFile(ctx: any, input: Row) { calls.push({ actor: ctx?.actor?.type, input: structuredClone(input) }); return open(ctx, input); } }, {
    set: (t: any, k, v) => { if (k === 'openReleasedReportFile') open = v; else t[k] = v; return true; },
  });
  const smartPort = new Proxy({}, { get: (_t, m) => async () => { smartCalls.push(String(m)); throw new Error('C16 must never call SmartReportPort (08 A2.3)'); } });
  const addReport = (over: Row = {}): Row => { const r: Row = { tenant_id: w.tenantId, report_id: RPT, version_no: 1, order_id: ORD, patient_id: PAT, report_kind: 'final', status: 'valid', released_at: REL, supersedes_version_no: null, panel_names: [PANEL], smart_summary_available: true,
    created_by: SYSTEM_ACTOR, updated_by: SYSTEM_ACTOR, created_at: T0, updated_at: T0, ...over }; w.t['patient_reports']!.push(r); return r; };
  const setFixture = (over: Row = {}) => { inner.__seed({ reports: [{ id: ID(0xb00 + n++), tenantId: w.tenantId, reportId: RPT, versionNo: 1, orderId: ORD, patientId: PAT, kind: 'final', status: 'valid', released: true, releasedAt: REL, panelNames: [PANEL], smartSummary: summary(), ...over }] } as any); };
  if (o.reportRow !== false) addReport();
  setFixture(o.snapshot === undefined ? {} : { smartSummary: o.snapshot });
  const run: Fx['run'] = (payload = { tenant_id: w.tenantId, report_id: RPT, version_no: 1 }, over = {}) => w.inTx(() => handler()(payload, w.jobCtx({ ports: { ...w.ports, ReportingPort: rp, SmartReportPort: smartPort }, ...over })));
  return { w, rp, calls, smartCalls, run, addReport, setFixture, summaries: () => w.t['smart_summaries']!, reminders: () => w.t['reminders']! };
}

describe('manifest (TRD §8.1)', () => {
  it('engagement.fetch_smart_summary is implemented (no longer the fail-closed stub), max_attempts 5, manifest still validates', async () => {
    expect(() => validateManifests([manifest])).not.toThrow();
    expect(manifest.maxAttempts?.[TASK]).toBe(5);
    const f = setup(); const e = await rejection(f.run());
    expect(String(e?.message ?? '')).not.toMatch(/not implemented/);
  });
});

describe('US-EN-09.1 approved snapshot is copied', () => {
  it('stores ONE row: ids from the read model, template version, approved_at from the snapshot, fetched_at = now, system actor; the port is called once as the system actor with the exact report version', async () => {
    const f = setup(); await f.run();
    expect(f.summaries()).toHaveLength(1);
    expect(f.summaries()[0]).toMatchObject({ tenant_id: f.w.tenantId, order_id: ORD, report_id: RPT, report_version_no: 1, patient_id: PAT, template_library_version: 'lib-2026.1', created_by: SYSTEM_ACTOR });
    expect(Date.parse(f.summaries()[0]!['approved_at'])).toBe(Date.parse('2026-11-05T05:00:00.000Z')); expect(Date.parse(f.summaries()[0]!['fetched_at'])).toBe(Date.parse(f.w.now()));
    expect(typeof f.summaries()[0]!['id']).toBe('string');
    expect(f.calls).toEqual([{ actor: 'system', input: { reportId: RPT, versionNo: 1 } }]);
  });

  it('never calls SmartReportPort (08 A2.3), also for a draft and for a missing snapshot', async () => {
    for (const snapshot of [undefined, summary({ status: 'draft' }), null] as const) { const f = setup({ snapshot }); await f.run(); expect(f.smartCalls).toEqual([]); }
  });

  it('the stored copy keeps the displayed content verbatim (health score, panels, deranged, advice, follow-ups, trends, disclaimer) and carries NO id of any kind', async () => {
    const f = setup(); await f.run(); const s = parsed(f.summaries()[0]!);
    expect(s).toMatchObject(KEPT(summary()));
    expect(idKeys(s), 'every key ending Id / Ids / _id / _ids is dropped (analyte, result, template block, rule, summary, approver ids)').toEqual([]);
    expect(JSON.stringify(s)).not.toMatch(/0000-7000-8000-0000000007|0000-7000-8000-000000000a/); // none of the synthetic uuids of the snapshot survives anywhere
  });

  it('is idempotent: running the task twice leaves one row with the same id and content (job_key smart:<report_id>:<version_no> + unique (tenant, report, version))', async () => {
    const f = setup({ auto: true }); await f.run(); const first = structuredClone(f.summaries()); const remFirst = structuredClone(f.reminders());
    await f.run();
    expect(f.summaries()).toHaveLength(1); expect(f.summaries()[0]!['id']).toBe(first[0]!['id']); expect(parsed(f.summaries()[0]!)).toEqual(parsed(first[0]!));
    expect(f.reminders()).toEqual(remFirst);
  });

});

describe('US-EN-09.1 / 09.3 approved-only storage', () => {
  const NOT_STORED: Array<[string, Row | null]> = [
    ['draft', summary({ status: 'draft' })], ['status "Approved" (case differs)', summary({ status: 'Approved' })], ['status "superseded"', summary({ status: 'superseded' })], ['status missing', (({ status: _s, ...rest }) => rest)(summary())],
    ['status not a string (true)', summary({ status: true })], ['no snapshot attached (C6 feature off)', null],
  ];
  for (const [name, snapshot] of NOT_STORED) {
    it(`${name} -> nothing stored, no reminders (even with auto_follow_up_reminders), the task resolves (no retry)`, async () => {
      const f = setup({ snapshot, auto: true });
      if (snapshot === null) f.w.t['patient_reports']![0]!['smart_summary_available'] = false;
      await f.run(); expect(f.summaries()).toHaveLength(0); expect(f.reminders()).toHaveLength(0);
    });
  }
  it('a snapshot field named like an approved flag is not enough: only status === "approved" counts (approvedAt present but status draft)', async () => {
    const f = setup({ snapshot: summary({ status: 'draft', approvedAt: '2026-11-05T05:00:00.000Z' }) }); await f.run(); expect(f.summaries()).toHaveLength(0);
  });
  it('the port answers common.not_found -> no row, resolves (no retry, TRD §6.2)', async () => {
    const f = setup(); f.rp.openReleasedReportFile = async () => { throw Object.assign(new Error('nf'), { code: 'common.not_found' }); };
    await f.run(); expect(f.summaries()).toHaveLength(0);
  });
  it('a storage / infrastructure error (common.dependency_unavailable, or a plain Error) -> the task rejects so the queue retries, and nothing is stored', async () => {
    for (const err of [Object.assign(new Error('down'), { code: 'common.dependency_unavailable' }), new Error('ECONNRESET')]) {
      const f = setup(); f.rp.openReleasedReportFile = async () => { throw err; };
      const e = await rejection(f.run()); expect(e).toBeDefined(); expect(String(e?.message ?? '')).not.toMatch(/not implemented/); expect(f.calls).toHaveLength(1); expect(f.summaries()).toHaveLength(0);
    }
  });
  it('only the one requested version is read: a different report or version in the fixture is never stored', async () => {
    const f = setup(); f.setFixture({ versionNo: 2, smartSummary: summary({ reportVersionNo: 2 }) }); f.setFixture({ reportId: ID(0x721), smartSummary: summary({ summaryId: ID(0xa99) }) });
    await f.run(); expect(f.summaries().map((r) => [r['report_id'], r['report_version_no']])).toEqual([[RPT, 1]]);
  });
});

describe('feature disabled -> hidden (06-PLAN tests column; US-EN-09.1 "and smart_report_in_app = true")', () => {
  it('smart_report_in_app = false at run time (switched off after the enqueue): nothing stored, no reminders, and the port is not even called (no PHI fetched for a hidden feature)', async () => {
    const f = setup({ setting: false, auto: true }); await f.run();
    expect(f.summaries()).toHaveLength(0); expect(f.reminders()).toHaveLength(0); expect(f.calls).toHaveLength(0);
  });
  it('smart_report_in_app of ANOTHER tenant does not leak in: this tenant off, the other on -> still nothing', async () => {
    const f = setup({ setting: false }); f.w.t['settings']!.push({ id: ID(0xb99), tenant_id: TENANT_B, smart_report_in_app: true, auto_follow_up_reminders: true, follow_up_reminder_lead_days: 3, version: 1 });
    await f.run(); expect(f.summaries()).toHaveLength(0);
  });
});

describe('read model guards', () => {
  it('no patient_reports row for the version (patient unlinked / reconciled away): nothing stored, the task resolves', async () => {
    const f = setup({ reportRow: false }); await f.run(); expect(f.summaries()).toHaveLength(0);
  });
  it('a payload for another tenant, or a malformed payload, is a silent no-op: no row, no port call, no throw', async () => {
    const f = setup(); const t = f.w.tenantId;
    for (const payload of [{ tenant_id: TENANT_B, report_id: RPT, version_no: 1 }, { tenant_id: t, report_id: 'x', version_no: 1 }, { tenant_id: t, report_id: RPT, version_no: 0 }, { tenant_id: t, report_id: RPT, version_no: '1' }, { tenant_id: t, report_id: RPT, version_no: 1.5 }, { tenant_id: t, version_no: 1 }, { tenant_id: t, report_id: RPT }, {}, null]) {
      await f.run(payload as any);
    }
    expect(f.summaries()).toHaveLength(0); expect(f.calls).toHaveLength(0);
  });
  it('a row of another tenant with the same report id / version is never touched or read (tenant_id bound everywhere)', async () => {
    const f = setup({ reportRow: false }); f.addReport({ tenant_id: TENANT_B }); await f.run(); expect(f.summaries()).toHaveLength(0);
  });
});

describe('US-EN-09.4 newer version', () => {
  it('v2 released: the older summary is kept (it is shown as superseded) and v2 gets its own row with its own content', async () => {
    const f = setup(); await f.run(); const v1 = structuredClone(f.summaries()[0]!);
    f.w.t['patient_reports']![0]!['status'] = 'superseded';
    f.addReport({ version_no: 2, order_id: ORD, released_at: '2026-11-06T04:35:00.000Z', supersedes_version_no: 1, report_kind: 'amended' });
    f.setFixture({ versionNo: 2, releasedAt: '2026-11-06T04:35:00.000Z', kind: 'amended', smartSummary: summary({ reportVersionNo: 2, healthScore: { value: 64, band: 'fair', formulaVersion: 'hs-1', panelsScored: 2 }, advice: [{ templateBlockId: ID(0xa32), text: 'Synthetic: version two advice.' }], approvedAt: '2026-11-06T05:00:00.000Z' }) });
    await f.run({ tenant_id: f.w.tenantId, report_id: RPT, version_no: 2 });
    expect(f.summaries()).toHaveLength(2);
    const byV = (n: number) => f.summaries().find((r) => r['report_version_no'] === n)!;
    expect(byV(1)).toEqual(v1); // untouched
    expect(byV(2)).toMatchObject({ report_id: RPT, patient_id: PAT, order_id: ORD });
    expect(parsed(byV(2))).toMatchObject({ healthScore: { value: 64, band: 'fair' }, advice: [{ text: 'Synthetic: version two advice.' }] });
    expect(f.calls.at(-1)).toEqual({ actor: 'system', input: { reportId: RPT, versionNo: 2 } });
  });
  it('the key is per (report, version): the same version number of another report is a different row', async () => {
    const f = setup(); await f.run();
    f.addReport({ report_id: ID(0x721), order_id: ORD2 }); f.setFixture({ reportId: ID(0x721), orderId: ORD2, smartSummary: summary({ orderId: ORD2, summaryId: ID(0xa88) }) });
    await f.run({ tenant_id: f.w.tenantId, report_id: ID(0x721), version_no: 1 }); expect(f.summaries()).toHaveLength(2);
  });
});

describe('US-EN-24.1-3 follow-up reminders from the approved summary', () => {
  const rel = Date.parse(REL);
  const bySeq = (f: Fx) => [...f.reminders()].sort((a, b) => a['source_ref_seq'] - b['source_ref_seq']);

  it('auto_follow_up_reminders = true: ONE reminder per follow-up, kind follow_up, source smart_report, source_ref_id = the stored summary id, source_ref_seq = index, due = released_at + intervalDays - lead days, scheduled, system actor', async () => {
    const f = setup({ auto: true, lead: 3 }); await f.run(); const sum = f.summaries()[0]!;
    expect(f.reminders()).toHaveLength(2);
    const [a, b] = bySeq(f);
    for (const r of [a!, b!]) expect(r).toMatchObject({ tenant_id: f.w.tenantId, patient_id: PAT, kind: 'follow_up', source: 'smart_report', source_ref_id: sum['id'], status: 'scheduled', created_by: SYSTEM_ACTOR, version: 1 });
    expect([a!['source_ref_seq'], b!['source_ref_seq']]).toEqual([0, 1]);
    expect(Date.parse(a!['due_at'])).toBe(rel + (90 - 3) * DAY); expect(Date.parse(b!['due_at'])).toBe(rel + (30 - 3) * DAY);
    expect(new Date(a!['due_at']).toISOString()).toBe('2027-01-31T04:35:00.000Z'); // 2026-11-05 + 90 d - 3 d (literal cross-check of the arithmetic)
    for (const r of [a!, b!]) expect(String(r['reason_code'])).toMatch(/^[a-z0-9_]{1,64}$/);
  });
  it('the lead comes from follow_up_reminder_lead_days (0 and 30 tried)', async () => {
    for (const lead of [0, 30]) { const f = setup({ auto: true, lead }); await f.run(); expect(Date.parse(bySeq(f)[0]!['due_at'])).toBe(rel + (90 - lead) * DAY); }
  });
  it('idempotent on (kind, source_ref_id, source_ref_seq): a retry of the task adds no second set', async () => {
    const f = setup({ auto: true }); await f.run(); await f.run(); expect(f.reminders()).toHaveLength(2);
    expect(new Set(f.reminders().map((r) => r['source_ref_seq'])).size).toBe(2);
  });
  it('REQ-SEC-070 / 04 R6: neither the suggested test code / name nor the follow-up text is stored on the reminder row (the SMS carries only lab name and date)', async () => {
    const f = setup({ auto: true }); await f.run();
    expect(JSON.stringify(f.reminders())).not.toMatch(/SYN_HBA1C|SYN_LIPID|Synthetic HbA1c|repeat the lipid|repeat the cholesterol/i);
  });
  it('auto_follow_up_reminders = false (the default): the summary is stored and NO reminder is created (staff see the suggestion on the reminder screen, US-EN-24.3)', async () => {
    const f = setup({ auto: false }); await f.run(); expect(f.summaries()).toHaveLength(1); expect(f.reminders()).toHaveLength(0);
  });
  it('an approved summary without follow-ups -> stored, no reminders', async () => {
    const f = setup({ auto: true, snapshot: summary({ followUps: [] }) }); await f.run(); expect(f.summaries()).toHaveLength(1); expect(f.reminders()).toHaveLength(0);
  });
  it('the reminder belongs to the READ-MODEL patient and tenant, and no reminder is written for another patient', async () => {
    const f = setup({ auto: true }); await f.run(); expect(new Set(f.reminders().map((r) => r['patient_id']))).toEqual(new Set([PAT]));
  });
});

describe('hygiene (07-SECURITY rule 2, 02-CV §5.13 / REQ-SEC-024)', () => {
  it('nothing the task logs, audits or counts carries the summary text, the panel name or the disclaimer', async () => {
    const f = setup({ auto: true }); await f.run(); const seen = f.w.observed();
    for (const s of [T1, A1, F1, F2, DISC, PANEL, 'SYN_HBA1C', 'Synthetic LDL']) expect(seen).not.toContain(s);
  });
  it('a failed fetch (infra error) also logs no summary text', async () => {
    const f = setup(); f.rp.openReleasedReportFile = async () => { throw Object.assign(new Error(`boom ${T1}`), { code: 'common.dependency_unavailable' }); };
    const e = await rejection(f.run()); expect(e).toBeDefined(); expect(f.calls).toHaveLength(1); expect(f.w.logs.join('\n')).not.toContain(PANEL);
  });
  it('every statement on an engagement table binds tenant_id; the task writes only smart_summaries and reminders; plain SQL only (the world rejects JOIN / sub-select)', async () => {
    const f = setup({ auto: true }); await f.run();
    for (const s of f.w.stmts.filter((x) => /engagement\.|\b(patient_reports|smart_summaries|reminders|settings)\b/i.test(x.text))) expect(s.text).toMatch(/tenant_id/i);
    const tables = new Set(f.w.writes().map((s) => /\b(?:into|update)\s+(?:\w+\.)?(\w+)/i.exec(s.text.replace(/\s+/g, ' '))?.[1]));
    expect([...tables].every((t) => t === 'smart_summaries' || t === 'reminders')).toBe(true);
    expect(f.w.writes().length).toBeGreaterThan(0);
  });
});

describe('source rules (02-CV §5, REQ-SEC-024, 08 A2.3)', () => {
  const dir = join(REPO_ROOT, 'services/worker/src/jobs/engagement'); const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === '__tests__' ? [] : files(join(d, e.name))) : e.name.endsWith('.ts') ? [join(d, e.name)] : []));
  it('the task source exists, never references SmartReportPort / smartreport schema, and never reads another schema directly', () => {
    const src = files(dir).filter((p) => /fetch_smart_summary/.test(p)); expect(src.length, 'tasks/fetch_smart_summary.ts (or a service it names) must exist').toBeGreaterThan(0);
    for (const p of files(dir)) { const s = readFileSync(p, 'utf8'); if (!/smart/i.test(s)) continue; expect(/SmartReportPort\.|smartreport\.(summaries|v_pub)/.test(s), relative(REPO_ROOT, p)).toBe(false); }
  });
});
