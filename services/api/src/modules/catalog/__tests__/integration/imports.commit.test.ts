// T-23 (C3) — commitImport API (#102) for kind price_list: guards, stale-base rule, commit params, enqueue, duplicates, handler.
// Spec: 06-PLAN row T-23; 02-TRD §5.2 #102, §8.5 (API half), §10 (job_key = import id); 03-APP-FLOW §2.2 guard table + E6;
//       PRD AC-16.5 (stale base), AC-16.7 (a different key on an already committed import -> 409; no second job/version);
//       07-SECURITY AB-5 (foreign id -> 404), AB-16, S-4/P-10 (per-kind permission), S-1 (mass assignment).
// Interface expected from the writer (SEAM = not fixed by the spec; see .orchestra/notes/C3.T-23-tests.md):
//   imports.service.ts   commitImport(ctx, importId, expectedVersion, body) -> Import (status 'committing', version + 1)      (SEAM: same shape as discardImport)
//     body = { change_reason (1..500, required), effective_from? (ISO-8601 UTC), accept_stale_base? bool, publish? bool (default true), replace_draft? bool (default false) }
//     Guarded UPDATE on the import row (status = 'validated'); stores commit_effective_from / commit_change_reason / commit_publish / commit_accept_stale_base,
//     committed_by = the requesting user (ASSUMED: the job writes the version rows "as committed_by", 02-TRD §8.5 actor-on-behalf), then
//     SELECT app.enqueue_job('catalog.import_commit', $1::jsonb, <import id>) with payload { tenant_id, import_id, replace_draft } (ASSUMED: 05-SCHEMA has no
//     commit_replace_draft column, so the flag travels in the job payload).
//   handlers/imports.handlers.ts   importsHandlers.commitImport -> 202 + body Import + ETag "<version>"; If-Match required (428) like discardImport.
//   Idempotency-Key replay (AC-16.7, first half) is the core pipeline's (x-idempotency: required), not asserted here.
import { describe, expect, it } from 'vitest';
import { importsHandlers } from '../../handlers/imports.handlers.js';
import { createImportsService } from '../../service/imports.service.js';
import { makeIdentity } from '../helpers/identity.js';
import { makeImportsDb, NOW, TENANT_A, TENANT_B, USER, V7 } from '../helpers/importsDb.js';

const T = 20_000;
const PL = V7('0000000d0001');
const PL_B = V7('0000000d0002');
const PRICE_ALL = ['catalog.price_list.read', 'catalog.price_list.manage'];
const REASON = 'Quarterly tariff revision (synthetic)';
const EFFECTIVE = '2026-12-01T00:00:00.000Z';
const OTHER_USER = V7('00000000a002');

interface Svc { commitImport(ctx: unknown, id: string, expectedVersion: number | undefined, body: unknown): Promise<any> }
function setup(o: { grants?: readonly string[]; aal?: 1 | 2; versions?: Array<[number, string]> } = {}) {
  const db = makeImportsDb();
  db.seed.priceList(TENANT_A, PL);
  db.seed.priceList(TENANT_B, PL_B);
  for (const [no, status] of o.versions ?? [[3, 'published']]) db.seed.priceListVersion(TENANT_A, PL, no, status);
  const identity = makeIdentity(o.grants ?? PRICE_ALL, o.aal ?? 2);
  const svc = createImportsService({ identity } as never) as unknown as Svc;
  const run = <R>(fn: (s: Svc, ctx: any) => Promise<R>, tenantId = TENANT_A, actorId = USER) => db.run((ctx) => fn(svc, ctx), { tenantId, actorId });
  const seedImport = (over: Record<string, unknown> = {}) =>
    db.seed.import(TENANT_A, { kind: 'price_list', target_price_list_id: PL, base_version_no: 3, status: 'validated', ...over });
  return { db, identity, svc, run, seedImport };
}
const errOf = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } return undefined; };
const body = (extra: Record<string, unknown> = {}) => ({ change_reason: REASON, ...extra });
const commit = (s: ReturnType<typeof setup>, imp: { id: string; version: number }, b: unknown = body(), tenantId = TENANT_A, actorId = USER) =>
  s.run((svc, ctx) => svc.commitImport(ctx, imp.id, imp.version, b), tenantId, actorId);
const row = (s: ReturnType<typeof setup>, id: string) => s.db.rows('imports').find((r) => r.id === id)!;

describe('commitImport — happy path (AC-16.6 API half)', () => {
  it('validated -> committing: returns the Import, stores the commit params, bumps version, enqueues catalog.import_commit keyed by the import id', async () => {
    const s = setup();
    const imp = s.seedImport();
    const v0 = imp.version; // seed returns the live row; commit mutates it
    const out = await commit(s, imp, body({ effective_from: EFFECTIVE }));
    expect(out).toMatchObject({ id: imp.id, kind: 'price_list', status: 'committing', version: v0 + 1 });
    const r = row(s, imp.id);
    expect(r).toMatchObject({ status: 'committing', commit_change_reason: REASON, commit_publish: true, commit_accept_stale_base: false, committed_by: USER, version: v0 + 1 });
    expect(new Date(r.commit_effective_from).toISOString()).toBe(EFFECTIVE);
    expect(r.committed_at ?? null).toBeNull();                       // set by the job when the apply commits
    expect(r.result_price_list_version_id ?? null).toBeNull();
    expect(s.db.jobs).toHaveLength(1);
    expect(s.db.jobs[0]).toMatchObject({ identifier: 'catalog.import_commit', jobKey: imp.id });
    expect(s.db.jobs[0]!.payload).toMatchObject({ tenant_id: TENANT_A, import_id: imp.id });
    expect(s.db.jobs[0]!.payload.replace_draft ?? false).toBe(false);
  }, T);

  it('publish:false, accept_stale_base:true and replace_draft:true are stored / forwarded; effective_from omitted -> NULL (the job uses its clock)', async () => {
    const s = setup();
    const imp = s.seedImport();
    await commit(s, imp, body({ publish: false, accept_stale_base: true, replace_draft: true }));
    const r = row(s, imp.id);
    expect(r).toMatchObject({ commit_publish: false, commit_accept_stale_base: true });
    expect(r.commit_effective_from ?? null).toBeNull();
    expect(s.db.jobs[0]!.payload.replace_draft).toBe(true);
  }, T);

  it('the enqueue and the state change share one transaction: a failing enqueue leaves the import validated and no job', async () => {
    const s = setup();
    const imp = s.seedImport();
    s.db.fail(/enqueue_job/i);
    expect(await errOf(commit(s, imp))).toBeDefined();
    expect(row(s, imp.id)).toMatchObject({ status: 'validated', version: imp.version });
    expect(s.db.jobs).toHaveLength(0);
  }, T);
});

describe('commitImport — stale base (AC-16.5, CR-C3-003)', () => {
  it('latest published v4 while the file was exported at base 3 -> 409 catalog.import_stale_base; nothing changes, no job', async () => {
    const s = setup({ versions: [[3, 'superseded'], [4, 'published']] });
    const imp = s.seedImport({ base_version_no: 3 });
    const e = await errOf(commit(s, imp));
    expect(e?.code).toBe('catalog.import_stale_base');
    expect(row(s, imp.id)).toMatchObject({ status: 'validated', version: imp.version });
    expect(s.db.jobs).toHaveLength(0);
  }, T);

  it('accept_stale_base:true -> committing, and the flag is stored', async () => {
    const s = setup({ versions: [[3, 'superseded'], [4, 'published']] });
    const imp = s.seedImport({ base_version_no: 3 });
    expect((await commit(s, imp, body({ accept_stale_base: true }))).status).toBe('committing');
    expect(row(s, imp.id).commit_accept_stale_base).toBe(true);
  }, T);

  it('base equal to the latest published version is not stale (an open draft v5 or a discarded v6 does not count)', async () => {
    const s = setup({ versions: [[3, 'published'], [5, 'draft'], [6, 'discarded']] });
    const imp = s.seedImport({ base_version_no: 3 });
    expect((await commit(s, imp)).status).toBe('committing');
  }, T);

  it('superseded latest-window: the highest version_no among published|superseded rows is the comparison (v4 superseded by an immediate v5 published)', async () => {
    const s = setup({ versions: [[3, 'superseded'], [4, 'superseded'], [5, 'published']] });
    const imp = s.seedImport({ base_version_no: 4 });
    expect((await errOf(commit(s, imp)))?.code).toBe('catalog.import_stale_base');
  }, T);

  it('the stale-base check reads only the import\'s own list and tenant: another list\'s / tenant\'s newer version is ignored', async () => {
    const s = setup();
    s.db.seed.priceListVersion(TENANT_B, PL_B, 9, 'published');
    const other = V7('0000000d0003');
    s.db.seed.priceList(TENANT_A, other);
    s.db.seed.priceListVersion(TENANT_A, other, 9, 'published');
    const imp = s.seedImport({ base_version_no: 3 });
    expect((await commit(s, imp)).status).toBe('committing');
  }, T);
});

describe('commitImport — not committable (AC-16.7 second half, E6, AB-16)', () => {
  it.each(['uploaded', 'scanning', 'validating', 'invalid', 'quarantined', 'committing', 'committed', 'commit_failed', 'discarded', 'expired', 'failed'])(
    'status %s -> 409 catalog.import_not_committable, row untouched, no job', async (status) => {
      const s = setup();
      const imp = s.seedImport({ status });
      const e = await errOf(commit(s, imp));
      expect(e?.code).toBe('catalog.import_not_committable');
      expect(row(s, imp.id)).toMatchObject({ status, version: imp.version });
      expect(s.db.jobs).toHaveLength(0);
    }, T);

  it('validated but past expires_at (the hourly cron has not run yet) -> 409 catalog.import_not_committable', async () => {
    const s = setup();
    const imp = s.seedImport({ expires_at: new Date(Date.parse(NOW) - 1000) });
    expect((await errOf(commit(s, imp)))?.code).toBe('catalog.import_not_committable');
    expect(s.db.jobs).toHaveLength(0);
  }, T);

  it('a second commit with a different key (new call) after the first -> 409; still exactly one job', async () => {
    const s = setup();
    const imp = s.seedImport();
    await commit(s, imp);
    const e = await errOf(s.run((svc, ctx) => svc.commitImport(ctx, imp.id, undefined, body())));
    expect(e?.code).toBe('catalog.import_not_committable');
    expect(s.db.jobs).toHaveLength(1);
  }, T);

  it('stale-base is evaluated only for a committable import: an invalid import answers not_committable even when stale', async () => {
    const s = setup({ versions: [[3, 'superseded'], [4, 'published']] });
    const imp = s.seedImport({ status: 'invalid', base_version_no: 3 });
    expect((await errOf(commit(s, imp)))?.code).toBe('catalog.import_not_committable');
  }, T);

  it('many users at once: ten concurrent commits of one validated import -> exactly one wins, nine get 409 not_committable, one job', async () => {
    const s = setup();
    const imp = s.seedImport();
    const results = await Promise.all(Array.from({ length: 10 }, () => errOf(commit(s, imp))));
    expect(results.filter((e) => e === undefined)).toHaveLength(1);
    expect(results.filter((e) => e?.code === 'catalog.import_not_committable' || e?.code === 'common.version_conflict')).toHaveLength(9);
    expect(s.db.jobs).toHaveLength(1);
    expect(row(s, imp.id).status).toBe('committing');
  }, T);
});

describe('commitImport — If-Match and body validation', () => {
  it('stale If-Match version -> 409 common.version_conflict; nothing changes', async () => {
    const s = setup();
    const imp = s.seedImport();
    const e = await errOf(s.run((svc, ctx) => svc.commitImport(ctx, imp.id, imp.version + 7, body())));
    expect(e?.code).toBe('common.version_conflict');
    expect(row(s, imp.id).status).toBe('validated');
    expect(s.db.jobs).toHaveLength(0);
  }, T);

  const BAD: Array<[string, unknown]> = [
    ['missing change_reason', {}],
    ['empty change_reason', { change_reason: '' }],
    ['blank change_reason', { change_reason: '   ' }],
    ['change_reason 501 chars', { change_reason: 'x'.repeat(501) }],
    ['change_reason not a string', { change_reason: 42 }],
    ['effective_from not ISO', { change_reason: REASON, effective_from: 'next tuesday' }],
    ['effective_from not a string', { change_reason: REASON, effective_from: 20261201 }],
    ['accept_stale_base not boolean', { change_reason: REASON, accept_stale_base: 'yes' }],
    ['publish not boolean', { change_reason: REASON, publish: 1 }],
    ['replace_draft not boolean', { change_reason: REASON, replace_draft: 'true' }],
    ['unknown field', { change_reason: REASON, price_list_id: PL }],
    ['body is null', null],
    ['body is an array', [REASON]],
  ];
  it.each(BAD)('%s -> 422 common.validation_failed, nothing changes', async (_n, b) => {
    const s = setup();
    const imp = s.seedImport();
    const e = await errOf(commit(s, imp, b));
    expect(e?.code).toBe('common.validation_failed');
    expect(row(s, imp.id).status).toBe('validated');
    expect(s.db.jobs).toHaveLength(0);
  }, T);

  it('500-character change_reason is accepted (boundary)', async () => {
    const s = setup();
    const imp = s.seedImport();
    expect((await commit(s, imp, body({ change_reason: 'r'.repeat(500) }))).status).toBe('committing');
  }, T);

  it('mass assignment: client-supplied status / committed_by / result / tenant never reach the row', async () => {
    const s = setup();
    const imp = s.seedImport();
    const e = await errOf(commit(s, imp, body({ status: 'committed', committed_by: OTHER_USER, result_price_list_version_id: V7('00000000dead'), tenant_id: TENANT_B })));
    expect(e?.code).toBe('common.validation_failed');                 // unknown fields are rejected, not silently ignored
    expect(row(s, imp.id)).toMatchObject({ status: 'validated' });
  }, T);

  it('committed_by is the authenticated caller, never taken from the body', async () => {
    const s = setup();
    const imp = s.seedImport();
    await commit(s, imp, body(), TENANT_A, OTHER_USER);
    expect(row(s, imp.id).committed_by).toBe(OTHER_USER);
  }, T);
});

describe('commitImport — tenancy and permissions (AB-5, S-4, P-10)', () => {
  it('a tenant-B caller with tenant-A\'s import id -> 404 common.not_found; the row is untouched (S-1)', async () => {
    const s = setup({ grants: PRICE_ALL });
    const imp = s.seedImport();
    const e = await errOf(commit(s, imp, body(), TENANT_B));
    expect(e?.code).toBe('common.not_found');
    expect(row(s, imp.id)).toMatchObject({ status: 'validated', version: imp.version });
    expect(s.db.jobs).toHaveLength(0);
  }, T);

  it.each(['not-a-uuid', '00000000-0000-0000-0000-000000000000', "'; DROP TABLE catalog.imports; --"])('unknown / malformed id %j -> 404', async (id) => {
    const s = setup();
    expect((await errOf(s.run((svc, ctx) => svc.commitImport(ctx, id, 1, body()))))?.code).toBe('common.not_found');
  }, T);

  it('price_list kind asserts catalog.price_list.manage AFTER the tenant-scoped load: without it -> 403, row untouched, no job', async () => {
    const s = setup({ grants: ['catalog.price_list.read', 'catalog.test.manage', 'catalog.referrer.manage'] });
    const imp = s.seedImport();
    expect((await errOf(commit(s, imp)))?.code).toBe('auth.forbidden');
    expect(s.identity.calls.at(-1)?.permission).toBe('catalog.price_list.manage');
    expect(row(s, imp.id).status).toBe('validated');
    expect(s.db.jobs).toHaveLength(0);
  }, T);

  it('catalog.price_list.manage is privileged: aal1 -> 401/403 auth.mfa_required, nothing changes', async () => {
    const s = setup({ aal: 1 });
    const imp = s.seedImport();
    expect((await errOf(commit(s, imp)))?.code).toBe('auth.mfa_required');
    expect(row(s, imp.id).status).toBe('validated');
    expect(s.db.jobs).toHaveLength(0);
  }, T);

  it('a foreign-tenant id answers 404 even to a caller who lacks the permission (no existence oracle)', async () => {
    const s = setup({ grants: [] });
    const imp = s.seedImport();
    expect((await errOf(commit(s, imp, body(), TENANT_B)))?.code).toBe('common.not_found');
  }, T);
});

describe('importsHandlers.commitImport — HTTP mapping (#102)', () => {
  const hctx = (s: ReturnType<typeof setup>, tx: any, over: Record<string, unknown> = {}) =>
    ({ tenantId: TENANT_A, actor: { type: 'user', id: USER }, tx, now: () => NOW, ports: { IdentityPort: s.identity }, log: { info() {}, warn() {}, error() {} }, ...over });
  const call = (s: ReturnType<typeof setup>, req: Record<string, unknown>, over: Record<string, unknown> = {}) =>
    s.db.run((ctx) => (importsHandlers['commitImport'] as any)(req, hctx(s, ctx.tx, over)), { tenantId: TENANT_A });

  it('202 with the Import body and ETag "<version>"', async () => {
    const s = setup();
    const imp = s.seedImport();
    const v0 = imp.version; // seed returns the live row; commit mutates it
    const res = await call(s, { params: { import_id: imp.id }, headers: { 'if-match': `"${v0}"` }, body: body({ effective_from: EFFECTIVE }) });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ id: imp.id, status: 'committing' });
    expect(res.headers.etag).toBe(`"${v0 + 1}"`);
    expect(s.db.jobs).toHaveLength(1);
  }, T);

  it('missing If-Match -> 428 common.precondition_required; malformed -> 422 common.validation_failed; nothing enqueued', async () => {
    const s = setup();
    const imp = s.seedImport();
    expect((await errOf(call(s, { params: { import_id: imp.id }, headers: {}, body: body() })))?.code).toBe('common.precondition_required');
    expect((await errOf(call(s, { params: { import_id: imp.id }, headers: { 'if-match': 'abc' }, body: body() })))?.code).toBe('common.validation_failed');
    expect(s.db.jobs).toHaveLength(0);
  }, T);

  it('a context without tenant / actor / identity is unauthenticated (fails closed)', async () => {
    const s = setup();
    const imp = s.seedImport();
    const e = await errOf(call(s, { params: { import_id: imp.id }, headers: { 'if-match': `"${imp.version}"` }, body: body() }, { tenantId: undefined }));
    expect(e?.code).toBe('auth.unauthenticated');
  }, T);
});
