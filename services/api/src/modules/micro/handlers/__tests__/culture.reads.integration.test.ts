// C10 T-07 — culture read endpoints M1/M2/M15/M16 against the migrated database (06 row T-07; 02-TRD §5 M1/M2/M15/M16, §5.6; 05-SCHEMA §4 RLS, §8 cultures + children, §9 index map;
// PRD AC-02.1, AC-02.3, AC-02.4; 07-SECURITY T-A1, T-F1, S-01, S-02, S-25).
// Needs a database with the micro DDL + RLS of 05-SCHEMA §8/§4 applied (C0 prerequisite, 06 §1): LIMS_TEST_DATABASE_URL = role lims_api (RLS on), LIMS_TEST_ADMIN_DATABASE_URL = superuser.
// Without them the DB tests skip, except under LIMS_T07_REQUIRE_DB=1 where "database is provided" fails. (Same harness status as C10 T-05/T-06: no micro migration in db/migrations yet.)
// SEAMS: as culture.reads.test.ts; ctx.tx = the request tx under RLS with claims { tenant_id, sub, actor_type: 'user', membership_id } (centre scope = core.memberships.all_centres / membership_centres, 05-SCHEMA §4);
//   IdentityPort / CatalogPort / LabPort / core.memberships.list / core.user are hand fakes (helpers/cultureReads.ts).
// Isolation from other test files sharing the DB: every list query is filtered by this run's order_id (cultures are append-only; nothing is deleted).
// ASSUMED (spec silent): sort `next_read_due_at` ascending, ties by id; `received_at_from/_to` inclusive; has_open_instrument_records = a record of the culture in match_status
//   pending_match|needs_mapping|conflict|late_after_final (the open partial index of 05-SCHEMA); open_instrument_record_count counts the same; read_overdue = status incubating AND next_read_due_at < now.
// Synthetic data only.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { LAB_READ, mkCtx, READ, responseErrors, run, schemaErrors, type Row } from './helpers/cultureReads.js';

const API_URL = process.env['LIMS_TEST_DATABASE_URL'];
const ADMIN_URL = process.env['LIMS_TEST_ADMIN_DATABASE_URL'];
const live = Boolean(API_URL && ADMIN_URL);
const REQUIRE = process.env['LIMS_T07_REQUIRE_DB'] === '1';

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const C = '01a1a98a-ac40-7000-8000-00000000c001';            // cap test tenant (10,001 cultures, seeded once)
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const RUN = Date.now();
let seqN = 0;
const uid = () => `0190c60c-0000-7000-8000-${(RUN % 0xffffffff).toString(16).padStart(8, '0')}${(++seqN).toString(16).padStart(4, '0')}`;
const at = (d: string) => new Date(`${d}T04:00:00.000Z`);

let api: pg.Pool;
let admin: pg.Pool;
const q = async (text: string, values: unknown[] = []) => (await admin.query(text, values)).rows;

async function seedRow(table: string, given: Record<string, unknown>, onConflict = ''): Promise<void> {
  const [schema, name] = table.split('.') as [string, string];
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL session_replication_role = 'replica'");
    const cols = (await c.query(`SELECT column_name, udt_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2
      AND is_nullable = 'NO' AND column_default IS NULL AND is_generated = 'NEVER' AND is_identity = 'NO'`, [schema, name])).rows as { column_name: string; udt_name: string }[];
    const row: Record<string, unknown> = { ...given };
    for (const { column_name, udt_name } of cols) {
      if (column_name in row) continue;
      row[column_name] = udt_name === 'uuid' ? uid() : /^(int|numeric|float)/.test(udt_name) ? 1 : udt_name === 'bool' ? false : udt_name === 'timestamptz' || udt_name === 'timestamp' ? at('2026-11-01')
        : udt_name === 'date' ? '2026-11-01' : udt_name === 'jsonb' || udt_name === 'json' ? '[]' : `syn-${seqN}`;
    }
    const keys = Object.keys(row);
    await c.query(`INSERT INTO ${table} (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) ${onConflict}`,
      keys.map((k) => (row[k] !== null && typeof row[k] === 'object' && !(row[k] instanceof Date) ? JSON.stringify(row[k]) : row[k])));
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

// ------------------------------------------------------------------ the world
const W = {
  order: uid(), centreA1: uid(), centreA2: uid(), centreB1: uid(), patient: uid(),
  memHub: uid(), memA1: uid(), memB: uid(), userTech: uid(), test: uid(), specimen: uid(),
  ids: {} as Record<string, string>, b: { culture: uid(), order: uid() },
};
interface Seed { key: string; status: string; centre?: string; received: string; next?: Date | null; updated?: Date; extra?: Row }
const SEEDS: Seed[] = [
  { key: 'setup1', status: 'awaiting_setup', received: '2026-11-01' },
  { key: 'setup2', status: 'awaiting_setup', received: '2026-11-03' },
  { key: 'incOver', status: 'incubating', received: '2026-11-02', next: new Date('2020-01-01T00:00:00.000Z'), updated: at('2026-11-04') },
  { key: 'incOk', status: 'incubating', received: '2026-11-04', next: new Date('2099-01-01T00:00:00.000Z'), updated: at('2026-11-05') },
  { key: 'growth', status: 'growth_detected', received: '2026-11-05', next: new Date('2099-02-01T00:00:00.000Z'), updated: at('2026-11-06') },
  { key: 'final', status: 'final_submitted', received: '2026-11-06', updated: at('2026-11-09'), extra: { outcome_code: 'syn_positive', current_report_version_no: 2, last_report_phase: 'final', barcode_snapshot: 'SYNBC0001' } },
  { key: 'cancelled', status: 'cancelled', received: '2026-11-07', updated: at('2026-11-08'), extra: { cancel_reason_code: 'syn_reason', cancelled_at: at('2026-11-08') } },
  { key: 'amending', status: 'amending', received: '2026-11-08', updated: at('2026-11-07'), extra: { outcome_code: 'syn_positive', amendment_reason_code: 'syn_correction', current_report_version_no: 2, last_report_phase: 'final' } },
  { key: 'a2', status: 'awaiting_setup', centre: 'A2', received: '2026-11-09', updated: new Date('2026-11-06T12:00:00.000Z'), extra: { current_report_version_no: 1, last_report_phase: 'preliminary' } },
];
const TECH = 'Synthetic Tech Reads';

async function cultureRow(tenant: string, o: { id: string; order: string; centre: string; status: string; received: string; next?: Date | null; updated?: Date; extra?: Row }): Promise<void> {
  await seedRow('micro.cultures', { id: o.id, tenant_id: tenant, centre_id: o.centre, order_id: o.order, order_item_id: uid(), specimen_id: uid(), patient_id: W.patient, test_id: W.test, specimen_type_code: 'urine',
    status: o.status, received_at: at(o.received), next_read_due_at: o.next ?? null, last_specimen_seq: 1, created_by: SYS, updated_by: SYS, updated_at: o.updated ?? at(o.received), ...(o.extra ?? {}) });
}

beforeAll(async () => {
  if (!live) { if (REQUIRE) throw new Error('database is provided: set LIMS_TEST_DATABASE_URL (lims_api) and LIMS_TEST_ADMIN_DATABASE_URL (superuser)'); return; }
  api = new pg.Pool({ connectionString: API_URL, max: 4 }); admin = new pg.Pool({ connectionString: ADMIN_URL, max: 4 });
  for (const t of [A, B, C]) await seedRow('core.tenants', { id: t }, 'ON CONFLICT DO NOTHING');
  for (const [t, id] of [[A, W.centreA1], [A, W.centreA2], [B, W.centreB1]] as const) await seedRow('core.collection_centres', { tenant_id: t, id });
  await seedRow('core.users', { tenant_id: A, id: W.userTech, display_name: TECH });
  for (const [t, id, all] of [[A, W.memHub, true], [A, W.memA1, false], [B, W.memB, true]] as const)
    await seedRow('core.memberships', { tenant_id: t, id, user_id: W.userTech, actor_type: 'user', status: 'active', is_active: true, all_centres: all });
  await seedRow('core.membership_centres', { tenant_id: A, membership_id: W.memA1, centre_id: W.centreA1 });
  await seedRow('frontdesk.patients', { tenant_id: A, id: W.patient });
  await seedRow('catalog.tests', { tenant_id: A, id: W.test });
  for (const s of SEEDS) {
    const id = uid(); W.ids[s.key] = id;
    await cultureRow(A, { id, order: W.order, centre: s.centre === 'A2' ? W.centreA2 : W.centreA1, status: s.status, received: s.received, ...(s.next !== undefined ? { next: s.next } : {}), ...(s.updated ? { updated: s.updated } : {}), ...(s.extra ? { extra: s.extra } : {}) });
  }
  await cultureRow(B, { id: W.b.culture, order: W.b.order, centre: W.centreB1, status: 'awaiting_setup', received: '2026-11-01' });
  // instrument records: incOver has an open (conflict) and a closed (ignored); incOk one open (pending_match); growth only an applied one
  const rec = (cultureKey: string, status: string, extra: Row = {}) => seedRow('micro.instrument_records', { tenant_id: A, centre_id: W.centreA1, culture_id: W.ids[cultureKey], match_status: status, record_kind: 'ast', received_at: at('2026-11-05'), ...extra });
  await rec('incOver', 'conflict'); await rec('incOver', 'ignored', { ignore_reason_code: 'syn_reason' }); await rec('incOk', 'pending_match'); await rec('growth', 'applied');
  // report versions: final has v1, v2; a2 (centre A2) has v1
  const ver = (cultureKey: string, centre: string, n: number) => seedRow('micro.report_versions', { tenant_id: A, centre_id: centre, culture_id: W.ids[cultureKey], order_item_id: uid(), version_no: n, report_phase: n === 1 ? 'preliminary' : 'final',
    version_kind: n === 1 ? 'initial' : 'update', submission_kind: 'structured', outcome_code: n === 1 ? null : 'syn_positive', culture_summary_text: `Synthetic summary ${n}`, isolates: [{ seq: 1, organism_code: 'syn_org', organism_display: 'Synthetic organism', growth_text: 'heavy' }],
    ast: [], is_critical: false, flag: 'N', signed_by_membership_id: W.memHub, signed_at: at('2026-11-06'), lab_result_id: uid(), lab_result_version_no: n, lab_status_at_submit: 'resulted', lab_replayed: false, created_by: SYS });
  await ver('final', W.centreA1, 1); await ver('final', W.centreA1, 2); await ver('a2', W.centreA2, 1);
  // children of `final`: plate (A1), plate (centre A2 — a hidden child row), observation, isolate, ast, transitions
  const plate = uid();
  await seedRow('micro.culture_plates', { id: plate, tenant_id: A, centre_id: W.centreA1, culture_id: W.ids['final'], plate_no: 1, media_code: 'syn_blood', planted_at: at('2026-11-06'), status: 'active', created_by: SYS, updated_by: SYS });
  await seedRow('micro.culture_plates', { id: uid(), tenant_id: A, centre_id: W.centreA2, culture_id: W.ids['final'], plate_no: 2, media_code: 'syn_hidden', planted_at: at('2026-11-06'), status: 'active', created_by: SYS, updated_by: SYS });
  const o1 = uid();
  await seedRow('micro.culture_observations', { id: o1, tenant_id: A, centre_id: W.centreA1, culture_id: W.ids['final'], plate_id: plate, kind: 'plate_read', growth_code: 'syn_growth', observed_at: at('2026-11-07'), hours_since_planting: '24.00', recorded_by_membership_id: W.memHub, created_by: SYS });
  await seedRow('micro.culture_observations', { id: uid(), tenant_id: A, centre_id: W.centreA1, culture_id: W.ids['final'], plate_id: plate, kind: 'plate_read', growth_code: 'syn_growth', observed_at: at('2026-11-08'), recorded_by_membership_id: W.memHub, corrects_observation_id: o1, created_by: SYS });
  const iso1 = uid();
  await seedRow('micro.isolates', { id: iso1, tenant_id: A, centre_id: W.centreA1, culture_id: W.ids['final'], specimen_id: uid(), isolate_seq: 1, plate_id: plate, status: 'identified', organism_code: 'syn_org', organism_source: 'manual', identified_at: at('2026-11-07'), created_by: SYS, updated_by: SYS });
  await seedRow('micro.ast_results', { id: uid(), tenant_id: A, centre_id: W.centreA1, culture_id: W.ids['final'], isolate_id: iso1, antibiotic_code: 'syn_abx', method: 'mic', raw_value: '<=0.25', source: 'manual', created_by: SYS, updated_by: SYS });
  for (const [from, to] of [[null, 'awaiting_setup'], ['awaiting_setup', 'incubating']] as const)
    await seedRow('micro.culture_transitions', { tenant_id: A, centre_id: W.centreA1, culture_id: W.ids['final'], from_status: from, to_status: to, occurred_at: at('2026-11-06'), created_by: W.userTech });
});
afterAll(async () => { await api?.end(); await admin?.end(); });

// ------------------------------------------------------------------ driving a handler under RLS
interface Who { tenant: string; membership: string; centres?: string[]; all?: boolean }
const HUB: Who = { get tenant() { return A; }, get membership() { return W.memHub; }, all: true };
const A1: Who = { get tenant() { return A; }, get membership() { return W.memA1; }, get centres() { return [W.centreA1]; }, all: false };
const asB: Who = { get tenant() { return B; }, get membership() { return W.memB; }, all: true };

async function call(who: Who, op: string, req: Row, o: { grants?: string[]; lab?: (i: Row) => unknown } = {}): Promise<{ res?: any; err?: any; calls: ReturnType<typeof mkCtx>['calls'] }> {
  const client = await api.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ tenant_id: who.tenant, sub: SYS, actor_type: 'user', membership_id: who.membership })]);
    const { ctx, calls } = mkCtx({ tenantId: who.tenant, tx: client, grants: o.grants ?? [READ], actor: { type: 'user', id: SYS, membershipId: who.membership },
      centreScope: { all: who.all === true, centreIds: who.centres ?? [] }, tests: { [W.test]: { code: 'SYN_URINE', name: 'Synthetic Urine Culture' } },
      members: { [W.memHub]: TECH }, users: { [W.userTech]: TECH }, ...(o.lab ? { lab: o.lab } : {}) });
    try { const res = await run(op, req, ctx); await client.query('COMMIT'); return { res, calls }; }
    catch (err) { await client.query('ROLLBACK'); return { err, calls }; }
  } finally { client.release(); }
}
const listBody = async (who: Who, query: Row, o = {}) => { const r = await call(who, 'listCultures', { query: { order_id: W.order, ...query } }, o); if (r.err) throw r.err; return r.res.body as { data: Row[]; page: Row }; };
const keysOf = (rows: Row[]) => rows.map((r) => Object.entries(W.ids).find(([, v]) => v === r['id'])?.[0] ?? `?${r['id']}`);

describe.skipIf(!live && !REQUIRE)('T-07 culture reads (live DB)', () => {
  it('database is provided', () => { expect(live).toBe(true); });

  describe('AC-02.1 list: filters, sorts, paging, include_total', () => {
    it('every row conforms to CultureSummaryDto and the page to the 200 schema; open_instrument_record_count counts open records only (conflict yes, ignored/applied no)', async () => {
      const b = await listBody(HUB, { limit: 100 });
      expect(responseErrors('listCultures', b)).toEqual([]);
      expect(keysOf(b.data).sort()).toEqual(SEEDS.map((s) => s.key).sort());
      const by = Object.fromEntries(b.data.map((d) => [d['id'], d]));
      expect(by[W.ids['incOver']!]!['open_instrument_record_count']).toBe(1);
      expect(by[W.ids['incOk']!]!['open_instrument_record_count']).toBe(1);
      expect(by[W.ids['growth']!]!['open_instrument_record_count']).toBe(0);
      expect(by[W.ids['setup1']!]!['open_instrument_record_count']).toBe(0);
      expect(by[W.ids['final']!]!['barcode']).toBe('SYNBC0001');
      expect('barcode' in by[W.ids['setup1']!]!).toBe(false);
      expect(by[W.ids['setup1']!]).toMatchObject({ test_code: 'SYN_URINE', test_name: 'Synthetic Urine Culture', received_at: '2026-11-01T04:00:00.000Z' });
    });

    it('status csv = a worklist tab (AC-02.1): awaiting setup | incubating | growth/work-up | amending | recently submitted', async () => {
      expect(keysOf((await listBody(HUB, { status: 'awaiting_setup' })).data).sort()).toEqual(['a2', 'setup1', 'setup2']);
      expect(keysOf((await listBody(HUB, { status: 'incubating' })).data).sort()).toEqual(['incOk', 'incOver']);
      expect(keysOf((await listBody(HUB, { status: 'growth_detected' })).data)).toEqual(['growth']);
      expect(keysOf((await listBody(HUB, { status: 'amending' })).data)).toEqual(['amending']);
      expect(keysOf((await listBody(HUB, { status: 'final_submitted,cancelled', updated_at_from: '2026-11-08T00:00:00.000Z' })).data).sort()).toEqual(['cancelled', 'final']);
      expect(keysOf((await listBody(HUB, { status: 'final_submitted,cancelled', updated_at_from: '2026-11-09T00:00:00.000Z' })).data)).toEqual(['final']);
    });

    it.each([
      ['received_at', ['setup1', 'incOver', 'setup2', 'incOk', 'growth', 'final', 'cancelled', 'amending', 'a2']],
      ['-received_at', ['a2', 'amending', 'cancelled', 'final', 'growth', 'incOk', 'setup2', 'incOver', 'setup1']],
      ['-updated_at', ['final', 'cancelled', 'amending', 'a2', 'growth', 'incOk', 'incOver', 'setup2', 'setup1']],
    ])('sort=%s orders the rows', async (sort, expected) => {
      expect(keysOf((await listBody(HUB, { sort, limit: 100 })).data)).toEqual(expected);
    });

    it('sort=next_read_due_at (ascending, over the cultures that are due): 2020 < 2099-01 < 2099-02', async () => {
      expect(keysOf((await listBody(HUB, { sort: 'next_read_due_at', status: 'incubating,growth_detected' })).data)).toEqual(['incOver', 'incOk', 'growth']);
    });

    it('filters: specimen_id, centre_id, received_at window (inclusive), read_overdue, has_open_instrument_records', async () => {
      const spec = (await q('SELECT specimen_id FROM micro.cultures WHERE id = $1', [W.ids['setup2']]))[0].specimen_id;
      expect(keysOf((await listBody(HUB, { specimen_id: spec })).data)).toEqual(['setup2']);
      expect(keysOf((await listBody(HUB, { centre_id: W.centreA2 })).data)).toEqual(['a2']);
      expect(keysOf((await listBody(HUB, { received_at_from: '2026-11-02T00:00:00.000Z', received_at_to: '2026-11-04T23:59:59.000Z', sort: 'received_at' })).data)).toEqual(['incOver', 'setup2', 'incOk']);
      expect(keysOf((await listBody(HUB, { read_overdue: true })).data)).toEqual(['incOver']);
      expect(keysOf((await listBody(HUB, { has_open_instrument_records: true })).data).sort()).toEqual(['incOk', 'incOver']);
    });

    it('AC-02.4 is_read_overdue: true for the incubating culture whose next_read_due_at is past, false for the future one and for non-incubating rows', async () => {
      const by = Object.fromEntries((await listBody(HUB, {})).data.map((d) => [d['id'], d]));
      expect(by[W.ids['incOver']!]!['is_read_overdue']).toBe(true);
      for (const k of ['incOk', 'growth', 'setup1', 'final', 'cancelled', 'amending', 'a2']) expect(by[W.ids[k]!]!['is_read_overdue'], k).toBe(false);
    });

    it('cursor walk: limit=2 visits every row exactly once in the sort order, the last page has no next_cursor; include_total is the whole filtered count, not the page', async () => {
      const seen: string[] = []; let cursor: string | undefined; let pages = 0; let first: any;
      do {
        const b = await listBody(HUB, { limit: 2, sort: 'received_at', include_total: true, ...(cursor ? { cursor } : {}) });
        first ??= b; pages++; seen.push(...keysOf(b.data)); cursor = b.page['next_cursor'];
        expect(b.page['total']).toBe(SEEDS.length);
        expect(responseErrors('listCultures', b)).toEqual([]);
      } while (cursor && pages < 20);
      expect(pages).toBe(5);
      expect(seen).toEqual(['setup1', 'incOver', 'setup2', 'incOk', 'growth', 'final', 'cancelled', 'amending', 'a2']);
      expect(first.page.next_cursor).toMatch(/^[A-Za-z0-9_-]{1,512}$/);
    });

    it('page.total is absent unless include_total; with a filter it counts that filter (3 awaiting_setup, limit 1)', async () => {
      expect('total' in (await listBody(HUB, {})).page).toBe(false);
      const b = await listBody(HUB, { status: 'awaiting_setup', include_total: true, limit: 1 });
      expect(b.data).toHaveLength(1);
      expect(b.page['total']).toBe(3);
    });

    it('T-F1 invalid cursor -> 400 common.invalid_cursor', async () => {
      const r = await call(HUB, 'listCultures', { query: { order_id: W.order, cursor: 'AAAA' } });
      expect(isLimsError(r.err, 'common.invalid_cursor'), `${r.err?.code}`).toBe(true);
    });

    it('S-25 include_total is capped at 10,000 (tenant C holds 10,001 cultures of one order): page.total = 10000', async () => {
      const ORDER_C = '0190c60c-0000-7000-8000-0000000c0001';
      const have = Number((await q('SELECT count(*) AS n FROM micro.cultures WHERE tenant_id = $1 AND order_id = $2', [C, ORDER_C]))[0].n);
      if (have < 10001) {
        const c = await admin.connect();
        try {
          await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'");
          await c.query(`INSERT INTO micro.cultures (id, tenant_id, centre_id, order_id, order_item_id, specimen_id, patient_id, test_id, specimen_type_code, status, received_at, last_specimen_seq, created_by, updated_by)
            SELECT md5('c10t07cap' || g)::uuid, $1, $2, $3, md5('c10t07item' || g)::uuid, md5('c10t07spec' || g)::uuid, $4, $5, 'urine', 'awaiting_setup', now(), 1, $6, $6 FROM generate_series(1, 10001) g
            ON CONFLICT DO NOTHING`, [C, uid(), ORDER_C, W.patient, W.test, SYS]);
          await c.query('COMMIT');
        } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
      }
      const r = await call({ tenant: C, membership: W.memHub, all: true }, 'listCultures', { query: { order_id: ORDER_C, include_total: true, limit: 1 } });
      expect(r.err).toBeUndefined();
      expect(r.res.body.page.total).toBe(10000);
      expect(responseErrors('listCultures', r.res.body)).toEqual([]);
    }, 60_000);
  });

  describe('AC-02.3 / S-02 centre scope (RLS, D-63) — A1-only user vs D-13 hub user', () => {
    it('list: the A1-only user sees every A1 culture and none of A2; the hub user sees both', async () => {
      const a1 = keysOf((await listBody(A1, { limit: 100 })).data);
      expect(a1).not.toContain('a2');
      expect(a1.sort()).toEqual(SEEDS.filter((s) => s.centre !== 'A2').map((s) => s.key).sort());
      expect(keysOf((await listBody(HUB, { limit: 100 })).data)).toContain('a2');
      expect((await listBody(A1, { include_total: true })).page['total']).toBe(SEEDS.length - 1);
    });

    it('list with centre_id = A2 as the A1-only user -> 200 and zero rows (no error that confirms the centre)', async () => {
      const b = await listBody(A1, { centre_id: W.centreA2, include_total: true });
      expect(b.data).toEqual([]);
      expect(b.page['total']).toBe(0);
    });

    it.each([['getCulture', {}], ['listCultureReportVersions', {}], ['getCultureReportVersion', { version_no: 1 }]])('%s of the A2 culture: A1-only user -> 404 common.not_found; hub user -> 200', async (op, extra) => {
      const params = { culture_id: W.ids['a2'], ...extra };
      const denied = await call(A1, op, { params });
      expect(isLimsError(denied.err, 'common.not_found'), `${denied.err?.code}`).toBe(true);
      expect(denied.err.statusCode).toBe(404);
      expect(denied.calls.access).toEqual([]);
      const ok = await call(HUB, op, { params });
      expect(ok.err, `${ok.err?.code}`).toBeUndefined();
      expect(ok.res.status).toBe(200);
    });

    it('child rows are centre-scoped too: a plate of an A1 culture filed under centre A2 is invisible to the A1-only user and visible to the hub user', async () => {
      const params = { culture_id: W.ids['final'] };
      const a1 = (await call(A1, 'getCulture', { params })).res.body;
      const hub = (await call(HUB, 'getCulture', { params })).res.body;
      expect(a1.plates.map((p: Row) => p.media_code)).toEqual(['syn_blood']);
      expect(hub.plates.map((p: Row) => p.media_code)).toEqual(['syn_blood', 'syn_hidden']);
    });
  });

  describe('cross-tenant probe (T-A1, S-01)', () => {
    it.each([['getCulture', {}], ['listCultureReportVersions', {}], ['getCultureReportVersion', { version_no: 1 }]])('%s with a tenant B culture id as tenant A -> the same 404 as a missing id; no side effect', async (op, extra) => {
      const foreign = await call(HUB, op, { params: { culture_id: W.b.culture, ...extra } });
      const missing = await call(HUB, op, { params: { culture_id: uid(), ...extra } });
      for (const r of [foreign, missing]) { expect(isLimsError(r.err, 'common.not_found'), `${r.err?.code}`).toBe(true); expect(r.err.statusCode).toBe(404); }
      expect({ code: foreign.err.code, message: foreign.err.message }).toEqual({ code: missing.err.code, message: missing.err.message });
      expect(foreign.calls.access).toEqual([]);
      expect(foreign.calls.lab).toEqual([]);
    });
    it('list by a tenant B order_id / specimen_id / centre_id as tenant A -> 200, zero rows; tenant B sees its own culture', async () => {
      const spB = (await q('SELECT specimen_id FROM micro.cultures WHERE id = $1', [W.b.culture]))[0].specimen_id;
      for (const query of [{ order_id: W.b.order }, { specimen_id: spB }, { centre_id: W.centreB1 }]) {
        const r = await call(HUB, 'listCultures', { query }); expect(r.err).toBeUndefined(); expect(r.res.body.data).toEqual([]);
      }
      const own = await call(asB, 'listCultures', { query: { order_id: W.b.order } });
      expect(own.res.body.data.map((d: Row) => d['id'])).toEqual([W.b.culture]);
    });
  });

  describe('M2 / M15 / M16 from stored rows', () => {
    it('M2 final culture: conforms to CultureDetailDto; plates/observations/isolates(+ast)/transitions/report_versions from the DB; displays from the core fakes; one culture.view access entry; no lab_result without lab.result.read', async () => {
      const r = await call(HUB, 'getCulture', { params: { culture_id: W.ids['final'] } });
      expect(r.err, `${r.err?.code}`).toBeUndefined();
      const b = r.res.body;
      expect(schemaErrors('CultureDetailDto', b)).toEqual([]);
      expect(b.observations.map((o: Row) => [o['recorded_by_display'], o['is_corrected']])).toEqual([[TECH, true], [TECH, false]]);
      expect(b.observations[0].hours_since_planting).toBe(24);
      expect(b.isolates).toHaveLength(1);
      expect(b.isolates[0].ast.map((x: Row) => x['antibiotic_code'])).toEqual(['syn_abx']);
      expect(b.transitions.map((t: Row) => [t['to_status'], t['actor_display']])).toEqual([['awaiting_setup', TECH], ['incubating', TECH]]);
      expect(b.report_versions.map((v: Row) => v['version_no'])).toEqual([1, 2]);
      expect('lab_result' in b).toBe(false);
      expect(r.calls.access).toEqual([{ action: 'culture.view', entityType: 'micro_culture', entityId: W.ids['final'], outcome: 'allowed' }]);
      expect(r.calls.members).toHaveLength(1);
    });

    it('M2 with lab.result.read: lab_result from the LabPort line of the culture\'s order item', async () => {
      const lab = (i: Row) => ({ orderId: i['orderId'], specimens: [], approvedSetHash: 'h', items: [{ orderItemId: 'x', testId: W.test, departmentId: uid(), results: [{ resultId: uid(), orderItemId: 'x', testId: W.test, analyteId: uid(), versionNo: 2, status: 'approved', origin: 'module', commentCodes: [],
        attachments: [], onHold: false, qcReviewRequired: false, approvedAt: '2026-11-07T00:00:00.000Z', moduleRef: { module: 'micro', entityId: W.ids['final'], versionNo: 2 } }] }] });
      const item = (await q('SELECT order_item_id FROM micro.cultures WHERE id = $1', [W.ids['final']]))[0].order_item_id;
      const withItem = (i: Row) => { const x: any = lab(i); x.items[0].orderItemId = item; x.items[0].results[0].orderItemId = item; return x; };
      const r = await call(HUB, 'getCulture', { params: { culture_id: W.ids['final'] } }, { grants: [READ, LAB_READ], lab: withItem });
      expect(r.err, `${r.err?.code}`).toBeUndefined();
      expect(r.res.body.lab_result).toMatchObject({ status: 'approved', version_no: 2, approved_at: '2026-11-07T00:00:00.000Z' });
      expect(r.calls.lab).toEqual([{ orderId: W.order, scope: 'all_visible' }]);
    });

    it('M15 lists the two versions of `final` ascending; M16 returns ReportVersionDto with the stored snapshot', async () => {
      const l = await call(HUB, 'listCultureReportVersions', { params: { culture_id: W.ids['final'] } });
      expect(responseErrors('listCultureReportVersions', l.res.body)).toEqual([]);
      expect(l.res.body.data.map((v: Row) => v['version_no'])).toEqual([1, 2]);
      const v = await call(HUB, 'getCultureReportVersion', { params: { culture_id: W.ids['final'], version_no: 2 } });
      expect(schemaErrors('ReportVersionDto', v.res.body)).toEqual([]);
      expect(v.res.body).toMatchObject({ version_no: 2, report_phase: 'final', culture_summary_text: 'Synthetic summary 2', signed_by_display: TECH });
      expect(v.res.body.isolates).toEqual([{ seq: 1, organism_code: 'syn_org', organism_display: 'Synthetic organism', growth_text: 'heavy' }]);
      const none = await call(HUB, 'getCultureReportVersion', { params: { culture_id: W.ids['final'], version_no: 3 } });
      expect(isLimsError(none.err, 'common.not_found')).toBe(true);
    });

    it('the reads write nothing to micro (row counts and culture versions unchanged)', async () => {
      const before = await q('SELECT (SELECT count(*) FROM micro.cultures) c, (SELECT count(*) FROM micro.culture_transitions) t, (SELECT max(version) FROM micro.cultures WHERE order_id = $1) v', [W.order]);
      await call(HUB, 'getCulture', { params: { culture_id: W.ids['final'] } }); await listBody(HUB, {}); await call(HUB, 'listCultureReportVersions', { params: { culture_id: W.ids['final'] } });
      expect(await q('SELECT (SELECT count(*) FROM micro.cultures) c, (SELECT count(*) FROM micro.culture_transitions) t, (SELECT max(version) FROM micro.cultures WHERE order_id = $1) v', [W.order])).toEqual(before);
    });
  });
});
