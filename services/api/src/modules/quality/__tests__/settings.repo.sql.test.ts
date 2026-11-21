// C9 T-20 — SQL hygiene of repository/settings.repo.ts additions (updateSettings, listGlobalCodes, listTenantCodes, upsertTenantCode) plus the T-01 statements (02-TRD §12.1, 05-SCHEMA §2/§8;
// 07-SECURITY REQ-SEC-022/024/082). No database: a recording tx. Seams: settings.helpers.ts header. Fails now: the four functions do not exist ("is not a function").
import { describe, expect, it } from 'vitest';
import * as repo from '../repository/settings.repo.js';
import { MUTABLE, SET_ID, TENANT_A, USER, body, rejection } from './settings.helpers.js';

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
function rec(rows: any[] = [{ code: 'x', display: 'x', sort_order: 1, is_active: true, version: 2 }]) {
  const q: Array<{ text: string; values: unknown[] }> = [];
  return { tx: { async query(text: string, values: unknown[] = []) { q.push({ text: norm(text), values }); return { rows, rowCount: rows.length }; } }, q };
}
const patch = () => { const b = body(); return Object.fromEntries(MUTABLE.map((k) => [k, b[k]])); };
const R: any = repo;
async function all(set = 'corrective_actions') {
  const { tx, q } = rec();
  await repo.insertSettingsDefaults(tx, { id: SET_ID(1), tenantId: TENANT_A, actorId: USER });
  await repo.getSettings(tx, TENANT_A);
  await repo.insertSyncState(tx, { id: SET_ID(2), tenantId: TENANT_A, activatedAt: '2026-07-16T03:15:00.000Z' });
  await R.updateSettings(tx, TENANT_A, 1, patch(), USER);
  await R.listGlobalCodes(tx, set);
  await R.listTenantCodes(tx, TENANT_A, set);
  await R.upsertTenantCode(tx, TENANT_A, set, { id: SET_ID(3), code: 'recalibrated', display: 'Synthetic recalibration', sortOrder: 10, isActive: true, actorId: USER });
  return q;
}

describe('settings.repo: every statement', () => {
  it('is parameterised: no id, tenant, actor, code or display is interpolated into the SQL text', async () => {
    for (const s of await all()) for (const lit of [TENANT_A, USER, SET_ID(1), SET_ID(3), 'recalibrated', 'Synthetic recalibration', '2026-07-16']) expect(s.text, s.text).not.toContain(lit);
  });
  it('quality schema only; never DELETE / TRUNCATE / DROP; no other module\'s table or view', async () => {
    for (const s of await all()) {
      expect(s.text, s.text).not.toMatch(/\bDELETE\b|\bTRUNCATE\b|\bDROP\b|\bALTER\b/i);
      expect(s.text, s.text).not.toMatch(/\b(lab|instruments|catalog|frontdesk|billing|identity|core|reporting|analytics)\./i);
    }
  });
  it('every tenant-table statement binds the tenant and filters on tenant_id = $n (or writes the tenant_id column); the global-table read has no tenant predicate and binds no tenant', async () => {
    for (const s of await all()) {
      if (/quality\.g_cs_/.test(s.text)) { expect(s.text).not.toMatch(/tenant_id/); expect(s.values).not.toContain(TENANT_A); continue; }
      expect(s.values, s.text).toContain(TENANT_A); expect(s.text, s.text).toMatch(/tenant_id/);
      if (!/^INSERT/i.test(s.text)) expect(s.text, s.text).toMatch(/tenant_id\s*=\s*\$\d/);
    }
  });
});

describe('T-01 ensure statements stay race-safe (02-TRD §12.1, 08 A17 D-56)', () => {
  it('settings insert is ON CONFLICT (tenant_id) DO NOTHING with activated_at = now(); sync_state cursor = activated_at - 400 days, ON CONFLICT DO NOTHING', async () => {
    const q = await all(); const s = q.find((x) => /INSERT INTO quality\.settings/i.test(x.text))!, y = q.find((x) => /INSERT INTO quality\.sync_state/i.test(x.text))!;
    expect(s.text).toMatch(/ON CONFLICT \(tenant_id\) DO NOTHING/i); expect(s.text).toMatch(/now\(\)/i); expect(y.text).toMatch(/ON CONFLICT \(tenant_id\) DO NOTHING/i); expect(y.text).toMatch(/interval '400 days'/i);
  });
  it('getSettings now returns updated_at (the DTO needs it) and still the columns it had', async () => {
    const q = await all(); const g = q.find((x) => /^SELECT/i.test(x.text) && /quality\.settings/.test(x.text))!;
    for (const c of ['updated_at', 'version', 'activated_at', 'default_plan_params', ...MUTABLE.filter((k) => k !== 'default_plan_params')]) expect(g.text, c).toContain(c);
  });
});

describe('updateSettings (#52)', () => {
  it('UPDATE quality.settings ... WHERE tenant_id = $n AND version = $n ... RETURNING: compare-and-swap, one statement, version = version + 1, updated_by / updated_at set', async () => {
    const { tx, q } = rec(); await R.updateSettings(tx, TENANT_A, 4, patch(), USER); expect(q).toHaveLength(1); const t = q[0]!.text;
    expect(t).toMatch(/^UPDATE quality\.settings SET /i); expect(t).toMatch(/WHERE .*tenant_id\s*=\s*\$\d+/i); expect(t).toMatch(/\bversion\s*=\s*\$\d+/i); expect(t).toMatch(/version\s*=\s*version\s*\+\s*1/i);
    expect(t).toMatch(/updated_at\s*=\s*now\(\)/i); expect(t).toMatch(/updated_by\s*=\s*\$\d+/i); expect(t).toMatch(/RETURNING/i); expect(q[0]!.values).toEqual(expect.arrayContaining([TENANT_A, 4, USER]));
  });
  it('the SET list holds exactly the nine mutable columns (+ version/updated_*): never activated_at, tenant_id, id, is_active, created_*', async () => {
    const { tx, q } = rec(); await R.updateSettings(tx, TENANT_A, 1, patch(), USER); const set = /SET (.*?) WHERE/i.exec(q[0]!.text)![1]!;
    const cols = [...set.matchAll(/(?:^|,\s*)([a-z_]+)\s*=/gi)].map((m) => m[1]);
    expect(cols).toEqual(expect.arrayContaining(MUTABLE)); for (const bad of ['activated_at', 'tenant_id', 'id', 'is_active', 'created_by', 'created_at']) expect(cols, bad).not.toContain(bad);
    expect(cols.filter((c) => !MUTABLE.includes(c!)).sort()).toEqual(['updated_at', 'updated_by', 'version']);
  });
  it('default_plan_params goes in as a bound jsonb parameter (::jsonb of JSON text), not spliced', async () => {
    const { tx, q } = rec(); const p = patch(); await R.updateSettings(tx, TENANT_A, 1, p, USER);
    expect(q[0]!.text).toMatch(/default_plan_params\s*=\s*\$\d+(::jsonb)?/i); expect(q[0]!.values.some((v) => (typeof v === 'string' && v === JSON.stringify(p['default_plan_params'])) || (typeof v === 'object' && v !== null && JSON.stringify(v) === JSON.stringify(p['default_plan_params'])))).toBe(true);
  });
  it('0 rows -> undefined (version mismatch); a row -> that row', async () => {
    expect(await R.updateSettings(rec([]).tx, TENANT_A, 9, patch(), USER)).toBeUndefined(); expect((await R.updateSettings(rec([{ version: 2 }]).tx, TENANT_A, 1, patch(), USER)).version).toBe(2);
  });
  it('a patch key outside the mutable set is refused before any statement is run (no SQL built from keys it does not know)', async () => {
    for (const k of ['activated_at', 'tenant_id', 'version = 99, tenant_id', 'x" = 1; DROP TABLE quality.settings; --']) {
      const { tx, q } = rec(); const e = await rejection(R.updateSettings(tx, TENANT_A, 1, { ...patch(), [k]: 'x' }, USER)); expect(e).toBeInstanceOf(Error); expect(q).toEqual([]);
    }
  });
});

describe('coded sets (#53, #54): the table name comes from a fixed allowlist', () => {
  const T: Record<string, [string, string]> = { corrective_actions: ['quality.g_cs_corrective_actions', 'quality.cs_corrective_actions'], exclusion_reasons: ['quality.g_cs_exclusion_reasons', 'quality.cs_exclusion_reasons'] };
  for (const [set, [g, t]] of Object.entries(T)) {
    it(`${set}: global read hits ${g} only; tenant read and upsert hit ${t} only (never the other set's tables)`, async () => {
      const q = await all(set); const other = Object.values(T).flat().filter((x) => x !== g && x !== t);
      const tbls = (s: string) => [...s.matchAll(/quality\.[a-z_]+/gi)].map((m) => m[0]);
      expect(q.filter((x) => tbls(x.text).includes(g))).toHaveLength(1); expect(q.filter((x) => tbls(x.text).includes(t))).toHaveLength(2);
      for (const s of q) for (const o of other) expect(s.text, o).not.toContain(o);
    });
  }
  it('an unknown or hostile set is refused (throws) before any statement; nothing is ever built from it', async () => {
    for (const set of ['nope', '', 'x; DROP TABLE quality.settings', "corrective_actions' --", '../settings', 'settings', undefined, 5]) {
      const { tx, q } = rec();
      for (const call of [() => R.listGlobalCodes(tx, set), () => R.listTenantCodes(tx, TENANT_A, set), () => R.upsertTenantCode(tx, TENANT_A, set, { id: SET_ID(3), code: 'abc', display: 'x', sortOrder: 1, isActive: true, actorId: USER })]) expect((await rejection(call())) instanceof Error).toBe(true);
      expect(q, String(set)).toEqual([]);
    }
  });
  it('listGlobalCodes / listTenantCodes are plain SELECTs of code, display, sort_order, is_active (no select *), ordered', async () => {
    const q = await all(); for (const s of q.filter((x) => /^SELECT/i.test(x.text) && /cs_/.test(x.text))) { expect(s.text).not.toMatch(/SELECT\s+\*/i); for (const c of ['code', 'display', 'sort_order', 'is_active']) expect(s.text, c).toContain(c); expect(s.text).toMatch(/ORDER BY/i); expect(s.text).not.toMatch(/\bFOR UPDATE\b/i); }
  });
  it('upsertTenantCode: one INSERT ... ON CONFLICT (tenant_id, code) DO UPDATE ... RETURNING (race-safe); sets display, sort_order, is_active, version + 1, updated_*; never rewrites id / tenant_id / created_*', async () => {
    const { tx, q } = rec(); await R.upsertTenantCode(tx, TENANT_A, 'corrective_actions', { id: SET_ID(3), code: 'recalibrated', display: 'Synthetic recalibration', sortOrder: 10, isActive: true, actorId: USER });
    expect(q).toHaveLength(1); const t = q[0]!.text; expect(t).toMatch(/^INSERT INTO quality\.cs_corrective_actions/i); expect(t).toMatch(/ON CONFLICT \(tenant_id, code\) DO UPDATE/i); expect(t).toMatch(/RETURNING/i);
    const upd = /DO UPDATE SET (.*?)(?: WHERE| RETURNING|$)/i.exec(t)![1]!; for (const c of ['display', 'sort_order', 'is_active', 'updated_at', 'updated_by']) expect(upd, c).toContain(c);
    for (const bad of ['tenant_id', 'created_by', 'created_at', ' id ']) expect(upd, bad).not.toContain(bad);
    expect(q[0]!.values).toEqual(expect.arrayContaining([TENANT_A, 'recalibrated', 'Synthetic recalibration', 10, true, USER]));
  });
  it('the upsert returns the DTO columns only (code, display, sort_order, is_active) — nothing of tenant_id / created_by / version', async () => {
    const { tx } = rec([{ code: 'a', display: 'b', sort_order: 1, is_active: true, tenant_id: TENANT_A, created_by: USER, version: 3 }]);
    const r = await R.upsertTenantCode(tx, TENANT_A, 'exclusion_reasons', { id: SET_ID(3), code: 'abc', display: 'b', sortOrder: 1, isActive: true, actorId: USER }); expect(Object.keys(r).sort()).toEqual(['code', 'display', 'is_active', 'sort_order']);
  });
});
