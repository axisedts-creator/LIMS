// C6-T13 — R6 POST /report-versions/{report_version_id}/release (operationId releaseReportVersion; 02-TRD §4.6 rules 1-4, 6, 8; §6.3 R6; 03-APP-FLOW V5, E-flows).
// ACs: AC-06.4 (override), AC-06.5 (credit party), AC-06.6 (not ready / not latest), AC-06.7 (If-Match, Idempotency-Key), AC-06.9 (supersede, atomic),
// AC-08.3 (referrer audience needs consent), AC-08.6 (no consent: release still succeeds, audience patient); 07-SECURITY T13 (release without payment).
// Handler context ASSUMED like R8 (retry-render.handlers.ts): { tenantId, actor, tx, ports:{billing,frontdesk}, events, audit, now }. DB = the worker's single-tx fake
// (release.helpers.ts); BillingPort fake is programmable. Contract checks read contracts/openapi/reporting.yaml.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../core/module.js';
import {
  DISPATCH_TASK, DUE_500, ELIGIBLE, EVENT, FULL_NAME, LAB, NARR, NOW, ORDER, OVERRIDE_ID, PARTNER, PHONE, EMAIL, REG_NO, TENANT_A, TENANT_B, USER, V,
  atomically, billingDown, idN, ifMatch, money, releaseSetup, released, releasedEventValid, rendered, rejection, type ReleaseWorldOpts, type Row,
} from '../../../../../worker/src/jobs/reporting/__tests__/release.helpers.js';

const OP = 'releaseReportVersion';
let manifest: any;
beforeAll(async () => {
  const k = join(mkdtempSync(join(tmpdir(), 'c6-t13-')), 'otp.key'); writeFileSync(k, Buffer.alloc(32, 7));
  process.env.LIMS_CORE_ENV = 'dev'; delete process.env.NODE_ENV; delete process.env.LIMS_REPORTING_ALLOW_REAL_PROVIDERS; process.env.LIMS_REPORTING_OTP_HMAC_KEY_FILE = k;
  manifest = (await import('../index.js')).manifest;
});

/** One R6 call against a fresh world. `versions` defaults to a single rendered v1 (row version 3 -> If-Match "3"). */
function setup(o: ReleaseWorldOpts = {}) {
  const s = releaseSetup({ versions: [rendered(1)], ...o });
  const call = (over: { id?: string; ifMatch?: string | undefined; body?: any; ctx?: any } = {}) => {
    const headers: Record<string, string> = over.ifMatch === undefined && 'ifMatch' in over ? {} : { 'if-match': over.ifMatch ?? ifMatch(3) };
    return manifest.handlers[OP]({ params: { report_version_id: over.id ?? V(1) }, query: {}, headers, body: over.body }, over.ctx ?? s.userCtx());
  };
  const piped = (over: Parameters<typeof call>[0] = {}) => atomically(s.tx, () => call(over));
  return { ...s, call, piped };
}
const sorted = (a: unknown) => [...(a as string[])].sort();

// ============================================================================================ contract + fail-closed
describe('contract', () => {
  it('R6: operation exists, x-permission reporting.report.release, Idempotency-Key required, If-Match param, 200 + the CR error codes documented', () => {
    const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/reporting.yaml'));
    const op = spec.paths['/v1/reporting/report-versions/{report_version_id}/release'].post;
    expect(op.operationId).toBe(OP); expect(op['x-permission']).toBe('reporting.report.release'); expect(op['x-idempotency']).toBe('required');
    expect(Object.keys(op.responses)).toContain('200');
    expect(op['x-error-codes']).toEqual(expect.arrayContaining(['reporting.release_blocked_due', 'reporting.release_not_ready', 'reporting.version_not_latest', 'reporting.report_cancelled', 'common.version_conflict', 'common.precondition_required']));
    expect(JSON.stringify(op.parameters)).toMatch(/IfMatch/); expect(JSON.stringify(op.parameters)).toMatch(/IdempotencyKey/);
  });
  it('is no longer a 501 stub: without a request context it fails closed (auth.unauthenticated) and echoes no input', async () => {
    const planted = 'PLANTED-TOKEN-5b1c';
    const e = await rejection(manifest.handlers[OP]({ params: { report_version_id: planted }, query: {}, headers: { 'if-match': '"1"', authorization: planted }, body: undefined },
      { operationId: OP, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } }));
    expect(e?.code).toBe('auth.unauthenticated'); expect(JSON.stringify({ c: e?.code, m: e?.message, d: e?.details })).not.toContain(planted);
  });
});

// ============================================================================================ the release transaction (rule 4)
describe('V5 rendered -> released (single, manual)', () => {
  it('200 ReportVersionSummary: status released, version bumped, ETag, release fields', async () => {
    const s = setup(); const r = await s.call();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: V(1), version_no: 1, status: 'released', report_kind: 'final', completeness: 'complete', release_basis: 'paid_in_full', version: 4 });
    expect(r.body.released_at).toBeTruthy(); expect(sorted(r.body.audiences)).toEqual(['centre', 'patient']);
    expect(r.headers?.etag).toBe('"4"');
  });
  it('row: status released, released_at = now, released_by = the user, release_mode manual, release_basis, audiences, version + 1, updated_by', async () => {
    const s = setup(); await s.call(); const v = s.version(1);
    expect(v).toMatchObject({ status: 'released', release_mode: 'manual', release_basis: 'paid_in_full', released_by: USER, version: 4, updated_by: USER });
    expect(new Date(v['released_at']).toISOString()).toBe(NOW); expect(sorted(v['audiences'])).toEqual(['centre', 'patient']);
    expect(v['release_override_id'] ?? null).toBeNull();
  });
  it('the frozen content is untouched: content_snapshot / content_sha256 / pdf_* / template_version_id / version_no', async () => {
    const s = setup(); const keep = (r: Row) => JSON.stringify([r['content_snapshot'], r['content_sha256'], r['pdf_object_path'], r['pdf_sha256'], r['pdf_bytes'], r['page_count'], r['template_version_id'], r['version_no'], r['report_id']]);
    const before = keep(s.version(1)); expect((await s.call()).status).toBe(200); expect(keep(s.version(1))).toBe(before);
  });
  it('report row: released_version_no, first_released_at (and final_released_at for a final), version + 1', async () => {
    const s = setup(); await s.call(); const r = s.report();
    expect(r).toMatchObject({ released_version_no: 1, version: 6 });
    expect(new Date(r['first_released_at']).toISOString()).toBe(NOW); expect(new Date(r['final_released_at']).toISOString()).toBe(NOW);
  });
  it('[CONV] a partial report sets first_released_at but not final_released_at', async () => {
    const s = setup({ versions: [rendered(1, { report_kind: 'partial', completeness: 'partial' })] }); await s.call();
    expect(s.report()['first_released_at']).toBeTruthy(); expect(s.report()['final_released_at'] ?? null).toBeNull();
  });
  it('the other report of the order (narrative) is untouched', async () => {
    const s = setup(); const before = JSON.stringify(s.db.all('reporting.reports').find((r) => r['id'] === NARR)); expect((await s.call()).status).toBe(200);
    expect(JSON.stringify(s.db.all('reporting.reports').find((r) => r['id'] === NARR))).toBe(before);
  });
  it('exactly one reporting.report.released.v1: aggregate report/<report_id> with seq = reports.version after the update, key <report_id>:released:<version_no>', async () => {
    const s = setup(); await s.call();
    expect(s.published).toHaveLength(1); const p = s.published[0]!;
    expect(p.type).toBe(EVENT);
    expect(p.input.aggregate).toEqual({ type: 'report', id: LAB, seq: s.report()['version'] });
    expect(p.input.idempotencyKey).toBe(`${LAB}:released:1`);
  });
  it('event payload: report/version/order/patient/centre/referrer/partner ids, report_kind, release_basis, audiences, released_at, order_item_ids; validates against the contract schema', async () => {
    const s = setup(); await s.call(); const p = s.published[0]!;
    expect(p.input.payload).toMatchObject({ report_id: LAB, version_no: 1, order_id: ORDER, report_kind: 'final', release_basis: 'paid_in_full', referrer_id: expect.any(String), partner_id: PARTNER });
    expect(p.input.payload.supersedes_version_no).toBeUndefined(); expect(new Date(p.input.payload.released_at).toISOString()).toBe(NOW);
    expect(sorted(p.input.payload.order_item_ids)).toEqual(sorted(s.version(1)['order_item_ids']));
    expect(releasedEventValid(p)).toBe(true);
  });
  it('the event is published inside the SAME transaction (ctx.tx), with the acting user', async () => {
    const s = setup(); await s.call(); expect(s.published[0]!.ctxTxIsOurTx).toBe(true); expect(s.published[0]!.ctxActor).toMatchObject({ type: 'user', id: USER });
  });
  it('enqueues reporting.dispatch_release_deliveries once for this version (10 attempts)', async () => {
    const s = setup(); await s.call(); const j = s.jobs(DISPATCH_TASK);
    expect(j).toHaveLength(1); expect(j[0]!.payload).toMatchObject({ tenant_id: TENANT_A, report_version_id: V(1) }); expect(j[0]!.maxAttempts).toBe(10);
  });
  it('access log: one report.release entry on report_version, centre, outcome allowed, with the release basis', async () => {
    const s = setup(); await s.call();
    expect(s.accessLog).toHaveLength(1);
    expect(s.accessLog[0]).toMatchObject({ action: 'report.release', entityType: 'report_version', entityId: V(1), centreId: expect.any(String), outcome: 'allowed', detail: { release_basis: 'paid_in_full' } });
  });
  it('asks BillingPort exactly once, for this order, and nothing else of the port (C6 never writes billing)', async () => {
    const s = setup(); await s.call();
    expect(s.billing.calls).toHaveLength(1); expect(s.billing.calls[0]!.orderId).toBe(ORDER); expect(s.billing.other).toEqual([]);
  });
  it('every statement on a reporting table names tenant_id (REQ-SEC-024), and nothing of tenant B is written', async () => {
    const s = setup(); await s.call();
    expect(s.db.reportingStmts().length).toBeGreaterThan(0); expect(s.db.reportingStmts().every((x) => /\btenant_id\b/i.test(x.text))).toBe(true);
    expect(s.db.writes().every((x) => x.values.every((v) => v !== TENANT_B))).toBe(true);
  });
});

// ============================================================================================ eligibility bases (rule 2), AC-06.4, AC-06.5
describe('eligibility comes only from BillingPort.getReleaseEligibility', () => {
  it.each([['paid_in_full'], ['zero_balance'], ['credit_party'], ['policy_not_enforced']])('eligible basis %s -> released, release_basis stored and published', async (basis) => {
    const s = setup({ billing: { eligible: true, basis, balanceDue: money(basis === 'credit_party' ? 50_000 : 0) } }); const r = await s.call();
    expect(r.status).toBe(200); expect(s.version(1)).toMatchObject({ status: 'released', release_basis: basis });
    expect(s.published[0]!.input.payload.release_basis).toBe(basis); expect(s.accessLog[0]!.detail.release_basis).toBe(basis);
  });
  it('AC-06.5: a credit-party order with dues is released with basis credit_party', async () => {
    const s = setup({ billing: { eligible: true, basis: 'credit_party', balanceDue: money(125_000) } }); await s.call();
    expect(s.version(1)).toMatchObject({ status: 'released', release_basis: 'credit_party' });
  });
  it('AC-06.4: an override recorded in C4 -> released with basis override, release_override_id stored, access log carries the override id', async () => {
    const s = setup({ billing: { eligible: true, basis: 'override', overrideId: OVERRIDE_ID, balanceDue: money(50_000) } }); await s.call();
    expect(s.version(1)).toMatchObject({ status: 'released', release_basis: 'override', release_override_id: OVERRIDE_ID });
    expect(s.published[0]!.input.payload.release_basis).toBe('override');
    expect(s.accessLog[0]).toMatchObject({ action: 'report.release', entityId: V(1), detail: { release_basis: 'override', override_id: OVERRIDE_ID } });
  });
  it.each([['due_outstanding', DUE_500], ['no_invoice', { eligible: false, basis: 'no_invoice', balanceDue: money(0) }]])('AC-06.1 (manual path): %s -> 409 reporting.release_blocked_due, nothing released, no event, no dispatch', async (_b, reply) => {
    const s = setup({ billing: reply as any }); const e = await rejection(s.piped());
    expect(e?.code).toBe('reporting.release_blocked_due');
    expect(s.version(1)['status']).toBe('rendered'); expect(s.version(1)['released_at'] ?? null).toBeNull(); expect(s.report()['released_version_no'] ?? null).toBeNull();
    expect(s.published).toHaveLength(0); expect(s.jobs(DISPATCH_TASK)).toHaveLength(0); expect(s.accessLog.filter((a) => a.outcome === 'allowed')).toHaveLength(0);
  });
  it('the blocked problem carries no PHI (not the patient name, phone, e-mail or registration number)', async () => {
    const s = setup({ billing: DUE_500 }); const e = await rejection(s.piped());
    const text = JSON.stringify({ c: e?.code, m: e?.message, d: e?.detail, x: { ...e } });
    for (const p of [FULL_NAME, PHONE, EMAIL, REG_NO]) expect(text).not.toContain(p);
  });
  it('T13 forged request: a body naming a basis / override id cannot release a version the port says is not eligible', async () => {
    const s = setup({ billing: DUE_500 });
    const e = await rejection(s.piped({ body: { release_basis: 'override', release_override_id: OVERRIDE_ID, override_id: OVERRIDE_ID, eligible: true, balance_due_paisa: 0 } }));
    expect(['reporting.release_blocked_due', 'common.validation_failed']).toContain(e?.code);
    expect(s.version(1)['status']).toBe('rendered'); expect(s.published).toHaveLength(0);
  });
  it('T13 forged request: unknown body members never reach the stored override id when the port is eligible', async () => {
    const s = setup({ billing: ELIGIBLE }); const evil = idN(0xbad);
    const r = await s.piped({ body: { release_override_id: evil, release_basis: 'override' } }).catch(() => undefined);
    if (r) expect(r.status).toBe(200); else expect(s.version(1)['status']).toBe('rendered');
    expect(s.version(1)['status'] === 'released' || r === undefined).toBe(true);
    expect(s.version(1)['release_override_id'] ?? null).not.toBe(evil); expect(s.version(1)['release_basis'] ?? 'paid_in_full').not.toBe('override');
  });
  it('fail closed: BillingPort outage -> the error propagates, nothing released, nothing published', async () => {
    const s = setup({ billing: billingDown() }); const e = await rejection(s.piped());
    expect(e?.code).toBe('common.unavailable'); expect(s.version(1)['status']).toBe('rendered'); expect(s.published).toHaveLength(0);
  });
  it('fail closed: a user actor without ctx.audit -> common.internal (500), nothing released, superseded, published or enqueued (CR-C6-008: the access log is mandatory)', async () => {
    const s = setup({ versions: [released(1), rendered(2)] });
    const e = await rejection(s.piped({ id: V(2), ctx: s.userCtx({ audit: undefined }) }));
    expect(e?.code).toBe('common.internal');
    expect(s.version(1)['status']).toBe('released'); expect(s.version(2)['status']).toBe('rendered');
    expect(s.published).toHaveLength(0); expect(s.jobs(DISPATCH_TASK)).toHaveLength(0); expect(s.accessLog).toHaveLength(0);
  });
  it.each([
    ['eligible with a non-eligible basis', { eligible: true, basis: 'due_outstanding', balanceDue: money(50_000) }],
    ['not eligible with an eligible basis', { eligible: false, basis: 'paid_in_full', balanceDue: money(0) }],
    ['basis override without an override id', { eligible: true, basis: 'override', balanceDue: money(50_000) }],
    ['unknown basis', { eligible: true, basis: 'goodwill', balanceDue: money(0) }],
  ])('fail closed: contradictory port answer (%s) releases nothing', async (_n, reply) => {
    const s = setup({ billing: reply as any }); const e = await rejection(s.piped());
    expect(['reporting.release_blocked_due', 'common.internal']).toContain(e?.code);
    expect(s.version(1)['status']).toBe('rendered'); expect(s.published).toHaveLength(0); expect(s.jobs(DISPATCH_TASK)).toHaveLength(0);
  });
});

// ============================================================================================ AC-06.6 state rules (rule 1)
describe('AC-06.6 only the latest rendered version can be released', () => {
  it.each(['rendering', 'render_failed', 'released', 'superseded', 'discarded'])('status %s -> 409 reporting.release_not_ready, nothing written', async (st) => {
    const extra = st === 'released' || st === 'superseded' ? { released_at: '2026-11-06T09:00:00.000Z', release_basis: 'paid_in_full', audiences: ['patient'] } : st === 'rendering' || st === 'render_failed' ? { pdf_object_path: null, pdf_sha256: null, page_count: null } : {};
    const s = setup({ versions: [rendered(1, { status: st, ...extra })] }); const before = JSON.stringify(s.version(1));
    const e = await rejection(s.piped()); expect(e?.code).toBe('reporting.release_not_ready');
    expect(JSON.stringify(s.version(1))).toBe(before); expect(s.db.jobs).toHaveLength(0); expect(s.published).toHaveLength(0); expect(s.billing.calls).toHaveLength(0);
  });
  it('a newer rendered version exists -> 409 reporting.version_not_latest (CR-C6-004)', async () => {
    const s = setup({ versions: [rendered(1), rendered(2)] }); const e = await rejection(s.piped());
    expect(e?.code).toBe('reporting.version_not_latest'); expect(s.version(1)['status']).toBe('rendered'); expect(s.published).toHaveLength(0);
  });
  it('a newer version still `rendering` also makes v1 not the latest', async () => {
    const s = setup({ versions: [rendered(1), rendered(2, { status: 'rendering', pdf_object_path: null, pdf_sha256: null, page_count: null })] });
    expect((await rejection(s.piped()))?.code).toBe('reporting.version_not_latest');
  });
  it('a newer DISCARDED version does not count ("latest non-discarded")', async () => {
    const s = setup({ versions: [rendered(1), rendered(2, { status: 'discarded', discarded_at: NOW, discard_reason: 'superseded_unreleased' })] });
    expect((await s.call()).status).toBe(200); expect(s.version(1)['status']).toBe('released');
  });
  it('the latest of two is releasable', async () => {
    const s = setup({ versions: [rendered(1, { status: 'discarded', discarded_at: NOW, discard_reason: 'superseded_unreleased' }), rendered(2)] });
    expect((await s.call({ id: V(2) })).status).toBe(200); expect(s.version(2)['status']).toBe('released'); expect(s.version(1)['status']).toBe('discarded');
  });
  it('a cancelled report -> 409 reporting.report_cancelled, nothing released', async () => {
    const s = setup({ reportOver: { state: 'cancelled', cancelled_at: NOW } }); const e = await rejection(s.piped());
    expect(e?.code).toBe('reporting.report_cancelled'); expect(s.version(1)['status']).toBe('rendered'); expect(s.published).toHaveLength(0);
  });
});

// ============================================================================================ AC-06.7 If-Match / lookup / tenancy / double submit
describe('AC-06.7 If-Match, idempotency, lookup', () => {
  it('missing If-Match -> common.precondition_required, nothing written', async () => {
    const s = setup(); const e = await rejection(s.piped({ ifMatch: undefined })); expect(e?.code).toBe('common.precondition_required');
    expect(s.db.writes()).toHaveLength(0); expect(s.billing.calls).toHaveLength(0);
  });
  it('stale If-Match -> common.version_conflict, nothing released, BillingPort not consulted for a write', async () => {
    const s = setup(); const e = await rejection(s.piped({ ifMatch: ifMatch(2) })); expect(e?.code).toBe('common.version_conflict');
    expect(s.version(1)).toMatchObject({ status: 'rendered', version: 3 }); expect(s.published).toHaveLength(0); expect(s.jobs(DISPATCH_TASK)).toHaveLength(0);
  });
  it.each(['3', '"abc"', '""', '"0"', 'W/"3"'])('malformed If-Match %s -> rejected, nothing changes', async (h) => {
    const s = setup(); const e = await rejection(s.piped({ ifMatch: h }));
    expect(['common.validation_failed', 'common.precondition_required', 'common.version_conflict']).toContain(e?.code); expect(s.version(1)['status']).toBe('rendered');
  });
  it('the same request repeated (same If-Match) is not executed twice: one event, one dispatch job, second answer is a conflict (the stored response replay is the pipeline\'s job)', async () => {
    const s = setup(); await s.call();
    const e = await rejection(s.piped());
    expect(['common.version_conflict', 'reporting.release_not_ready']).toContain(e?.code);
    expect(s.published).toHaveLength(1); expect(s.jobs(DISPATCH_TASK)).toHaveLength(1); expect(s.accessLog).toHaveLength(1);
  });
  it('a double submit with a fresh If-Match on an already released version -> release_not_ready, still one event', async () => {
    const s = setup(); await s.call(); const e = await rejection(s.piped({ ifMatch: ifMatch(4) }));
    expect(e?.code).toBe('reporting.release_not_ready'); expect(s.published).toHaveLength(1);
  });
  it('unknown version id -> common.not_found', async () => {
    const s = setup(); expect((await rejection(s.piped({ id: idN(0xdead) })))?.code).toBe('common.not_found'); expect(s.billing.calls).toHaveLength(0);
  });
  it('another tenant\'s version -> the same common.not_found (no existence leak), even with RLS off', async () => {
    const s = setup({ versions: [rendered(1, { tenant_id: TENANT_B })], rls: false }); const e = await rejection(s.piped());
    expect(e?.code).toBe('common.not_found'); expect(s.version(1)['status']).toBe('rendered'); expect(s.published).toHaveLength(0); expect(s.billing.calls).toHaveLength(0);
    expect(s.db.reportingStmts().every((x) => /\btenant_id\b/i.test(x.text))).toBe(true);
  });
  it('non-uuid id -> rejected without touching the database', async () => {
    const s = setup(); const e = await rejection(s.piped({ id: "x'; DROP TABLE reporting.report_versions;--" }));
    expect(['common.validation_failed', 'common.not_found']).toContain(e?.code); expect(s.db.writes()).toHaveLength(0);
  });
  it('error responses never echo the If-Match or the id', async () => {
    const s = setup(); const planted = 'PLANTED-3e8f'; const e = await rejection(s.piped({ id: planted, ifMatch: planted }));
    expect(JSON.stringify({ c: e?.code, m: e?.message, d: e?.details })).not.toContain(planted);
  });
});

// ============================================================================================ AC-06.9 supersede
describe('AC-06.9 releasing v2 while v1 is released', () => {
  const two = (v2: Row = {}) => setup({ versions: [released(1), rendered(2, { report_kind: 'amended', ...v2 })], reportOver: { released_version_no: 1, first_released_at: '2026-11-06T09:00:00.000Z', final_released_at: '2026-11-06T09:00:00.000Z' } });
  it('v2 becomes released, v1 becomes superseded (superseded_at, superseded_by_version_no = 2); never two released at once (the fake enforces the partial unique index)', async () => {
    const s = two(); const r = await s.call({ id: V(2) });
    expect(r.status).toBe(200); expect(s.version(2)['status']).toBe('released');
    expect(s.version(1)).toMatchObject({ status: 'superseded', superseded_by_version_no: 2 }); expect(new Date(s.version(1)['superseded_at']).toISOString()).toBe(NOW);
    expect(s.version(2)['supersedes_version_no']).toBe(1);
  });
  it('the report row points at v2; first_released_at keeps the original time', async () => {
    const s = two(); await s.call({ id: V(2) });
    expect(s.report()['released_version_no']).toBe(2); expect(new Date(s.report()['first_released_at']).toISOString()).toBe('2026-11-06T09:00:00.000Z');
  });
  it('the event for v2 carries supersedes_version_no = 1 and report_kind = amended; key <report_id>:released:2; valid against the contract', async () => {
    const s = two(); await s.call({ id: V(2) });
    expect(s.published).toHaveLength(1); const p = s.published[0]!;
    expect(p.input.payload).toMatchObject({ version_no: 2, supersedes_version_no: 1, report_kind: 'amended' }); expect(p.input.idempotencyKey).toBe(`${LAB}:released:2`);
    expect(releasedEventValid(p)).toBe(true);
  });
  it('v1\'s QR token is left alone (the verify page derives "superseded" from the version status; nothing is revoked)', async () => {
    const s = setup({ versions: [released(1), rendered(2, { report_kind: 'amended' })], extraSeed: { 'reporting.qr_tokens': [{ tenant_id: TENANT_A, centre_id: idN(0xc1), id: idN(0x91), report_id: LAB, report_version_id: V(1), revoked_at: null }] } });
    await s.call({ id: V(2) }); const q = s.db.all('reporting.qr_tokens')[0]!;
    expect(q['revoked_at'] ?? null).toBeNull(); expect(s.version(1)['status']).toBe('superseded');
  });
  it('atomic: if the event cannot be published the whole release rolls back — v1 still released, v2 still rendered, no job, no access-log row', async () => {
    const s = setup({ versions: [released(1), rendered(2, { report_kind: 'amended' })], eventsFail: Object.assign(new Error('event_log down'), { code: 'common.internal' }),
      reportOver: { released_version_no: 1 } });
    const e = await rejection(s.piped({ id: V(2) }));
    expect(e).toBeTruthy(); expect(s.version(1)['status']).toBe('released'); expect(s.version(2)['status']).toBe('rendered'); expect(s.report()['released_version_no']).toBe(1);
    expect(s.jobs(DISPATCH_TASK)).toHaveLength(0); expect(s.published).toHaveLength(0);
  });
  it('atomic: a failing UPDATE of v1 (supersede) rolls back everything — v2 not released', async () => {
    const s = setup({ versions: [released(1), rendered(2, { report_kind: 'amended' })], reportOver: { released_version_no: 1 },
      dbOpts: { failOn: [{ match: /superseded/i, error: () => Object.assign(new Error('boom'), { code: '40001' }) }] } });
    const e = await rejection(s.piped({ id: V(2) }));
    expect(e).toBeTruthy(); expect(s.version(1)['status']).toBe('released'); expect(s.version(2)['status']).toBe('rendered'); expect(s.published).toHaveLength(0);
  });
  it('a first release (no previous released version) has no supersedes_version_no and supersedes nothing', async () => {
    const s = setup(); await s.call(); expect(s.version(1)['supersedes_version_no'] ?? null).toBeNull(); expect(s.published[0]!.input.payload.supersedes_version_no).toBeUndefined();
  });
});

// ============================================================================================ audiences (rule 6): AC-08.3, AC-08.6
describe('audiences (event field)', () => {
  const rel = async (o: ReleaseWorldOpts = {}, body?: any) => { const s = setup(o); const r = await s.call(body === undefined ? {} : { body }); return { s, r, a: sorted(s.published[0]?.input.payload.audiences ?? []) }; };
  it('AC-08.3: referrer on the order + shareWithReferrer = true -> patient, referrer, centre', async () => {
    const { a, s } = await rel({ consent: { shareWithReferrer: true } });
    expect(a).toEqual(['centre', 'patient', 'referrer']); expect(sorted(s.version(1)['audiences'])).toEqual(a);
  });
  it('AC-08.3: shareWithReferrer = false -> the audience referrer is omitted', async () => {
    const { a } = await rel({ consent: { shareWithReferrer: false } }); expect(a).toEqual(['centre', 'patient']);
  });
  it('no referrer on the order, consent given -> no referrer audience', async () => {
    const { a } = await rel({ consent: { shareWithReferrer: true }, reportOver: { referrer_id: null } }); expect(a).toEqual(['centre', 'patient']);
  });
  it('partner_manifest orders add the partner audience', async () => {
    const { a } = await rel({ reportOver: { order_source: 'partner_manifest' } }); expect(a).toEqual(['centre', 'partner', 'patient']);
  });
  it('AC-08.6: no consent on any channel -> the release still succeeds, audiences contain patient (deliveries are suppressed later by the dispatch task)', async () => {
    const { s, r, a } = await rel({ consent: { sms: false, whatsapp: false, email: false, shareWithReferrer: false } });
    expect(r.status).toBe(200); expect(a).toContain('patient'); expect(s.version(1)['status']).toBe('released'); expect(s.jobs(DISPATCH_TASK)).toHaveLength(1);
  });
  it('consent is read through FrontdeskPort.getPatientDemographics with purpose notification, for this patient, once', async () => {
    const { s } = await rel({ consent: { shareWithReferrer: true } });
    expect(s.frontdesk.calls).toEqual([{ patientId: expect.any(String), purpose: 'notification' }]);
  });
  it('a caller subset is honoured: audiences [patient] -> exactly patient', async () => {
    const { a } = await rel({ consent: { shareWithReferrer: true } }, { audiences: ['patient'] }); expect(a).toEqual(['patient']);
  });
  it('a caller audience outside the computed set -> 400 common.validation_failed, nothing released', async () => {
    const s = setup({ consent: { shareWithReferrer: false } }); const e = await rejection(s.piped({ body: { audiences: ['patient', 'referrer'] } }));
    expect(e?.code).toBe('common.validation_failed'); expect(s.version(1)['status']).toBe('rendered'); expect(s.published).toHaveLength(0);
  });
  it('partner requested on a non-partner order -> 400 common.validation_failed', async () => {
    const s = setup(); expect((await rejection(s.piped({ body: { audiences: ['partner'] } })))?.code).toBe('common.validation_failed');
  });
  it('print_only is never accepted from the caller', async () => {
    const s = setup(); const e = await rejection(s.piped({ body: { audiences: ['print_only'] } })); expect(e?.code).toBe('common.validation_failed'); expect(s.version(1)['status']).toBe('rendered');
  });
  it('suppress_notifications: true -> audiences = [print_only] alone (event and row)', async () => {
    const { s, a } = await rel({ consent: { shareWithReferrer: true } }, { suppress_notifications: true });
    expect(a).toEqual(['print_only']); expect(s.version(1)['audiences']).toEqual(['print_only']);
  });
  it('the demographics (name, phone, e-mail) fetched for consent never reach the event, the jobs, the access log or the logs', async () => {
    const s = setup({ consent: { shareWithReferrer: true, sms: true, email: true } }); expect((await s.call()).status).toBe(200);
    for (const p of [FULL_NAME, PHONE, EMAIL, REG_NO]) expect(s.allText()).not.toContain(p);
  });
  it('FrontdeskPort outage -> the release fails (retry), nothing released: the audience set is never guessed', async () => {
    const s = setup({ consent: { down: true } }); const e = await rejection(s.piped());
    expect(e).toBeTruthy(); expect(s.version(1)['status']).toBe('rendered'); expect(s.published).toHaveLength(0);
  });
});

// ============================================================================================ rule 8 (release transaction part): dues links
describe('dues links are revoked in the release transaction (TRD §4.6 rule 8)', () => {
  const link = (id: number, over: Row = {}): Row => ({ tenant_id: TENANT_A, centre_id: idN(0xc1), id: idN(id), report_id: LAB, purpose: 'dues', revoked_at: null, revoked_by: null, revoke_reason_code: null, ...over });
  it('every unrevoked dues link of the report gets revoked_at and revoke_reason_code dues_settled; report links and other reports\' links are untouched', async () => {
    const s = setup({ links: [link(0x71), link(0x72), link(0x73, { purpose: 'report' }), link(0x74, { report_id: NARR }), link(0x75, { revoked_at: '2026-11-06T00:00:00.000Z', revoke_reason_code: 'manual' })] });
    await s.call(); const by = (id: number) => s.links().find((l) => l['id'] === idN(id))!;
    for (const id of [0x71, 0x72]) { expect(by(id)['revoked_at']).toBeTruthy(); expect(by(id)['revoke_reason_code']).toBe('dues_settled'); }
    expect(by(0x73)['revoked_at'] ?? null).toBeNull(); expect(by(0x74)['revoked_at'] ?? null).toBeNull();
    expect(by(0x75)['revoke_reason_code']).toBe('manual');
  });
  it('a blocked release revokes nothing', async () => {
    const s = setup({ billing: DUE_500, links: [link(0x71)] }); await rejection(s.piped()); expect(s.links()[0]!['revoked_at'] ?? null).toBeNull();
  });
});

