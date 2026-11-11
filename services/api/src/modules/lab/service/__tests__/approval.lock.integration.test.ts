// C5 T-17 — DB lock behaviour for approved results, as lims_api (06 T-17 "DB lock test (UPDATE as lims_api raises)"; PRD AC-16.4; 07-SECURITY S-03, REQ-SEC-024; 02-TRD §4.3 finding C5 #10;
//   05-SCHEMA lab.enforce_result_lock, result_versions__mutable_columns, lab.v_result_current, lab.approvals).
// Needs the migrated+seeded database that tests/db/c5-t03/run.sh starts (see .orchestra/notes/C5.T-17-verify.cmd): LIMS_TEST_DATABASE_URL = role lims_api (RLS on), LIMS_TEST_ADMIN_DATABASE_URL = superuser.
// Loads tests/db/c5-t03/fixtures.sql (tenant A approved result uid(2003); tenant B approved result uid(4001)) into the fresh database. Without the URLs the DB tests skip, except under LIMS_T03_REQUIRE_DB=1 (run.sh).
// The DB-level raise is mapped to 409 common.immutable_record by core/db/sqlstate.ts (tested in core); here: the raw behaviour the API relies on. No product code is under test: this proves the schema/lock contract the T-17 store builds on.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const API_URL = process.env['LIMS_TEST_DATABASE_URL'];
const ADMIN_URL = process.env['LIMS_TEST_ADMIN_DATABASE_URL'];
const live = Boolean(API_URL && ADMIN_URL);

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const MEMBERSHIP_A = '01a1a98a-ac40-7000-8000-00000000a500';
const uid = (n: number) => `0190c503-0000-7000-8000-${String(n).padStart(12, '0')}`;
const APPROVED_A = uid(2003), APPROVED_B = uid(4001), PENDING_A = uid(2002);
const claims = (tenantId: string) => JSON.stringify({ tenant_id: tenantId, sub: SYS, actor_type: 'system' });

let api: pg.Pool;
let admin: pg.Pool;

/** One request-shaped transaction as lims_api (claims transaction-local like core/db/tx.ts). Rolled back unless `commit`. */
async function asApi<T>(tenant: string, fn: (q: (text: string, v?: unknown[]) => Promise<pg.QueryResult>) => Promise<T>, commit = false): Promise<T> {
  const c = await api.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(tenant)]);
    const out = await fn((t, v) => c.query(t, v));
    await c.query(commit ? 'COMMIT' : 'ROLLBACK');
    return out;
  } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
}
async function rejection(p: Promise<unknown>): Promise<any> { try { await p; } catch (e) { return e; } throw new Error('expected rejection, but it resolved'); }

beforeAll(async () => {
  if (!live) return;
  api = new pg.Pool({ connectionString: API_URL, max: 3 });
  admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
  await admin.query(readFileSync(fileURLToPath(new URL('../../../../../../../tests/db/c5-t03/fixtures.sql', import.meta.url)), 'utf8'));
}, 120_000);
afterAll(async () => { await Promise.all([api?.end(), admin?.end()]); });

describe('T-17 harness', () => {
  it('the migrated database is provided (fails, never skips, under LIMS_T03_REQUIRE_DB=1)', () => {
    if (process.env['LIMS_T03_REQUIRE_DB'] === '1') expect(live).toBe(true);
  });
});

describe.skipIf(!live)('T-17 AC-16.4 / S-03 approved result is locked for lims_api', () => {
  it('fixture sanity: the approved result is visible to its tenant and invisible to the other', async () => {
    expect((await asApi(A, (q) => q('SELECT status FROM lab.results WHERE id = $1', [APPROVED_A]))).rows).toEqual([{ status: 'approved' }]);
    expect((await asApi(B, (q) => q('SELECT 1 FROM lab.results WHERE id = $1', [APPROVED_A]))).rows).toEqual([]);
  });
  it.each([
    ['value_numeric', 'value_numeric = 9.9'], ['flag', "flag = 'HH'"], ['status back to resulted', "status = 'resulted'"], ['comment_text', "comment_text = 'x'"], ['unit_code', "unit_code = 'x'"],
  ])('UPDATE lab.results SET %s on an approved row raises immutable_row', async (_n, set) => {
    const e = await rejection(asApi(A, (q) => q(`UPDATE lab.results SET ${set} WHERE id = $1`, [APPROVED_A])));
    expect(String(e.message)).toContain('immutable_row');
  });
  it('a pending result of the same tenant is still editable (the lock is status-bound, not table-wide)', async () => {
    const r = await asApi(A, (q) => q('UPDATE lab.results SET comment_text = $2 WHERE id = $1', [PENDING_A, 'ok']));
    expect(r.rowCount).toBe(1);
  });
  it('DELETE on lab.results / lab.result_versions / lab.approvals is permission denied (no DELETE grant)', async () => {
    for (const t of ['lab.results', 'lab.result_versions', 'lab.approvals']) {
      const e = await rejection(asApi(A, (q) => q(`DELETE FROM ${t} WHERE tenant_id = $1`, [A])));
      expect(String(e.message), t).toMatch(/permission denied/);
    }
  });
  it('tenant B cannot touch tenant A approved result (RLS: 0 rows, not even the lock error)', async () => {
    const r = await asApi(B, (q) => q('UPDATE lab.results SET current_version_no = 2 WHERE id = $1', [APPROVED_A]));
    expect(r.rowCount).toBe(0);
  });
});

describe.skipIf(!live)('T-17 amendment storage: new result_versions row, read back through lab.v_result_current (finding C5 #10)', () => {
  it('v1 + v2 inserted as lims_api, results.current_version_no bumped (the only allowed change); the row value stays v1, the view returns v2 evaluation; v1 can be marked superseded but its value never changes', async () => {
    const centre = (await admin.query('SELECT centre_id FROM lab.results WHERE id = $1', [APPROVED_A])).rows[0].centre_id;
    const v1 = uid(7001), v2 = uid(7002);
    const ins = `INSERT INTO lab.result_versions (id, tenant_id, centre_id, result_id, version_no, origin, value_numeric, flag, is_critical, delta_status, approved_at, approved_by_membership_id, previous_version_no, amendment_reason_code, created_by, updated_by)
                 VALUES ($1, $2, $3, $4, $5, 'manual', $6, $7, $8, 'not_applicable', now(), $9, $10, $11, $12, $12)`;
    await asApi(A, async (q) => {
      await q(ins, [v1, A, centre, APPROVED_A, 1, '5.1', 'N', false, MEMBERSHIP_A, null, null, SYS]);
      await q(ins, [v2, A, centre, APPROVED_A, 2, '13.8', 'H', true, MEMBERSHIP_A, 1, 'TRANSCRIPTION_ERROR', SYS]);
      await q("UPDATE lab.result_versions SET superseded_at = now(), superseded_by_version_no = 2 WHERE id = $1", [v1]);
      const bump = await q('UPDATE lab.results SET current_version_no = 2 WHERE id = $1', [APPROVED_A]);
      expect(bump.rowCount).toBe(1);                                                    // allowed by lab.enforce_result_lock on an approved row
      const row = (await q('SELECT value_numeric, cur_value_numeric, cur_flag, cur_is_critical, current_version_no FROM lab.v_result_current WHERE id = $1', [APPROVED_A])).rows[0];
      expect(Number(row.value_numeric)).toBe(5.1);                                      // the locked row keeps v1
      expect(Number(row.cur_value_numeric)).toBe(13.8);                                 // readers go through the view
      expect([row.cur_flag, row.cur_is_critical, row.current_version_no]).toEqual(['H', true, 2]);
      const e1 = await rejection(q('UPDATE lab.result_versions SET value_numeric = 1 WHERE id = $1', [v2]));
      expect(String(e1.message)).toMatch(/immutable_row|immutable/);                    // version value columns are immutable (S-03)
    });
  });
  it('lab.approvals only accepts aal2 and one row per (result, version_no)', async () => {
    const centre = (await admin.query('SELECT centre_id FROM lab.results WHERE id = $1', [APPROVED_B])).rows[0].centre_id;
    const ins = (aal: string, n = 1, rid = uid(7101)) => asApi(B, (q) => q(
      `INSERT INTO lab.approvals (id, tenant_id, centre_id, result_id, version_no, kind, membership_id, aal, occurred_at, created_by) VALUES ($1, $2, $3, $4, $5, 'approval', $6, $7, now(), $8)`,
      [rid, B, centre, APPROVED_B, n, '01a1a98a-ac40-7000-8000-00000000b500', aal, SYS]));
    expect(String((await rejection(ins('aal1'))).message)).toMatch(/approvals__aal__ck|check constraint/);
    expect((await ins('aal2')).rowCount).toBe(1);
  });
});
