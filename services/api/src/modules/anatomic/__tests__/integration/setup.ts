// C11 T-04 integration harness (06-PLAN T-04: "CRUD against migrated PG17 with tenants A/B"). Used by repositories.live.test.ts.
// Gated like billing/repository/__tests__/immutability.live.test.ts: live tests are skipped unless both URLs are set.
//   LIMS_TEST_DATABASE_URL      superuser URL of a DB with the C0 migrations (incl. the anatomic schema, 05-SCHEMA §6/§7) + db/seeds applied. Seeds/cleans only.
//   LIMS_TEST_APP_DATABASE_URL  URL of a connection that logs in as (or can SET ROLE to) lims_app; every repo call runs as lims_app with real claims.
// Seeded identities (db/seeds/010_core__synthetic_tenants.sql): tenant A + centres A1/A2, membership a50a = centre-scoped to A1 only, a500 = all_centres; tenant B.
// Fixture rows are inserted by the superuser with session_replication_role = replica (no frontdesk/lab FK parents needed), use ids `0190c411-…`
// and year/series values that cannot collide with seeds, and are removed again by `cleanup()`.
import { createDb } from '../../../../core/db/tx.js';

export const SU_URL = process.env['LIMS_TEST_DATABASE_URL'], APP_URL = process.env['LIMS_TEST_APP_DATABASE_URL'];
export const LIVE = !!SU_URL && !!APP_URL;

export const TENANT_A = '01a1a98a-ac40-7000-8000-00000000a001', TENANT_B = '01a1a98a-ac40-7000-8000-00000000b001';
export const CENTRE_A1 = '01a1a98a-ac40-7000-8000-00000000a201', CENTRE_A2 = '01a1a98a-ac40-7000-8000-00000000a202', CENTRE_B1 = '01a1a98a-ac40-7000-8000-00000000b201';
export const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const USER_ALL_A = '01a1a98a-ac40-7000-8000-00000000a300', MEMB_ALL_A = '01a1a98a-ac40-7000-8000-00000000a500';
const USER_A1 = '01a1a98a-ac40-7000-8000-00000000a30a', MEMB_A1 = '01a1a98a-ac40-7000-8000-00000000a50a';

export const CLAIMS = {
  /** staff of tenant A holding all_centres */ allA: { actor_type: 'user', tenant_id: TENANT_A, sub: USER_ALL_A, membership_id: MEMB_ALL_A },
  /** staff of tenant A attached to centre A1 only (no all_centres) */ a1Only: { actor_type: 'user', tenant_id: TENANT_A, sub: USER_A1, membership_id: MEMB_A1 },
  /** core system actor of tenant A / B (has_all_centres true for system) */ sysA: { actor_type: 'system', tenant_id: TENANT_A, sub: SYS },
  sysB: { actor_type: 'system', tenant_id: TENANT_B, sub: SYS },
} as const;

export const uid = (n: number) => `0190c411-0000-7000-8000-${String(n).padStart(12, '0')}`;
/** Fixture ids: cases 1xx, parts 2xx, stains 3xx, transitions 4xx. */
export const ID = { caseA1: uid(101), caseA2: uid(102), caseB1: uid(103), partA1: uid(201), partA2: uid(202), stainA: uid(301), stainB: uid(302), trA1: uid(401) };
/** accession_counters.year_ad value reserved for these tests (CHECK allows 2000..2199). */
export const YEAR = 2199;

export const caseRow = (id: string, tenant: string, centre: string, over: Record<string, unknown> = {}) => ({
  id, tenant_id: tenant, centre_id: centre, order_id: uid(Number(id.slice(-3)) + 500), patient_id: uid(Number(id.slice(-3)) + 600), case_kind: 'histology', status: 'received',
  priority: 'routine', received_at: '2026-11-10T04:00:00.000Z', created_by: SYS, updated_by: SYS, ...over,
});
export const partRow = (id: string, caseId: string, tenant: string, centre: string, letter = 'A') => ({
  id, tenant_id: tenant, centre_id: centre, case_id: caseId, letter, letter_seq: 1, created_by: SYS, updated_by: SYS,
});
export const stainRow = (id: string, tenant: string, code: string, over: Record<string, unknown> = {}) => ({
  id, tenant_id: tenant, code, display: `Stain ${code} (SYNTHETIC)`, kind: 'routine', created_by: SYS, updated_by: SYS, ...over,
});
export const transitionRow = (id: string, caseId: string, tenant: string, centre: string) => ({
  id, tenant_id: tenant, centre_id: centre, case_id: caseId, from_status: null, to_status: 'received', created_by: SYS,
});

export interface Harness {
  /** run `fn` through the real core requestTx as lims_app with the given claims; rolls back when `fn` throws */
  asApp<T>(claims: Record<string, unknown>, fn: (tx: any) => Promise<T>): Promise<T>;
  /** run `fn` on a superuser transaction (bypasses RLS): proves the repo's own explicit tenant filter independently of RLS */
  asSuperuser<T>(fn: (tx: { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }) => Promise<T>): Promise<T>;
  /** one raw statement as lims_app with claims, rolled back; resolves 'n=<rowcount>' or 'E<sqlstate>|<message>' */
  rawApp(claims: Record<string, unknown>, sql: string, values?: unknown[]): Promise<string>;
  /** superuser insert of fixture rows: seed('anatomic.cases', row) */
  seed(table: string, row: object): Promise<void>;
  cleanup(): Promise<void>;
  close(): Promise<void>;
}

const FIXTURE_TABLES = [
  'batch_members', 'molecular_results', 'batches', 'item_submissions', 'report_versions', 'addenda', 'report_drafts', 'images', 'object_movements', 'slides', 'stain_orders',
  'blocks', 'gross_records', 'specimen_links', 'case_items', 'case_transitions', 'parts', 'cases', 'stains',
  'synoptic_templates', 'text_templates', 'cs_cancel_reasons', 'cs_diagnoses', 'cs_cytology_adequacy', 'accession_counters',
] as const; // FK-safe delete order (children first)

export async function openHarness(): Promise<Harness> {
  const pg: any = await import(['p', 'g'].join(''));
  const Pool = (pg.default ?? pg).Pool;
  const su = new Pool({ connectionString: SU_URL, max: 3 }), app = new Pool({ connectionString: APP_URL, max: 12 });
  const db = createDb({ pool: app, identitySystemActorId: SYS });
  let n = 900;
  const withSu = async <T>(fn: (c: any) => Promise<T>) => {
    const c = await su.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL session_replication_role = replica`);
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
  };
  const h: Harness = {
    asApp: (claims, fn) => db.requestTx({ claims: claims as never, requestId: uid(n++), clientIp: '203.0.113.7', operation: { module: 'anatomic', operationId: 'C11.T-04.live' } }, fn as never) as never,
    asSuperuser: (fn) => withSu((c) => fn({ query: (t, v) => c.query(t, v) })),
    async rawApp(claims, sql, values = []) {
      const c = await app.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE lims_app');
        await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
        const r = await c.query(sql, values);
        await c.query('ROLLBACK');
        return `n=${r.rowCount}`;
      } catch (e: any) { await c.query('ROLLBACK').catch(() => undefined); return `E${e.code}|${e.message}`; } finally { c.release(); }
    },
    seed: (table, row) => withSu((c) => c.query(`INSERT INTO ${table} SELECT * FROM jsonb_populate_record(NULL::${table}, $1::jsonb)`, [JSON.stringify(row)])),
    async cleanup() {
      await withSu(async (c) => {
        for (const t of FIXTURE_TABLES) {
          const where = t === 'accession_counters' ? 'year_ad = $1' : `id::text LIKE '0190c411-0000-7000-8000-%' AND $1::int IS NOT NULL`;
          await c.query(`DELETE FROM anatomic.${t} WHERE ${where}`, [YEAR]);
        }
      });
    },
    async close() { await su.end(); await app.end(); },
  };
  return h;
}
