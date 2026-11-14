// C10 T-09 — M7 createIsolate, M8 identifyIsolate, M9 describeIsolate, M10 withdrawIsolate against the migrated database (06 row T-09; 08 A17 P-22; 02-TRD §5 M7–M10, §12 SQLSTATE mapping;
// 05-SCHEMA §4 RLS, §8 constraints + triggers + grants; PRD AC-05.1–05.5; 07-SECURITY T-A1–T-A3, S-01–S-04, S-08, S-29).
// Needs the micro DDL + RLS of 05-SCHEMA applied (C0 prerequisite, 06 §1): LIMS_TEST_DATABASE_URL = role lims_api (RLS on), LIMS_TEST_ADMIN_DATABASE_URL = superuser.
// Without them the DB tests skip, except under LIMS_T09_REQUIRE_DB=1 where "database is provided" fails. (Same harness status as C10 T-05/T-07/T-08: no micro migration in db/migrations yet.)
// SEAMS: as isolate.writes.test.ts; ctx.tx = the request tx under RLS with claims { tenant_id, sub, actor_type: 'user', membership_id }; IdentityPort / CatalogPort / core.* are hand fakes (helpers/cultureReads.ts).
//   AC-05.3 "the audit log keeps old/new": rows of audit.audit_log (schema_name 'micro', table_name 'isolates', row_id, old_values / new_values; written by the generic audit trigger, 08 A28).
// Isolation: every test creates its own cultures / specimens (append-only tables; nothing is deleted); organisms / reasons are unique per run.
// Synthetic data only.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { mkCtx, responseErrors, run, WORK, type Row } from './helpers/cultureReads.js';

const API_URL = process.env['LIMS_TEST_DATABASE_URL'];
const ADMIN_URL = process.env['LIMS_TEST_ADMIN_DATABASE_URL'];
const live = Boolean(API_URL && ADMIN_URL);
const REQUIRE = process.env['LIMS_T09_REQUIRE_DB'] === '1';

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const RUN = Date.now();
let seqN = 0;
const uid = () => `0190c60e-0000-7000-8000-${(RUN % 0xffffffff).toString(16).padStart(8, '0')}${(++seqN).toString(16).padStart(4, '0')}`;
const NOW = new Date('2026-11-05T05:00:00.000Z');                       // ctx.now() of mkCtx
const PLANTED = '2026-11-04T05:00:00.000Z';
const CODE = { ecoli: `syn_t09_ecoli_${RUN}`, staph: `syn_t09_staph_${RUN}`, old: `syn_t09_old_${RUN}`, contaminant: `syn_t09_contam_${RUN}`, dup: `syn_t09_dup_${RUN}`, oldReason: `syn_t09_oldr_${RUN}` };

let api: pg.Pool;
let admin: pg.Pool;
const q = async (text: string, values: unknown[] = []) => (await admin.query(text, values)).rows;

async function seedRow(table: string, given: Record<string, unknown>, onConflict = ''): Promise<void> {
  const [schema, name] = table.split('.') as [string, string];
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL session_replication_role = 'replica'");        // seed rows without FK / trigger noise; the handlers run on the real constraints
    const cols = (await c.query(`SELECT column_name, udt_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2
      AND is_nullable = 'NO' AND column_default IS NULL AND is_generated = 'NEVER' AND is_identity = 'NO'`, [schema, name])).rows as { column_name: string; udt_name: string }[];
    const row: Record<string, unknown> = { ...given };
    for (const { column_name, udt_name } of cols) {
      if (column_name in row) continue;
      row[column_name] = udt_name === 'uuid' ? uid() : /^(int|numeric|float)/.test(udt_name) ? 1 : udt_name === 'bool' ? false : udt_name === 'timestamptz' || udt_name === 'timestamp' ? NOW
        : udt_name === 'date' ? '2026-11-01' : udt_name === 'jsonb' || udt_name === 'json' ? '[]' : `syn-${seqN}`;
    }
    const keys = Object.keys(row);
    await c.query(`INSERT INTO ${table} (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) ${onConflict}`,
      keys.map((k) => (row[k] !== null && typeof row[k] === 'object' && !(row[k] instanceof Date) && !Array.isArray(row[k]) ? JSON.stringify(row[k]) : row[k])));
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

const W = { order: uid(), centreA1: uid(), centreA2: uid(), centreB1: uid(), patient: uid(), memHub: uid(), memA1: uid(), memB: uid(), userTech: uid(), test: uid() };
const TECH = 'Synthetic Tech Isolates';

beforeAll(async () => {
  if (!live) { if (REQUIRE) throw new Error('database is provided: set LIMS_TEST_DATABASE_URL (lims_api) and LIMS_TEST_ADMIN_DATABASE_URL (superuser)'); return; }
  api = new pg.Pool({ connectionString: API_URL, max: 24 }); admin = new pg.Pool({ connectionString: ADMIN_URL, max: 4 });
  for (const t of [A, B]) await seedRow('core.tenants', { id: t }, 'ON CONFLICT DO NOTHING');
  for (const [t, id] of [[A, W.centreA1], [A, W.centreA2], [B, W.centreB1]] as const) await seedRow('core.collection_centres', { tenant_id: t, id });
  await seedRow('core.users', { tenant_id: A, id: W.userTech, display_name: TECH });
  for (const [t, id, all] of [[A, W.memHub, true], [A, W.memA1, false], [B, W.memB, true]] as const)
    await seedRow('core.memberships', { tenant_id: t, id, user_id: W.userTech, actor_type: 'user', status: 'active', is_active: true, all_centres: all });
  await seedRow('core.membership_centres', { tenant_id: A, membership_id: W.memA1, centre_id: W.centreA1 });
  await seedRow('frontdesk.patients', { tenant_id: A, id: W.patient });
  await seedRow('catalog.tests', { tenant_id: A, id: W.test });
  for (const [c, display, active] of [[CODE.ecoli, 'Synthetic E. coli', true], [CODE.staph, 'Synthetic S. aureus', true], [CODE.old, 'Synthetic retired organism', false]] as const)
    await seedRow('micro.cs_organisms', { tenant_id: A, code: c, display, is_active: active, created_by: SYS, updated_by: SYS }, 'ON CONFLICT DO NOTHING');
  for (const [c, display, active] of [[CODE.contaminant, 'Synthetic contaminant', true], [CODE.dup, 'Synthetic duplicate', true], [CODE.oldReason, 'Synthetic retired reason', false]] as const)
    await seedRow('micro.cs_isolate_withdraw_reasons', { tenant_id: A, code: c, display, is_active: active, created_by: SYS, updated_by: SYS }, 'ON CONFLICT DO NOTHING');
});
afterAll(async () => { await api?.end(); await admin?.end(); });

interface NewC { status?: string; centre?: string; tenant?: string; specimen?: string }
/** A culture with its own specimen row (the counter has a real FK to lab.specimens) and one plate. */
async function newCulture(o: NewC = {}): Promise<{ id: string; specimen: string; plate: string }> {
  const id = uid(); const status = o.status ?? 'incubating'; const specimen = o.specimen ?? uid(); const tenant = o.tenant ?? A;
  if (!o.specimen) await seedRow('lab.specimens', { tenant_id: tenant, id: specimen });
  await seedRow('micro.cultures', { id, tenant_id: tenant, centre_id: o.centre ?? W.centreA1, order_id: W.order, order_item_id: uid(), specimen_id: specimen, patient_id: W.patient, test_id: W.test,
    specimen_type_code: 'urine', status, received_at: '2026-11-04T04:00:00.000Z', planted_at: status === 'awaiting_setup' ? null : PLANTED, last_specimen_seq: 1, created_by: SYS, updated_by: SYS, version: 1 });
  const plate = uid();
  await seedRow('micro.culture_plates', { id: plate, tenant_id: tenant, centre_id: o.centre ?? W.centreA1, culture_id: id, plate_no: 1, media_code: 'syn_blood', planted_at: PLANTED, status: 'active', created_by: SYS, updated_by: SYS });
  return { id, specimen, plate };
}
async function newIsolate(c: { id: string; specimen: string }, seq: number, o: Row = {}): Promise<string> {
  const id = uid();
  await seedRow('micro.isolates', { id, tenant_id: o['tenant_id'] ?? A, centre_id: o['centre_id'] ?? W.centreA1, culture_id: c.id, specimen_id: c.specimen, isolate_seq: seq, status: 'pending_id', is_reportable: true,
    created_by: SYS, updated_by: SYS, version: 2, ...o });
  await seedRow('micro.specimen_isolate_counters', { tenant_id: o['tenant_id'] ?? A, specimen_id: c.specimen, last_seq: seq, created_by: SYS, updated_by: SYS }, 'ON CONFLICT (tenant_id, specimen_id) DO UPDATE SET last_seq = GREATEST(micro.specimen_isolate_counters.last_seq, EXCLUDED.last_seq)');
  return id;
}
const cul = async (id: string) => (await q('SELECT * FROM micro.cultures WHERE id = $1', [id]))[0]!;
const isolatesOf = (cultureId: string) => q('SELECT * FROM micro.isolates WHERE culture_id = $1 ORDER BY isolate_seq', [cultureId]);
const isoRow = async (id: string) => (await q('SELECT * FROM micro.isolates WHERE id = $1', [id]))[0]!;
const counterOf = async (specimen: string) => (await q('SELECT last_seq FROM micro.specimen_isolate_counters WHERE specimen_id = $1', [specimen]))[0]?.last_seq;
const transitions = (id: string) => q('SELECT * FROM micro.culture_transitions WHERE culture_id = $1 ORDER BY occurred_at, created_at', [id]);
const auditOf = (id: string) => q(`SELECT action, changed_columns, old_values, new_values FROM audit.audit_log WHERE schema_name = 'micro' AND table_name = 'isolates' AND row_id = $1 ORDER BY occurred_at, id`, [id]);
const isoAt = (d: unknown) => (d ? new Date(d as any).toISOString() : null);

interface Who { tenant: string; membership: string; centres?: string[]; all?: boolean }
const HUB: Who = { get tenant() { return A; }, get membership() { return W.memHub; }, all: true };
const A1: Who = { get tenant() { return A; }, get membership() { return W.memA1; }, get centres() { return [W.centreA1]; }, all: false };
const asB: Who = { get tenant() { return B; }, get membership() { return W.memB; }, all: true };

async function call(who: Who, op: string, req: Row, grants: string[] = [WORK]): Promise<{ res?: any; err?: any }> {
  const client = await api.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ tenant_id: who.tenant, sub: SYS, actor_type: 'user', membership_id: who.membership })]);
    const { ctx } = mkCtx({ tenantId: who.tenant, tx: client, grants, actor: { type: 'user', id: SYS, membershipId: who.membership }, centreScope: { all: who.all === true, centreIds: who.centres ?? [] },
      tests: { [W.test]: { code: 'SYN_URINE', name: 'Synthetic Urine Culture' } }, members: { [W.memHub]: TECH, [W.memA1]: TECH }, users: { [W.userTech]: TECH } });
    try { const res = await run(op, req, ctx); await client.query('COMMIT'); return { res }; } catch (err) { await client.query('ROLLBACK'); return { err }; }
  } finally { client.release(); }
}
const ok = async (p: Promise<{ res?: any; err?: any }>) => { const r = await p; if (r.err) throw r.err; return r.res; };
const bad = async (p: Promise<{ res?: any; err?: any }>, code: string) => { const r = await p; expect(r.err, `expected ${code}`).toBeDefined(); expect(isLimsError(r.err, code), `${r.err?.code ?? r.err}`).toBe(true); return r.err; };
const ifm = (v: number) => ({ 'if-match': `"${v}"` });
const createReq = (id: string, body: Row = {}) => ({ params: { culture_id: id }, headers: { 'idempotency-key': `k-${uid()}` }, body });
const isoReq = (id: string, body: Row, v: number) => ({ params: { isolate_id: id }, headers: ifm(v), body });

describe.skipIf(!live && !REQUIRE)('T-09 isolates (live DB)', () => {
  it('database is provided', () => { expect(live).toBe(true); });

  describe('AC-05.1 createIsolate numbering', () => {
    it('specimen with isolates 1 (culture X) and 2 (culture Y of the same specimen): create on X -> 3; the culture incubating -> growth_detected with one transition row; counter 3; audit INSERT row', async () => {
      const x = await newCulture(); const y = await newCulture({ specimen: x.specimen });
      await newIsolate(x, 1); await newIsolate(y, 2);
      const res = await ok(call(HUB, 'createIsolate', createReq(x.id, { colony_description: 'Synthetic colony', plate_id: x.plate })));
      expect(res.body).toMatchObject({ isolate_seq: 3, status: 'pending_id', version: 1, is_reportable: true });
      expect(responseErrors('createIsolate', res.body)).toEqual([]);
      expect(await counterOf(x.specimen)).toBe(3);
      expect(await cul(x.id)).toMatchObject({ status: 'growth_detected' });
      expect((await transitions(x.id)).map((t) => [t.from_status, t.to_status])).toEqual([['incubating', 'growth_detected']]);
      expect(await isoRow(res.body.id)).toMatchObject({ tenant_id: A, centre_id: W.centreA1, culture_id: x.id, specimen_id: x.specimen, plate_id: x.plate, created_by: SYS });
      expect((await auditOf(res.body.id)).map((a) => a.action)).toEqual(['INSERT']);
    });

    it('lazy counter row: a specimen without one gets isolate 1 and a counter row; the same organism twice gives two isolates (AC-05.5)', async () => {
      const x = await newCulture();
      expect(await counterOf(x.specimen)).toBeUndefined();
      const r1 = await ok(call(HUB, 'createIsolate', createReq(x.id, { organism_code: CODE.ecoli })));
      const r2 = await ok(call(HUB, 'createIsolate', createReq(x.id, { organism_code: CODE.ecoli })));
      expect([r1.body.isolate_seq, r2.body.isolate_seq]).toEqual([1, 2]);
      expect(await counterOf(x.specimen)).toBe(2);
      expect(r1.body).toMatchObject({ status: 'identified', organism_code: CODE.ecoli, organism_display: 'Synthetic E. coli', organism_source: 'manual' });
      expect((await transitions(x.id)).map((t) => t.to_status)).toEqual(['growth_detected']);
    });

    it('done_when: 20 parallel creates on one culture -> isolate_seq 1..20 each once, counter 20, one transition row, no error', async () => {
      const x = await newCulture();
      const out = await Promise.all(Array.from({ length: 20 }, () => call(HUB, 'createIsolate', createReq(x.id, { colony_description: 'Synthetic parallel' }))));
      expect(out.filter((o) => o.err).map((o) => o.err?.code ?? String(o.err))).toEqual([]);
      expect(out.map((o) => o.res.body.isolate_seq).sort((a: number, b: number) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      expect((await isolatesOf(x.id)).map((r) => r.isolate_seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      expect(await counterOf(x.specimen)).toBe(20);
      expect(await transitions(x.id)).toHaveLength(1);
      expect((await cul(x.id)).status).toBe('growth_detected');
    });

    it('20 parallel creates split over TWO cultures of one specimen share the counter: 1..20, no duplicate', async () => {
      const x = await newCulture(); const y = await newCulture({ specimen: x.specimen });
      const out = await Promise.all(Array.from({ length: 20 }, (_, i) => call(HUB, 'createIsolate', createReq(i % 2 ? x.id : y.id))));
      expect(out.filter((o) => o.err).map((o) => o.err?.code ?? String(o.err))).toEqual([]);
      expect(out.map((o) => o.res.body.isolate_seq).sort((a: number, b: number) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      expect(await counterOf(x.specimen)).toBe(20);
    });

    it('a refused create (unknown organism -> 422) rolls the counter back with the request: the next create takes the next number without a gap', async () => {
      const x = await newCulture();
      await bad(call(HUB, 'createIsolate', createReq(x.id, { organism_code: 'syn_t09_nope' })), 'micro.organism_code_unknown');
      await bad(call(HUB, 'createIsolate', createReq(x.id, { organism_code: CODE.old })), 'micro.organism_code_unknown');
      expect(await counterOf(x.specimen)).toBeUndefined();
      expect(await isolatesOf(x.id)).toEqual([]);
      const r = await ok(call(HUB, 'createIsolate', createReq(x.id)));
      expect(r.body.isolate_seq).toBe(1);
    });

    it('culture states: awaiting_setup / cancelled -> 409 micro.culture_invalid_transition; final_submitted -> 409 micro.report_final_locked; amending accepts; nothing written on refusals', async () => {
      for (const [status, code] of [['awaiting_setup', 'micro.culture_invalid_transition'], ['cancelled', 'micro.culture_invalid_transition'], ['final_submitted', 'micro.report_final_locked']] as const) {
        const x = await newCulture({ status });
        await bad(call(HUB, 'createIsolate', createReq(x.id)), code);
        expect(await isolatesOf(x.id)).toEqual([]);
        expect(await counterOf(x.specimen)).toBeUndefined();
      }
      const am = await newCulture({ status: 'amending' });
      expect((await ok(call(HUB, 'createIsolate', createReq(am.id)))).body.isolate_seq).toBe(1);
      expect((await cul(am.id)).status).toBe('amending');
    });

    it('the counter ceiling: at 99 the next create is refused (4xx), nothing written, counter stays 99 (specimen_isolate_counters__seq__ck / isolates__seq__ck)', async () => {
      const x = await newCulture();
      await newIsolate(x, 99);
      const r = await call(HUB, 'createIsolate', createReq(x.id));
      expect(r.err, 'expected a refusal').toBeDefined();
      expect(r.err.statusCode).toBeGreaterThanOrEqual(400);
      expect(r.err.statusCode).toBeLessThan(500);
      expect(await counterOf(x.specimen)).toBe(99);
      expect(await isolatesOf(x.id)).toHaveLength(1);
    });
  });

  describe('AC-05.2 / AC-05.3 identify and re-identify; AC-05.4 withdraw; describe', () => {
    it('AC-05.2 identify: pending_id -> identified (manual, identified_at, identified_by), version + 1; unknown / inactive organism -> 422 and the row is untouched', async () => {
      const x = await newCulture(); const id = await newIsolate(x, 1);
      await bad(call(HUB, 'identifyIsolate', isoReq(id, { organism_code: 'syn_t09_nope' }, 2)), 'micro.organism_code_unknown');
      await bad(call(HUB, 'identifyIsolate', isoReq(id, { organism_code: CODE.old }, 2)), 'micro.organism_code_unknown');
      expect(await isoRow(id)).toMatchObject({ status: 'pending_id', version: 2 });
      const res = await ok(call(HUB, 'identifyIsolate', isoReq(id, { organism_code: CODE.staph }, 2)));
      expect(res.body).toMatchObject({ status: 'identified', organism_code: CODE.staph, organism_display: 'Synthetic S. aureus', organism_source: 'manual', version: 3 });
      expect(responseErrors('identifyIsolate', res.body)).toEqual([]);
      const r = await isoRow(id);
      expect(r).toMatchObject({ status: 'identified', organism_code: CODE.staph, organism_source: 'manual', identified_by_membership_id: W.memHub, version: 3 });
      expect(isoAt(r.identified_at)).toBe(NOW.toISOString());
    });

    it('AC-05.3 re-identify before final: the organism changes and audit.audit_log keeps old and new organism_code; stale If-Match -> 409, missing -> 428', async () => {
      const x = await newCulture(); const id = await newIsolate(x, 1);
      await ok(call(HUB, 'identifyIsolate', isoReq(id, { organism_code: CODE.ecoli }, 2)));
      await bad(call(HUB, 'identifyIsolate', isoReq(id, { organism_code: CODE.staph }, 2)), 'common.version_conflict');
      await bad(call(HUB, 'identifyIsolate', { params: { isolate_id: id }, headers: {}, body: { organism_code: CODE.staph } }), 'common.precondition_required');
      await ok(call(HUB, 'identifyIsolate', isoReq(id, { organism_code: CODE.staph }, 3)));
      expect(await isoRow(id)).toMatchObject({ status: 'identified', organism_code: CODE.staph, version: 4 });
      const last = (await auditOf(id)).at(-1)!;
      expect(last.action).toBe('UPDATE');
      expect(last.old_values).toMatchObject({ organism_code: CODE.ecoli });
      expect(last.new_values).toMatchObject({ organism_code: CODE.staph });
      expect(last.changed_columns).toContain('organism_code');
    });

    it('AC-05.4 withdraw: status withdrawn with reason and comment, audit old/new status; the culture and the isolate\'s organism are untouched; a second withdraw / identify / describe -> 409 micro.isolate_invalid_transition', async () => {
      const x = await newCulture(); const id = await newIsolate(x, 1, { status: 'identified', organism_code: CODE.ecoli, organism_source: 'manual', identified_at: PLANTED });
      const cBefore = await cul(x.id);
      await bad(call(HUB, 'withdrawIsolate', isoReq(id, { reason_code: CODE.oldReason }, 2)), 'common.validation_failed');
      const res = await ok(call(HUB, 'withdrawIsolate', isoReq(id, { reason_code: CODE.contaminant, comment: 'Synthetic note' }, 2)));
      expect(res.body).toMatchObject({ status: 'withdrawn', withdraw_reason_code: CODE.contaminant, version: 3 });
      expect(await isoRow(id)).toMatchObject({ status: 'withdrawn', withdraw_reason_code: CODE.contaminant, withdraw_comment: 'Synthetic note', organism_code: CODE.ecoli, isolate_seq: 1 });
      expect(await cul(x.id)).toEqual(cBefore);
      const last = (await auditOf(id)).at(-1)!;
      expect([last.old_values?.status, last.new_values?.status]).toEqual(['identified', 'withdrawn']);
      await bad(call(HUB, 'withdrawIsolate', isoReq(id, { reason_code: CODE.dup }, 3)), 'micro.isolate_invalid_transition');
      await bad(call(HUB, 'identifyIsolate', isoReq(id, { organism_code: CODE.staph }, 3)), 'micro.isolate_invalid_transition');
      await bad(call(HUB, 'describeIsolate', isoReq(id, { is_reportable: false }, 3)), 'micro.isolate_invalid_transition');
      const next = await ok(call(HUB, 'createIsolate', createReq(x.id)));
      expect(next.body.isolate_seq).toBe(2);                                                  // number 1 is never reused
    });

    it('describe is a full replace (omitted optional fields cleared), version + 1', async () => {
      const x = await newCulture(); const id = await newIsolate(x, 1, { colony_description: 'Synthetic old', quantity_text: 'Synthetic few', plate_id: x.plate });
      const res = await ok(call(HUB, 'describeIsolate', isoReq(id, { colony_description: 'Synthetic new', is_reportable: false }, 2)));
      expect(res.body).toMatchObject({ colony_description: 'Synthetic new', is_reportable: false, version: 3 });
      expect(res.body.quantity_text).toBeUndefined();
      expect(await isoRow(id)).toMatchObject({ colony_description: 'Synthetic new', quantity_text: null, plate_id: null, is_reportable: false, version: 3 });
    });

    it('S-29 final lock: identify / describe / withdraw on an isolate of a final_submitted culture -> 409 micro.report_final_locked (isolates__final_lock P0001 mapped)', async () => {
      const x = await newCulture({ status: 'final_submitted' }); const id = await newIsolate(x, 1, { status: 'identified', organism_code: CODE.ecoli, organism_source: 'manual', identified_at: PLANTED });
      await bad(call(HUB, 'identifyIsolate', isoReq(id, { organism_code: CODE.staph }, 2)), 'micro.report_final_locked');
      await bad(call(HUB, 'describeIsolate', isoReq(id, { is_reportable: false }, 2)), 'micro.report_final_locked');
      await bad(call(HUB, 'withdrawIsolate', isoReq(id, { reason_code: CODE.contaminant }, 2)), 'micro.report_final_locked');
      expect(await isoRow(id)).toMatchObject({ organism_code: CODE.ecoli, status: 'identified', version: 2 });
    });
  });

  describe('scope and probes (S-01–S-04, S-08)', () => {
    it('S-01 tenant: tenant B sees another tenant\'s culture / isolate as 404 on M7–M10 (same as a missing id); nothing changes', async () => {
      const x = await newCulture(); const id = await newIsolate(x, 1);
      const before = await isoRow(id);
      await bad(call(asB, 'createIsolate', createReq(x.id)), 'common.not_found');
      for (const [op, body] of [['identifyIsolate', { organism_code: CODE.ecoli }], ['describeIsolate', { is_reportable: false }], ['withdrawIsolate', { reason_code: CODE.contaminant }]] as const)
        await bad(call(asB, op, isoReq(id, body, 2)), 'common.not_found');
      await bad(call(HUB, 'identifyIsolate', isoReq(uid(), { organism_code: CODE.ecoli }, 1)), 'common.not_found');
      expect(await isoRow(id)).toEqual(before);
      expect(await counterOf(x.specimen)).toBe(1);
    });

    it('S-02 centre scope: a user limited to centre A1 writes isolates of A1 and gets 404 for a culture / isolate of centre A2 (positive and negative); the A2 culture stays untouched', async () => {
      const own = await newCulture({ centre: W.centreA1 }); const other = await newCulture({ centre: W.centreA2 });
      const otherIso = await newIsolate(other, 1, { centre_id: W.centreA2 });
      expect((await ok(call(A1, 'createIsolate', createReq(own.id)))).body.isolate_seq).toBe(1);
      await bad(call(A1, 'createIsolate', createReq(other.id)), 'common.not_found');
      await bad(call(A1, 'identifyIsolate', isoReq(otherIso, { organism_code: CODE.ecoli }, 2)), 'common.not_found');
      expect(await isoRow(otherIso)).toMatchObject({ status: 'pending_id', version: 2 });
      expect(await counterOf(other.specimen)).toBe(1);
    });

    it('D-64: without micro.culture.work -> 403 on all four operations; nothing changes', async () => {
      const x = await newCulture(); const id = await newIsolate(x, 1);
      for (const [op, req] of [['createIsolate', createReq(x.id)], ['identifyIsolate', isoReq(id, { organism_code: CODE.ecoli }, 2)], ['describeIsolate', isoReq(id, { is_reportable: false }, 2)], ['withdrawIsolate', isoReq(id, { reason_code: CODE.contaminant }, 2)]] as const)
        await bad(call(HUB, op, req, ['micro.culture.read']), 'auth.forbidden');
      expect(await isoRow(id)).toMatchObject({ status: 'pending_id', version: 2 });
      expect(await counterOf(x.specimen)).toBe(1);
    });

    it('S-03 id mismatch: a plate of another culture of the same tenant in M7 / M9 -> 400 common.id_mismatch; S-04 a plate of tenant B -> 404 (composite FK never reached); nothing written', async () => {
      const x = await newCulture(); const y = await newCulture(); const b = await newCulture({ tenant: B, centre: W.centreB1 });
      const id = await newIsolate(x, 1);
      await bad(call(HUB, 'createIsolate', createReq(x.id, { plate_id: y.plate })), 'common.id_mismatch');
      await bad(call(HUB, 'describeIsolate', isoReq(id, { is_reportable: true, plate_id: y.plate }, 2)), 'common.id_mismatch');
      await bad(call(HUB, 'createIsolate', createReq(x.id, { plate_id: b.plate })), 'common.not_found');
      expect(await counterOf(x.specimen)).toBe(1);
      expect(await isolatesOf(x.id)).toHaveLength(1);
    });

    it('S-04 / S-08 database probes: lims_api cannot DELETE or UPDATE a counter outside its tenant, cannot insert an isolate with a plate of another tenant (23503), a duplicate (specimen, seq) is 23505, a counter above 99 is 23514, direct INSERT into a final culture is P0001', async () => {
      const x = await newCulture(); const y = await newCulture({ tenant: B, centre: W.centreB1 }); const f = await newCulture({ status: 'final_submitted' });
      await newIsolate(x, 1);
      const cl = await api.connect();
      const attempt = async (sql: string, params: unknown[], tenant = A, membership = W.memHub) => {
        await cl.query('BEGIN');
        await cl.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ tenant_id: tenant, sub: SYS, actor_type: 'user', membership_id: membership })]);
        try { await cl.query(sql, params); await cl.query('ROLLBACK'); return undefined; } catch (e: any) { await cl.query('ROLLBACK'); return e; }
      };
      try {
        const ins = (cid: string, spec: string, seq: number, plate: string | null) => attempt(`INSERT INTO micro.isolates (id, tenant_id, centre_id, culture_id, specimen_id, isolate_seq, plate_id, status, created_by, updated_by)
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_id', $8, $8)`, [uid(), A, W.centreA1, cid, spec, seq, plate, SYS]);
        expect((await attempt('DELETE FROM micro.specimen_isolate_counters WHERE specimen_id = $1', [x.specimen]))?.code).toBe('42501');
        expect((await ins(x.id, x.specimen, 1, null))?.code).toBe('23505');
        expect((await ins(x.id, x.specimen, 2, y.plate))?.code).toBe('23503');
        expect((await ins(x.id, x.specimen, 100, null))?.code).toBe('23514');
        expect((await ins(f.id, f.specimen, 1, null))?.message).toMatch(/immutable_row/);
        expect((await attempt('UPDATE micro.specimen_isolate_counters SET last_seq = 100 WHERE specimen_id = $1', [x.specimen]))?.code).toBe('23514');
      } finally { cl.release(); }
      expect(await counterOf(x.specimen)).toBe(1);
    });
  });
});
