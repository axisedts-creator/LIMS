// C9 T-09 — SQL hygiene of repository/qcview.repo.ts (02-TRD §6.1 "imports ONLY from lab.v_pub_qc_result", §6.2 steps 2, 3, 5; 07-SECURITY REQ-SEC-022/024/082). No database: a recording tx.
// Fails now: "Cannot find module ../repository/qcview.repo.js".
import { describe, expect, it } from 'vitest';
import { createQcViewRepo } from '../repository/qcview.repo.js';
import { INS, ANA, LOT, PLN, QCR, TENANT_A, viewRow } from './observation.helpers.js';

const T = TENANT_A;
const AT = '2026-11-13T18:00:00.000000Z';
function rec(rows: any[] = []) {
  const q: Array<{ text: string; values: unknown[] }> = [];
  const tx = { async query(text: string, values: unknown[] = []) { q.push({ text, values }); return { rows, rowCount: rows.length }; } };
  return { tx, q };
}
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const repo = createQcViewRepo();
async function everyStatement() {
  const { tx, q } = rec([{ id: 'x', value_numeric: '1' }]);
  const row = { id: QCR(1), tenant_id: T, source_qc_result_id: QCR(1), source: 'instrument', instrument_id: INS(1), analyte_id: ANA(1), control_id_raw: 'QC-L1', control_lot_raw: null, control_level_raw: null, value: '1', unit_code: null,
    instrument_result_time: null, received_at: AT, observed_at: AT, observed_at_basis: 'server', status: 'no_plan', plan_id: null, level_id: null, lot_id: null, target_id: null, mean: null, sd: null, z: null, qc_run_id: null,
    classified_at: AT, created_by: INS(1), updated_by: INS(1) };
  await repo.getSyncState(tx, T);
  await repo.lockSyncState(tx, T);
  await repo.readFirstPage(tx, T, { cursorAt: AT, overlapSeconds: 600, limit: 500 });
  await repo.readPageAfter(tx, T, { afterAt: AT, afterId: QCR(5), limit: 500 });
  await repo.findExistingSourceIds(tx, T, [QCR(1), QCR(2)]);
  await repo.lockPair(tx, T, INS(1), ANA(1));
  await repo.lockPair(tx, T, INS(1), null);
  await repo.findActivePlan(tx, T, INS(1), ANA(1));
  await repo.findControlMaps(tx, T, INS(1), 'QC-L1');
  await repo.findLot(tx, T, LOT(1));
  await repo.listTargets(tx, T, PLN(1), LOT(1));
  await repo.latestEvaluatedRunAt(tx, T, PLN(1));
  await repo.insertObservation(tx, T, row);
  await repo.advanceCursor(tx, T, { at: AT, id: QCR(9) });
  return q.map((x) => ({ ...x, text: norm(x.text) }));
}

describe('qcview.repo: every statement', () => {
  it('is parameterised: no value (id, raw control id, timestamp) is interpolated into the SQL text', async () => {
    for (const s of await everyStatement()) for (const lit of [T, QCR(1), QCR(5), INS(1), 'QC-L1', AT]) expect(s.text, s.text).not.toContain(lit);
  });
  it('carries an explicit tenant_id = $n predicate (or the tenant_id column in the insert) on top of RLS, with the tenant bound as a value', async () => {
    for (const s of await everyStatement()) {
      expect(s.text, s.text).toMatch(/tenant_id/);
      if (!/^INSERT/i.test(s.text)) expect(s.text, s.text).toMatch(/tenant_id\s*=\s*\$\d/);
      expect(s.values, s.text).toContain(T);
    }
  });
  it('never DELETEs and never touches another module\'s table except through the view (no lab.qc_results, no instruments.*, no catalog.*)', async () => {
    for (const s of await everyStatement()) {
      expect(s.text, s.text).not.toMatch(/\bDELETE\b|\bTRUNCATE\b|\bDROP\b/i);
      expect(s.text, s.text).not.toMatch(/\blab\.qc_results\b/i);
      expect(s.text, s.text).not.toMatch(/\b(instruments|catalog|frontdesk|billing|identity)\./i);
      for (const m of s.text.matchAll(/\blab\.([a-z_]+)/gi)) expect(m[1], s.text).toBe('v_pub_qc_result');
    }
  });
  it('the only lab object read is lab.v_pub_qc_result (both page reads)', async () => {
    const s = await everyStatement();
    const reads = s.filter((x) => /lab\./i.test(x.text));
    expect(reads).toHaveLength(2);
    for (const r of reads) expect(r.text).toMatch(/FROM lab\.v_pub_qc_result\b/i);
  });
});

describe('qcview.repo: view reads (§6.2 step 2)', () => {
  it('first page: created_at >= cursor - overlap, ORDER BY created_at, qc_result_id, bound LIMIT; cursor and overlap are bound values', async () => {
    const { tx, q } = rec();
    await repo.readFirstPage(tx, T, { cursorAt: AT, overlapSeconds: 600, limit: 500 });
    const s = norm(q[0]!.text);
    expect(s).toMatch(/created_at >= \$\d+(::timestamptz)? - /);
    expect(s).toMatch(/ORDER BY created_at, qc_result_id\b/);
    expect(s).toMatch(/LIMIT \$\d+\b/);
    expect(q[0]!.values).toEqual(expect.arrayContaining([T, AT, 600, 500]));
  });
  it('continuation page: keyset (created_at, qc_result_id) > ($at, $id), same order, bound LIMIT (never OFFSET)', async () => {
    const { tx, q } = rec();
    await repo.readPageAfter(tx, T, { afterAt: AT, afterId: QCR(5), limit: 500 });
    const s = norm(q[0]!.text);
    expect(s).toMatch(/\(created_at, qc_result_id\) > \(\$\d+(::timestamptz)?, \$\d+(::uuid)?\)/);
    expect(s).toMatch(/ORDER BY created_at, qc_result_id\b/);
    expect(s).toMatch(/LIMIT \$\d+\b/);
    expect(s).not.toMatch(/\bOFFSET\b/i);
    expect(q[0]!.values).toEqual(expect.arrayContaining([T, AT, QCR(5), 500]));
  });
  it('selects created_at with microsecond precision as text (an exact keyset: a millisecond-truncated key would skip or repeat rows of one second) and the value as text', async () => {
    const { tx, q } = rec();
    await repo.readPageAfter(tx, T, { afterAt: AT, afterId: QCR(5), limit: 1 });
    const s = norm(q[0]!.text);
    expect(s).toMatch(/to_char\([^)]*created_at[^)]*(US|MS)/i);
    expect(s).toMatch(/\bUS\b|\.US/);
    expect(s).toMatch(/value_numeric/);
    expect(s).not.toMatch(/SELECT \*/i);
  });
  it('returns the rows as the view gave them', async () => {
    const r = viewRow(1);
    const { tx } = rec([r]);
    expect(await repo.readFirstPage(tx, T, { cursorAt: AT, overlapSeconds: 600, limit: 5 })).toEqual([r]);
  });
});

describe('qcview.repo: writes', () => {
  it('insert: ON CONFLICT (tenant_id, source_qc_result_id) DO NOTHING RETURNING id; empty result -> undefined (duplicate), a row -> { id }', async () => {
    const row = { id: QCR(1), tenant_id: T, source_qc_result_id: QCR(1), instrument_id: INS(1), control_id_raw: 'x', received_at: AT, observed_at: AT, observed_at_basis: 'server', status: 'no_plan', source: 'manual', classified_at: AT, created_by: T, updated_by: T };
    const a = rec([]);
    expect(await repo.insertObservation(a.tx, T, row)).toBeUndefined();
    expect(norm(a.q[0]!.text)).toMatch(/INSERT INTO quality\.qc_observations\b/);
    expect(norm(a.q[0]!.text)).toMatch(/ON CONFLICT \(tenant_id, source_qc_result_id\) DO NOTHING RETURNING id\b/);
    const b = rec([{ id: QCR(1) }]);
    expect(await repo.insertObservation(b.tx, T, row)).toEqual({ id: QCR(1) });
  });
  it('insert lets a Postgres error through UNCHANGED (the service needs the SQLSTATE for import_error)', async () => {
    const err = Object.assign(new Error('fk'), { code: '23503', constraint: 'qc_observations__instrument__fk' });
    const tx = { async query() { throw err; } };
    await expect(repo.insertObservation(tx as any, T, { id: QCR(1), tenant_id: T })).rejects.toBe(err);
  });
  it('cursor advance is the §6.2 step 5 statement: UPDATE quality.sync_state ... WHERE tenant_id AND (qc_cursor_at, coalesce(qc_cursor_id, nil-uuid)) < ($at, $id); true only when a row moved', async () => {
    const a = rec([{ id: 'x' }]);
    expect(await repo.advanceCursor(a.tx, T, { at: AT, id: QCR(9) })).toBe(true);
    const s = norm(a.q[0]!.text);
    expect(s).toMatch(/UPDATE quality\.sync_state SET qc_cursor_at = \$\d+(::timestamptz)?, qc_cursor_id = \$\d+(::uuid)?, updated_at = now\(\)/);
    expect(s).toMatch(/WHERE tenant_id = \$\d+ AND \(qc_cursor_at, coalesce\(qc_cursor_id, '00000000-0000-0000-0000-000000000000'::uuid\)\) < \(\$\d+(::timestamptz)?, \$\d+(::uuid)?\)/);
    expect(a.q[0]!.values).toEqual(expect.arrayContaining([T, AT, QCR(9)]));
    const none = { async query() { return { rows: [], rowCount: 0 }; } };
    expect(await repo.advanceCursor(none as any, T, { at: AT, id: QCR(9) })).toBe(false);
  });
  it('the cursor update touches only the cursor columns (+ updated_at)', async () => {
    const a = rec([{ id: 'x' }]);
    await repo.advanceCursor(a.tx, T, { at: AT, id: QCR(9) });
    const set = /SET (.*?) WHERE/i.exec(norm(a.q[0]!.text))![1]!;
    expect(set.split(',').map((x) => x.split('=')[0]!.trim()).sort()).toEqual(['qc_cursor_at', 'qc_cursor_id', 'updated_at']);
  });
});

describe('qcview.repo: pair lock and lookups', () => {
  it('lockSyncState is SELECT 1 FROM quality.sync_state WHERE tenant_id = $1 FOR UPDATE (one sync run per tenant at a time; §6.2 step 4 / E1)', async () => {
    const a = rec();
    await repo.lockSyncState(a.tx, T);
    expect(a.q).toHaveLength(1);
    expect(norm(a.q[0]!.text)).toMatch(/^SELECT 1 FROM quality\.sync_state WHERE tenant_id = \$1 FOR UPDATE$/);
    expect(a.q[0]!.values).toEqual([T]);
  });
  it('lockPair is SELECT ... FROM quality.qc_plans WHERE tenant_id AND instrument_id AND analyte_id ... FOR UPDATE (serialises assembly per pair)', async () => {
    const a = rec();
    await repo.lockPair(a.tx, T, INS(1), ANA(1));
    const s = norm(a.q[0]!.text);
    expect(s).toMatch(/FROM quality\.qc_plans WHERE tenant_id = \$\d+ AND instrument_id = \$\d+ AND analyte_id = \$\d+ FOR UPDATE\b/);
    expect(a.q[0]!.values).toEqual([T, INS(1), ANA(1)]);
  });
  it('lockPair with an unknown analyte (null) is a no-op or a valid statement; it never builds `analyte_id = NULL`', async () => {
    const a = rec();
    await repo.lockPair(a.tx, T, INS(1), null);
    for (const s of a.q) expect(norm(s.text)).not.toMatch(/analyte_id = \$\d+/);
  });
  it('findActivePlan reads only ACTIVE plans (status literal or bound) of the pair; findControlMaps only active maps of the instrument + raw id', async () => {
    const a = rec();
    await repo.findActivePlan(a.tx, T, INS(1), ANA(1));
    expect(norm(a.q[0]!.text)).toMatch(/FROM quality\.qc_plans\b/);
    expect(norm(a.q[0]!.text) + JSON.stringify(a.q[0]!.values)).toMatch(/'active'|"active"/);
    const b = rec();
    await repo.findControlMaps(b.tx, T, INS(1), 'QC-L1');
    expect(norm(b.q[0]!.text)).toMatch(/FROM quality\.control_id_maps\b/);
    expect(norm(b.q[0]!.text)).toMatch(/is_active/);
    expect(b.q[0]!.values).toEqual(expect.arrayContaining([T, INS(1), 'QC-L1']));
  });
});
