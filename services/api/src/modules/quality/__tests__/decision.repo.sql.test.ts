// C9 T-16 — SQL pins of the decision repo (05-SCHEMA quality.autoverify_decisions: class A, append-only INSERT + SELECT only; REQ-SEC-022/024; 07-SECURITY "only the port impl writes autoverify_decisions").
// SEAM: ../repository/decision.repo.ts exports `createDecisionRepo(): DecisionRepo` with insertDecision(tx, tenantId, row): Promise<void> — exactly ONE parameterised INSERT on the caller's tx.
// A scripted tx stands in for Postgres (no database in this lane): the tests pin the statement text and bound values. Real constraint / RLS behaviour needs db/tests once the quality DDL lands.
// Fails now: "Cannot find module ../repository/decision.repo.js".
import { describe, expect, it } from 'vitest';
import { createDecisionRepo } from '../repository/decision.repo.js';
import { K, I1, NOW, RESULTED_AT, RESULT, RUN, TENANT_A, TENANT_B, USER, V3, idN } from './decision.helpers.js';

const row = (o: Record<string, unknown> = {}) => ({
  id: idN(0xde01), decided_at: NOW, mode: 'live', version_id: V3, result_id: RESULT, analyte_id: K, instrument_id: I1, decision: 'deny', reasons: ['instrument_flag', 'qc_warning'], matched_rule_key: 'K_ANY',
  qc_status: 'warning', qc_run_id: RUN(2), inputs: { value_numeric: '4.2', range_flag: 'N', delta_check_failed: false, is_critical: false, instrument_flags: ['SYN_FLAG'], resulted_at: RESULTED_AT }, created_by: USER, ...o,
});
const scripted = (fail?: Error) => { const q: Array<{ text: string; values: unknown[] }> = []; return { q, tx: { async query(text: string, values: unknown[] = []) { q.push({ text, values }); if (fail) throw fail; return { rows: [] }; } } }; };
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('createDecisionRepo.insertDecision', () => {
  it('runs exactly ONE statement on the caller tx: INSERT INTO quality.autoverify_decisions, schema-qualified, tenant_id bound as a value', async () => {
    const { q, tx } = scripted(); await createDecisionRepo().insertDecision(tx, TENANT_A, row());
    expect(q).toHaveLength(1); const s = norm(q[0]!.text);
    expect(s).toMatch(/^INSERT INTO quality\.autoverify_decisions\b/i); expect(s).toMatch(/\btenant_id\b/); expect(q[0]!.values).toContain(TENANT_A);
  });
  it('every column of 05-SCHEMA is written (id, tenant_id, decided_at, mode, version_id, result_id, analyte_id, instrument_id, decision, reasons, matched_rule_key, qc_status, qc_run_id, inputs, created_by); created_at uses the DB default', async () => {
    const { q, tx } = scripted(); await createDecisionRepo().insertDecision(tx, TENANT_A, row()); const s = norm(q[0]!.text);
    for (const c of ['id', 'tenant_id', 'decided_at', 'mode', 'version_id', 'result_id', 'analyte_id', 'instrument_id', 'decision', 'reasons', 'matched_rule_key', 'qc_status', 'qc_run_id', 'inputs', 'created_by']) expect(s, c).toMatch(new RegExp(`\\b${c}\\b`));
  });
  it('values are bound, never interpolated: ids, mode, reasons, rule key and inputs do not appear in the SQL text; tenant is the argument, not a row field', async () => {
    const { q, tx } = scripted(); await createDecisionRepo().insertDecision(tx, TENANT_A, row({ tenant_id: TENANT_B }));
    for (const lit of [TENANT_A, TENANT_B, RESULT, K, I1, V3, 'K_ANY', 'instrument_flag', 'SYN_FLAG', '4.2', RESULTED_AT]) expect(q[0]!.text, lit).not.toContain(lit);
    expect(q[0]!.values).toContain(TENANT_A); expect(q[0]!.values).not.toContain(TENANT_B);     // a tenant_id inside the row is ignored: the argument wins
    expect(q[0]!.values).toEqual(expect.arrayContaining([RESULT, K, I1, V3, 'live', 'deny', 'K_ANY', 'warning', RUN(2), USER]));
  });
  it('reasons bind as a text[] value; inputs bind as JSON text cast to jsonb', async () => {
    const { q, tx } = scripted(); await createDecisionRepo().insertDecision(tx, TENANT_A, row()); const s = norm(q[0]!.text);
    const reasons = q[0]!.values.find((v) => Array.isArray(v) || (typeof v === 'string' && /^\{.*\}$/.test(v)));
    expect(reasons === undefined ? false : Array.isArray(reasons) ? reasons.join() : String(reasons)).toMatch(/instrument_flag/);
    expect(s).toMatch(/\$\d+::jsonb/i);
    const json = q[0]!.values.find((v) => typeof v === 'string' && v.startsWith('{') && v.includes('delta_check_failed')) as string;
    expect(JSON.parse(json)).toEqual(row().inputs);
  });
  it('optional columns bind as null, never undefined: no instrument, no matched rule, no QC run', async () => {
    const { q, tx } = scripted(); await createDecisionRepo().insertDecision(tx, TENANT_A, row({ instrument_id: undefined, matched_rule_key: undefined, qc_run_id: undefined, qc_status: 'not_evaluated' }));
    expect(q[0]!.values.includes(undefined)).toBe(false);
  });
  it('append-only: nothing but INSERT is ever issued (no UPDATE / DELETE / TRUNCATE / ON CONFLICT DO UPDATE), no other table touched', async () => {
    const { q, tx } = scripted(); await createDecisionRepo().insertDecision(tx, TENANT_A, row()); const s = norm(q[0]!.text);
    expect(s).not.toMatch(/\b(UPDATE|DELETE|TRUNCATE|DROP)\b/i); expect([...s.matchAll(/\b(?:INSERT INTO|FROM|JOIN)\s+([a-z_]+\.[a-z_]+)/gi)].map((m) => m[1]!.toLowerCase())).toEqual(['quality.autoverify_decisions']);
  });
  it('a failing statement rejects with the driver error unchanged (the service maps it to common.internal); the repo never swallows', async () => {
    const boom = Object.assign(new Error('check violation'), { code: '23514', constraint: 'autoverify_decisions__allow__ck' });
    await expect(createDecisionRepo().insertDecision(scripted(boom).tx, TENANT_A, row())).rejects.toBe(boom);
  });
});
