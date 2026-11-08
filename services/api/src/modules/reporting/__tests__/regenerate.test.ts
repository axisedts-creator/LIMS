// C6-T41 — R9 POST /reports/{report_id}/regenerations (operationId regenerateReport; 02-TRD §6.3 R9, §4.2 fingerprint, §4.5 rule 0; 08 A13 D-33 / D-36;
// AC-02.6, AC-06.9 (kind), E8; 07-SECURITY REQ-SEC-024 tenancy, REQ-SEC-100 privileged/aal2, P2 free text).
// ASSUMED contract (spec gives no signatures; repeated in .orchestra/notes/C6-T41-tests.md):
//   - handler manifest.handlers.regenerateReport(req, ctx) with ctx = { tenantId, actor:{type,id}, tx, ports:{ IdentityPort:{ assertRole } }, log } (as R6/R7);
//     req = { params:{report_id}, query:{}, headers:{}, body:{ reason_code, reason_text? } }. Schema/permission/Idempotency-Key come from the pipeline (not run here).
//   - privileged: IdentityPort.assertRole(ctx, { permission: 'reporting.report.regenerate' }) is the defence in depth and carries auth.mfa_required (aal1).
//   - x-coded-set is annotation-only (core/openapi.ts), so the handler itself checks reason_code against the merged, active `regeneration_reasons`
//     rows of reporting.g_cs_reasons / reporting.cs_reasons (unknown code, e.g. the removed `centre_correction` -> common.validation_failed).
//   - the reason travels to the assembly task in the job payload: `reporting.assemble_report`, job key `assemble:<report_id>`, payload
//     { tenant_id, report_id, regeneration: { reason_code, reason_text? } } (the worker half is tested in worker assemble_regeneration.test.ts).
//   - SQL stays in the single-table dialect of the worker fake (assemble.helpers.ts / consumers.helpers.ts); the report row is locked with FOR UPDATE.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { LimsError } from '../../../core/errors.js';
import { REPO_ROOT, loadSpec } from '../../../core/module.js';
import { LAB, NARR, TENANT_A, TENANT_B, idN, mutex, world, wrapTx } from '../../../../../worker/src/jobs/reporting/__tests__/assemble.helpers.js';
import { SYSTEM_ACTOR } from '../../../../../worker/src/jobs/reporting/__tests__/consumers.helpers.js';
import { REPORTING_PERMISSIONS } from '../permissions.js';
import { regenerationNote, versionKind } from '../domain/version.js';

const OP = 'regenerateReport';
const PERM = 'reporting.report.regenerate';
const USER = idN(0xa001);
const SEED_CODES = ['demographic_correction', 'referrer_correction', 'template_correction', 'smart_summary_added', 'other'];
const reasons = () => SEED_CODES.map((code, i) => ({ set_name: 'regeneration_reasons', code, display: code.replace(/_/g, ' '), sort_order: i + 1, is_active: true }));
const idle = { needs_assembly: false, needs_assembly_since: null, regeneration_counter: 2, version: 7 };

let manifest: any;
beforeAll(async () => {
  const k = join(mkdtempSync(join(tmpdir(), 'c6-t41-')), 'otp.key'); writeFileSync(k, Buffer.alloc(32, 7));
  process.env.LIMS_CORE_ENV = 'dev'; delete process.env.NODE_ENV; delete process.env.LIMS_REPORTING_ALLOW_REAL_PROVIDERS; process.env.LIMS_REPORTING_OTP_HMAC_KEY_FILE = k;
  manifest = (await import('../index.js')).manifest;
});
const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, got success'); };

interface Opts { report?: Record<string, unknown>; denied?: string; actorType?: string; rls?: boolean; noIdentity?: boolean; codes?: boolean }
function setup(o: Opts = {}) {
  const w = world({ reportOver: { ...idle, ...o.report }, ...(o.rls === undefined ? {} : { rls: o.rls }),
    extraSeed: { 'reporting.g_cs_reasons': o.codes === false ? [] : reasons(), 'reporting.cs_reasons': [] } });
  const asserted: any[] = []; const logs: any[] = [];
  const ports = o.noIdentity ? {} : { IdentityPort: { async assertRole(_c: unknown, i: any) { asserted.push(i); if (o.denied) throw new LimsError(o.denied as any); } } };
  const log = { info: (x: unknown) => logs.push(x), warn: (x: unknown) => logs.push(x), error: (x: unknown) => logs.push(x) };
  const ctx = (tx: unknown = w.db.tx) => ({ tenantId: TENANT_A, actor: { type: o.actorType ?? 'user', id: USER }, tx, ports, requestId: idN(0xf1), operationId: OP, clientIp: '203.0.113.9', log });
  const call = (body: unknown = { reason_code: 'demographic_correction' }, over: { id?: string; ctx?: any } = {}) =>
    manifest.handlers[OP]({ params: { report_id: over.id ?? LAB }, query: {}, headers: {}, body }, over.ctx ?? ctx());
  return { ...w, call, ctx, asserted, logs, row: (id = LAB) => w.db.all('reporting.reports').find((r) => r['id'] === id)! };
}
const untouched = (s: ReturnType<typeof setup>) => { expect(s.db.writes()).toHaveLength(0); expect(s.db.jobs).toHaveLength(0); };

describe('contract', () => {
  it('operation exists: POST /reports/{report_id}/regenerations, reporting.report.regenerate, Idempotency-Key required, 202, documents report_cancelled + mfa_required', () => {
    const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/reporting.yaml'));
    const op = spec.paths['/v1/reporting/reports/{report_id}/regenerations'].post;
    expect(op.operationId).toBe(OP); expect(op['x-permission']).toBe(PERM); expect(op['x-idempotency']).toBe('required'); expect(Object.keys(op.responses)).toContain('202');
    expect(op['x-error-codes']).toEqual(expect.arrayContaining(['reporting.report_cancelled', 'auth.mfa_required', 'common.validation_failed', 'common.not_found']));
  });
  it('the permission code is registered (verbatim) and the operation is no longer a 501 stub', () => {
    expect(REPORTING_PERMISSIONS).toContain(PERM); expect(typeof manifest.handlers[OP]).toBe('function');
  });
  it('without a request context it fails closed (auth.unauthenticated), echoing no input', async () => {
    const planted = 'PLANTED-TOKEN-41aa';
    const e = await rejection(manifest.handlers[OP]({ params: { report_id: planted }, query: {}, headers: { authorization: planted }, body: { reason_code: planted, reason_text: planted } }, { operationId: OP, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } }));
    expect(e?.code).toBe('auth.unauthenticated'); expect(JSON.stringify({ c: e?.code, m: e?.message, d: e?.details })).not.toContain(planted);
  });
});

describe('R9 happy path (02-TRD R9; 08 P-13 fingerprint)', () => {
  it('202 {report_id, scheduled: true} and nothing else', async () => {
    const s = setup(); const r = await s.call({ reason_code: 'demographic_correction', reason_text: 'Synthetic: name spelling fixed' });
    expect(r.status).toBe(202); expect(r.body).toEqual({ report_id: LAB, scheduled: true });
  });
  it('locks the report row (FOR UPDATE, tenant-scoped) BEFORE the first write', async () => {
    const s = setup(); await s.call();
    const stmts = s.db.reportingStmts(); const firstWrite = stmts.findIndex((x) => /^\s*(update|insert)/i.test(x.text));
    const lock = stmts.findIndex((x) => /\breporting\.reports\b/i.test(x.text) && /\bfor\s+update\b/i.test(x.text));
    expect(lock).toBeGreaterThanOrEqual(0); expect(lock).toBeLessThan(firstWrite); expect(/\btenant_id\b/i.test(stmts[lock]!.text)).toBe(true);
  });
  it('row: regeneration_counter + 1 (fingerprint input), needs_assembly = true with needs_assembly_since, version + 1, updated_by = the actor', async () => {
    const s = setup(); await s.call();
    expect(s.row()).toMatchObject({ regeneration_counter: 3, needs_assembly: true, version: 8, updated_by: USER });
    expect(s.row()['needs_assembly_since']).toBeTruthy(); expect(s.row()['updated_by']).not.toBe(SYSTEM_ACTOR);
  });
  it('an already-pending needs_assembly_since is kept (oldest pending wins, as the other producers)', async () => {
    const s = setup({ report: { needs_assembly: true, needs_assembly_since: '2026-11-07T11:00:00.000Z' } }); await s.call();
    expect(s.row()).toMatchObject({ needs_assembly: true, needs_assembly_since: '2026-11-07T11:00:00.000Z', regeneration_counter: 3 });
  });
  it('enqueues exactly one reporting.assemble_report, key assemble:<report_id>, payload tenant + report + reason code/text', async () => {
    const s = setup(); await s.call({ reason_code: 'other', reason_text: 'Synthetic: footer wording' });
    expect(s.db.jobs).toHaveLength(1);
    expect(s.db.jobs[0]).toMatchObject({ identifier: 'reporting.assemble_report', jobKey: `assemble:${LAB}` });
    expect(s.db.jobs[0]!.payload).toMatchObject({ tenant_id: TENANT_A, report_id: LAB, regeneration: { reason_code: 'other', reason_text: 'Synthetic: footer wording' } });
  });
  it('reason_text is optional for every code except `other`: the payload then carries no text', async () => {
    const s = setup(); await s.call({ reason_code: 'smart_summary_added' });
    expect(s.db.jobs[0]!.payload.regeneration.reason_code).toBe('smart_summary_added'); expect(s.db.jobs[0]!.payload.regeneration.reason_text ?? null).toBeNull();
  });
  it.each(SEED_CODES.filter((c) => c !== 'other'))('seed reason %s is accepted', async (code) => {
    const s = setup(); expect((await s.call({ reason_code: code })).status).toBe(202);
  });
  it('allowed after a release too (the released report keeps released_version_no; no version row is written by the API)', async () => {
    const s = setup({ report: { released_version_no: 1, latest_version_no: 1 } }); await s.call();
    expect(s.row()).toMatchObject({ released_version_no: 1, latest_version_no: 1, regeneration_counter: 3 }); expect(s.db.all('reporting.report_versions')).toHaveLength(0);
  });
  it('only the addressed report changes (the sibling narrative report of the same order is untouched)', async () => {
    const s = setup(); const before = JSON.stringify(s.row(NARR)); await s.call(); expect(JSON.stringify(s.row(NARR))).toBe(before);
  });
  it('two regenerations at once: both succeed, counter +2, serialised by the row lock', async () => {
    const s = setup(); const m = mutex(); const run = (reason: string) => { const tx = wrapTx(s.db.tx, m); return s.call({ reason_code: reason }, { ctx: s.ctx(tx) }).finally(() => tx.release()); };
    const out = await Promise.all([run('demographic_correction'), run('template_correction')]);
    expect(out.map((r: any) => r.status)).toEqual([202, 202]); expect(s.row()['regeneration_counter']).toBe(4); expect(s.db.jobs).toHaveLength(2);
  });
});

describe('validation (400): reason_code / reason_text', () => {
  it('`other` without reason_text -> common.validation_failed pointing at /reason_text, nothing written', async () => {
    const s = setup(); const e = await rejection(s.call({ reason_code: 'other' }));
    expect(e?.code).toBe('common.validation_failed'); expect(JSON.stringify(e?.errors ?? [])).toContain('/reason_text'); untouched(s);
  });
  it.each(['', '   ', '\n\t'])('`other` with blank reason_text %j -> common.validation_failed', async (t) => {
    const s = setup(); expect((await rejection(s.call({ reason_code: 'other', reason_text: t })))?.code).toBe('common.validation_failed'); untouched(s);
  });
  it('`other` WITH text is accepted; text of exactly 500 chars is accepted', async () => {
    const s = setup(); expect((await s.call({ reason_code: 'other', reason_text: 'x'.repeat(500) })).status).toBe(202);
  });
  it('reason_text of 501 chars -> common.validation_failed', async () => {
    const s = setup(); expect((await rejection(s.call({ reason_code: 'demographic_correction', reason_text: 'x'.repeat(501) })))?.code).toBe('common.validation_failed'); untouched(s);
  });
  it('unknown reason_code -> common.validation_failed; `centre_correction` was removed from the seed (D-36)', async () => {
    for (const code of ['centre_correction', 'nope', 'OTHER']) { const s = setup(); expect((await rejection(s.call({ reason_code: code })))?.code).toBe('common.validation_failed'); untouched(s); }
  });
  it('an inactive tenant override hides the global code (merged coded set, 02-CV §5.5)', async () => {
    const s = setup(); s.db.store['reporting.cs_reasons']!.push({ tenant_id: TENANT_A, set_name: 'regeneration_reasons', code: 'template_correction', display: 'x', sort_order: 3, is_active: false });
    expect((await rejection(s.call({ reason_code: 'template_correction' })))?.code).toBe('common.validation_failed'); untouched(s);
  });
  it.each([
    ['missing reason_code', {}], ['null body', null], ['array body', []], ['string body', 'other'], ['reason_code not a string', { reason_code: 5 }],
    ['empty reason_code', { reason_code: '' }], ['reason_code > 64', { reason_code: 'a'.repeat(65) }], ['reason_text not a string', { reason_code: 'demographic_correction', reason_text: 7 }],
    ['unknown extra property', { reason_code: 'demographic_correction', centre_id: idN(1) }], ['sql in reason_code', { reason_code: "x'; DROP TABLE reporting.reports;--" }],
  ])('%s -> common.validation_failed, nothing written', async (_n, body) => {
    const s = setup(); expect((await rejection(s.call(body as any)))?.code).toBe('common.validation_failed'); untouched(s);
  });
  it('reason_text is stored/forwarded verbatim as DATA: statements bind it as a parameter, never in SQL text', async () => {
    const s = setup(); const t = "Synthetic'; DROP TABLE reporting.reports;--"; await s.call({ reason_code: 'other', reason_text: t });
    expect(s.db.reportingStmts().some((x) => x.text.includes('DROP TABLE'))).toBe(false); expect(s.db.jobs[0]!.payload.regeneration.reason_text).toBe(t);
  });
  it('the free text (P2) is never written to logs and never echoed in an error', async () => {
    const planted = 'PLANTED-P2-77c1'; const s = setup(); await s.call({ reason_code: 'other', reason_text: planted });
    expect(JSON.stringify(s.logs)).not.toContain(planted);
    const s2 = setup({ report: { state: 'cancelled' } }); const e = await rejection(s2.call({ reason_code: 'other', reason_text: planted }));
    expect(JSON.stringify({ c: e?.code, m: e?.message, d: e?.details })).not.toContain(planted); expect(JSON.stringify(s2.logs)).not.toContain(planted);
  });
});

describe('cancelled report', () => {
  it('state cancelled -> reporting.report_cancelled (409): counter unchanged, no needs_assembly, no job', async () => {
    const s = setup({ report: { state: 'cancelled', cancelled_at: '2026-11-07T11:00:00.000Z' } });
    const e = await rejection(s.call()); expect(e?.code).toBe('reporting.report_cancelled'); untouched(s);
    expect(s.row()).toMatchObject({ regeneration_counter: 2, needs_assembly: false, version: 7 });
  });
  it('a released report whose order was cancelled (review_flag) is still cancelled -> same code', async () => {
    const s = setup({ report: { state: 'cancelled', released_version_no: 1, review_flag: 'released_order_cancelled' } });
    expect((await rejection(s.call()))?.code).toBe('reporting.report_cancelled'); untouched(s);
  });
});

describe('lookup / tenancy (REQ-SEC-024)', () => {
  it('unknown report -> common.not_found', async () => {
    const s = setup(); expect((await rejection(s.call(undefined, { id: idN(0xdead) })))?.code).toBe('common.not_found'); untouched(s);
  });
  it('another tenant\'s report -> the same common.not_found — even with RLS off the statements name tenant_id', async () => {
    const s = setup({ report: { tenant_id: TENANT_B }, rls: false }); const e = await rejection(s.call());
    expect(e?.code).toBe('common.not_found'); expect(s.row()).toMatchObject({ regeneration_counter: 2, needs_assembly: false }); expect(s.db.jobs).toHaveLength(0);
    expect(s.db.reportingStmts().length).toBeGreaterThan(0); expect(s.db.reportingStmts().every((x) => /\btenant_id\b/i.test(x.text))).toBe(true);
  });
  it('non-uuid report_id -> rejected without touching the database', async () => {
    const s = setup(); const e = await rejection(s.call(undefined, { id: "x'; DROP TABLE reporting.reports;--" })); expect(['common.validation_failed', 'common.not_found']).toContain(e?.code);
    expect(s.db.writes()).toHaveLength(0); expect(s.db.jobs).toHaveLength(0);
  });
  it('error responses never echo the report id', async () => {
    const s = setup(); const planted = 'PLANTED-9c1b'; const e = await rejection(s.call(undefined, { id: planted }));
    expect(JSON.stringify({ c: e?.code, m: e?.message, d: e?.details })).not.toContain(planted);
  });
});

describe('privileged: aal2 + role (REQ-SEC-100)', () => {
  it('asks IdentityPort.assertRole for reporting.report.regenerate before reading or writing anything', async () => {
    const s = setup(); await s.call(); expect(s.asserted).toHaveLength(1); expect(s.asserted[0]).toMatchObject({ permission: PERM });
  });
  it('aal1 -> auth.mfa_required; nothing read from reporting, nothing written, no job', async () => {
    const s = setup({ denied: 'auth.mfa_required' }); const e = await rejection(s.call());
    expect(e?.code).toBe('auth.mfa_required'); untouched(s); expect(s.db.reportingStmts()).toHaveLength(0);
  });
  it('role missing -> auth.forbidden, nothing written', async () => {
    const s = setup({ denied: 'auth.forbidden' }); expect((await rejection(s.call()))?.code).toBe('auth.forbidden'); untouched(s);
  });
  it.each(['device', 'portal', 'patient', 'partner', 'system'])('actor type %s -> auth.forbidden', async (t) => {
    const s = setup({ actorType: t }); expect((await rejection(s.call()))?.code).toBe('auth.forbidden'); untouched(s);
  });
  it('no IdentityPort wired -> fails closed (common.internal), nothing written', async () => {
    const s = setup({ noIdentity: true }); expect((await rejection(s.call()))?.code).toBe('common.internal'); untouched(s);
  });
});

describe('§4.5 rule 0 (domain/version.ts) as R9 + assembly use it — AC-02.6, AC-06.9, E8', () => {
  const sec = [{ kind: 'lab' }];
  it('regeneration after a release -> amended, except smart_summary_added (kind from rules 1-4)', () => {
    for (const c of ['demographic_correction', 'referrer_correction', 'template_correction', 'other']) expect(versionKind({ regeneration: { reasonCode: c }, earlierReleased: true, sections: sec, complete: true })).toBe('amended');
    expect(versionKind({ regeneration: { reasonCode: 'smart_summary_added' }, earlierReleased: true, sections: sec, complete: true })).toBe('final');
    expect(versionKind({ regeneration: { reasonCode: 'smart_summary_added' }, earlierReleased: true, sections: sec, complete: false })).toBe('partial');
  });
  it('regeneration before any release is not an amendment', () => {
    expect(versionKind({ regeneration: { reasonCode: 'demographic_correction' }, earlierReleased: false, sections: sec, complete: true })).toBe('final');
  });
  it('the amendment-box note is one "Report details" entry carrying the reason', () => {
    expect(regenerationNote('other', 'Synthetic text')).toEqual({ analyteOrSection: 'Report details', reasonCode: 'other', reasonText: 'Synthetic text' });
    expect(regenerationNote('demographic_correction')).toEqual({ analyteOrSection: 'Report details', reasonCode: 'demographic_correction' });
  });
});
