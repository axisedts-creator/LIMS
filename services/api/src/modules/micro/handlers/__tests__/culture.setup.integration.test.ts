// C10 T-08 — M3 setupCulture, M4 addCulturePlate, M5 discardCulturePlate, M6 recordCultureObservation against the migrated database (06 row T-08; 02-TRD §4.1, §5 M3–M6, §12 SQLSTATE mapping;
// 05-SCHEMA §4 RLS, §8 constraints + triggers + grants; PRD AC-03.1–03.4, AC-04.1–04.5; 07-SECURITY T-A1–T-A3, S-01, S-02, S-03, S-04, S-08).
// Needs the micro DDL + RLS of 05-SCHEMA applied (C0 prerequisite, 06 §1): LIMS_TEST_DATABASE_URL = role lims_api (RLS on), LIMS_TEST_ADMIN_DATABASE_URL = superuser.
// Without them the DB tests skip, except under LIMS_T08_REQUIRE_DB=1 where "database is provided" fails. (Same harness status as C10 T-05/T-07: no micro migration in db/migrations yet.)
// SEAMS: as culture.setup.test.ts; ctx.tx = the request tx under RLS with claims { tenant_id, sub, actor_type: 'user', membership_id }; IdentityPort / CatalogPort / core.* are hand fakes (helpers/cultureReads.ts);
//   ctx.now() of the fake ctx is fixed at 2026-11-05T05:00:00.000Z, so every time the handlers write is derived from it (the database clock is not used for the asserted values).
// Isolation: every test creates its own cultures (append-only tables; nothing is deleted); the protocol, its key and the test ids are unique per run.
// Synthetic data only.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { mkCtx, responseErrors, run, WORK, type Row } from './helpers/cultureReads.js';

const API_URL = process.env['LIMS_TEST_DATABASE_URL'];
const ADMIN_URL = process.env['LIMS_TEST_ADMIN_DATABASE_URL'];
const live = Boolean(API_URL && ADMIN_URL);
const REQUIRE = process.env['LIMS_T08_REQUIRE_DB'] === '1';

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const RUN = Date.now();
let seqN = 0;
const uid = () => `0190c60d-0000-7000-8000-${(RUN % 0xffffffff).toString(16).padStart(8, '0')}${(++seqN).toString(16).padStart(4, '0')}`;
const NOW = new Date('2026-11-05T05:00:00.000Z');                       // ctx.now() of mkCtx
const H = 3_600_000;
const plus = (d: Date | string, h: number) => new Date(new Date(d).getTime() + h * H).toISOString();
const PLANTED = '2026-11-04T05:00:00.000Z';
const CODE = { blood: 'syn_t08_blood', mac: 'syn_t08_mac', old: 'syn_t08_old', heavy: 'syn_t08_heavy', none: 'syn_t08_none' };

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

const W = { order: uid(), centreA1: uid(), centreA2: uid(), centreB1: uid(), patient: uid(), memHub: uid(), memA1: uid(), memB: uid(), userTech: uid(), testP: uid(), testN: uid(), proto: uid(), protoCode: `syn_t08_${RUN}` };
const TECH = 'Synthetic Tech Setup';

beforeAll(async () => {
  if (!live) { if (REQUIRE) throw new Error('database is provided: set LIMS_TEST_DATABASE_URL (lims_api) and LIMS_TEST_ADMIN_DATABASE_URL (superuser)'); return; }
  api = new pg.Pool({ connectionString: API_URL, max: 12 }); admin = new pg.Pool({ connectionString: ADMIN_URL, max: 4 });
  for (const t of [A, B]) await seedRow('core.tenants', { id: t }, 'ON CONFLICT DO NOTHING');
  for (const [t, id] of [[A, W.centreA1], [A, W.centreA2], [B, W.centreB1]] as const) await seedRow('core.collection_centres', { tenant_id: t, id });
  await seedRow('core.users', { tenant_id: A, id: W.userTech, display_name: TECH });
  for (const [t, id, all] of [[A, W.memHub, true], [A, W.memA1, false], [B, W.memB, true]] as const)
    await seedRow('core.memberships', { tenant_id: t, id, user_id: W.userTech, actor_type: 'user', status: 'active', is_active: true, all_centres: all });
  await seedRow('core.membership_centres', { tenant_id: A, membership_id: W.memA1, centre_id: W.centreA1 });
  await seedRow('frontdesk.patients', { tenant_id: A, id: W.patient });
  for (const id of [W.testP, W.testN]) await seedRow('catalog.tests', { tenant_id: A, id });
  for (const [c, display, active] of [[CODE.blood, 'Synthetic blood', true], [CODE.mac, 'Synthetic mac', true], [CODE.old, 'Synthetic retired', false]] as const)
    await seedRow('micro.cs_media', { tenant_id: A, code: c, display, is_active: active, created_by: SYS, updated_by: SYS }, 'ON CONFLICT DO NOTHING');
  for (const [c, display, growth] of [[CODE.heavy, 'Synthetic heavy', true], [CODE.none, 'Synthetic none', false]] as const)
    await seedRow('micro.cs_growth_codes', { tenant_id: A, code: c, display, indicates_growth: growth, is_active: true, created_by: SYS, updated_by: SYS }, 'ON CONFLICT DO NOTHING');
  await seedRow('micro.plating_protocols', { id: W.proto, tenant_id: A, code: W.protoCode, version_no: 1, display: 'Synthetic setup protocol', read_schedule_hours: '{24,48,72}', final_no_growth_hours: 96, created_by: SYS, updated_by: SYS });
  await seedRow('micro.plating_protocol_media', { tenant_id: A, protocol_id: W.proto, media_code: CODE.blood, sort_order: 1, incubation_text: 'Synthetic CO2', created_by: SYS, updated_by: SYS });
  await seedRow('micro.plating_protocol_media', { tenant_id: A, protocol_id: W.proto, media_code: CODE.mac, sort_order: 2, created_by: SYS, updated_by: SYS });
  await seedRow('micro.plating_protocol_keys', { tenant_id: A, protocol_code: W.protoCode, test_id: W.testP, specimen_type_code: 'urine', created_by: SYS, updated_by: SYS });
});
afterAll(async () => { await api?.end(); await admin?.end(); });

interface NewC { status?: string; test?: string; type?: string; centre?: string; tenant?: string; planted?: string | null; extra?: Row }
async function newCulture(o: NewC = {}): Promise<string> {
  const id = uid(); const status = o.status ?? 'awaiting_setup';
  const planted = o.planted === undefined ? (status === 'awaiting_setup' ? null : PLANTED) : o.planted;
  await seedRow('micro.cultures', { id, tenant_id: o.tenant ?? A, centre_id: o.centre ?? W.centreA1, order_id: uid(), order_item_id: uid(), specimen_id: uid(), patient_id: W.patient, test_id: o.test ?? W.testP,
    specimen_type_code: o.type ?? 'urine', status, received_at: '2026-11-04T04:00:00.000Z', planted_at: planted, last_specimen_seq: 1, created_by: SYS, updated_by: SYS, version: 1, ...(o.extra ?? {}) });
  return id;
}
async function newPlate(cultureId: string, no: number, o: Row = {}): Promise<string> {
  const id = uid();
  await seedRow('micro.culture_plates', { id, tenant_id: o['tenant_id'] ?? A, centre_id: W.centreA1, culture_id: cultureId, plate_no: no, media_code: CODE.blood, planted_at: PLANTED, status: 'active', created_by: SYS, updated_by: SYS, ...o });
  return id;
}
const cul = async (id: string) => (await q('SELECT * FROM micro.cultures WHERE id = $1', [id]))[0]!;
const plates = (id: string) => q('SELECT * FROM micro.culture_plates WHERE culture_id = $1 ORDER BY plate_no', [id]);
const observations = (id: string) => q('SELECT * FROM micro.culture_observations WHERE culture_id = $1 ORDER BY created_at, id', [id]);
const transitions = (id: string) => q('SELECT * FROM micro.culture_transitions WHERE culture_id = $1 ORDER BY occurred_at, created_at', [id]);
const iso = (d: unknown) => (d ? new Date(d as any).toISOString() : null);

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
      tests: { [W.testP]: { code: 'SYN_URINE', name: 'Synthetic Urine Culture' }, [W.testN]: { code: 'SYN_OTHER', name: 'Synthetic Other Culture' } }, members: { [W.memHub]: TECH, [W.memA1]: TECH }, users: { [W.userTech]: TECH } });
    try { const res = await run(op, req, ctx); await client.query('COMMIT'); return { res }; } catch (err) { await client.query('ROLLBACK'); return { err }; }
  } finally { client.release(); }
}
const ok = async (p: Promise<{ res?: any; err?: any }>) => { const r = await p; if (r.err) throw r.err; return r.res; };
const bad = async (p: Promise<{ res?: any; err?: any }>, code: string) => { const r = await p; expect(r.err, `expected ${code}`).toBeDefined(); expect(isLimsError(r.err, code), `${r.err?.code ?? r.err}`).toBe(true); return r.err; };
const ifm = (v: number) => ({ 'if-match': `"${v}"` });
const setupReq = (id: string, body: Row, v = 1) => ({ params: { culture_id: id }, headers: { 'idempotency-key': `k-${uid()}`, ...ifm(v) }, body });
const addReq = (id: string, body: Row) => ({ params: { culture_id: id }, headers: { 'idempotency-key': `k-${uid()}` }, body });
const obsReq = (id: string, body: Row) => ({ params: { culture_id: id }, headers: { 'idempotency-key': `k-${uid()}` }, body });
const discardReq = (id: string, plate: string, v: number) => ({ params: { culture_id: id, plate_id: plate }, headers: ifm(v), body: {} });

describe.skipIf(!live && !REQUIRE)('T-08 setup, plates, observations (live DB)', () => {
  it('database is provided', () => { expect(live).toBe(true); });

  describe('AC-03.1–03.4 setupCulture', () => {
    it('AC-03.1/03.2 protocol resolved by key (test + specimen type): plates from its media, planted_at/next_read_due_at/final_due_at, protocol id, one transition row, culture version 2', async () => {
      const id = await newCulture();
      const res = await ok(call(HUB, 'setupCulture', setupReq(id, {})));
      expect(responseErrors('setupCulture', res.body)).toEqual([]);
      const c = await cul(id);
      expect(c).toMatchObject({ status: 'incubating', version: 2, plating_protocol_id: W.proto });
      expect([iso(c.planted_at), iso(c.next_read_due_at), iso(c.final_due_at)]).toEqual([NOW.toISOString(), plus(NOW, 24), plus(NOW, 96)]);
      expect((await plates(id)).map((p) => [p.plate_no, p.media_code, p.incubation_text, p.status, p.centre_id])).toEqual([[1, CODE.blood, 'Synthetic CO2', 'active', W.centreA1], [2, CODE.mac, null, 'active', W.centreA1]]);
      const t = await transitions(id);
      expect(t.map((x) => [x.from_status, x.to_status])).toEqual([['awaiting_setup', 'incubating']]);
    });

    it('AC-03.2 no protocol resolves (other test): explicit plates are needed (400 /plates without), final_due_at falls back to the 48 h default; the planted_at window is enforced', async () => {
      const id = await newCulture({ test: W.testN, type: 'swab' });
      const e = await bad(call(HUB, 'setupCulture', setupReq(id, {})), 'common.validation_failed');
      expect(e.errors?.map((x: any) => x.path)).toContain('/plates');
      await bad(call(HUB, 'setupCulture', setupReq(id, { plates: [{ media_code: CODE.blood }], planted_at: plus(NOW, -73) })), 'common.validation_failed');
      expect((await cul(id)).status).toBe('awaiting_setup');
      await ok(call(HUB, 'setupCulture', setupReq(id, { plates: [{ media_code: CODE.blood }, { media_code: CODE.mac, incubation_text: 'Synthetic' }], planted_at: plus(NOW, -72) })));
      const c = await cul(id);
      expect([c.status, iso(c.planted_at), iso(c.final_due_at), c.next_read_due_at]).toEqual(['incubating', plus(NOW, -72), plus(NOW, -72 + 48), null]);
      expect((await plates(id)).map((p) => p.plate_no)).toEqual([1, 2]);
    });

    it('inactive / unknown media code -> 400 common.validation_failed; nothing is stored (one unit)', async () => {
      const id = await newCulture({ test: W.testN, type: 'swab' });
      await bad(call(HUB, 'setupCulture', setupReq(id, { plates: [{ media_code: CODE.blood }, { media_code: CODE.old }] })), 'common.validation_failed');
      expect([(await cul(id)).status, (await plates(id)).length, (await transitions(id)).length]).toEqual(['awaiting_setup', 0, 0]);
    });

    it('AC-03.3 a culture that is not awaiting_setup -> 409 micro.culture_invalid_transition; AC-03.4 stale If-Match -> 409 common.version_conflict; missing -> 428', async () => {
      const inc = await newCulture({ status: 'incubating' });
      await bad(call(HUB, 'setupCulture', setupReq(inc, { plates: [{ media_code: CODE.blood }] })), 'micro.culture_invalid_transition');
      const id = await newCulture({ test: W.testN, type: 'swab' });
      await bad(call(HUB, 'setupCulture', setupReq(id, { plates: [{ media_code: CODE.blood }] }, 7)), 'common.version_conflict');
      await bad(call(HUB, 'setupCulture', { ...setupReq(id, { plates: [{ media_code: CODE.blood }] }), headers: { 'idempotency-key': 'k' } }), 'common.precondition_required');
      expect([(await cul(id)).status, (await plates(id)).length]).toEqual(['awaiting_setup', 0]);
    });

    it('parallel: 5 simultaneous setups of one culture with the same If-Match -> exactly one succeeds, the others get 409; one set of plates, one transition', async () => {
      const id = await newCulture({ test: W.testN, type: 'swab' });
      const rs = await Promise.all(Array.from({ length: 5 }, () => call(HUB, 'setupCulture', setupReq(id, { plates: [{ media_code: CODE.blood }, { media_code: CODE.mac }] }))));
      expect(rs.filter((r) => !r.err)).toHaveLength(1);
      for (const r of rs.filter((x) => x.err)) expect(['common.version_conflict', 'micro.culture_invalid_transition'].some((c) => isLimsError(r.err, c)), `${r.err?.code ?? r.err}`).toBe(true);
      expect((await plates(id)).map((p) => p.plate_no)).toEqual([1, 2]);
      expect(await transitions(id)).toHaveLength(1);
    });
  });

  describe('M4 / M5 plates', () => {
    it('M4 adds plate max+1 on an incubating culture; 8 parallel adds all succeed with distinct consecutive numbers (the culture row is locked, no version_conflict)', async () => {
      const id = await newCulture({ status: 'incubating' }); await newPlate(id, 1);
      const rs = await Promise.all(Array.from({ length: 8 }, () => call(HUB, 'addCulturePlate', addReq(id, { media_code: CODE.mac }))));
      expect(rs.filter((r) => r.err).map((r) => r.err?.code)).toEqual([]);
      expect((await plates(id)).map((p) => p.plate_no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    it('M4 on awaiting_setup / cancelled -> 409 micro.culture_invalid_transition; on final_submitted -> 409 micro.report_final_locked (trigger P0001 immutable_row mapped); nothing inserted', async () => {
      const setup = await newCulture();
      const cancelled = await newCulture({ status: 'cancelled', extra: { cancel_reason_code: 'syn_reason', cancelled_at: NOW } });
      const final = await newCulture({ status: 'final_submitted', extra: { outcome_code: 'syn_positive', current_report_version_no: 1, last_report_phase: 'final' } });
      await bad(call(HUB, 'addCulturePlate', addReq(setup, { media_code: CODE.blood })), 'micro.culture_invalid_transition');
      await bad(call(HUB, 'addCulturePlate', addReq(cancelled, { media_code: CODE.blood })), 'micro.culture_invalid_transition');
      await bad(call(HUB, 'addCulturePlate', addReq(final, { media_code: CODE.blood })), 'micro.report_final_locked');
      for (const id of [setup, cancelled, final]) expect(await plates(id)).toEqual([]);
    });

    // Review T-08 #1: culture_plates__no__ck CHECK (plate_no BETWEEN 1 AND 50) must answer 400, never 500 common.internal.
    it('M4 on a culture whose highest plate_no is 50 -> 400 common.validation_failed (path /); no 51st row; plate_no 49 still yields the 50th', async () => {
      const id = await newCulture({ status: 'incubating' }); await newPlate(id, 50);
      const e = await bad(call(HUB, 'addCulturePlate', addReq(id, { media_code: CODE.blood })), 'common.validation_failed');
      expect(e.errors?.map((x: any) => x.path)).toContain('/');
      expect((await plates(id)).map((p) => p.plate_no)).toEqual([50]);
      const id2 = await newCulture({ status: 'incubating' }); await newPlate(id2, 49);
      await ok(call(HUB, 'addCulturePlate', addReq(id2, { media_code: CODE.blood })));
      expect((await plates(id2)).map((p) => p.plate_no)).toEqual([49, 50]);
    });

    it('M5 discards the plate with the right If-Match (version + 1); stale -> 409 version_conflict; on a final culture -> 409 report_final_locked', async () => {
      const id = await newCulture({ status: 'incubating' }); const p = await newPlate(id, 1);
      await bad(call(HUB, 'discardCulturePlate', discardReq(id, p, 9)), 'common.version_conflict');
      const res = await ok(call(HUB, 'discardCulturePlate', discardReq(id, p, 1)));
      expect(res.body).toMatchObject({ id: p, status: 'discarded', version: 2 });
      expect(await q('SELECT status, version, discarded_at IS NOT NULL AS has_ts FROM micro.culture_plates WHERE id = $1', [p])).toEqual([{ status: 'discarded', version: 2, has_ts: true }]);
      const fin = await newCulture({ status: 'final_submitted', extra: { outcome_code: 'syn_positive', current_report_version_no: 1, last_report_phase: 'final' } }); const fp = await newPlate(fin, 1);
      await bad(call(HUB, 'discardCulturePlate', discardReq(fin, fp, 1)), 'micro.report_final_locked');
      expect((await q('SELECT status FROM micro.culture_plates WHERE id = $1', [fp]))[0].status).toBe('active');
    });
  });

  describe('AC-04.1–04.5 observations', () => {
    it('AC-04.1 growth read: incubating -> growth_detected with one transition; hours_since_planting 24.00; DTO valid; 6 parallel growth reads store 6 observations and exactly ONE transition', async () => {
      const id = await newCulture({ status: 'incubating' }); const p = await newPlate(id, 1);
      const res = await ok(call(HUB, 'recordCultureObservation', obsReq(id, { kind: 'plate_read', plate_id: p, growth_code: CODE.heavy })));
      expect(responseErrors('recordCultureObservation', res.body)).toEqual([]);
      expect(res.body.culture.status).toBe('growth_detected');
      expect(Number((await observations(id))[0].hours_since_planting)).toBe(24);
      const id2 = await newCulture({ status: 'incubating' }); const p2 = await newPlate(id2, 1);
      const rs = await Promise.all(Array.from({ length: 6 }, () => call(HUB, 'recordCultureObservation', obsReq(id2, { kind: 'plate_read', plate_id: p2, growth_code: CODE.heavy }))));
      expect(rs.filter((r) => r.err).map((r) => r.err?.code)).toEqual([]);
      expect(await observations(id2)).toHaveLength(6);
      expect((await transitions(id2)).map((t) => [t.from_status, t.to_status])).toEqual([['incubating', 'growth_detected']]);
      expect((await cul(id2)).status).toBe('growth_detected');
    });

    it('AC-04.2 no growth keeps incubating and moves next_read_due_at to the next slot after the latest read, or clears it when exhausted', async () => {
      const planted = '2026-11-01T05:00:00.000Z';                              // now (2026-11-05T05:00Z) is 96 h later; protocol schedule 24/48/72 h
      const id = await newCulture({ status: 'incubating', planted, extra: { plating_protocol_id: W.proto, next_read_due_at: plus(planted, 24) } }); const p = await newPlate(id, 1);
      const read = (observed_at?: string) => ok(call(HUB, 'recordCultureObservation', obsReq(id, { kind: 'plate_read', plate_id: p, growth_code: CODE.none, ...(observed_at ? { observed_at } : {}) })));
      await read(plus(planted, 25));
      let c = await cul(id);
      expect([c.status, iso(c.next_read_due_at)]).toEqual(['incubating', plus(planted, 48)]);
      await read(plus(planted, 49));
      expect(iso((await cul(id)).next_read_due_at)).toBe(plus(planted, 72));
      await read(plus(planted, 30));                                           // late-entered older read: the latest read (49 h) still decides (TRD §4.1)
      expect(iso((await cul(id)).next_read_due_at)).toBe(plus(planted, 72));
      await read();                                                            // observed_at = now = 96 h: schedule exhausted
      c = await cul(id);
      expect([c.status, c.next_read_due_at]).toEqual(['incubating', null]);
      expect(await transitions(id)).toEqual([]);
    });

    it('AC-04.3 gram_stain / microscopy / other need finding_text (1..2000) and never change the state; stored without plate or growth code', async () => {
      const id = await newCulture({ status: 'incubating', extra: { next_read_due_at: plus(NOW, 5) } });
      for (const kind of ['gram_stain', 'microscopy', 'other']) {
        await bad(call(HUB, 'recordCultureObservation', obsReq(id, { kind })), 'common.validation_failed');
        await ok(call(HUB, 'recordCultureObservation', obsReq(id, { kind, finding_text: `Synthetic ${kind}` })));
      }
      await bad(call(HUB, 'recordCultureObservation', obsReq(id, { kind: 'gram_stain', finding_text: 'x'.repeat(2001) })), 'common.validation_failed');
      const c = await cul(id);
      expect([c.status, iso(c.next_read_due_at)]).toEqual(['incubating', plus(NOW, 5)]);
      expect((await observations(id)).map((o) => [o.kind, o.plate_id, o.growth_code])).toEqual([['gram_stain', null, null], ['microscopy', null, null], ['other', null, null]]);
      expect(await transitions(id)).toEqual([]);
    });

    it('AC-04.4 a correction is a new row with corrects_observation_id; the original is never updated (and the database refuses UPDATE / DELETE for lims_api)', async () => {
      const id = await newCulture({ status: 'incubating' });
      const first = await ok(call(HUB, 'recordCultureObservation', obsReq(id, { kind: 'gram_stain', finding_text: 'Synthetic first' })));
      const before = (await observations(id))[0];
      const second = await ok(call(HUB, 'recordCultureObservation', obsReq(id, { kind: 'gram_stain', finding_text: 'Synthetic corrected', corrects_observation_id: first.body.observation.id })));
      expect(second.body.observation.corrects_observation_id).toBe(first.body.observation.id);
      const rows = await observations(id);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual(before);
      const c = await api.connect();
      try {
        await c.query('BEGIN'); await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ tenant_id: A, sub: SYS, actor_type: 'user', membership_id: W.memHub })]);
        await expect(c.query("UPDATE micro.culture_observations SET finding_text = 'tampered' WHERE id = $1", [before.id])).rejects.toMatchObject({ code: '42501' });
        await c.query('ROLLBACK'); await c.query('BEGIN'); await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ tenant_id: A, sub: SYS, actor_type: 'user', membership_id: W.memHub })]);
        await expect(c.query('DELETE FROM micro.culture_observations WHERE id = $1', [before.id])).rejects.toMatchObject({ code: '42501' });
      } finally { await c.query('ROLLBACK'); c.release(); }
    });

    it('AC-04.5 final_submitted -> 409 micro.report_final_locked; cancelled -> 409 micro.culture_invalid_transition; no row stored, culture unchanged (all four kinds)', async () => {
      const final = await newCulture({ status: 'final_submitted', extra: { outcome_code: 'syn_positive', current_report_version_no: 1, last_report_phase: 'final' } }); const fp = await newPlate(final, 1);
      const cancelled = await newCulture({ status: 'cancelled', extra: { cancel_reason_code: 'syn_reason', cancelled_at: NOW } }); const cp = await newPlate(cancelled, 1);
      for (const [id, p, code] of [[final, fp, 'micro.report_final_locked'], [cancelled, cp, 'micro.culture_invalid_transition']] as const)
        for (const body of [{ kind: 'plate_read', plate_id: p, growth_code: CODE.none }, { kind: 'gram_stain', finding_text: 'x' }, { kind: 'microscopy', finding_text: 'x' }, { kind: 'other', finding_text: 'x' }]) {
          await bad(call(HUB, 'recordCultureObservation', obsReq(id, body)), code);
          expect(await observations(id)).toEqual([]);
        }
      expect([(await cul(final)).version, (await cul(cancelled)).version]).toEqual([1, 1]);
    });
  });

  describe('probes: centre scope (S-02), cross-tenant (S-01), id mismatch (S-03), composite FKs (S-04), final lock at the database', () => {
    it('S-02 an A1-only user gets 404 for every M3–M6 on an A2 culture and nothing is written; the hub user (all_centres) can work on it', async () => {
      const id = await newCulture({ status: 'incubating', centre: W.centreA2 }); const p = await newPlate(id, 1, { centre_id: W.centreA2 });
      const setupId = await newCulture({ centre: W.centreA2, test: W.testN, type: 'swab' });
      for (const [op, req] of [['setupCulture', setupReq(setupId, { plates: [{ media_code: CODE.blood }] })], ['addCulturePlate', addReq(id, { media_code: CODE.blood })],
        ['discardCulturePlate', discardReq(id, p, 1)], ['recordCultureObservation', obsReq(id, { kind: 'gram_stain', finding_text: 'x' })]] as const)
        await bad(call(A1, op, req), 'common.not_found');
      expect([(await cul(setupId)).status, (await plates(id)).length, (await observations(id)).length]).toEqual(['awaiting_setup', 1, 0]);
      await ok(call(HUB, 'recordCultureObservation', obsReq(id, { kind: 'gram_stain', finding_text: 'Synthetic hub stain' })));
      const own = await newCulture({ status: 'incubating' });
      await ok(call(A1, 'recordCultureObservation', obsReq(own, { kind: 'gram_stain', finding_text: 'Synthetic A1 stain' })));
    });

    it('S-01 a tenant B user on a tenant A culture -> 404 for M3–M6, nothing written; tenant-B ids in the body of an A culture -> 404', async () => {
      const id = await newCulture({ status: 'incubating' }); const p = await newPlate(id, 1); const setupId = await newCulture({ test: W.testN, type: 'swab' });
      for (const [op, req] of [['setupCulture', setupReq(setupId, { plates: [{ media_code: CODE.blood }] })], ['addCulturePlate', addReq(id, { media_code: CODE.blood })],
        ['discardCulturePlate', discardReq(id, p, 1)], ['recordCultureObservation', obsReq(id, { kind: 'gram_stain', finding_text: 'x' })]] as const)
        await bad(call(asB, op, req), 'common.not_found');
      const bc = await newCulture({ status: 'incubating', tenant: B, centre: W.centreB1 }); const bp = await newPlate(bc, 1, { tenant_id: B, centre_id: W.centreB1 });
      await bad(call(HUB, 'addCulturePlate', addReq(id, { media_code: CODE.blood, parent_plate_id: bp })), 'common.not_found');
      await bad(call(HUB, 'recordCultureObservation', obsReq(id, { kind: 'plate_read', plate_id: bp, growth_code: CODE.none })), 'common.not_found');
      expect([(await cul(setupId)).status, (await plates(id)).length, (await observations(id)).length]).toEqual(['awaiting_setup', 1, 0]);
    });

    it('S-03 a plate / observation of another culture of the same tenant -> 400 common.id_mismatch', async () => {
      const a = await newCulture({ status: 'incubating' }); const b = await newCulture({ status: 'incubating' }); const pb = await newPlate(b, 1);
      const ob = await ok(call(HUB, 'recordCultureObservation', obsReq(b, { kind: 'gram_stain', finding_text: 'Synthetic other' })));
      await bad(call(HUB, 'addCulturePlate', addReq(a, { media_code: CODE.blood, parent_plate_id: pb })), 'common.id_mismatch');
      await bad(call(HUB, 'recordCultureObservation', obsReq(a, { kind: 'plate_read', plate_id: pb, growth_code: CODE.none })), 'common.id_mismatch');
      await bad(call(HUB, 'recordCultureObservation', obsReq(a, { kind: 'gram_stain', finding_text: 'x', corrects_observation_id: ob.body.observation.id })), 'common.id_mismatch');
      expect([(await plates(a)).length, (await observations(a)).length]).toEqual([0, 0]);
    });

    it('S-04 / 05-SCHEMA §8 composite FKs and RLS WITH CHECK reject grafted rows even for a raw statement under the lims_api role; the final-lock trigger raises immutable_row', async () => {
      const a = await newCulture({ status: 'incubating' }); const bc = await newCulture({ status: 'incubating', tenant: B, centre: W.centreB1 }); const bp = await newPlate(bc, 1, { tenant_id: B, centre_id: W.centreB1 });
      const fin = await newCulture({ status: 'final_submitted', extra: { outcome_code: 'syn_positive', current_report_version_no: 1, last_report_phase: 'final' } });
      const raw = async (sql: string, params: unknown[], tenant = A) => {
        const c = await api.connect();
        try { await c.query('BEGIN'); await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ tenant_id: tenant, sub: SYS, actor_type: 'user', membership_id: W.memHub })]); await c.query(sql, params); }
        finally { await c.query('ROLLBACK'); c.release(); }
      };
      const PL = 'INSERT INTO micro.culture_plates (id, tenant_id, centre_id, culture_id, plate_no, media_code, planted_at, parent_plate_id, created_by, updated_by) VALUES ($1,$2,$3,$4,1,$5,now(),$6,$7,$7)';
      await expect(raw(PL, [uid(), A, W.centreA1, a, CODE.blood, bp, SYS])).rejects.toMatchObject({ code: '23503' });                         // parent plate of tenant B
      await expect(raw(PL, [uid(), B, W.centreB1, bc, CODE.blood, null, SYS])).rejects.toMatchObject({ code: '42501' });                      // tenant B row under tenant A claims
      await expect(raw('INSERT INTO micro.culture_observations (id, tenant_id, centre_id, culture_id, plate_id, kind, growth_code, observed_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8)',
        [uid(), A, W.centreA1, a, bp, 'plate_read', CODE.none, SYS])).rejects.toMatchObject({ code: '23503' });                              // plate of tenant B
      await expect(raw('INSERT INTO micro.culture_observations (id, tenant_id, centre_id, culture_id, kind, observed_at, created_by) VALUES ($1,$2,$3,$4,$5,now(),$6)',
        [uid(), A, W.centreA1, a, 'gram_stain', SYS])).rejects.toMatchObject({ code: '23514' });                                              // finding_text required
      await expect(raw('INSERT INTO micro.culture_observations (id, tenant_id, centre_id, culture_id, kind, finding_text, observed_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,now(),$7)',
        [uid(), A, W.centreA1, fin, 'gram_stain', 'x', SYS])).rejects.toMatchObject({ code: 'P0001', message: 'immutable_row' });             // tg_child_final_lock
    });
  });
});
