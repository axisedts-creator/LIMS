// C14 T13 — SmartReportPort.buildSummary (ports/SmartReportPort.impl.ts + mappers/port.mapper.ts): 02-TRD §7.1 steps 1-2 and 6-9, 08 A2.3 / A19 D-111, CR-C14-006.
// ACs: AC-01.1, AC-01.2, AC-14.4, AC-17.1 (port side). Security: 07-SECURITY T3 (tenant from ctx, non-staff fail-closed, no draft/PHI leak).
// Seams: only the public signature smartReportPort.buildSummary(ctx, {orderId, version}); ctx.ports.IdentityPort.getTenantSettings(ctx, {keys:['featureFlags']}) gives the flag;
// the build is summary.service.buildOrGet over the T12 emulators (see t12.fakes.ts header). ASSUMPTION (not in IC @throws, pinned from the fake + TRD step 6 "fail-closed"):
// a non-staff actor (patient/portal/partner/device) gets LimsError auth.forbidden and causes no read or write. Fails now: the T01 placeholder always throws feature_disabled.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../repository/summaries.repo.js', async () => (await import('./t12.fakes.js')).summariesRepoFake);
vi.mock('../repository/bindings.repo.js', async () => (await import('./t12.fakes.js')).bindingsRepoFake);
vi.mock('../repository/library.repo.js', async () => (await import('./t12.fakes.js')).libraryRepoFake);
vi.mock('../repository/blocks.repo.js', async () => (await import('./t12.fakes.js')).blocksRepoFake);
vi.mock('../repository/rules.repo.js', async () => (await import('./t12.fakes.js')).rulesRepoFake);
vi.mock('../repository/mappings.repo.js', async () => (await import('./t12.fakes.js')).mappingsRepoFake);
vi.mock('../repository/groups.repo.js', async () => (await import('./t12.fakes.js')).groupsRepoFake);
vi.mock('../repository/codedSets.repo.js', async () => (await import('./t12.fakes.js')).codedSetsRepoFake);

import { smartReportPort } from '../ports/SmartReportPort.impl.js';
import { LimsError, ORDER, PATIENT, REG_NO, TA, TB, ac081, amend, approveLibrary, makeCtx, retireLibrary, run, seed, setResults, w } from './t12.fakes.js';

const NOW_ISO = '2026-11-05T04:00:00.000Z';
let settings: Record<string, unknown>;
const identity = { getTenantSettings: vi.fn(async (_c: unknown, input: { keys: string[] }) => Object.fromEntries(input.keys.map((k) => [k, settings[k]]))) };
const ctxOf = (tenant: 'A' | 'B' = 'A', type = 'system'): any => {
  const c = makeCtx(tenant, 'system');
  c.actor = { ...c.actor, type };
  c.ports.IdentityPort = identity;
  return c;
};
const call = (ctx: any, ...rest: unknown[]): Promise<any> => {
  const input = rest.length > 0 ? rest[0] : { orderId: ORDER.a, version: 1 };     // an explicit undefined is a real (bad) input
  return run(ctx, () => smartReportPort.buildSummary(ctx, input as any)) as Promise<any>;
};
const codeOf = async (p: Promise<unknown>): Promise<string> => { try { await p; return 'resolved'; } catch (e: any) { return e instanceof LimsError ? e.code : `non_lims_error:${e?.message}`; } };
const untouched = (): void => { expect(w.calls).toEqual([]); expect(w.portCalls).toEqual([]); expect(w.summaries).toEqual([]); expect(w.bindings).toEqual([]); expect(w.writes).toEqual([]); };
const stored = (): any => w.summaries[0];

beforeEach(() => {
  seed(); approveLibrary(1); vi.clearAllMocks();
  settings = { featureFlags: { smart_report: true } };
});

describe('C14-T13 step 2 — feature flag (AC-01.1)', () => {
  it('AC-01.1: featureFlags.smart_report = false -> smartreport.feature_disabled, no row written, no order/result/catalog read', async () => {
    settings = { featureFlags: { smart_report: false } };
    expect(await codeOf(call(ctxOf()))).toBe('smartreport.feature_disabled');
    untouched();
  });
  it('the flag is read once through IdentityPort.getTenantSettings(ctx, { keys: [\'featureFlags\'] }) with the caller ctx', async () => {
    const ctx = ctxOf();
    await call(ctx);
    expect(identity.getTenantSettings).toHaveBeenCalledTimes(1);
    expect(identity.getTenantSettings).toHaveBeenCalledWith(ctx, { keys: ['featureFlags'] });
  });
  it.each<[string, unknown]>([
    ['flag absent', {}], ['featureFlags missing', undefined], ['featureFlags null', null], ['string "true"', { smart_report: 'true' }], ['number 1', { smart_report: 1 }],
    ['object', { smart_report: {} }], ['null', { smart_report: null }], ['other flag only', { smart_report_llm: true }],
  ])('only boolean true enables (!== true -> disabled): %s', async (_n, featureFlags) => {
    settings = { featureFlags };
    expect(await codeOf(call(ctxOf()))).toBe('smartreport.feature_disabled');
    untouched();
  });
  it('a failing IdentityPort propagates unchanged and is never read as "disabled" or "enabled"; nothing written', async () => {
    identity.getTenantSettings.mockRejectedValueOnce(new LimsError('auth.forbidden'));
    expect(await codeOf(call(ctxOf()))).toBe('auth.forbidden');
    identity.getTenantSettings.mockRejectedValueOnce(new Error('settings store down'));
    expect(await codeOf(call(ctxOf()))).toBe('non_lims_error:settings store down');
    untouched();
  });
});

describe('C14-T13 step 1 — input validation', () => {
  it.each([[0], [-1], [1.5], [NaN], [Infinity], ['1'], [null], [undefined], [true]])('version %s -> common.validation_failed, before the flag read, nothing touched', async (version) => {
    settings = { featureFlags: { smart_report: false } };              // step 1 runs before step 2
    expect(await codeOf(call(ctxOf(), { orderId: ORDER.a, version }))).toBe('common.validation_failed');
    expect(identity.getTenantSettings).not.toHaveBeenCalled();
    untouched();
  });
  it.each([[undefined], [null], [{}], [{ version: 1 }], [{ orderId: 'not-a-uuid', version: 1 }], [{ orderId: 42, version: 1 }]])('bad input %j -> common.validation_failed, nothing written', async (input) => {
    expect(await codeOf(call(ctxOf(), input))).toBe('common.validation_failed');
    expect(w.summaries).toEqual([]); expect(w.bindings).toEqual([]); expect(w.writes).toEqual([]);
  });
});

describe('C14-T13 step 6 — actors (08 A2.3, AC-17.1)', () => {
  it.each([['patient'], ['portal'], ['partner'], ['device']])('AC-17.1: %s actor -> auth.forbidden, zero reads, zero writes, flag not even read', async (type) => {
    expect(await codeOf(call(ctxOf('A', type)))).toBe('auth.forbidden');
    expect(identity.getTenantSettings).not.toHaveBeenCalled();
    untouched();
  });
  it('non-staff is refused even for an approved summary that already exists (no read path, no draft/approved text to a patient)', async () => {
    await call(ctxOf());
    Object.assign(stored(), { status: 'approved', approved_at: new Date(NOW_ISO), approved_by_membership_id: PATIENT.a });
    const before = w.calls.length;
    expect(await codeOf(call(ctxOf('A', 'patient')))).toBe('auth.forbidden');
    expect(w.calls.length).toBe(before);
  });
  it('staff (user) and building actors (system) both build', async () => {
    for (const t of ['user', 'system']) expect((await call(ctxOf('A', t))).status).toBe('draft');
    expect(w.summaries).toHaveLength(1);
  });
});

describe('C14-T13 steps 3-7 — errors from the build propagate as the original LimsError', () => {
  it('AC-01.2: flag true, no approved library -> smartreport.template_not_approved, no summary row', async () => {
    seed();                                                               // fresh world: results but NO library
    expect(await codeOf(call(ctxOf()))).toBe('smartreport.template_not_approved');
    expect(w.summaries).toEqual([]);
  });
  it('AC-01.2: only a retired library -> template_not_approved', async () => {
    retireLibrary(1);
    expect(await codeOf(call(ctxOf()))).toBe('smartreport.template_not_approved');
  });
  it('order not visible to the tenant -> common.not_found (the original LimsError), nothing written for either tenant', async () => {
    const e = await call(ctxOf('A'), { orderId: ORDER.b, version: 1 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(LimsError); expect(e.code).toBe('common.not_found');
    expect(w.summaries).toEqual([]); expect(w.bindings).toEqual([]);
  });
  it('approved set empty -> smartreport.no_eligible_results', async () => {
    setResults(ORDER.a, []);
    expect(await codeOf(call(ctxOf()))).toBe('smartreport.no_eligible_results');
    expect(w.summaries).toEqual([]);
  });
});

describe('C14-T13 step 9 — mapping to SmartSummary', () => {
  it('first build: draft view of the stored row, reportVersionNo = input.version, templateLibraryVersion = decimal version_no, display fields set', async () => {
    seed(); approveLibrary(4);
    const s = await call(ctxOf(), { orderId: ORDER.a, version: 3 });
    expect(s).toMatchObject({ summaryId: stored().id, orderId: ORDER.a, reportVersionNo: 3, templateLibraryVersion: '4', status: 'draft', language: 'en', disclaimerBlockId: stored().content.disclaimerBlockId });
    expect(s.builtAt).toBe(stored().built_at);
    expect(s.disclaimerText).toBe(stored().content.disclaimerText);
    expect(s.healthScore).toMatchObject({ value: stored().health_score_value, band: stored().health_score_band, panelsScored: stored().panels_scored });
    expect(s.deranged).toHaveLength(1);
    expect(s).not.toHaveProperty('approvedByMembershipId'); expect(s).not.toHaveProperty('approvedAt');
  });
  it('panels, deranged, advice, followUps, trends are the stored content (no re-computation, no extra text)', async () => {
    const s = await call(ctxOf());
    for (const k of ['panels', 'deranged', 'advice', 'followUps', 'trends'] as const) expect(s[k], k).toEqual(stored().content[k]);
  });
  it('AC-14.4: a rejected summary is returned as status "draft" without approval fields and without any reject reason / comment', async () => {
    await call(ctxOf());
    Object.assign(stored(), { status: 'rejected', rejected_at: new Date(NOW_ISO), rejected_by_membership_id: PATIENT.a, reject_reason_code: 'wording_problem', reject_comment: 'SYN-PRIVATE-REJECT-COMMENT' });
    const s = await call(ctxOf());
    expect(s.status).toBe('draft');
    expect(s).not.toHaveProperty('approvedAt'); expect(s).not.toHaveProperty('approvedByMembershipId');
    const text = JSON.stringify(s);
    for (const leak of ['wording_problem', 'SYN-PRIVATE-REJECT-COMMENT', 'reject']) expect(text).not.toContain(leak);
  });
  it.each([['Date from the driver', new Date(NOW_ISO)], ['ISO string', NOW_ISO]])('approved -> status "approved" with approvedByMembershipId and approvedAt as IsoUtc string (%s)', async (_n, at) => {
    await call(ctxOf());
    Object.assign(stored(), { status: 'approved', approved_at: at, approved_by_membership_id: '01900000-0000-7000-8000-0000000c1499' });
    const s = await call(ctxOf());
    expect(s.status).toBe('approved');
    expect(s.approvedByMembershipId).toBe('01900000-0000-7000-8000-0000000c1499');
    expect(s.approvedAt).toBe(NOW_ISO);
  });
  it('D-111: smartreport.summary_not_ready is never thrown, whatever the stored status, for staff and system', async () => {
    await call(ctxOf());
    for (const status of ['draft', 'rejected', 'approved']) {
      Object.assign(stored(), { status, ...(status === 'approved' ? { approved_at: new Date(NOW_ISO), approved_by_membership_id: PATIENT.a } : {}) });
      for (const t of ['user', 'system']) {
        const c = await codeOf(call(ctxOf('A', t)));
        expect(c, `${status}/${t}`).toBe('resolved');
      }
    }
  });
  it('output is an allow-list: no tenant/patient/centre ids, no hashes, no review or LLM columns, no registration number', async () => {
    const text = JSON.stringify(await call(ctxOf()));
    for (const leak of [TA, PATIENT.a, REG_NO, 'tenant_id', 'patient_id', 'centre_id', 'content_sha256', 'approved_set_hash', 'input_result_versions', 'llm_overlay', 'use_llm_text', 'library_version_id',
      'created_by', 'updated_by', 'superseded', 'rejected_by']) expect(text, leak).not.toContain(leak);
  });
});

describe('C14-T13 step 8 — report-version binding', () => {
  it('writes one binding per (summary, version) with the requested report version; a repeat is a no-op; a new version adds one; one summary throughout', async () => {
    const a = await call(ctxOf(), { orderId: ORDER.a, version: 3 });
    expect(w.bindings.map((b) => [b.summary_id, b.order_id, b.report_version_no])).toEqual([[a.summaryId, ORDER.a, 3]]);
    await call(ctxOf(), { orderId: ORDER.a, version: 3 });
    expect(w.bindings).toHaveLength(1);
    const b = await call(ctxOf(), { orderId: ORDER.a, version: 4 });
    expect(b.summaryId).toBe(a.summaryId); expect(b.reportVersionNo).toBe(4);
    expect(w.bindings.map((x) => x.report_version_no).sort()).toEqual([3, 4]);
    expect(w.summaries).toHaveLength(1);
  });
});

describe('C14-T13 tenant isolation and concurrency', () => {
  it('tenant comes from ctx only: an input tenantId / centreId is ignored; every repository call and the stored row carry the ctx tenant', async () => {
    await call(ctxOf('A'), { orderId: ORDER.a, version: 1, tenantId: TB, centreId: 'x', patientId: PATIENT.b } as unknown);
    expect(stored().tenant_id).toBe(TA); expect(stored().patient_id).toBe(PATIENT.a);
    for (const c of w.calls) if (c.tenantId !== undefined) expect(c.tenantId, c.fn).toBe(TA);
  });
  it('the other tenant sees its own order and never the first tenant\'s summary', async () => {
    seed(); approveLibrary(1);                                            // tenant B has no library in this world
    await call(ctxOf('A'));
    expect(await codeOf(call(ctxOf('B'), { orderId: ORDER.a, version: 1 }))).toBe('common.not_found');
    expect(w.summaries.every((s) => s.tenant_id === TA)).toBe(true);
  });
  it('two simultaneous calls for one order (other transactions) build once and return the same summary (advisory lock)', async () => {
    const [a, b] = await Promise.all([call(ctxOf(), { orderId: ORDER.a, version: 1 }), call(ctxOf('A', 'user'), { orderId: ORDER.a, version: 2 })]);
    expect(w.summaries).toHaveLength(1);
    expect(a.summaryId).toBe(b.summaryId);
    expect(w.bindings.map((x) => x.report_version_no).sort()).toEqual([1, 2]);
    expect(w.lockCalls.length).toBe(2);
  });
  it('amendment: the old summary is superseded and linked to the new one, and is never returned again', async () => {
    const old = await call(ctxOf());
    amend(ORDER.a, w.results.get(ORDER.a)![0]!.resultId);
    const fresh = await call(ctxOf());
    expect(fresh.summaryId).not.toBe(old.summaryId);
    const oldRow = w.summaries.find((s) => s.id === old.summaryId)!;
    expect(oldRow).toMatchObject({ status: 'superseded', superseded_by_summary_id: fresh.summaryId });
    expect((await call(ctxOf())).summaryId).toBe(fresh.summaryId);
  });
  it('ctx.db is never needed: the port runs in ctx.tx only (no transaction opened)', async () => {
    const ctx = ctxOf();
    expect(ctx.db).toBeUndefined();
    expect((await call(ctx)).status).toBe('draft');
  });
});

describe('C14-T13 results as data', () => {
  it('a different order of the same tenant builds independently (no cross-order state)', async () => {
    setResults(ORDER.a2, ac081());
    const a = await call(ctxOf(), { orderId: ORDER.a, version: 1 });
    const b = await call(ctxOf(), { orderId: ORDER.a2, version: 1 });
    expect(a.summaryId).not.toBe(b.summaryId);
    expect(w.summaries.map((s) => s.order_id).sort()).toEqual([ORDER.a, ORDER.a2].sort());
  });
});
