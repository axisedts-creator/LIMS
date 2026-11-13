// C10 T-13 — breakpoint lifecycle + suggestions: M46 activateBreakpointSet, M47 retireBreakpointSet, M48 discardBreakpointSet, M13 previewAstInterpretation,
// and `breakpoint.service.lookup` (the single evaluation path M13 and M12 `accept_suggestion` share).
// Spec: 06-IMPLEMENTATION-PLAN row T-13; 02-TRD §4.5, §5 M13/M46–M48, §13; 03-APP-FLOW §2.5 B4–B6 + serialisation paragraph; 05-SCHEMA §8 breakpoint_sets;
//       01-PRD AC-07.1, AC-07.4, AC-07.5 (lookup half), AC-07.6, AC-13.1–13.4 (+13.5 for M48); 07-SECURITY S-10, S-11, T-B1, T-B2, REQ-SEC-024, REQ-SEC-100.
// No database: helpers/bpDb.ts is a multi-transaction fake (READ COMMITTED + row locks + the breakpoint_sets guard, dialect in its header) so "two parallel tx" really
// interleave. The same invariants run against real PostgreSQL in breakpoint.lifecycle.integration.test.ts (skipped without LIMS_TEST_DATABASE_URL).
// SEAMS (spec silent; the writer must match — also in .orchestra/notes/C10.T-13-tests.md):
//   - handlers M46–M48 + M13 are added to breakpointHandlers (handlers/breakpoint.handlers.ts) over service/breakpoint.service.ts + repository/breakpoints.repo.ts;
//     permission FIRST via ctx.ports.IdentityPort.assertRole (M46–M48 'micro.breakpoint.manage' privileged => aal2 inside assertRole; M13 'micro.culture.work').
//   - M46–M48 read If-Match (`"<version>"`, as config.handlers): absent 428 common.precondition_required, malformed 400 /If-Match, stale 409 common.version_conflict.
//     A 200 carries `etag: "<new version>"` and BreakpointDto = setDto(row) with status/effective_from/effective_to/activated_*; version bumps by 1 per UPDATE.
//   - Serialisation (03-APP-FLOW §2.5): activation AND retirement first INSERT ... ON CONFLICT DO NOTHING the tenant's micro.settings row (defaults; created_by/updated_by =
//     actor) and `SELECT ... FROM micro.settings WHERE tenant_id = $n FOR UPDATE`, BEFORE any UPDATE of breakpoint_sets; the settings row is never UPDATEd by them.
//   - Activation closes `status = 'active'` sets of the same tenant + standard (other than this one): status 'retired', effective_to = the new effective_from
//     (retired_by/retired_at not asserted). Retirement: effective_to = greatest(now, effective_from), retired_by = actor, retired_at = ctx.now().
//   - M46 rejects a missing/past (< now - 60 s) effective_from with 400 common.validation_failed errors[0].path '/effective_from'; strict bodies: an unknown key => 400 at '/<key>'.
//   - Reads for M13/lookup are SINGLE-TABLE selects (no JOIN; the fake dialect refuses it): micro.isolates, micro.cultures (specimen_site_code), micro.settings,
//     micro.v_organisms (code -> organism_group_code), micro.breakpoint_sets (filtered by tenant_id), micro.breakpoint_rows, micro.breakpoint_bands; the clock is ctx.now().
//   - service export `lookup(ctx, { organism_code, specimen_site_code, antibiotic_code, method, raw_value, qualifier_code? })` returns the domain BreakpointResult
//     ({ suggestion: { category_code, standard, standard_version, breakpoint_set_id, breakpoint_band_id } } | { suggestion: 'none', reason }) — `reason: 'disabled'` included —
//     never caches, never writes. M12's accept_suggestion re-evaluation (T-10) calls it; M13 results are lookup() results mapped to the wire shape (suggestion omitted when none).
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { loadSpec, REPO_ROOT } from '../../../../core/module.js';
import * as bpService from '../../service/breakpoint.service.js';
import { handlers } from '../index.js';
import { makeDb, NOW, type Db, type Row } from './helpers/bpDb.js';

const spec: any = loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'micro.yaml'));
const specOps = (): Record<string, any> => {
  const out: Record<string, any> = {};
  for (const item of Object.values<any>(spec.paths)) for (const op of Object.values<any>(item)) if (op?.operationId) out[op.operationId] = op;
  return out;
};
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
const schemaErrors = (name: string, x: unknown): string[] => {
  const v = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components });
  return v(x) ? [] : (v.errors ?? []).map((e: any) => `${e.instancePath} ${e.message}`);
};

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const IMPORTER = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const ACTIVATOR = '01a1b34e-1000-7eee-9d29-d7ca59a102b6';
const MANAGE = 'micro.breakpoint.manage';
const WORK = 'micro.culture.work';
const READ = 'micro.culture.read';
const id = (n: number) => `01950c13-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const ms = (v: unknown): number | null => (v == null ? null : new Date(v as string).getTime());
const T = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);
const DAY = 86_400_000;
let n = 100;

// ------------------------------------------------------------------ harness
interface Opt { tenant?: string; actor?: string; grants?: readonly string[]; aal?: 1 | 2; now?: Date; denyWorkInCentre?: string }
async function run(db: Db, op: string, req: { params?: object; query?: object; headers?: object; body?: unknown }, o: Opt = {}) {
  const tenantId = o.tenant ?? A;
  const tx = db.begin(tenantId);
  const access: Row[] = [];
  const published: unknown[] = [];
  const grants = o.grants ?? [MANAGE, WORK, READ];
  const aal = o.aal ?? 2;
  const ctx: any = {
    operationId: op, clientIp: '203.0.113.9', tenantId, tx, requestId: id(++n), now: () => o.now ?? NOW,
    log: { info() {}, warn() {}, error() {} },
    actor: { type: 'user', id: o.actor ?? ACTIVATOR, membershipId: '01a1a98a-ac40-7000-8000-00000000a500' },
    ports: { IdentityPort: {
      async assertRole(_c: unknown, r: { permission: string; centreId?: string }) {
        if (!grants.includes(r?.permission)) throw new LimsError('auth.forbidden');
        if (o.denyWorkInCentre !== undefined && r.permission === WORK && r.centreId === o.denyWorkInCentre) throw new LimsError('auth.forbidden'); // 02-TRD §13 / 03-IC IdentityPort.assertRole: centre-scoped
        if (r.permission === MANAGE && aal < 2) throw new LimsError('auth.mfa_required');
      },
      async getActor() { return { actor: { type: 'user', id: o.actor ?? ACTIVATOR }, permissions: [...grants], centreScope: { all: true, centreIds: [] }, isLocked: false }; },
    } },
    core: { user: async (_c: unknown, i: { userId: string }) => ({ displayName: `Synthetic ${i.userId.slice(-4)}` }) },
    audit: { access: async (e: Row) => { access.push(e); } },
    events: { publish: async (e: unknown) => { published.push(e); return { eventId: 'e', duplicate: false }; } },
    uploads: { accept: async () => { throw new Error('uploads are not part of T-13'); } },
    storage: { delete: async () => undefined },
  };
  try {
    const out: any = await (handlers as any)[op]({ params: {}, query: {}, headers: {}, body: undefined, ...req }, ctx);
    tx.commit();
    return { ...out, access, published, ctx };
  } catch (e) { tx.rollback(); throw e; }
}
const errOf = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as any);
const expectErr = async (p: Promise<unknown>, code: string, status?: number) => {
  const e = await errOf(p);
  expect(e, `expected rejection ${code}`).toBeDefined();
  expect(e.code, String(e?.message)).toBe(code);
  if (status !== undefined) expect(e.statusCode).toBe(status);
  return e;
};
const badPath = async (p: Promise<unknown>, path: string) => { const e = await expectErr(p, 'common.validation_failed', 400); expect(e.errors?.[0]?.path, JSON.stringify(e.errors)).toBe(path); };

const setRow = (over: Row = {}): Row => {
  const sid = over['id'] ?? id(++n);
  return {
    id: sid, tenant_id: A, standard: 'CLSI', standard_version: '2026', title: 'Seeded synthetic', licence_attestation_text: 'Synthetic attestation: seeded test row only.',
    file_bucket: 'micro-imports', file_object_path: `${A}/breakpoints/${sid}.csv`, file_sha256: String(n).padStart(64, 'a'), file_bytes: 10, status: 'validated',
    intended_effective_from: null, validation_started_at: null, validated_at: T(0), row_count: 0, band_count: 0, error_count: 0, warning_count: 0,
    effective_from: null, effective_to: null, activated_by: null, activated_at: null, retired_by: null, retired_at: null,
    version: 1, is_active: true, created_at: T(-DAY), created_by: IMPORTER, updated_at: T(-DAY), updated_by: IMPORTER, ...over,
  };
};
const seedValidated = (db: Db, over: Row = {}) => db.put('breakpoint_sets', setRow(over));
const seedActive = (db: Db, over: Row = {}) => db.put('breakpoint_sets', setRow({ status: 'active', effective_from: T(-10 * DAY), activated_by: ACTIVATOR, activated_at: T(-10 * DAY), version: 2, ...over }));
const seedSettings = (db: Db, over: Row = {}, tenant = A) => db.put('settings', {
  id: id(++n), tenant_id: tenant, manual_ast_standard: 'CLSI', zone_suggestion_enabled: true, mic_suggestion_enabled: false, default_final_no_growth_hours: 48,
  early_final_requires_reason: true, recent_window_days: 7, version: 1, is_active: true, created_by: IMPORTER, updated_by: IMPORTER, created_at: T(-DAY), updated_at: T(-DAY), ...over,
});

const hdr = (version: number | string | undefined, extra: Row = {}) => ({ ...(version === undefined ? {} : { 'if-match': typeof version === 'number' ? `"${version}"` : version }), 'idempotency-key': `k-${++n}`, ...extra });
const act = (db: Db, set: Row, o: Opt & { body?: Row; version?: number | string | undefined } = {}) =>
  run(db, 'activateBreakpointSet', { params: { set_id: set['id'] }, headers: hdr('version' in o ? o.version : set['version']), body: o.body ?? {} }, o);
const retire = (db: Db, set: Row, o: Opt & { version?: number | string | undefined } = {}) =>
  run(db, 'retireBreakpointSet', { params: { set_id: set['id'] }, headers: hdr('version' in o ? o.version : set['version']), body: {} }, o);
const discard = (db: Db, set: Row, o: Opt = {}) =>
  run(db, 'discardBreakpointSet', { params: { set_id: set['id'] }, headers: hdr(set['version']), body: {} }, o);

/** no two active/retired sets of one tenant+standard overlap (zero-length retired periods are fine); at most one is `active`. */
function assertChain(rows: Row[]) {
  const live = rows.filter((r) => ['active', 'retired'].includes(r['status']));
  expect(live.filter((r) => r['status'] === 'active').length, 'at most one active set').toBeLessThanOrEqual(1);
  const per = live.map((r) => ({ s: r, from: ms(r['effective_from'])!, to: r['effective_to'] == null ? Infinity : ms(r['effective_to'])! }));
  for (const p of per) { if (p.s['status'] === 'retired') expect(p.s['effective_to'], 'retired => effective_to').not.toBeNull(); expect(p.to).toBeGreaterThanOrEqual(p.from); }
  for (const a of per) for (const b of per) if (a !== b) expect(a.from < b.to && b.from < a.to, `periods overlap: ${a.s['id']} / ${b.s['id']}`).toBe(false);
}
const inStandard = (db: Db, std = 'CLSI', tenant = A) => db.rows('breakpoint_sets').filter((r) => r['tenant_id'] === tenant && r['standard'] === std);

// ------------------------------------------------------------------ fake self-check (so a red test means the writer's code, not the fake)
describe('C10-T13 fake dialect self-check', () => {
  it('UPDATE ... WHERE with ANY / greatest / now / IN, READ COMMITTED, rollback, FOR UPDATE blocks until commit', async () => {
    const db = makeDb({ spread: false });
    const s1 = db.put('breakpoint_sets', setRow({ status: 'active', effective_from: T(-DAY), version: 2 }));
    const t1 = db.begin(A);
    const r = await t1.query(`UPDATE micro.breakpoint_sets SET status = 'retired', effective_to = greatest($1::timestamptz, effective_from), version = version + 1, updated_at = now()
       WHERE tenant_id = $2 AND id = ANY($3::uuid[]) AND status IN ('active') RETURNING *`, [T(5), A, [s1['id']]]);
    expect(r.rows[0]).toMatchObject({ status: 'retired', version: 3 });
    expect(db.get('breakpoint_sets', s1['id'])!['status']).toBe('active'); // uncommitted
    const t2 = db.begin(A);
    let got: unknown = 'pending';
    const w = t2.query('SELECT * FROM micro.breakpoint_sets WHERE id = $1 FOR UPDATE', [s1['id']]).then((x) => { got = x.rows[0]!['status']; });
    await new Promise((res) => setTimeout(res, 30));
    expect(got).toBe('pending');
    t1.commit();
    await w;
    expect(got).toBe('retired'); // re-read after the lock: sees the committed change
    t2.rollback();
    const t3 = db.begin(A);
    await t3.query("UPDATE micro.breakpoint_sets SET status = 'retired' WHERE id = $1", [s1['id']]).catch(() => undefined);
    t3.rollback();
    expect(db.get('breakpoint_sets', s1['id'])!['effective_to']).toEqual(T(5));
  });
  it('refuses what a lifecycle operation must never do (join, delete, write to rows/bands, bad transition, edit effective_from of an active set)', async () => {
    const db = makeDb({ spread: false });
    const s = db.put('breakpoint_sets', setRow({ status: 'active', effective_from: T(-DAY) }));
    const t = db.begin(A);
    await expect(t.query('SELECT * FROM micro.breakpoint_sets a JOIN micro.settings b ON b.tenant_id = a.tenant_id')).rejects.toThrow(/fake dialect/);
    await expect(t.query('DELETE FROM micro.breakpoint_rows WHERE tenant_id = $1', [A])).rejects.toThrow(/fake dialect/);
    await expect(t.query('UPDATE micro.breakpoint_bands SET category_code = $1 WHERE tenant_id = $2', ['S', A])).rejects.toThrow(/fake dialect/);
    await expect(t.query("UPDATE micro.breakpoint_sets SET status = 'validated' WHERE id = $1", [s['id']])).rejects.toMatchObject({ code: 'P0001' });
    await expect(t.query('UPDATE micro.breakpoint_sets SET effective_from = $1::timestamptz WHERE id = $2', [T(1), s['id']])).rejects.toMatchObject({ code: 'P0001' });
    t.rollback();
  });
});

// ------------------------------------------------------------------ contract
describe('C10-T13 contract pins (micro.yaml + handler map)', () => {
  const EXPECT = {
    activateBreakpointSet: { perm: MANAGE, idem: 'optional', codes: ['micro.breakpoint_set_invalid_transition', 'micro.breakpoint_four_eyes_required', 'auth.mfa_required', 'common.version_conflict', 'common.precondition_required'] },
    retireBreakpointSet: { perm: MANAGE, idem: 'optional', codes: ['micro.breakpoint_set_invalid_transition', 'auth.mfa_required', 'common.version_conflict', 'common.precondition_required'] },
    discardBreakpointSet: { perm: MANAGE, idem: 'optional', codes: ['micro.breakpoint_set_invalid_transition', 'auth.mfa_required', 'common.version_conflict', 'common.precondition_required'] },
    previewAstInterpretation: { perm: WORK, idem: 'none', codes: ['common.validation_failed', 'common.not_found', 'auth.forbidden'] },
  } as const;
  it.each(Object.keys(EXPECT) as (keyof typeof EXPECT)[])('%s: x-permission, idempotency class and error codes of TRD §5', (op) => {
    const o = specOps()[op];
    expect(o, op).toBeDefined();
    expect(o['x-permission']).toBe(EXPECT[op].perm);
    expect(o['x-idempotency']).toBe(EXPECT[op].idem);
    for (const c of EXPECT[op].codes) expect(o['x-error-codes'], c).toContain(c);
  });
  it.each(['activateBreakpointSet', 'retireBreakpointSet', 'discardBreakpointSet'])('%s requires If-Match', (op) => {
    expect(JSON.stringify(specOps()[op].parameters)).toContain('IfMatch');
  });
  it('M46 body is only { effective_from? } (additionalProperties false); M47/M48 take {}; M13 takes 1..60 strict entries', () => {
    const body = (op: string) => specOps()[op].requestBody.content['application/json'].schema;
    expect(body('activateBreakpointSet')).toMatchObject({ additionalProperties: false });
    expect(Object.keys(body('activateBreakpointSet').properties)).toEqual(['effective_from']);
    for (const op of ['retireBreakpointSet', 'discardBreakpointSet']) expect(body(op)).toMatchObject({ additionalProperties: false, properties: {} });
    const e = body('previewAstInterpretation').properties.entries;
    expect(e).toMatchObject({ minItems: 1, maxItems: 60 });
    expect(e.items.additionalProperties).toBe(false);
  });
  it('no operation of the module writes, replaces or deletes breakpoint rows / bands (AC-13.4): only import (create), activate, retire, discard, list/read exist', () => {
    const ops = Object.keys(specOps()).filter((k) => /breakpoint/i.test(k)).sort();
    expect(ops).toEqual(['activateBreakpointSet', 'createBreakpointImport', 'discardBreakpointSet', 'downloadBreakpointTemplate', 'getBreakpointSet', 'listBreakpointImportIssues', 'listBreakpointRows', 'listBreakpointSets', 'retireBreakpointSet']);
  });
  it.each(['activateBreakpointSet', 'retireBreakpointSet', 'discardBreakpointSet', 'previewAstInterpretation'])('%s is a real handler, not the common.internal stub', async (op) => {
    const db = makeDb();
    const e = await errOf(run(db, op, { params: { set_id: id(1), isolate_id: id(1) }, headers: hdr(1), body: op === 'previewAstInterpretation' ? { entries: [{ antibiotic_code: 'synthetic_abx_a', method: 'zone_diameter', raw_value: '20' }] } : {} }, { grants: [] }));
    expect(e?.code).toBe('auth.forbidden');
  });
});

// ------------------------------------------------------------------ permission first (S-10)
describe('C10-T13 permission + aal2 before any SQL (07-SECURITY S-10, T-B1)', () => {
  const OPS = ['activateBreakpointSet', 'retireBreakpointSet', 'discardBreakpointSet'] as const;
  it.each(OPS)('%s without micro.breakpoint.manage => 403 auth.forbidden, zero statements, even for an invalid body/id', async (op) => {
    const db = makeDb();
    const set = seedValidated(db);
    const e = await expectErr(run(db, op, { params: { set_id: 'not-a-uuid' }, headers: {}, body: { junk: 1 } }, { grants: [READ, WORK] }), 'auth.forbidden', 403);
    expect(e).toBeDefined();
    expect(db.log).toHaveLength(0);
    expect(db.get('breakpoint_sets', set['id'])!['status']).toBe('validated');
  });
  it.each(OPS)('%s at aal1 => 403 auth.mfa_required, zero statements', async (op) => {
    const db = makeDb();
    const set = seedValidated(db);
    await expectErr(run(db, op, { params: { set_id: set['id'] }, headers: hdr(1), body: {} }, { aal: 1 }), 'auth.mfa_required', 403);
    expect(db.log).toHaveLength(0);
  });
  it('M13 needs micro.culture.work (read alone => auth.forbidden, zero statements)', async () => {
    const db = makeDb();
    await expectErr(run(db, 'previewAstInterpretation', { params: { isolate_id: id(1) }, body: { entries: [{ antibiotic_code: 'synthetic_abx_a', method: 'zone_diameter', raw_value: '20' }] } }, { grants: [READ] }), 'auth.forbidden', 403);
    expect(db.log).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ M46 activate — AC-13.1
describe('C10-T13 M46 activate: four eyes + effective_from (AC-13.1, S-11, T-B2)', () => {
  it('the importer activating their own import => 403 micro.breakpoint_four_eyes_required; nothing written, no access_log row', async () => {
    const db = makeDb();
    const set = seedValidated(db, { created_by: IMPORTER });
    const before = db.snapshot();
    await expectErr(act(db, set, { actor: IMPORTER }), 'micro.breakpoint_four_eyes_required', 403);
    expect(db.snapshot()).toBe(before);
    expect(db.writeCount()).toBe(0);
  });
  it('a different user activates => 200, status active, activated_by/at, version + 1, etag, BreakpointSetDto-valid, access_log breakpoint_set.activate', async () => {
    const db = makeDb();
    seedSettings(db);
    const set = seedValidated(db);
    const r = await act(db, set, { actor: ACTIVATOR });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: set['id'], status: 'active', version: 2 });
    expect(schemaErrors('BreakpointSetDto', r.body)).toEqual([]);
    expect(r.headers?.['etag'] ?? r.headers?.['ETag']).toBe('"2"');
    const row = db.get('breakpoint_sets', set['id'])!;
    expect(row).toMatchObject({ status: 'active', activated_by: ACTIVATOR, version: 2, updated_by: ACTIVATOR });
    expect(ms(row['activated_at'])).toBe(NOW.getTime());
    expect(r.access).toEqual([expect.objectContaining({ action: 'breakpoint_set.activate', entityType: 'micro_breakpoint_set', entityId: set['id'], outcome: 'allowed' })]);
    expect(JSON.stringify(r.access)).not.toMatch(/file_sha256|licence_attestation/);
  });
  it.each([
    ['intended in the future => honoured', 30 * DAY, 30 * DAY],
    ['intended 30 s ago => honoured (not earlier than now - 60 s)', -30_000, -30_000],
    ['intended exactly now - 60 s => honoured (>=)', -60_000, -60_000],
    ['intended 61 s ago => now', -61_000, 0],
    ['intended 2 years ago => now (never back-dated)', -730 * DAY, 0],
    ['no intended date => now', null, 0],
  ] as const)('default effective_from: %s', async (_name, intended, expected) => {
    const db = makeDb();
    seedSettings(db);
    const set = seedValidated(db, { intended_effective_from: intended === null ? null : T(intended) });
    await act(db, set);
    expect(ms(db.get('breakpoint_sets', set['id'])!['effective_from'])).toBe(NOW.getTime() + expected);
  });
  it('an explicit effective_from wins over intended; exactly now - 60 s and the future are accepted', async () => {
    for (const off of [-60_000, 0, DAY]) {
      const db = makeDb(); seedSettings(db);
      const set = seedValidated(db, { intended_effective_from: T(7 * DAY) });
      await act(db, set, { body: { effective_from: T(off).toISOString() } });
      expect(ms(db.get('breakpoint_sets', set['id'])!['effective_from'])).toBe(NOW.getTime() + off);
    }
  });
  it.each([
    ['now - 60.001 s', T(-60_001).toISOString()],
    ['yesterday', T(-DAY).toISOString()],
    ['not ISO-UTC-ms', '2026-06-15'],
    ['a number', 1_781_500_000_000],
    ['null', null],
  ])('effective_from %s => 400 common.validation_failed at /effective_from, nothing written', async (_n, v) => {
    const db = makeDb();
    const set = seedValidated(db);
    await badPath(act(db, set, { body: { effective_from: v as never } }), '/effective_from');
    expect(db.writeCount()).toBe(0);
  });
  it.each([{ status: 'active' }, { tenant_id: B }, { activated_by: IMPORTER }, { effective_to: T(DAY).toISOString() }])('strict body: %j => 400 at the unknown key (cannot forge provenance)', async (extra) => {
    const db = makeDb();
    const set = seedValidated(db);
    await badPath(act(db, set, { body: extra }), `/${Object.keys(extra)[0]}`);
    expect(db.writeCount()).toBe(0);
  });
  it.each(['uploaded', 'validating', 'invalid', 'active', 'retired', 'discarded'])('a %s set cannot be activated => 409 micro.breakpoint_set_invalid_transition, nothing written', async (status) => {
    const db = makeDb();
    const set = seedValidated(db, { status, effective_from: ['active', 'retired'].includes(status) ? T(-DAY) : null });
    const before = db.snapshot();
    await expectErr(act(db, set, { actor: ACTIVATOR }), 'micro.breakpoint_set_invalid_transition', 409);
    expect(db.snapshot()).toBe(before);
  });
  it('If-Match: absent => 428 common.precondition_required; malformed => 400 /If-Match; stale => 409 common.version_conflict; nothing written in any case', async () => {
    const db = makeDb();
    const set = seedValidated(db, { version: 3 });
    await expectErr(act(db, set, { version: undefined }), 'common.precondition_required', 428);
    await badPath(act(db, set, { version: 'abc' }), '/If-Match');
    await expectErr(act(db, set, { version: 1 }), 'common.version_conflict', 409);
    expect(db.writeCount()).toBe(0);
  });
  it('another tenant\'s set, an unknown id => 404 common.not_found (same answer, S-01); a malformed id => 400 /set_id', async () => {
    const db = makeDb();
    const foreign = seedValidated(db, { tenant_id: B });
    await expectErr(act(db, foreign, { tenant: A }), 'common.not_found', 404);
    await expectErr(run(db, 'activateBreakpointSet', { params: { set_id: id(999_999) }, headers: hdr(1), body: {} }), 'common.not_found', 404);
    await badPath(run(db, 'activateBreakpointSet', { params: { set_id: 'x' }, headers: hdr(1), body: {} }), '/set_id');
    expect(db.get('breakpoint_sets', foreign['id'])!['status']).toBe('validated');
    expect(db.writeCount()).toBe(0);
  });
});

// ------------------------------------------------------------------ M46 closing + serialisation — AC-13.2 / AC-07.6
describe('C10-T13 M46 closes the previous active set (AC-13.2, AC-07.6, 03-APP-FLOW B4)', () => {
  it('previous active of the same standard => retired with effective_to = new effective_from; new => active; other standard / other tenant / non-active sets untouched', async () => {
    const db = makeDb();
    seedSettings(db);
    const prev = seedActive(db);
    const eucast = seedActive(db, { standard: 'EUCAST' });
    const foreign = seedActive(db, { tenant_id: B });
    const stale = seedValidated(db);
    const old = db.put('breakpoint_sets', setRow({ status: 'retired', effective_from: T(-40 * DAY), effective_to: T(-10 * DAY), version: 3 }));
    const next = seedValidated(db);
    const eff = T(2 * 3_600_000);
    await act(db, next, { body: { effective_from: eff.toISOString() } });
    const p = db.get('breakpoint_sets', prev['id'])!;
    expect(p['status']).toBe('retired');
    expect(ms(p['effective_to'])).toBe(eff.getTime());
    expect(ms(p['effective_from'])).toBe(ms(prev['effective_from'])); // frozen
    expect(db.get('breakpoint_sets', next['id'])).toMatchObject({ status: 'active' });
    for (const untouched of [eucast, foreign, stale, old]) expect(db.get('breakpoint_sets', untouched['id'])).toEqual(untouched);
    assertChain(inStandard(db));
  });
  it('first ever activation (no previous active) works and closes nothing', async () => {
    const db = makeDb();
    const next = seedValidated(db);
    const r = await act(db, next);
    expect(r.status).toBe(200);
    expect(inStandard(db).filter((s) => s['status'] === 'retired')).toHaveLength(0);
  });
  it('serialisation: locks the tenant micro.settings row FOR UPDATE before any breakpoint_sets UPDATE, never UPDATEs it; creates it with defaults when absent', async () => {
    const withRow = makeDb({ spread: false });
    const s0 = seedSettings(withRow, { manual_ast_standard: 'EUCAST' });
    seedActive(withRow);
    await act(withRow, seedValidated(withRow));
    const kinds = withRow.log.map((l) => `${l.kind}:${l.table}`);
    const lockAt = kinds.indexOf('for_update:settings');
    const firstUpdate = kinds.indexOf('update:breakpoint_sets');
    expect(lockAt, kinds.join(' ')).toBeGreaterThanOrEqual(0);
    expect(lockAt).toBeLessThan(firstUpdate);
    expect(kinds).not.toContain('update:settings');
    expect(withRow.get('settings', s0['id'])).toEqual(s0);

    const bare = makeDb({ spread: false });
    seedActive(bare);
    await act(bare, seedValidated(bare), { actor: ACTIVATOR });
    const created = bare.rows('settings');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ tenant_id: A, manual_ast_standard: null, zone_suggestion_enabled: true, mic_suggestion_enabled: false, default_final_no_growth_hours: 48, recent_window_days: 7, version: 1, created_by: ACTIVATOR });
    expect(bare.log.map((l) => `${l.kind}:${l.table}`).indexOf('for_update:settings')).toBeLessThan(bare.log.map((l) => `${l.kind}:${l.table}`).indexOf('update:breakpoint_sets'));
  });
  it('atomic: a failure after the previous set was closed (or before) leaves BOTH sets exactly as they were (one transaction)', async () => {
    let rejected = 0; let completed = false;
    for (let k = 1; k <= 8 && !completed; k++) {
      const db = makeDb({ spread: false });
      seedSettings(db);
      const prev = seedActive(db);
      const next = seedValidated(db);
      const before = db.snapshot();
      db.state.failAtWrite = k;
      const e = await errOf(act(db, next));
      if (e) { rejected++; expect(db.snapshot(), `failure at write #${k} must roll everything back`).toBe(before); }
      else { completed = true; expect(db.get('breakpoint_sets', prev['id'])!['status']).toBe('retired'); expect(db.get('breakpoint_sets', next['id'])!['status']).toBe('active'); }
    }
    expect(rejected, 'closing the previous set and activating the new one are separate writes').toBeGreaterThanOrEqual(2);
    expect(completed).toBe(true);
  });
  it('lookups keep using the first set inside its period (AC-07.6 end): future-dated successor, preview at now picks the previous set, at the successor start picks the new one', async () => {
    const db = makeDb();
    const w = world(db);
    const next = seedValidated(db);
    addRow(db, next['id'], { scope: 'any', abx: 'synthetic_abx_a', method: 'zone_diameter' }, [['S', '10', true, null, false]]);
    const eff = T(3_600_000);
    await act(db, next, { body: { effective_from: eff.toISOString() } });
    const before = await preview(db, w, [zone('synthetic_abx_a', '22')], { now: NOW });
    expect(before.body.results[0].suggestion.breakpoint_set_id).toBe(w.setId);
    const after = await preview(db, w, [zone('synthetic_abx_a', '22')], { now: T(3_600_000) });
    expect(after.body.results[0].suggestion.breakpoint_set_id).toBe(next['id']);
    expect(after.body.results[0].suggestion.breakpoint_band_id).not.toBe(before.body.results[0].suggestion.breakpoint_band_id);
  });
});

// ------------------------------------------------------------------ concurrency
describe('C10-T13 M46 concurrency: two parallel transactions (done_when, 03-APP-FLOW §2.5 serialisation)', () => {
  const SEEDS = Array.from({ length: 25 }, (_, i) => i + 1);
  it.each(SEEDS)('seed %i: two validated sets of one standard activated at once => both 200, exactly one active, the other(s) retired, no overlapping periods', async (seed) => {
    const db = makeDb({ seed });
    seedSettings(db);
    const prev = seedActive(db);
    const n1 = seedValidated(db); const n2 = seedValidated(db);
    const res = await Promise.allSettled([act(db, n1, { actor: ACTIVATOR }), act(db, n2, { actor: ACTIVATOR })]);
    expect(res.map((r) => r.status), JSON.stringify(res.map((r) => (r as any).reason?.message))).toEqual(['fulfilled', 'fulfilled']);
    const all = inStandard(db);
    expect(all.filter((s) => s['status'] === 'active')).toHaveLength(1);
    expect(all.filter((s) => s['status'] === 'retired')).toHaveLength(2);
    expect(db.get('breakpoint_sets', prev['id'])!['status']).toBe('retired');
    const active = all.find((s) => s['status'] === 'active')!;
    const closed = all.filter((s) => s['id'] !== active['id'] && s['id'] !== prev['id']);
    expect(ms(closed[0]!['effective_to'])).toBe(ms(active['effective_from'])); // the loser of the race was closed at the winner's start
    assertChain(all);
  });
  it('without a settings row yet (the lock row is created by the first request): still exactly one active', async () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const db = makeDb({ seed });
      const n1 = seedValidated(db); const n2 = seedValidated(db);
      const res = await Promise.allSettled([act(db, n1), act(db, n2)]);
      expect(res.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(inStandard(db).filter((s) => s['status'] === 'active')).toHaveLength(1);
      expect(db.rows('settings')).toHaveLength(1);
    }
  });
  it.each([1, 7, 13])('seed %i: four parallel activations => one active, three + the original retired, a clean chain', async (seed) => {
    const db = makeDb({ seed });
    seedSettings(db);
    seedActive(db);
    const sets = [0, 1, 2, 3].map(() => seedValidated(db));
    const res = await Promise.allSettled(sets.map((s) => act(db, s)));
    expect(res.every((r) => r.status === 'fulfilled'), JSON.stringify(res.map((r) => (r as any).reason?.message))).toBe(true);
    const all = inStandard(db);
    expect(all.filter((s) => s['status'] === 'active')).toHaveLength(1);
    expect(all.filter((s) => s['status'] === 'retired')).toHaveLength(4);
    assertChain(all);
  });
  it.each([2, 5, 9])('seed %i: double submit of the SAME activation => exactly one succeeds (409 on the other), one close, one active', async (seed) => {
    const db = makeDb({ seed });
    seedSettings(db);
    const prev = seedActive(db);
    const next = seedValidated(db);
    const res = await Promise.allSettled([act(db, next), act(db, next)]);
    const ok = res.filter((r) => r.status === 'fulfilled');
    const bad = res.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(['common.version_conflict', 'micro.breakpoint_set_invalid_transition']).toContain(bad[0]!.reason.code);
    expect(bad[0]!.reason.statusCode).toBe(409);
    expect(db.get('breakpoint_sets', next['id'])).toMatchObject({ status: 'active', version: 2 });
    expect(db.get('breakpoint_sets', prev['id'])).toMatchObject({ status: 'retired' });
  });
  it.each([3, 8, 11, 17])('seed %i: retire(active) racing with activate(new) => invariants hold, no 5xx (the loser is a 409 invalid transition at most)', async (seed) => {
    const db = makeDb({ seed });
    seedSettings(db);
    const prev = seedActive(db);
    const next = seedValidated(db);
    const res = await Promise.allSettled([retire(db, prev), act(db, next)]);
    for (const r of res) if (r.status === 'rejected') expect((r.reason as any).code).toBe('micro.breakpoint_set_invalid_transition');
    expect(res[1]!.status).toBe('fulfilled');
    const all = inStandard(db);
    expect(all.filter((s) => s['status'] === 'active')).toHaveLength(1);
    expect(db.get('breakpoint_sets', prev['id'])!['status']).toBe('retired');
    assertChain(all);
  });
  it('tenants do not serialise or close each other: A and B activate in parallel, each ends with exactly one active', async () => {
    const db = makeDb({ seed: 4 });
    seedSettings(db, {}, A); seedSettings(db, {}, B);
    const pa = seedActive(db); const pb = seedActive(db, { tenant_id: B });
    const na = seedValidated(db); const nb = seedValidated(db, { tenant_id: B });
    const res = await Promise.allSettled([act(db, na, { tenant: A }), act(db, nb, { tenant: B })]);
    expect(res.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(db.get('breakpoint_sets', pa['id'])!['status']).toBe('retired');
    expect(db.get('breakpoint_sets', pb['id'])!['status']).toBe('retired');
    expect(inStandard(db, 'CLSI', A).filter((s) => s['status'] === 'active')).toHaveLength(1);
    expect(inStandard(db, 'CLSI', B).filter((s) => s['status'] === 'active')).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ M47 retire — AC-13.3
describe('C10-T13 M47 retire (AC-13.3, 03-APP-FLOW B5)', () => {
  it('active set => retired, effective_to = greatest(now, effective_from) = now, retired_by/at, version + 1, access_log breakpoint_set.retire; AST references untouched', async () => {
    const db = makeDb();
    seedSettings(db);
    const set = seedActive(db);
    const r = await retire(db, set, { actor: IMPORTER });
    expect(r.status).toBe(200);
    expect(schemaErrors('BreakpointSetDto', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ status: 'retired', version: 3 });
    expect(r.headers?.['etag'] ?? r.headers?.['ETag']).toBe('"3"');
    const row = db.get('breakpoint_sets', set['id'])!;
    expect(row).toMatchObject({ status: 'retired', retired_by: IMPORTER });
    expect(ms(row['effective_to'])).toBe(NOW.getTime());
    expect(ms(row['retired_at'])).toBe(NOW.getTime());
    expect(ms(row['effective_from'])).toBe(ms(set['effective_from']));
    expect(r.access).toEqual([expect.objectContaining({ action: 'breakpoint_set.retire', entityType: 'micro_breakpoint_set', entityId: set['id'], outcome: 'allowed' })]);
    expect(db.log.filter((l) => l.kind === 'update').every((l) => l.table === 'breakpoint_sets')).toBe(true); // no ast_results, no rows, no bands
  });
  it('a set that has not started yet (effective_from in the future) retires with effective_to = effective_from (greatest), not in the past', async () => {
    const db = makeDb();
    seedSettings(db);
    const set = seedActive(db, { effective_from: T(2 * DAY) });
    await retire(db, set);
    expect(ms(db.get('breakpoint_sets', set['id'])!['effective_to'])).toBe(NOW.getTime() + 2 * DAY);
  });
  it('after the only active set is retired, a lookup answers no_active_set again only once the period has ended; inside the period the retired set still answers', async () => {
    const db = makeDb();
    const w = world(db);
    await retire(db, db.get('breakpoint_sets', w.setId)!);
    const same = await preview(db, w, [zone('synthetic_abx_a', '22')], { now: NOW });
    expect(same.body.results[0].suggestion).toBeUndefined();
    expect(same.body.results[0].reason).toBe('no_active_set'); // effective_to = now => t < effective_to is false
    const past = await preview(db, w, [zone('synthetic_abx_a', '22')], { now: T(-1000) });
    expect(past.body.results[0].suggestion.breakpoint_set_id).toBe(w.setId);
  });
  it.each(['uploaded', 'validating', 'validated', 'invalid', 'retired', 'discarded'])('a %s set cannot be retired => 409 micro.breakpoint_set_invalid_transition', async (status) => {
    const db = makeDb();
    seedSettings(db);
    const set = seedValidated(db, { status, effective_from: status === 'retired' ? T(-DAY) : null, effective_to: status === 'retired' ? T(-1000) : null });
    const before = db.snapshot();
    await expectErr(retire(db, set), 'micro.breakpoint_set_invalid_transition', 409);
    expect(db.snapshot()).toBe(before);
  });
  it('locks the tenant settings row first (same serialisation as activation); If-Match 428/409; other tenant 404', async () => {
    const db = makeDb({ spread: false });
    seedSettings(db);
    const set = seedActive(db, { version: 4 });
    await expectErr(retire(db, set, { version: undefined }), 'common.precondition_required', 428);
    await expectErr(retire(db, set, { version: 2 }), 'common.version_conflict', 409);
    await expectErr(retire(db, set, { tenant: B }), 'common.not_found', 404);
    db.log.length = 0;
    await retire(db, set);
    const kinds = db.log.map((l) => `${l.kind}:${l.table}`);
    expect(kinds.indexOf('for_update:settings')).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf('for_update:settings')).toBeLessThan(kinds.indexOf('update:breakpoint_sets'));
  });
});

// ------------------------------------------------------------------ M48 discard
describe('C10-T13 M48 discard (AC-13.5, B6)', () => {
  it.each(['uploaded', 'validated', 'invalid'])('%s => discarded (200), version + 1, rows/bands/issues untouched', async (status) => {
    const db = makeDb();
    const set = seedValidated(db, { status });
    const r = await discard(db, set);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'discarded', version: 2 });
    expect(schemaErrors('BreakpointSetDto', r.body)).toEqual([]);
    expect(db.log.filter((l) => l.kind === 'update' || l.kind === 'insert').every((l) => l.table === 'breakpoint_sets')).toBe(true);
  });
  it.each(['validating', 'active', 'retired', 'discarded'])('%s => 409 micro.breakpoint_set_invalid_transition', async (status) => {
    const db = makeDb();
    const set = seedValidated(db, { status, effective_from: ['active', 'retired'].includes(status) ? T(-DAY) : null });
    await expectErr(discard(db, set), 'micro.breakpoint_set_invalid_transition', 409);
  });
  it('If-Match 428 / stale 409; unknown or foreign set 404', async () => {
    const db = makeDb();
    const set = seedValidated(db, { version: 2 });
    await expectErr(run(db, 'discardBreakpointSet', { params: { set_id: set['id'] }, headers: {}, body: {} }), 'common.precondition_required', 428);
    await expectErr(run(db, 'discardBreakpointSet', { params: { set_id: set['id'] }, headers: hdr(1), body: {} }), 'common.version_conflict', 409);
    await expectErr(discard(db, set, { tenant: B }), 'common.not_found', 404);
  });
});

// ------------------------------------------------------------------ M13 + lookup
type World = { setId: string; isolateId: string; cultureId: string; band: Record<string, string> };
const hexId = (() => { let k = 0x5000; return () => id(++k); })();
function addRow(db: Db, setId: string, r: { scope: 'organism' | 'group' | 'any'; org?: string; abx: string; method: 'mic' | 'zone_diameter'; site?: string; qual?: string }, bands: (readonly [string, string | null, boolean, string | null, boolean])[], tenant = A): Record<string, string> {
  const rowId = hexId();
  db.put('breakpoint_rows', { id: rowId, tenant_id: tenant, set_id: setId, line_no: 2, organism_scope: r.scope, organism_code: r.org ?? null, antibiotic_code: r.abx, method: r.method, specimen_site_code: r.site ?? null, qualifier_code: r.qual ?? null, created_at: T(-DAY), created_by: IMPORTER });
  const out: Record<string, string> = {};
  bands.forEach(([cat, lo, loI, hi, hiI], i) => {
    const bandId = hexId();
    out[cat] = bandId;
    db.put('breakpoint_bands', { id: bandId, tenant_id: tenant, set_id: setId, row_id: rowId, band_no: i + 1, category_code: cat, lower_value: lo, lower_inclusive: loI, upper_value: hi, upper_inclusive: hiI, note: 'NOT CLINICAL', created_at: T(-DAY), created_by: IMPORTER });
  });
  return out;
}
/** A: tenant standard CLSI, zone suggestions on, MIC off; an identified isolate of synthetic_org_a (group synthetic_grp_a) on a culture with site synthetic_site_a;
 *  one active CLSI set (synthetic values only, every band note NOT CLINICAL). */
function world(db: Db, o: { settings?: Row; tenant?: string; noSettings?: boolean } = {}): World {
  const tenant = o.tenant ?? A;
  if (!o.noSettings) seedSettings(db, o.settings ?? {}, tenant);
  const cultureId = hexId(); const isolateId = hexId();
  db.put('cultures', { id: cultureId, tenant_id: tenant, centre_id: hexId(), specimen_site_code: 'synthetic_site_a', status: 'incubating', version: 1 });
  db.put('isolates', { id: isolateId, tenant_id: tenant, culture_id: cultureId, centre_id: hexId(), status: 'identified', organism_code: 'synthetic_org_a', organism_source: 'manual', version: 1 });
  db.put('v_organisms', { id: hexId(), code: 'synthetic_org_a', organism_group_code: 'synthetic_grp_a', is_active: true, source: 'tenant' });
  db.put('v_organisms', { id: hexId(), code: 'synthetic_org_b', organism_group_code: null, is_active: true, source: 'tenant' });
  const set = seedActive(db, { tenant_id: tenant, standard_version: 'syn-2026' });
  const sid = set['id'] as string;
  const band: Record<string, string> = {};
  const add = (k: string, b: Record<string, string>) => Object.entries(b).forEach(([c, v]) => { band[`${k}:${c}`] = v; });
  add('a', addRow(db, sid, { scope: 'organism', org: 'synthetic_org_a', abx: 'synthetic_abx_a', method: 'zone_diameter' }, [['R', null, false, '15', false], ['I', '15', true, '20', false], ['S', '20', true, null, false]], tenant));
  add('b', addRow(db, sid, { scope: 'any', abx: 'synthetic_abx_b', method: 'mic' }, [['S', null, false, '2', true], ['R', '2', false, null, false]], tenant));
  add('c', addRow(db, sid, { scope: 'group', org: 'synthetic_grp_a', abx: 'synthetic_abx_c', method: 'zone_diameter' }, [['S', '10', true, null, false]], tenant));
  add('d', addRow(db, sid, { scope: 'any', abx: 'synthetic_abx_d', method: 'zone_diameter' }, [['R', null, false, '10', true], ['S', '20', true, null, false]], tenant));
  return { setId: sid, isolateId, cultureId, band };
}
const zone = (abx: string, v: string, extra: Row = {}) => ({ antibiotic_code: abx, method: 'zone_diameter', raw_value: v, ...extra });
const mic = (abx: string, v: string, extra: Row = {}) => ({ antibiotic_code: abx, method: 'mic', raw_value: v, ...extra });
const preview = (db: Db, w: World, entries: unknown[], o: Opt = {}) => run(db, 'previewAstInterpretation', { params: { isolate_id: w.isolateId }, body: { entries } }, o);
const lookupIn = async (db: Db, input: Row, o: Opt = {}) => {
  const tx = db.begin(o.tenant ?? A);
  const ctx: any = { tenantId: o.tenant ?? A, tx, now: () => o.now ?? NOW, actor: { id: ACTIVATOR }, audit: { access: async () => undefined } };
  try { return await (bpService as any).lookup(ctx, input); } finally { tx.rollback(); }
};
const LOOK = { organism_code: 'synthetic_org_a', specimen_site_code: 'synthetic_site_a' };

describe('C10-T13 M13 previewAstInterpretation (AC-07.1, AC-07.4; never writes)', () => {
  it('AC-07.1: zone value => the band\'s category + breakpoint_set_id, breakpoint_band_id, standard, standard_version; nothing saved, no event, no access_log', async () => {
    const db = makeDb();
    const w = world(db);
    const before = db.snapshot();
    const r = await preview(db, w, [zone('synthetic_abx_a', '22')]);
    expect(r.status).toBe(200);
    expect(r.body.results).toEqual([{ antibiotic_code: 'synthetic_abx_a', method: 'zone_diameter', suggestion: { category_code: 'S', standard: 'CLSI', standard_version: 'syn-2026', breakpoint_set_id: w.setId, breakpoint_band_id: w.band['a:S'] } }]);
    expect(db.snapshot()).toBe(before);
    expect(db.writeCount()).toBe(0);
    expect(db.log.every((l) => l.kind === 'select')).toBe(true);
    expect(r.published).toEqual([]);
    expect(r.access).toEqual([]);
  });
  it('M13 asserts micro.culture.work with the isolate\'s centre_id (02-TRD §13 object first, then permission with centre): denied in that centre => 403 auth.forbidden, no breakpoint reads', async () => {
    const db = makeDb();
    const w = world(db);
    const centre = db.get('isolates', w.isolateId)!['centre_id'] as string;
    const before = db.log.length;
    await expectErr(preview(db, w, [zone('synthetic_abx_a', '22')], { denyWorkInCentre: centre }), 'auth.forbidden', 403);
    expect(db.log.slice(before).filter((l) => l.table.startsWith('breakpoint_')), 'no breakpoint_* statements after the centre check fails').toEqual([]);
    expect(db.writeCount()).toBe(0);
    // control: the same call succeeds when the centre is not denied
    expect((await preview(db, w, [zone('synthetic_abx_a', '22')], { denyWorkInCentre: hexId() })).status).toBe(200);
  });
  it('exact decimal band edges: 14.99 => R, 15 => I (inclusive lower), 19.99 => I, 20 => S, 20.01 => S', async () => {
    const db = makeDb();
    const w = world(db);
    const r = await preview(db, w, ['14.99', '15', '19.99', '20', '20.01'].map((v) => zone('synthetic_abx_a', v)));
    expect(r.body.results.map((x: Row) => x['suggestion'].category_code)).toEqual(['R', 'I', 'I', 'S', 'S']);
  });
  it('one result per entry, in request order; a none result has no `suggestion` key and a reason (never the string "none")', async () => {
    const db = makeDb();
    const w = world(db);
    const r = await preview(db, w, [zone('synthetic_abx_a', '22'), zone('synthetic_abx_z', '22'), zone('synthetic_abx_d', '15'), zone('synthetic_abx_a', 'abc'), zone('synthetic_abx_a', '150')]);
    expect(r.body.results.map((x: Row) => x['antibiotic_code'])).toEqual(['synthetic_abx_a', 'synthetic_abx_z', 'synthetic_abx_d', 'synthetic_abx_a', 'synthetic_abx_a']);
    expect(r.body.results.map((x: Row) => x['reason'])).toEqual([undefined, 'no_row', 'indeterminate', 'value_invalid', 'value_invalid']);
    for (const x of r.body.results.slice(1)) expect(x['suggestion']).toBeUndefined();
    expect(Object.keys(r.body.results[0]).sort()).toEqual(['antibiotic_code', 'method', 'suggestion']);
  });
  it('group row used through v_organisms (isolate organism -> organism_group_code); an organism without a group never matches a group row', async () => {
    const db = makeDb();
    const w = world(db);
    expect((await preview(db, w, [zone('synthetic_abx_c', '12')])).body.results[0].suggestion.category_code).toBe('S');
    db.put('isolates', { ...db.get('isolates', w.isolateId)!, organism_code: 'synthetic_org_b' });
    expect((await preview(db, w, [zone('synthetic_abx_c', '12')])).body.results[0].reason).toBe('no_row');
  });
  it('AC-07.3 at the service level: MIC `<=4` spanning two bands => indeterminate; `1` => S', async () => {
    const db = makeDb();
    const w = world(db, { settings: { mic_suggestion_enabled: true } });
    const r = await preview(db, w, [mic('synthetic_abx_b', '<=4'), mic('synthetic_abx_b', '1'), mic('synthetic_abx_b', '>2')]);
    expect(r.body.results.map((x: Row) => x['suggestion']?.category_code ?? x['reason'])).toEqual(['indeterminate', 'S', 'R']);
  });
  it('AC-07.4: method mic with mic_suggestion_enabled = false (default) => reason disabled, no suggestion (even though a matching row exists)', async () => {
    const db = makeDb();
    const w = world(db); // mic off
    const r = await preview(db, w, [mic('synthetic_abx_b', '1')]);
    expect(r.body.results[0]).toEqual({ antibiotic_code: 'synthetic_abx_b', method: 'mic', reason: 'disabled' });
  });
  it('zone_suggestion_enabled = false => disabled for zones; manual_ast_standard unset => no suggestion (disabled); method other => no suggestion', async () => {
    const db1 = makeDb(); const w1 = world(db1, { settings: { zone_suggestion_enabled: false } });
    expect((await preview(db1, w1, [zone('synthetic_abx_a', '22')])).body.results[0]).toEqual({ antibiotic_code: 'synthetic_abx_a', method: 'zone_diameter', reason: 'disabled' });
    const db2 = makeDb(); const w2 = world(db2, { settings: { manual_ast_standard: null } });
    const r2 = (await preview(db2, w2, [zone('synthetic_abx_a', '22')])).body.results[0];
    expect(r2.suggestion).toBeUndefined();
    expect(['disabled', 'no_active_set']).toContain(r2.reason);
    const db3 = makeDb(); const w3 = world(db3);
    const r3 = (await preview(db3, w3, [{ antibiotic_code: 'synthetic_abx_a', method: 'other', raw_value: 'positive' }])).body.results[0];
    expect(r3.suggestion).toBeUndefined();
    expect(['disabled', 'value_invalid']).toContain(r3.reason);
  });
  it('no settings row at all => defaults => no suggestion (standard unset), not an error, and the preview still writes nothing (no lazily created settings row)', async () => {
    const db = makeDb();
    const w = world(db, { noSettings: true });
    const r = await preview(db, w, [zone('synthetic_abx_a', '22')]);
    expect(r.status).toBe(200);
    expect(r.body.results[0].suggestion).toBeUndefined();
    expect(db.rows('settings')).toHaveLength(0);
    expect(db.writeCount()).toBe(0);
  });
  it('only active/retired sets count: a validated set of the tenant standard is ignored => no_active_set; a set of another standard is ignored', async () => {
    const db = makeDb();
    const w = world(db);
    db.put('breakpoint_sets', { ...db.get('breakpoint_sets', w.setId)!, status: 'validated', effective_from: null });
    expect((await preview(db, w, [zone('synthetic_abx_a', '22')])).body.results[0].reason).toBe('no_active_set');
    db.put('breakpoint_sets', { ...db.get('breakpoint_sets', w.setId)!, status: 'active', effective_from: T(-DAY), standard: 'EUCAST' });
    expect((await preview(db, w, [zone('synthetic_abx_a', '22')])).body.results[0].reason).toBe('no_active_set');
  });
  it('tenant isolation (REQ-SEC-024): tenant B\'s active set is invisible to tenant A', async () => {
    const db = makeDb();
    const w = world(db);
    const wb = world(db, { tenant: B });
    db.put('breakpoint_sets', { ...db.get('breakpoint_sets', w.setId)!, status: 'validated', effective_from: null });
    const r = await preview(db, w, [zone('synthetic_abx_a', '22')]);
    expect(r.body.results[0].reason).toBe('no_active_set');
    expect(wb.setId).not.toBe(w.setId);
  });
  it('isolate of another tenant / unknown => 404 common.not_found; malformed isolate id => 400 /isolate_id', async () => {
    const db = makeDb();
    const w = world(db); const wb = world(db, { tenant: B });
    await expectErr(preview(db, wb, [zone('synthetic_abx_a', '22')], { tenant: A }), 'common.not_found', 404);
    await expectErr(run(db, 'previewAstInterpretation', { params: { isolate_id: id(777_777) }, body: { entries: [zone('synthetic_abx_a', '22')] } }), 'common.not_found', 404);
    await badPath(run(db, 'previewAstInterpretation', { params: { isolate_id: 'x' }, body: { entries: [zone('synthetic_abx_a', '22')] } }), '/isolate_id');
    expect(w.isolateId).toBeDefined();
  });
  it('entries: 0 or 61 => 400 /entries; unknown key (standard, organism_code, breakpoint_band_id) => 400 at that path; bad method / code => 400; 60 is fine', async () => {
    const db = makeDb();
    const w = world(db);
    await badPath(preview(db, w, []), '/entries');
    await badPath(preview(db, w, Array.from({ length: 61 }, () => zone('synthetic_abx_a', '22'))), '/entries');
    for (const k of ['standard', 'organism_code', 'breakpoint_band_id']) await badPath(preview(db, w, [zone('synthetic_abx_a', '22', { [k]: 'x' })]), `/entries/0/${k}`);
    await badPath(preview(db, w, [{ antibiotic_code: 'synthetic_abx_a', method: 'disk', raw_value: '1' }]), '/entries/0/method');
    await badPath(preview(db, w, [zone('Bad Code', '22')]), '/entries/0/antibiotic_code');
    await badPath(preview(db, w, [zone('synthetic_abx_a', '')]), '/entries/0/raw_value');
    const ok = await preview(db, w, Array.from({ length: 60 }, () => zone('synthetic_abx_a', '22')));
    expect(ok.body.results).toHaveLength(60);
    expect(db.writeCount()).toBe(0);
  });
  it('60 entries do not issue one query set per entry (bounded statement count — REQ-SEC-100)', async () => {
    const db = makeDb({ spread: false });
    const w = world(db);
    await preview(db, w, Array.from({ length: 60 }, (_, i) => zone(i % 2 ? 'synthetic_abx_a' : 'synthetic_abx_d', '22')));
    expect(db.log.length).toBeLessThanOrEqual(30);
  });
});

describe('C10-T13 breakpoint.service.lookup: the one evaluation path; accept_suggestion re-evaluates (TRD §4.5 step 5; AC-07.5 lookup half)', () => {
  it('lookup() returns what M13 returns for the same input (same band id), and never writes', async () => {
    const db = makeDb();
    const w = world(db);
    const l = await lookupIn(db, { ...LOOK, antibiotic_code: 'synthetic_abx_a', method: 'zone_diameter', raw_value: '17' });
    expect(l).toEqual({ suggestion: { category_code: 'I', standard: 'CLSI', standard_version: 'syn-2026', breakpoint_set_id: w.setId, breakpoint_band_id: w.band['a:I'] } });
    const p = await preview(db, w, [zone('synthetic_abx_a', '17')]);
    expect(p.body.results[0].suggestion.breakpoint_band_id).toBe((l as any).suggestion.breakpoint_band_id);
    expect(db.writeCount()).toBe(0);
  });
  it('lookup() answers { suggestion: "none", reason } for none/disabled cases', async () => {
    const db = makeDb();
    world(db);
    expect(await lookupIn(db, { ...LOOK, antibiotic_code: 'synthetic_abx_z', method: 'zone_diameter', raw_value: '17' })).toEqual({ suggestion: 'none', reason: 'no_row' });
    expect(await lookupIn(db, { ...LOOK, antibiotic_code: 'synthetic_abx_b', method: 'mic', raw_value: '1' })).toEqual({ suggestion: 'none', reason: 'disabled' });
    expect(await lookupIn(db, { ...LOOK, antibiotic_code: 'synthetic_abx_a', method: 'zone_diameter', raw_value: '1x' })).toEqual({ suggestion: 'none', reason: 'value_invalid' });
  });
  it('re-evaluation sees the CURRENT state, not a cache: after a new set is activated the band id of an earlier preview no longer matches (mismatch is detectable); after retire => no_active_set', async () => {
    const db = makeDb();
    const w = world(db);
    const first = (await lookupIn(db, { ...LOOK, antibiotic_code: 'synthetic_abx_a', method: 'zone_diameter', raw_value: '22' })) as any;
    expect(first.suggestion.breakpoint_band_id).toBe(w.band['a:S']);

    const next = seedValidated(db);
    const bands = addRow(db, next['id'], { scope: 'any', abx: 'synthetic_abx_a', method: 'zone_diameter' }, [['I', '10', true, null, false]]);
    await act(db, next, { body: { effective_from: NOW.toISOString() } });
    const second = (await lookupIn(db, { ...LOOK, antibiotic_code: 'synthetic_abx_a', method: 'zone_diameter', raw_value: '22' })) as any;
    expect(second.suggestion.breakpoint_set_id).toBe(next['id']);
    expect(second.suggestion.breakpoint_band_id).toBe(bands['I']);
    expect(second.suggestion.breakpoint_band_id).not.toBe(first.suggestion.breakpoint_band_id);

    await retire(db, db.get('breakpoint_sets', next['id'])!);
    expect(await lookupIn(db, { ...LOOK, antibiotic_code: 'synthetic_abx_a', method: 'zone_diameter', raw_value: '22' })).toEqual({ suggestion: 'none', reason: 'no_active_set' });
  });
  it('is tenant-bound: another tenant\'s active set is never used', async () => {
    const db = makeDb();
    const w = world(db);
    db.put('breakpoint_sets', { ...db.get('breakpoint_sets', w.setId)!, tenant_id: B });
    expect(await lookupIn(db, { ...LOOK, antibiotic_code: 'synthetic_abx_a', method: 'zone_diameter', raw_value: '22' })).toEqual({ suggestion: 'none', reason: 'no_active_set' });
  });
});
