// C6-T14 — R7 POST /report-versions/bulk-release (operationId bulkReleaseReportVersions; 02-TRD §4.6 rule 7, §6.3 R7; 03-APP-FLOW V5, E5).
// ACs: AC-07.1 (150 ids / 20 dues -> 130 released, 20 blocked_due, 130 events), AC-07.2 (201 -> 400; bulk_release_max 100 + 101 -> 422), AC-07.3 (other tenant / centre -> not_found per
// item), AC-07.4 (aal2 -> auth.mfa_required). 07-SECURITY A7, T7, T13, REQ-SEC-040/044/100. The 200-id load target is bulk-release.load.test.ts.
// Context shape and the savepoint/assertRole assumptions: bulk-release.helpers.ts header + .orchestra/notes/C6-T14-tests.md. DB = single-tx in-memory fake; real RLS is a DB test.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../core/module.js';
import { EMAIL, FULL_NAME, PHONE, REG_NO, releasedEventValid, rejection } from '../../../../../worker/src/jobs/reporting/__tests__/release.helpers.js';
import {
  CENTRE_A, CENTRE_B, DUE_500, EVENT, OID, OP, PERMISSION, REL, RID, TENANT_A, TENANT_B, USER, V2, VID, bulkSetup, callBulk, countBy, idN, idsOf, many, outcomes, type BulkOpts, type Row,
} from './bulk-release.helpers.js';

let manifest: any;
beforeAll(async () => {
  const k = join(mkdtempSync(join(tmpdir(), 'c6-t14-')), 'otp.key'); writeFileSync(k, Buffer.alloc(32, 7));
  process.env.LIMS_CORE_ENV = 'dev'; delete process.env.NODE_ENV; delete process.env.LIMS_REPORTING_ALLOW_REAL_PROVIDERS; process.env.LIMS_REPORTING_OTP_HMAC_KEY_FILE = k;
  manifest = (await import('../index.js')).manifest;
}, 90_000);
const setup = (o: Partial<BulkOpts> & { n?: number } = {}) => bulkSetup({ items: many(o.n ?? 3), ...o });
const run = (s: ReturnType<typeof setup>, ids: string[], ctx?: Row) => callBulk(manifest, s, { ids }, ctx);
const nothingHappened = (s: ReturnType<typeof setup>) => {
  expect(s.db.writes()).toHaveLength(0); expect(s.published).toHaveLength(0); expect(s.jobs()).toHaveLength(0); expect(s.access).toHaveLength(0); expect(s.billing.calls).toHaveLength(0);
};
const readRepo = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

// ============================================================================================ contract + fail-closed
describe('contract', () => {
  it('R7: operation exists, x-permission reporting.report.bulk_release, Idempotency-Key required, body ids 1..200 unique uuids, 422/mfa codes documented', () => {
    const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/reporting.yaml'));
    const op = spec.paths['/v1/reporting/report-versions/bulk-release'].post;
    expect(op.operationId).toBe(OP); expect(op['x-permission']).toBe(PERMISSION); expect(op['x-idempotency']).toBe('required');
    const ids = op.requestBody.content['application/json'].schema.properties.ids;
    expect(ids).toMatchObject({ type: 'array', minItems: 1, maxItems: 200, uniqueItems: true });
    expect(op['x-error-codes']).toEqual(expect.arrayContaining(['common.validation_failed', 'reporting.bulk_release_too_large', 'auth.mfa_required', 'auth.forbidden', 'common.idempotency_key_reused']));
  });
  it('REQ-SEC-100: the permission is privileged (aal2 at the pipeline) and held by pathologist + lab_manager only; the 422 code is registered as 422', () => {
    expect(readRepo('contracts/permissions.yaml')).toMatch(/code:\s*reporting\.report\.bulk_release,\s*privileged:\s*true,\s*roles:\s*\[pathologist,\s*lab_manager\]/);
    expect(readRepo('contracts/errors.yaml')).toMatch(/code:\s*reporting\.bulk_release_too_large,\s*http:\s*422/);
  });
  it('is no longer a 501 stub: without a request context it fails closed (auth.unauthenticated) and echoes no input', async () => {
    const planted = 'PLANTED-TOKEN-7d2e';
    const e = await rejection(manifest.handlers[OP]({ params: {}, query: {}, headers: { authorization: planted }, body: { ids: [planted] } }, { operationId: OP, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } }));
    expect(e?.code).toBe('auth.unauthenticated'); expect(JSON.stringify({ c: e?.code, m: e?.message, d: e?.details })).not.toContain(planted);
  });
});

// ============================================================================================ AC-07.1
describe('AC-07.1 150 selected rendered versions, 20 with dues', () => {
  const dues = Array.from({ length: 20 }, (_, k) => k * 7 + 3);    // 20 distinct report numbers in 1..150
  const go = async () => { const s = bulkSetup({ items: many(150), dues }); const r = await run(s, idsOf(150)); return { s, r }; };
  it('200 with 130 released, 20 blocked_due, one result per id in request order', async () => {
    const { r } = await go();
    expect(r.status).toBe(200); expect(r.body.results).toHaveLength(150);
    expect(r.body.results.map((x: any) => x.id)).toEqual(idsOf(150));
    expect(countBy(r, 'released')).toBe(130); expect(countBy(r, 'blocked_due')).toBe(20);
    for (const x of r.body.results) {
      if (x.outcome === 'released') expect(x).toEqual({ id: x.id, outcome: 'released', release_basis: 'paid_in_full' });
      else expect(x).toEqual({ id: x.id, outcome: 'blocked_due' });                      // no basis, no balance, nothing about the patient
    }
  });
  it('the 20 with dues are exactly the ones held back (rows untouched), the 130 are released with release_mode bulk by the acting user', async () => {
    const { s } = await go(); const dueIds = new Set(dues.map(OID));
    for (let i = 1; i <= 150; i++) {
      const v = s.version(i);
      if (dueIds.has(OID(i))) expect(v).toMatchObject({ status: 'rendered', version: 3 });
      else expect(v).toMatchObject({ status: 'released', release_mode: 'bulk', release_basis: 'paid_in_full', released_by: USER, version: 4, updated_by: USER });
    }
    expect(s.db.all('reporting.report_versions').filter((v) => v['status'] === 'released')).toHaveLength(130);
  });
  it('130 reporting.report.released.v1 events, one per released version: aggregate report/<id>, key <report_id>:released:1, same tx, user actor, valid against the contract', async () => {
    const { s } = await go(); expect(s.published).toHaveLength(130);
    expect(new Set(s.published.map((p) => p.input.idempotencyKey)).size).toBe(130);
    for (const p of s.published) {
      expect(p.type).toBe(EVENT); expect(p.ctxTxIsOurTx).toBe(true); expect(p.ctxActor).toMatchObject({ type: 'user', id: USER });
      expect(p.input.idempotencyKey).toBe(`${p.input.aggregate.id}:released:1`); expect(p.input.aggregate.type).toBe('report');
      expect(releasedEventValid(p as any)).toBe(true);
    }
  });
  it('130 dispatch jobs (one per released version, 10 attempts) and 130 report.release access-log entries; none for the held ones', async () => {
    const { s } = await go(); expect(s.jobs()).toHaveLength(130);
    expect(new Set(s.jobs().map((j) => j.payload.report_version_id)).size).toBe(130); expect(s.jobs().every((j) => j.maxAttempts === 10 && j.payload.tenant_id === TENANT_A)).toBe(true);
    expect(s.access).toHaveLength(130); expect(s.access.every((a) => a.action === 'report.release' && a.entityType === 'report_version' && a.outcome === 'allowed' && a.centreId === CENTRE_A)).toBe(true);
    const held = new Set(dues.map((d) => VID(d))); expect(s.access.some((a) => held.has(a.entityId))).toBe(false);
  });
  it('BillingPort is asked once per id for that id\'s own order and nothing else of it; C6 writes no billing data', async () => {
    const { s } = await go(); expect(s.billing.calls).toHaveLength(150);
    expect(s.billing.calls.map((c) => c.orderId).sort()).toEqual(Array.from({ length: 150 }, (_, k) => OID(k + 1)).sort()); expect(s.billing.other).toEqual([]);
  });
  it('rule 7: every id runs in its own savepoint (one per id on top of the pipeline\'s) — the held ones too', async () => {
    const { s } = await go(); expect(s.tx.savepoints - 1).toBeGreaterThanOrEqual(150);
  });
  it('every statement on a reporting table names tenant_id (REQ-SEC-024)', async () => {
    const { s } = await go(); expect(s.db.reportingStmts().length).toBeGreaterThan(0); expect(s.db.reportingStmts().every((x) => /\btenant_id\b/i.test(x.text))).toBe(true);
  });
  it('the report rows point at the released version (released_version_no, first_released_at, final_released_at, version + 1)', async () => {
    const { s } = await go(); expect(s.report(1)).toMatchObject({ released_version_no: 1, version: 6 }); expect(s.report(1)['first_released_at']).toBeTruthy(); expect(s.report(1)['final_released_at']).toBeTruthy();
    expect(s.report(3)['released_version_no'] ?? null).toBeNull();                       // held (dues)
  });
  it('no If-Match is needed (rows are at version 3) and auto_release = manual does not stop an explicit bulk release', async () => {
    const s = bulkSetup({ items: many(3), autoRelease: 'manual' }); const r = await run(s, idsOf(3)); expect(countBy(r, 'released')).toBe(3);
  });
  it('the second identical call releases nothing more: all already_released, still one event per version', async () => {
    const s = setup({ n: 5 }); await run(s, idsOf(5)); const r = await run(s, idsOf(5));
    expect(r.status).toBe(200); expect(countBy(r, 'already_released')).toBe(5); expect(s.published).toHaveLength(5); expect(s.jobs()).toHaveLength(5); expect(s.access).toHaveLength(5);
  });
  it('eligibility bases: credit_party and policy_not_enforced release; an override stores its id; no_invoice is blocked_due', async () => {
    const s = setup({ n: 4, billing: (o) => (o === OID(1) ? { eligible: true, basis: 'credit_party', balanceDue: { amountPaisa: 50_000, currency: 'NPR' } }
      : o === OID(2) ? { eligible: true, basis: 'override', overrideId: idN(0x0ee1), balanceDue: { amountPaisa: 50_000, currency: 'NPR' } }
      : o === OID(3) ? { eligible: true, basis: 'policy_not_enforced', balanceDue: { amountPaisa: 0, currency: 'NPR' } }
      : { eligible: false, basis: 'no_invoice', balanceDue: { amountPaisa: 0, currency: 'NPR' } }) });
    const r = await run(s, idsOf(4));
    expect(r.body.results).toEqual([{ id: VID(1), outcome: 'released', release_basis: 'credit_party' }, { id: VID(2), outcome: 'released', release_basis: 'override' },
      { id: VID(3), outcome: 'released', release_basis: 'policy_not_enforced' }, { id: VID(4), outcome: 'blocked_due' }]);
    expect(s.version(2)).toMatchObject({ release_basis: 'override', release_override_id: idN(0x0ee1) }); expect(s.version(1)['release_override_id'] ?? null).toBeNull();
    expect(s.access.find((a) => a.entityId === VID(2))?.detail).toMatchObject({ release_basis: 'override', override_id: idN(0x0ee1) });
  });
});

// ============================================================================================ rule 7: every other per-id outcome (rules 1-6 per id)
describe('per-id outcomes (rules 1-6 applied per id)', () => {
  const nr = { pdf_object_path: null, pdf_sha256: null, page_count: null };
  it('not_ready / already_released / not_latest / cancelled / not_found / blocked_due / released side by side; nothing changes for the non-released', async () => {
    const s = bulkSetup({ dues: [7], items: [
      {},                                                                                                       // 1 released
      { versions: [{ status: 'rendering', ...nr }], reportOver: { _i: 2 } },                                    // 2 not_ready
      { versions: [{ status: 'render_failed', ...nr }], reportOver: { _i: 3 } },                                // 3 not_ready
      { versions: [{ ...REL }], reportOver: { _i: 4, released_version_no: 1 } },                               // 4 already_released
      { versions: [{}, { version_no: 2 }], reportOver: { _i: 5, latest_version_no: 2 } },                      // 5 v1 is not the latest (v2 rendered exists)
      { reportOver: { _i: 6, state: 'cancelled', cancelled_at: '2026-11-07T08:00:00.000Z' } },                 // 6 cancelled
      { reportOver: { _i: 7 } },                                                                                // 7 dues
      { versions: [{ status: 'discarded', discarded_at: '2026-11-07T08:00:00.000Z', discard_reason: 'superseded_unreleased' }], reportOver: { _i: 8 } },   // 8 not_ready
      { versions: [{ ...REL, status: 'superseded', superseded_at: '2026-11-07T08:00:00.000Z', superseded_by_version_no: 2 }, { ...REL, version_no: 2 }], reportOver: { _i: 9, latest_version_no: 2, released_version_no: 2 } },   // 9 v1 superseded
    ] });
    const ghost = idN(0xdead00); const ids = [...idsOf(9), ghost];
    const before = [2, 3, 4, 6, 7, 8].map((i) => JSON.stringify(s.version(i)));
    const r = await run(s, ids);
    expect(r.status).toBe(200);
    expect(outcomes(r)).toEqual({ [VID(1)]: 'released', [VID(2)]: 'not_ready', [VID(3)]: 'not_ready', [VID(4)]: 'already_released', [VID(5)]: 'not_latest', [VID(6)]: 'cancelled',
      [VID(7)]: 'blocked_due', [VID(8)]: 'not_ready', [VID(9)]: 'not_ready', [ghost]: 'not_found' });
    expect([2, 3, 4, 6, 7, 8].map((i) => JSON.stringify(s.version(i)))).toEqual(before);
    expect(s.published).toHaveLength(1); expect(s.jobs()).toHaveLength(1); expect(s.access).toHaveLength(1);
    expect(s.billing.calls.map((c) => c.orderId)).not.toContain(OID(2));              // rule 1 is decided before BillingPort is consulted (as R6)
  });
  it('a newer rendered v2 of a report whose v1 is released: v2 is released, v1 becomes superseded in the same savepoint, event carries supersedes_version_no', async () => {
    const s = bulkSetup({ items: [{ versions: [{ ...REL }, { version_no: 2, report_kind: 'amended' }], reportOver: { latest_version_no: 2, released_version_no: 1, first_released_at: '2026-11-06T09:00:00.000Z', final_released_at: '2026-11-06T09:00:00.000Z' } }] });
    const r = await run(s, [V2(1)]);
    expect(r.body.results).toEqual([{ id: V2(1), outcome: 'released', release_basis: 'paid_in_full' }]);
    const vs = s.db.all('reporting.report_versions'); expect(vs.find((v) => v['version_no'] === 1)).toMatchObject({ status: 'superseded', superseded_by_version_no: 2 });
    expect(vs.find((v) => v['version_no'] === 2)).toMatchObject({ status: 'released', supersedes_version_no: 1, release_mode: 'bulk' });
    expect(s.report(1)['released_version_no']).toBe(2); expect(s.published[0]!.input.payload).toMatchObject({ version_no: 2, supersedes_version_no: 1, report_kind: 'amended' });
    expect(releasedEventValid(s.published[0] as any)).toBe(true);
  });
  it('AC-08.3 / 08.6 audiences are computed per id: referrer + consent -> patient, referrer, centre; no consent -> release still succeeds', async () => {
    const referrer = idN(0xaf);
    const yes = bulkSetup({ items: [{ reportOver: { referrer_id: referrer } }, {}], consent: { shareWithReferrer: true } }); await run(yes, idsOf(2));
    expect([...yes.published[0]!.input.payload.audiences].sort()).toEqual(['centre', 'patient', 'referrer']); expect([...yes.published[1]!.input.payload.audiences].sort()).toEqual(['centre', 'patient']);
    expect(yes.frontdesk.calls).toEqual([{ patientId: expect.any(String), purpose: 'notification' }]);
    const no = bulkSetup({ items: [{ reportOver: { referrer_id: referrer } }], consent: { shareWithReferrer: false } }); const r = await run(no, idsOf(1));
    expect(countBy(r, 'released')).toBe(1); expect([...no.published[0]!.input.payload.audiences].sort()).toEqual(['centre', 'patient']);
  });
  it('R7 takes no audiences / suppress_notifications / basis / override members (additionalProperties false): rejected, nothing released', async () => {
    for (const extra of [{ audiences: ['patient'] }, { suppress_notifications: true }, { release_basis: 'override' }, { override_id: idN(1) }, { eligible: true }]) {
      const s = setup(); const e = await rejection(callBulk(manifest, s, { ids: idsOf(2), ...extra })); expect(e?.code).toBe('common.validation_failed'); nothingHappened(s);
    }
  });
  it('PHI never leaves the transaction: no name, phone, e-mail or registration number in the response, events, jobs or access log', async () => {
    const s = bulkSetup({ items: [{ reportOver: { referrer_id: idN(0xaf), patient_display_name: FULL_NAME } }], consent: { shareWithReferrer: true, sms: true, email: true }, dues: [] });
    const r = await run(s, idsOf(1)); for (const p of [FULL_NAME, PHONE, EMAIL, REG_NO]) { expect(JSON.stringify(r.body)).not.toContain(p); expect(s.allText()).not.toContain(p); }
    const d = bulkSetup({ items: many(2), dues: [1, 2] }); const rd = await run(d, idsOf(2)); expect(JSON.stringify(rd.body)).not.toMatch(/balance|paisa|amount|due_outstanding/i);
  });
});

// ============================================================================================ AC-07.2
describe('AC-07.2 request size and the tenant limit', () => {
  it('201 ids -> 400 common.validation_failed (spec maxItems 200); nothing consulted, nothing written', async () => {
    const s = setup({ n: 1 }); const e = await rejection(run(s, idsOf(201))); expect(e?.code).toBe('common.validation_failed'); nothingHappened(s);
  });
  it('bulk_release_max = 100 and 101 ids -> 422 reporting.bulk_release_too_large; nothing consulted, nothing written, no id echoed', async () => {
    const s = bulkSetup({ items: many(101), maxSetting: 100 }); const e = await rejection(run(s, idsOf(101)));
    expect(e?.code).toBe('reporting.bulk_release_too_large'); nothingHappened(s);
    expect(JSON.stringify({ c: e?.code, m: e?.message, d: e?.details, x: { ...e } })).not.toContain(VID(1));
  });
  it('exactly bulk_release_max (100) ids are processed', async () => {
    const s = bulkSetup({ items: many(100), maxSetting: 100 }); const r = await run(s, idsOf(100)); expect(countBy(r, 'released')).toBe(100);
  });
  it('the limit counts requested ids, not found ones: 101 ids of which 90 do not exist -> still 422', async () => {
    const s = bulkSetup({ items: many(11), maxSetting: 100 }); const e = await rejection(run(s, idsOf(101))); expect(e?.code).toBe('reporting.bulk_release_too_large'); nothingHappened(s);
  });
  it('201 ids with bulk_release_max = 100 -> 400 (the spec maximum is checked before the tenant limit)', async () => {
    const s = bulkSetup({ items: many(1), maxSetting: 100 }); expect((await rejection(run(s, idsOf(201))))?.code).toBe('common.validation_failed'); nothingHappened(s);
  });
  it('bulk_release_max = 1: one id passes, two ids -> 422', async () => {
    const one = bulkSetup({ items: many(2), maxSetting: 1 }); expect(countBy(await run(one, idsOf(1)), 'released')).toBe(1);
    const two = bulkSetup({ items: many(2), maxSetting: 1 }); expect((await rejection(run(two, idsOf(2))))?.code).toBe('reporting.bulk_release_too_large'); nothingHappened(two);
  });
  it('no settings row -> the default 200 applies (101 ids are fine)', async () => {
    const s = bulkSetup({ items: many(101), maxSetting: null }); expect(countBy(await run(s, idsOf(101)), 'released')).toBe(101);
  });
  it('the limit is read for this tenant only: the settings statement binds tenant_id', async () => {
    const s = bulkSetup({ items: many(2), maxSetting: 100 }); await run(s, idsOf(2));
    const st = s.db.stmts.filter((x) => /reporting\.settings/i.test(x.text)); expect(st.length).toBeGreaterThan(0); expect(st.every((x) => /\btenant_id\b/i.test(x.text) && x.values.includes(TENANT_A))).toBe(true);
  });
  it.each([
    ['no body', undefined], ['null body', null], ['array body', [VID(1)]], ['string body', 'x'], ['empty object', {}], ['ids not an array', { ids: VID(1) }], ['empty ids', { ids: [] }],
    ['duplicate ids', { ids: [VID(1), VID(1)] }], ['non-uuid id', { ids: ['not-a-uuid'] }], ['number id', { ids: [1] }], ['null id', { ids: [null] }],
    ['SQL in an id', { ids: ["x'; DROP TABLE reporting.report_versions;--"] }], ['unknown member', { ids: [VID(1)], all: true }],
  ])('bad body (%s) -> 400 common.validation_failed, nothing consulted or written', async (_n, body) => {
    const s = setup(); const e = await rejection(callBulk(manifest, s, body)); expect(e?.code).toBe('common.validation_failed'); nothingHappened(s);
  });
  it('a rejected request never echoes the planted input', async () => {
    const s = setup(); const planted = 'PLANTED-9a4c'; const e = await rejection(callBulk(manifest, s, { ids: [planted] }));
    expect(JSON.stringify({ c: e?.code, m: e?.message, d: e?.details, x: { ...e } })).not.toContain(planted);
  });
});

// ============================================================================================ AC-07.3 / 07-SECURITY A7, T7
describe('AC-07.3 other tenants\' and other centres\' versions are not_found per item and reveal nothing', () => {
  const mixed = (over: Partial<BulkOpts> = {}) => bulkSetup({ items: [{}, { tenant: TENANT_B, reportOver: { _i: 2 } }, {}, { centre: CENTRE_B, reportOver: { _i: 4 } }, {}], ...over });
  it('tenant B id -> not_found; the tenant A ids around it are processed (RLS on)', async () => {
    const s = mixed(); const r = await run(s, idsOf(3));
    expect(outcomes(r)).toEqual({ [VID(1)]: 'released', [VID(2)]: 'not_found', [VID(3)]: 'released' });
    expect(s.version(2)).toMatchObject({ tenant_id: TENANT_B, status: 'rendered', version: 3 }); expect(s.billing.calls.map((c) => c.orderId)).not.toContain(OID(2));
  });
  it('even with RLS off the explicit tenant_id predicate keeps tenant B out: not_found, untouched, no billing call, no event, no job, no tenant B value written', async () => {
    const s = mixed({ rls: false }); const r = await run(s, [VID(2)]);
    expect(r.body.results).toEqual([{ id: VID(2), outcome: 'not_found' }]); expect(s.version(2)).toMatchObject({ status: 'rendered', version: 3 }); expect(s.report(2)['released_version_no'] ?? null).toBeNull();
    nothingHappened(s); expect(s.db.reportingStmts().every((x) => /\btenant_id\b/i.test(x.text))).toBe(true);
  });
  it('A7: a centre-A user with ids of centre B -> not_found for B, centre A ids processed (centre RLS emulated)', async () => {
    const s = mixed({ centres: [CENTRE_A] }); const r = await run(s, [VID(1), VID(4), VID(5)]);
    expect(outcomes(r)).toEqual({ [VID(1)]: 'released', [VID(4)]: 'not_found', [VID(5)]: 'released' });
    expect(s.version(4)).toMatchObject({ centre_id: CENTRE_B, status: 'rendered', version: 3 }); expect(s.billing.calls.map((c) => c.orderId)).not.toContain(OID(4));
    expect(s.published.map((p) => p.input.aggregate.id)).not.toContain(RID(4)); expect(s.access.map((a) => a.entityId)).not.toContain(VID(4));
  });
  it('indistinguishable: another tenant\'s / another centre\'s id and a never-existing id get byte-identical answers (apart from the id)', async () => {
    const s = mixed({ centres: [CENTRE_A] }); const ghost = idN(0xdead01); const r = await run(s, [VID(2), VID(4), ghost]);
    const strip = (x: any) => JSON.stringify({ ...x, id: '-' }); const [a, b, c] = r.body.results; expect(strip(a)).toBe(strip(c)); expect(strip(b)).toBe(strip(c)); expect(c).toEqual({ id: ghost, outcome: 'not_found' });
  });
  it('a request of only foreign ids is a normal 200 with all not_found (no 403/404 that would reveal the difference), nothing written', async () => {
    const s = mixed({ centres: [CENTRE_A] }); const r = await run(s, [VID(2), VID(4)]); expect(r.status).toBe(200); expect(countBy(r, 'not_found')).toBe(2); nothingHappened(s);
  });
  it('the foreign rows are not read into the answer: no tenant B / centre B identifier, registration number or order id appears anywhere', async () => {
    const s = mixed({ centres: [CENTRE_A] }); const r = await run(s, idsOf(5)); const out = JSON.stringify(r.body) + s.allText();
    expect(r.status).toBe(200); expect(countBy(r, 'released')).toBe(3); expect(countBy(r, 'not_found')).toBe(2);
    for (const x of [TENANT_B, CENTRE_B, OID(2), OID(4), RID(2), RID(4)]) expect(out).not.toContain(x);
  });
});

// ============================================================================================ AC-07.4 / REQ-SEC-100
describe('AC-07.4 privileged: aal2 and the role are required', () => {
  it('asks IdentityPort.assertRole for reporting.report.bulk_release before doing anything for the ids', async () => {
    const s = setup({ n: 2 }); await run(s, idsOf(2));
    expect(s.roleCalls.length).toBeGreaterThanOrEqual(1); expect(s.roleCalls.every((c) => c.permission === PERMISSION)).toBe(true);
  });
  it.each([['auth.mfa_required'], ['auth.forbidden']])('assertRole rejects with %s -> the same code, nothing consulted, nothing written, nothing published', async (code) => {
    const s = setup({ n: 3, deniedWith: code }); const e = await rejection(run(s, idsOf(3)));
    expect(e?.code).toBe(code); nothingHappened(s); expect(s.version(1)).toMatchObject({ status: 'rendered', version: 3 });
  });
  it('the refusal carries nothing about the ids', async () => {
    const s = setup({ n: 1, deniedWith: 'auth.mfa_required' }); const e = await rejection(run(s, idsOf(1)));
    expect(JSON.stringify({ c: e?.code, m: e?.message, d: e?.details, x: { ...e } })).not.toContain(VID(1));
  });
  it('a missing IdentityPort fails closed (500 common.internal), it never skips the check', async () => {
    const s = setup({ n: 1 }); const ctx = s.ctx(); ctx.ports = { ...ctx.ports, IdentityPort: undefined };
    const e = await rejection(run(s, idsOf(1), ctx)); expect(e?.code).toBe('common.internal'); nothingHappened(s);
  });
  it('a non-user actor cannot bulk-release: a system actor is refused (auth.forbidden), nothing happens', async () => {
    const s = setup({ n: 1 }); const e = await rejection(run(s, idsOf(1), s.ctx({ actor: { type: 'system', id: idN(0xa009) } })));
    expect(['auth.forbidden', 'auth.unauthenticated']).toContain(e?.code); nothingHappened(s);
  });
});

// ============================================================================================ E5: one id fails mid-way, the others are unaffected
describe('E5 per-id savepoint: one failing id rolls back alone', () => {
  const boom = () => Object.assign(new Error('event_log down'), { code: 'common.internal' });
  it('events.publish fails for report 3 AFTER its rows were written (incl. a supersede): 200, report 3 left exactly as before, the others released', async () => {
    const s = bulkSetup({ items: [{}, {}, { versions: [{ ...REL }, { version_no: 2, report_kind: 'amended' }], reportOver: { latest_version_no: 2, released_version_no: 1 } }, {}, {}], publishFails: (rid) => (rid === RID(3) ? boom() : undefined) });
    const before = JSON.stringify([s.db.all('reporting.report_versions').filter((v) => v['report_id'] === RID(3)), s.report(3)]);
    const r = await run(s, [VID(1), VID(2), V2(3), VID(4), VID(5)]);
    expect(r.status).toBe(200); const o = outcomes(r);
    expect(o[V2(3)]).not.toBe('released'); expect(['not_ready', 'not_latest', 'already_released', 'blocked_due', 'cancelled', 'not_found']).toContain(o[V2(3)]);
    for (const i of [1, 2, 4, 5]) expect(o[VID(i)]).toBe('released');
    expect(JSON.stringify([s.db.all('reporting.report_versions').filter((v) => v['report_id'] === RID(3)), s.report(3)])).toBe(before);   // v1 still released, v2 still rendered
    expect(s.published.map((p) => p.input.aggregate.id).sort()).toEqual([1, 2, 4, 5].map(RID).sort()); expect(s.jobs()).toHaveLength(4); expect(s.access.map((a) => a.entityId).sort()).toEqual([1, 2, 4, 5].map(VID).sort());
    expect(s.tx.rollbacks).toBeGreaterThanOrEqual(1);
  });
  it('a failing UPDATE of the report row for the FIRST id only: that id untouched, the other four released', async () => {
    const s = bulkSetup({ items: many(5), failOn: [{ match: /update reporting\.reports set released_version_no/i, error: () => Object.assign(new Error('boom'), { code: '40001' }), times: 1 }] });
    const r = await run(s, idsOf(5)); expect(r.status).toBe(200); expect(outcomes(r)[VID(1)]).not.toBe('released');
    expect(s.version(1)).toMatchObject({ status: 'rendered', version: 3 }); expect(s.report(1)['released_version_no'] ?? null).toBeNull();
    for (let i = 2; i <= 5; i++) expect(s.version(i)['status']).toBe('released');
    expect(s.published).toHaveLength(4); expect(s.jobs()).toHaveLength(4); expect(s.access).toHaveLength(4);
  });
  it('BillingPort outage for one id: that id is not released (fail closed) and the others are', async () => {
    const s = bulkSetup({ items: many(4), billing: (o) => (o === OID(2) ? Object.assign(new Error('billing down'), { code: 'common.unavailable' }) : { eligible: true, basis: 'paid_in_full', balanceDue: { amountPaisa: 0, currency: 'NPR' } }) });
    const r = await run(s, idsOf(4)); const o = outcomes(r); expect(o[VID(2)]).not.toBe('released'); expect(s.version(2)['status']).toBe('rendered');
    for (const i of [1, 3, 4]) expect(o[VID(i)]).toBe('released'); expect(s.published).toHaveLength(3);
  });
  it('a contradictory BillingPort answer (eligible with an ineligible basis) never releases that id', async () => {
    const s = bulkSetup({ items: many(3), billing: (o) => (o === OID(2) ? { eligible: true, basis: 'due_outstanding', balanceDue: { amountPaisa: 50_000, currency: 'NPR' } } : { eligible: true, basis: 'paid_in_full', balanceDue: { amountPaisa: 0, currency: 'NPR' } }) });
    const r = await run(s, idsOf(3)); expect(outcomes(r)[VID(2)]).not.toBe('released'); expect(s.version(2)['status']).toBe('rendered'); expect(countBy(r, 'released')).toBe(2);
  });
});

// ============================================================================================ T13 release without payment
describe('T13 no release without payment', () => {
  it('a body cannot mark ids eligible: unknown members are rejected, and ids with dues stay blocked_due whatever else is sent', async () => {
    const s = bulkSetup({ items: many(2), dues: [1, 2] });
    const e = await rejection(callBulk(manifest, s, { ids: idsOf(2), eligible: true, release_basis: 'override', override_id: idN(0xbad) })); expect(e?.code).toBe('common.validation_failed');
    const r = await run(s, idsOf(2)); expect(countBy(r, 'blocked_due')).toBe(2); expect(s.db.all('reporting.report_versions').every((v) => v['status'] === 'rendered')).toBe(true);
  });
  it('a BillingPort answer for another order is refused: nothing released', async () => {
    const s = bulkSetup({ items: many(2), billing: () => ({ eligible: true, basis: 'paid_in_full', balanceDue: { amountPaisa: 0, currency: 'NPR' } }) });
    const g = s.billing.port.getReleaseEligibility; s.billing.port.getReleaseEligibility = async (c: any, i: any) => ({ ...(await g(c, i)), orderId: idN(0xf00d) });
    const r = await run(s, idsOf(2)); expect(countBy(r, 'released')).toBe(0); expect(s.published).toHaveLength(0);
  });
  it('DUE_500 is the only thing between a held id and a release: flipping the port to eligible releases it (control)', async () => {
    const s = bulkSetup({ items: many(1), billing: () => DUE_500 }); expect(countBy(await run(s, idsOf(1)), 'blocked_due')).toBe(1);
    const t = bulkSetup({ items: many(1) }); expect(countBy(await run(t, idsOf(1)), 'released')).toBe(1);
  });
});
