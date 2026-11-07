// T23 readiness (AC-E3.4, 03-APP-FLOW s2.5, 08 A25 D-216, 07-SECURITY D-T23): getTenantSettings(['ird']).annexReadiness is computed in the SETTINGS_SQL of
// repository/core-admin.repo.ts. Part 1 = static guard on that SQL (runs everywhere); part 2 = truth table over a real DB (skipped without LIMS_TEST_DATABASE_URL,
// same preconditions as ports/__tests__/IdentityPort.live.test.ts: tenant ...a001 with a tenant_settings row). Synthetic data only; every live case ROLLS BACK.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SRC = readFileSync(fileURLToPath(new URL('../../repository/core-admin.repo.ts', import.meta.url)), 'utf8');
const SQL = /const SETTINGS_SQL = `([\s\S]*?)`;/.exec(SRC)?.[1] ?? '';
const norm = (s: string) => s.replace(/\s+/g, ' ');

describe('SETTINGS_SQL readiness predicate (static)', () => {
  it('SETTINGS_SQL is found and still selects annex_complete', () => { expect(SQL).toContain('annex_complete'); });
  it('tenant side: own rows only ($1), active, completed, exactly annex_2/3/7 (count distinct = 3)', () => {
    const s = norm(SQL);
    expect(s).toMatch(/a\.tenant_id = \$1/); expect(s).toMatch(/a\.is_active/); expect(s).toMatch(/a\.status = 'completed'/);
    expect(s).toMatch(/a\.annex_code IN \('annex_2',\s*'annex_3',\s*'annex_7'\)/); expect(s).toMatch(/count\(DISTINCT a\.annex_code\) FROM[^;]*?\) = 3/);
  });
  it('platform side (D-216): ONLY the row the tenant references, platform-level, annex_1, completed - never "any completed annex_1"', () => {
    const s = norm(SQL);
    expect(s).toMatch(/p\.tenant_id IS NULL/); expect(s).toMatch(/p\.annex_code = 'annex_1'/);
    expect(s).toMatch(/p\.id = ts\.ird_annex_1_record_id/); expect(s).toMatch(/p\.status = 'completed'/);
  });
  it('the two sides are AND-ed (a missing reference cannot yield complete)', () => { expect(norm(SQL)).toMatch(/= 3 AND EXISTS \(SELECT 1 FROM identity\.ird_annex_records p/); });
});

const URL_ = process.env['LIMS_TEST_DATABASE_URL'];
const TENANT = '01a1a98a-ac40-7000-8000-00000000a001', OTHER = '01a1a98a-ac40-7000-8000-00000000a0ff', SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const id = (n: number) => `0190a000-0000-7000-8000-${(0x230000 + n).toString(16).padStart(12, '0')}`;
type Code = 'annex_1' | 'annex_2' | 'annex_3' | 'annex_7'; type St = 'completed' | 'in_preparation' | 'superseded' | 'not_started';
interface Row { n: number; code: Code; st: St; tenant?: string | null; active?: boolean }
const T = (n: number, code: Exclude<Code, 'annex_1'>, st: St, o: Partial<Row> = {}): Row => ({ n, code, st, tenant: TENANT, ...o });
const P = (n: number, st: St): Row => ({ n, code: 'annex_1', st, tenant: null });
const FULL = [T(1, 'annex_2', 'completed'), T(2, 'annex_3', 'completed'), T(3, 'annex_7', 'completed')];

describe.skipIf(!URL_)('annexReadiness truth table over a real DB (AC-E3.4)', () => {
  let admin: any;
  beforeAll(async () => { const pg: any = await import(['p', 'g'].join('')); admin = new ((pg.default ?? pg).Pool)({ connectionString: URL_, max: 2 }); });
  afterAll(async () => { await admin?.end(); });
  /** rows seeded, tenant_settings.ird_annex_1_record_id := id(ref) (or NULL), SETTINGS_SQL evaluated, then ROLLBACK */
  const readiness = async (rows: Row[], ref: number | null): Promise<string> => {
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ tenant_id: TENANT, sub: SYS, actor_type: 'system' })]);
      for (const r of rows) {
        const done = r.st === 'completed' || r.st === 'superseded';
        await c.query(`INSERT INTO identity.ird_annex_records (id, tenant_id, annex_code, status, submitted_on, completed_on, reference_no, is_active, created_by, updated_by)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
          [id(r.n), r.tenant ?? null, r.code, r.st, done ? '2026-11-01' : null, done ? '2026-11-03' : null, done ? `REF-${r.n}` : null, r.active ?? true, SYS]);
      }
      await c.query(`UPDATE identity.tenant_settings SET ird_annex_1_record_id = $2 WHERE tenant_id = $1`, [TENANT, ref === null ? null : id(ref)]);
      const out = await c.query(SQL, [TENANT]);
      return out.rows[0].annex_complete === true ? 'complete' : 'incomplete';
    } finally { await c.query('ROLLBACK'); c.release(); }
  };
  it.each([
    ['all four completed, annex_1 referenced', [...FULL, P(10, 'completed')], 10, 'complete'],
    ['annex_2 not completed', [T(1, 'annex_2', 'in_preparation'), FULL[1]!, FULL[2]!, P(10, 'completed')], 10, 'incomplete'],
    ['annex_3 missing', [FULL[0]!, FULL[2]!, P(10, 'completed')], 10, 'incomplete'],
    ['annex_7 superseded and its successor not_started', [FULL[0]!, FULL[1]!, T(3, 'annex_7', 'superseded'), T(4, 'annex_7', 'not_started'), P(10, 'completed')], 10, 'incomplete'],
    ['annex_7 superseded, successor completed', [FULL[0]!, FULL[1]!, T(3, 'annex_7', 'superseded'), T(4, 'annex_7', 'completed'), P(10, 'completed')], 10, 'complete'],
    ['annex_1 referenced but not completed', [...FULL, P(10, 'in_preparation')], 10, 'incomplete'],
    ['annex_1 completed but NOT the referenced one', [...FULL, P(10, 'in_preparation'), P(11, 'completed')], 10, 'incomplete'],
    ['no annex_1 reference at all', [...FULL, P(10, 'completed')], null, 'incomplete'],
    ['inactive tenant row does not count', [T(1, 'annex_2', 'completed', { active: false }), FULL[1]!, FULL[2]!, P(10, 'completed')], 10, 'incomplete'],
    ["another tenant's completed annexes do not count", [T(1, 'annex_2', 'completed', { tenant: OTHER }), FULL[1]!, FULL[2]!, P(10, 'completed')], 10, 'incomplete'],
  ] as const)('%s', async (_n, rows, ref, want) => { expect(await readiness(rows as Row[], ref)).toBe(want); });
});
