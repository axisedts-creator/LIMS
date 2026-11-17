// T-28a (C3) — the revision-keyed cache as seen through the REAL CatalogPort, and the port's security properties.
// Spec: 02-TRD §6.3 (key = tenant, catalog_revision, kind, id; revision read ONCE per request, memoised on the RequestContext; time filtering in memory so one entry serves all
//       instants), §6.1 ("all run inside ctx.tx, never open a transaction, tenant from ctx.tenantId only"), 03-IC §4.2 ("read-only", "same (input, catalogRevision) => same output",
//       "Caches invalidated by catalog.changed.v1"), 06-PLAN T-28a ("revision = orderables.revision"); PRD AC-19.1; 07-SECURITY S-1 (port probes), A6 (revision drives cache invalidation).
// Interface: helpers/t28a.ts (SEAM header). Notes: .orchestra/notes/T-28a-tests.md.
import { describe, expect, it } from 'vitest';
import {
  CBC, HP_ELITE_M, LAB, NOW, PANEL_B, REV, RHB, RB, T, TEST_B, TC, ID, TENANT_A, TENANT_B,
  bumpAndRename, call, codeOf, inB, isRevisionRead, keysOf, one, setup28a, stmtsOf,
} from '../helpers/t28a.js';

const rq = (analyteId: string, extra: Record<string, unknown> = {}) => ({ analyteId, sex: 'male', ageDays: 400, at: NOW, ...extra });
const CALLS: Array<[string, (e: ReturnType<typeof setup28a>) => unknown]> = [
  ['getTest', () => ({ testId: LAB.test.id })],
  ['getPanel', () => ({ panelId: HP_ELITE_M.panel.id })],
  ['resolveOrderables', () => ({ orderableIds: [HP_ELITE_M.panel.id, LAB.test.id] })],
  ['referenceRangeFor', () => rq(RHB.id)],
  ['criticalLimitsFor', () => rq(RHB.id)],
];

describe('revision-keyed cache (02-TRD §6.3)', () => {
  it.each(CALLS)('%s: a warm call from a NEW request issues exactly one statement — the catalog_revision read — and nothing else', { timeout: T }, async (method, input) => {
    const env = setup28a();
    const first = await one(env, method, input(env));                                  // cold: loads and caches
    const stmts = await stmtsOf(env, async () => { expect(await one(env, method, input(env))).toEqual(first); });
    expect(stmts.map((s) => s.text.replace(/\s+/g, ' ').trim())).toEqual(['SELECT catalog_revision FROM catalog.catalog_state WHERE tenant_id = $1']);
    expect(stmts[0]!.values).toEqual([TENANT_A]);
  });

  it('the revision is read ONCE per request: two different port calls in one ctx issue one catalog_state read in total', { timeout: T }, async () => {
    const env = setup28a();
    await one(env, 'getTest', { testId: LAB.test.id });                                // warm the entry
    const stmts = await stmtsOf(env, () => call(env, async (p, ctx) => {
      await p['getTest']!(ctx, { testId: LAB.test.id });
      await p['getPanel']!(ctx, { panelId: HP_ELITE_M.panel.id });
      await p['referenceRangeFor']!(ctx, rq(RHB.id));
      await p['getTest']!(ctx, { testId: LAB.test.id });
    }));
    expect(stmts.filter((s) => isRevisionRead(s.text))).toHaveLength(1);
  });

  it('a cold request reads the revision once too, even when it loads several entries (resolveOrderables over a panel + test)', { timeout: T }, async () => {
    const env = setup28a();
    const stmts = await stmtsOf(env, () => one(env, 'resolveOrderables', { orderableIds: [HP_ELITE_M.panel.id, LAB.test.id] }));
    expect(stmts.filter((s) => isRevisionRead(s.text))).toHaveLength(1);
    expect(stmts.length).toBeGreaterThan(1);
  });

  it('one entry serves all instants: asOf / at variations on a warm entry add no statements', { timeout: T }, async () => {
    const env = setup28a();
    await one(env, 'getTest', { testId: LAB.test.id });
    await one(env, 'referenceRangeFor', rq(RHB.id));
    const stmts = await stmtsOf(env, async () => {
      const old = await one(env, 'getTest', { testId: LAB.test.id, asOf: '2026-03-01T00:00:00.000Z' });
      const cur = await one(env, 'getTest', { testId: LAB.test.id });
      expect(old.analytes[0].decimals).toBe(1);
      expect(cur.analytes[0].decimals).toBe(2);
      expect((await one(env, 'referenceRangeFor', rq(RHB.id, { ageDays: 5, at: '2026-09-01T00:00:00.000Z' }))).version).toBe(1);
      expect((await one(env, 'referenceRangeFor', rq(RHB.id, { ageDays: 5 }))).version).toBe(2);
    });
    expect(stmts.filter((s) => !isRevisionRead(s.text))).toEqual([]);
    expect(stmts).toHaveLength(4);                                                      // one revision read per request
  });

  it('a committed change + revision bump is visible to the NEXT request (cache miss on the new revision), with no cross-process signal', { timeout: T }, async () => {
    const env = setup28a();
    const before = await one(env, 'getTest', { testId: TC.test.id });
    expect([before.name, before.revision]).toEqual(['Total cholesterol', 0]);
    expect((await one(env, 'resolveOrderables', { orderableIds: [TC.test.id] })).catalogRevision).toBe(REV);
    await bumpAndRename(env, TC.test.id, 'Total cholesterol (renamed)');
    const after = await one(env, 'getTest', { testId: TC.test.id });
    expect(after.name).toBe('Total cholesterol (renamed)');
    expect(after.revision).toBe(REV + 1);                                              // revision = orderables.revision, stamped by the bump
    const r = await one(env, 'resolveOrderables', { orderableIds: [TC.test.id] });
    expect(r.catalogRevision).toBe(REV + 1);
    expect(r.tests[0].name).toBe('Total cholesterol (renamed)');
  });

  it('within one request the revision is stable: a bump committed mid-request does not change the answers of that ctx', { timeout: T }, async () => {
    const env = setup28a();
    await one(env, 'getTest', { testId: TC.test.id });
    const seen = await call(env, async (p, ctx) => {
      const a = await p['getTest']!(ctx, { testId: TC.test.id });
      await bumpAndRename(env, TC.test.id, 'Changed meanwhile');                       // another request commits (a second tx)
      const b = await p['getTest']!(ctx, { testId: TC.test.id });
      return [a.name, b.name];
    });
    expect(seen).toEqual(['Total cholesterol', 'Total cholesterol']);
    expect((await one(env, 'getTest', { testId: TC.test.id })).name).toBe('Changed meanwhile');
  });

  it('an old-revision entry is never served after a bump even if the cache still holds it (key includes the revision)', { timeout: T }, async () => {
    const env = setup28a();
    await one(env, 'getTest', { testId: CBC.test.id });
    expect(env.cache.size).toBeGreaterThan(0);
    await bumpAndRename(env, CBC.test.id, 'CBC v2');
    const stmts = await stmtsOf(env, () => one(env, 'getTest', { testId: CBC.test.id }));
    expect(stmts.some((s) => /FROM\s+catalog\.(tests|orderables)\b/i.test(s.text))).toBe(true);   // reloaded, not served stale
  });

  it('tenants never share entries even at the same revision number: A\'s warm entry is invisible to B (same cache, both at revision 417)', { timeout: T }, async () => {
    const env = setup28a();
    await one(env, 'getTest', { testId: CBC.test.id });
    await one(env, 'referenceRangeFor', rq(RHB.id));
    await one(env, 'getPanel', { panelId: HP_ELITE_M.panel.id });
    expect(await codeOf(one(env, 'getTest', { testId: CBC.test.id }, inB))).toBe('common.not_found');
    expect(await codeOf(one(env, 'referenceRangeFor', rq(RHB.id), inB))).toBe('common.not_found');
    expect(await codeOf(one(env, 'getPanel', { panelId: HP_ELITE_M.panel.id }, inB))).toBe('common.not_found');
    expect(await codeOf(one(env, 'resolveOrderables', { orderableIds: [CBC.test.id] }, inB))).toBe('common.not_found');
    // and B's warm entries are invisible to A
    await one(env, 'getTest', { testId: TEST_B.test.id }, inB);
    await one(env, 'getPanel', { panelId: PANEL_B.panel.id }, inB);
    await one(env, 'referenceRangeFor', rq(RB.id), inB);
    expect(await codeOf(one(env, 'getTest', { testId: TEST_B.test.id }))).toBe('common.not_found');
    expect(await codeOf(one(env, 'getPanel', { panelId: PANEL_B.panel.id }))).toBe('common.not_found');
    expect(await codeOf(one(env, 'referenceRangeFor', rq(RB.id)))).toBe('common.not_found');
    expect(await codeOf(one(env, 'resolveOrderables', { orderableIds: [TEST_B.test.id, PANEL_B.panel.id] }))).toBe('common.not_found');
  });

  it('a caller mutating a returned definition cannot poison the cache (frozen or copied)', { timeout: T }, async () => {
    const env = setup28a();
    const first = await one(env, 'getTest', { testId: LAB.test.id });
    const snapshot = JSON.parse(JSON.stringify(first));
    for (const attack of [() => first.analytes.push({ code: 'EVIL' }), () => { first.name = 'EVIL'; }, () => { first.analytes[0].decimals = 99; }, () => { first.specimenTypeCodes.length = 0; }]) {
      try { attack(); } catch { /* frozen objects throw in strict mode: fine */ }
    }
    const resolved = await one(env, 'resolveOrderables', { orderableIds: [LAB.test.id] });
    try { resolved.tests[0].analytes.length = 0; } catch { /* frozen */ }
    expect(await one(env, 'getTest', { testId: LAB.test.id })).toEqual(snapshot);
    expect((await one(env, 'resolveOrderables', { orderableIds: [LAB.test.id] })).tests[0].analytes).toHaveLength(6);
  });

  it('same (input, catalogRevision) => same output for every T-28a method', { timeout: T }, async () => {
    const env = setup28a();
    for (const [method, input] of CALLS) expect(await one(env, method, input(env)), method).toEqual(await one(env, method, input(env)));
  });

  it('a failing load propagates (no partial definition is returned) and is not cached: the fake\'s failure is permanent, so the retry fails the same way', { timeout: T }, async () => {
    const env = setup28a();
    env.db.fail(/FROM catalog\.tat_targets/i);
    await expect(one(env, 'getTest', { testId: LAB.test.id })).rejects.toBeDefined();
    await expect(one(env, 'getTest', { testId: LAB.test.id })).rejects.toBeDefined();
  });
});

describe('security: read-only, tenant-scoped, parameterised (S-1, 02-CV §8.1)', () => {
  const WRITE = /^\s*(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|SET|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|LOCK)\b|FOR\s+(UPDATE|SHARE|NO KEY UPDATE)\b/i;
  const TENANT_TABLES = /FROM\s+catalog\.(orderables|tests|panels|panel_members|test_specimen_types|analytes|analyte_versions|reference_range_sets|reference_ranges|critical_limit_sets|critical_limits|tat_targets|cs_value_sets|cs_value_set_values|departments|specimen_types|containers|methods|catalog_state)\b/gi;

  it.each(CALLS)('%s: cold and warm, issues no write, no lock, no transaction control', { timeout: T }, async (method, input) => {
    const env = setup28a();
    const cold = await stmtsOf(env, () => one(env, method, input(env)));
    const warm = await stmtsOf(env, () => one(env, method, input(env)));
    for (const s of [...cold, ...warm]) expect(s.text, s.text).not.toMatch(WRITE);
  });

  it.each(CALLS)('%s: every statement on a tenant table names tenant_id and binds the ctx tenant; nothing is interpolated', { timeout: T }, async (method, input) => {
    const env = setup28a();
    const inputValue = input(env) as Record<string, unknown>;
    const stmts = await stmtsOf(env, () => one(env, method, inputValue));
    expect(stmts.length).toBeGreaterThan(0);
    for (const s of stmts) {
      const text = s.text.replace(/\s+/g, ' ');
      if (text.match(TENANT_TABLES)) expect(text, text).toMatch(/\btenant_id\b/i);
      expect(text, 'tenant id interpolated').not.toContain(TENANT_A);
      for (const v of JSON.stringify(inputValue).match(/[0-9a-f]{8}-[0-9a-f-]{27}/gi) ?? []) expect(text, 'input id interpolated').not.toContain(v);
      expect(s.tenantId).toBe(TENANT_A);
    }
    const asB = await stmtsOf(env, () => one(env, method, { ...inputValue }, inB).catch(() => undefined));
    for (const s of asB) { expect(s.tenantId).toBe(TENANT_B); expect(s.values).not.toContain(TENANT_A); }
  });

  it('hostile text in ids / codes never reaches SQL text and never yields an untyped error', { timeout: T }, async () => {
    const env = setup28a();
    const evil = "'; DROP TABLE catalog.tests; --";
    const from = env.db.stmts.length;
    for (const [m, i] of [['getTest', { testId: evil }], ['getPanel', { panelId: evil }], ['resolveOrderables', { orderableIds: [evil] }],
      ['referenceRangeFor', rq(evil)], ['criticalLimitsFor', rq(evil)]] as Array<[string, unknown]>) {
      expect(['common.validation_failed', 'common.not_found'], m).toContain(await codeOf(one(env, m, i)));
    }
    // a hostile specimen type code: spec is silent on the outcome (error or generic band) — it must stay a typed outcome and stay out of the SQL text
    const code = await codeOf(one(env, 'referenceRangeFor', rq(RHB.id, { specimenTypeCode: evil })));
    expect([undefined, 'common.validation_failed', 'common.not_found', 'catalog.no_reference_range']).toContain(code);
    for (const s of env.db.stmts.slice(from)) expect(s.text).not.toMatch(/DROP TABLE/i);
  });

  it('a device / portal / partner actor gets the same catalog reads as a user (no contact data here), and the answer carries no personal or internal fields', { timeout: T }, async () => {
    const env = setup28a();
    const t = await one(env, 'getTest', { testId: LAB.test.id }, { ctx: { actor: { type: 'device', id: ID(0xd1) } } });
    expect(keysOf(t).filter((k) => /tenant|created|updated|contact|phone|email|password|secret/i.test(k))).toEqual([]);
  });

  it('cross-tenant probe (S-1): tenant A\'s context with every tenant-B id of the world -> not_found, and no statement ever bound tenant B\'s id as a tenant', { timeout: T }, async () => {
    const env = setup28a();
    const from = env.db.stmts.length;
    expect(await codeOf(one(env, 'getTest', { testId: TEST_B.test.id }))).toBe('common.not_found');
    expect(await codeOf(one(env, 'getPanel', { panelId: PANEL_B.panel.id }))).toBe('common.not_found');
    expect(await codeOf(one(env, 'resolveOrderables', { orderableIds: [PANEL_B.panel.id] }))).toBe('common.not_found');
    expect(await codeOf(one(env, 'referenceRangeFor', rq(RB.id)))).toBe('common.not_found');
    expect(await codeOf(one(env, 'criticalLimitsFor', rq(RB.id)))).toBe('common.not_found');
    for (const s of env.db.stmts.slice(from)) expect(s.values).not.toContain(TENANT_B);
  });
});
