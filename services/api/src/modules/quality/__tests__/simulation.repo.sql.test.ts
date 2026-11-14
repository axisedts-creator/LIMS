// C9 T-17 — SQL pins of the simulation / decision read repo (02-TRD §8.6, 05-SCHEMA quality.autoverify_decisions (class A, append-only), quality.verification_log, quality.settings; REQ-SEC-022/024).
// SEAM: ../repository/simulation.repo.ts exports `createSimulationRepo(): SimulationRepo` (activation.helpers.ts). SELECT only; every statement parameterised with `tenant_id = $n` bound to the tenant ARGUMENT.
// A scripted tx stands in for Postgres (no database in this lane): the tests pin statement text and bound values. Real RLS / plan behaviour needs db/tests once the quality DDL lands.
// Fails now: "Cannot find module ../repository/simulation.repo.js".
import { describe, expect, it } from 'vitest';
import { createSimulationRepo } from '../repository/simulation.repo.js';
import { DEC, SIM_START, TENANT_A, TENANT_B, VER, at, DAY } from './activation.helpers.js';

const scripted = (rows: Array<Record<string, unknown>> = []) => { const q: Array<{ text: string; values: unknown[] }> = []; return { q, tx: { async query(text: string, values: unknown[] = []) { q.push({ text, values }); return { rows }; } } }; };
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const all = (q: Array<{ text: string }>) => q.map((x) => norm(x.text)).join(' ; ');
const COUNT = { n: '123', count: '123' };

const every = (q: Array<{ text: string; values: unknown[] }>, t: string) => { for (const x of q) { expect(norm(x.text), 'statement').toMatch(/^(SELECT|WITH)\b/i); expect(x.text).toMatch(/\btenant_id\s*=\s*\$\d+/i); expect(x.values).toContain(t); expect(x.values).not.toContain(t === TENANT_A ? TENANT_B : TENANT_A); } };

describe('every method: read-only, tenant-scoped, parameterised', () => {
  it('no statement is anything but SELECT/WITH; none writes', async () => {
    const r = createSimulationRepo(); const { q, tx } = scripted([COUNT]);
    await r.getMinimums(tx, TENANT_A).catch(() => undefined); await r.countShadowDecisions(tx, TENANT_A, VER(2), SIM_START).catch(() => undefined);
    await r.simulationReport(tx, TENANT_A, { versionId: VER(2), since: SIM_START, sampleLimit: 50 }).catch(() => undefined);
    await r.listDecisions(tx, TENANT_A, { from: SIM_START, to: at(DAY), limit: 50 }).catch(() => undefined); await r.findDecision(tx, TENANT_A, DEC(1)).catch(() => undefined);
    expect(q.length).toBeGreaterThanOrEqual(5); every(q, TENANT_A);
    expect(all(q)).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER)\b/i);
  });
});

describe('getMinimums', () => {
  it('reads sim_min_days / sim_min_decisions from quality.settings for the tenant; no row -> undefined', async () => {
    const { q, tx } = scripted([{ sim_min_days: 7, sim_min_decisions: 100 }]); expect(await createSimulationRepo().getMinimums(tx, TENANT_A)).toEqual({ sim_min_days: 7, sim_min_decisions: 100 });
    expect(norm(q[0]!.text)).toMatch(/quality\.settings\b/i); expect(q[0]!.text).toMatch(/sim_min_days/); expect(q[0]!.text).toMatch(/sim_min_decisions/);
    expect(await createSimulationRepo().getMinimums(scripted([]).tx, TENANT_A)).toBeUndefined();
  });
});

describe('countShadowDecisions (activation minimum, AC-11.2)', () => {
  it('counts quality.autoverify_decisions of this tenant, version and mode shadow with decided_at >= since; returns a number', async () => {
    const { q, tx } = scripted([COUNT]); const n = await createSimulationRepo().countShadowDecisions(tx, TENANT_A, VER(2), SIM_START); const s = norm(q[0]!.text);
    expect(n).toBe(123); expect(typeof n).toBe('number'); expect(q).toHaveLength(1);
    expect(s).toMatch(/quality\.autoverify_decisions\b/i); expect(s).toMatch(/count\(/i); expect(s).toMatch(/\bmode\b/); expect(s).toMatch(/\bversion_id\b/); expect(s).toMatch(/\bdecided_at\s*>=\s*\$\d+/i);
    expect(q[0]!.values).toEqual(expect.arrayContaining([TENANT_A, VER(2), SIM_START]));
  });
  it("mode 'shadow' is a literal or a bound value; ids and timestamps are never interpolated", async () => {
    const { q, tx } = scripted([COUNT]); await createSimulationRepo().countShadowDecisions(tx, TENANT_A, VER(2), SIM_START);
    for (const lit of [TENANT_A, VER(2), SIM_START]) expect(q[0]!.text, lit).not.toContain(lit);
    expect(/'shadow'/.test(q[0]!.text) || q[0]!.values.includes('shadow')).toBe(true);
  });
});

describe('simulationReport (02-TRD §8.6)', () => {
  const run = async (rows: Array<Record<string, unknown>> = [], sampleLimit = 50) => { const s = scripted(rows); await createSimulationRepo().simulationReport(s.tx, TENANT_A, { versionId: VER(2), since: SIM_START, sampleLimit }).catch(() => undefined); return s; };
  it('reads shadow decisions of THIS version since the start, left-joined to quality.verification_log on result_id', async () => {
    const { q } = await run(); const s = all(q);
    expect(s).toMatch(/quality\.autoverify_decisions\b/i); expect(s).toMatch(/quality\.verification_log\b/i); expect(s).toMatch(/LEFT\s+JOIN/i); expect(s).toMatch(/\bresult_id\b/);
    expect(s).toMatch(/\bversion_id\b/); expect(s).toMatch(/\bdecided_at\s*>=\s*\$\d+/i); expect(/'shadow'/.test(s) || q.some((x) => x.values.includes('shadow'))).toBe(true);
    expect(q.some((x) => x.values.includes(VER(2)))).toBe(true); expect(q.some((x) => x.values.includes(SIM_START))).toBe(true);
  });
  it('the live row of the same canAutoVerify call is read for live_decision / live_comparison (mode live, same result_id)', async () => {
    const { q } = await run(); const s = all(q); expect(s).toMatch(/'live'|\blive\b/i); expect(/'live'/.test(s) || q.some((x) => x.values.includes('live'))).toBe(true);
  });
  it('the sample is the MOST RECENT would-allow decisions: ORDER BY decided_at DESC, LIMIT bound (never interpolated)', async () => {
    const { q } = await run([], 37); const s = all(q);
    expect(s).toMatch(/ORDER BY[^;]*\bdecided_at\b[^;]*\bDESC\b/i); expect(s).toMatch(/\bLIMIT\s+\$\d+/i); expect(q.some((x) => x.values.includes(37))).toBe(true); expect(s).not.toMatch(/\bLIMIT\s+37\b/);
  });
  it('would-allow / would-deny / reason counts are computed in SQL (aggregates), not by pulling every decision row', async () => {
    const { q } = await run(); expect(all(q)).toMatch(/count\(|sum\(|FILTER\s*\(/i); expect(all(q)).toMatch(/\bGROUP BY\b|\bFILTER\s*\(|\bunnest\(/i);
  });
  it('no literal of the arguments in the statement text; the P3 `inputs` column is never selected', async () => {
    const { q } = await run(); for (const lit of [TENANT_A, VER(2), SIM_START]) expect(all(q), lit).not.toContain(lit); expect(all(q)).not.toMatch(/\binputs\b/);
  });
});

describe('listDecisions (#46)', () => {
  const base = { from: SIM_START, to: at(DAY), limit: 50 };
  it('window [from, to] on decided_at, newest first with an id tiebreak, LIMIT bound; the P3 `inputs` column is NOT selected (list is not a detail read)', async () => {
    const { q, tx } = scripted(); await createSimulationRepo().listDecisions(tx, TENANT_A, base); const s = norm(q[0]!.text);
    expect(q).toHaveLength(1); expect(s).toMatch(/quality\.autoverify_decisions\b/i); expect(s).toMatch(/\bdecided_at\s*>=\s*\$\d+/i); expect(s).toMatch(/\bdecided_at\s*<=?\s*\$\d+/i);
    expect(s).toMatch(/ORDER BY\s+decided_at\s+DESC\s*,\s*id\s+DESC/i); expect(s).toMatch(/\bLIMIT\s+\$\d+/i); expect(s).not.toMatch(/\binputs\b/);
    expect(q[0]!.values).toEqual(expect.arrayContaining([TENANT_A, SIM_START, at(DAY)]));
  });
  it('fetches limit + 1 rows to know whether a next page exists, and returns at most `limit` rows with nextCursor only when there is one', async () => {
    const rows = Array.from({ length: 3 }, (_x, i) => ({ id: DEC(i + 1), decided_at: at(DAY - i * 1000) }));
    const a = scripted(rows); const r = await createSimulationRepo().listDecisions(a.tx, TENANT_A, { ...base, limit: 2 });
    expect(a.q[0]!.values).toContain(3); expect(r.rows).toHaveLength(2); expect(typeof r.nextCursor).toBe('string');
    const b = scripted(rows.slice(0, 2)); const r2 = await createSimulationRepo().listDecisions(b.tx, TENANT_A, { ...base, limit: 2 }); expect(r2.rows).toHaveLength(2); expect(r2.nextCursor).toBeUndefined();
  });
  it('each filter adds a bound predicate; none is interpolated', async () => {
    const f = { resultId: DEC(1), analyteId: DEC(2), instrumentId: DEC(3), versionId: VER(4), mode: 'shadow', decision: 'deny', reason: 'qc_warning' };
    const { q, tx } = scripted(); await createSimulationRepo().listDecisions(tx, TENANT_A, { ...base, ...f }); const s = norm(q[0]!.text);
    for (const c of ['result_id', 'analyte_id', 'instrument_id', 'version_id', 'mode', 'decision']) expect(s, c).toMatch(new RegExp(`\\b${c}\\b`)); expect(s).toMatch(/\breasons\b/);
    for (const v of Object.values(f)) { expect(s, String(v)).not.toContain(String(v)); expect(q[0]!.values, String(v)).toContain(v); }
  });
  it('a cursor continues strictly after the previous page (keyset on decided_at, id); a malformed cursor -> common.invalid_cursor', async () => {
    const { q, tx } = scripted(); const first = scripted([{ id: DEC(1), decided_at: at(DAY) }, { id: DEC(2), decided_at: at(DAY - 1000) }]);
    const p = await createSimulationRepo().listDecisions(first.tx, TENANT_A, { ...base, limit: 1 }); expect(p.nextCursor).toBeTruthy();
    await createSimulationRepo().listDecisions(tx, TENANT_A, { ...base, cursor: p.nextCursor! }); expect(norm(q[0]!.text)).toMatch(/\(\s*decided_at\s*,\s*id\s*\)\s*<\s*\(\s*\$\d+/i);
    await expect(createSimulationRepo().listDecisions(scripted().tx, TENANT_A, { ...base, cursor: '%%%not-a-cursor' })).rejects.toMatchObject({ code: 'common.invalid_cursor' });
  });
});

describe('findDecision (#47)', () => {
  it('selects ONE decision of this tenant by id, including the P3 inputs; no row -> undefined', async () => {
    const { q, tx } = scripted([{ id: DEC(1), inputs: {} }]); expect((await createSimulationRepo().findDecision(tx, TENANT_A, DEC(1)))?.['id']).toBe(DEC(1));
    const s = norm(q[0]!.text); expect(s).toMatch(/quality\.autoverify_decisions\b/i); expect(s).toMatch(/\bid\s*=\s*\$\d+/i); expect(s).toMatch(/\binputs\b/); expect(q[0]!.values).toEqual(expect.arrayContaining([TENANT_A, DEC(1)])); expect(q[0]!.text).not.toContain(DEC(1));
    expect(await createSimulationRepo().findDecision(scripted([]).tx, TENANT_A, DEC(1))).toBeUndefined();
  });
  it('a tenant id inside a row or filter is never used: the argument wins', async () => {
    const { q, tx } = scripted(); await createSimulationRepo().findDecision(tx, TENANT_B, DEC(1)); expect(q[0]!.values).toContain(TENANT_B); expect(q[0]!.values).not.toContain(TENANT_A);
  });
});
