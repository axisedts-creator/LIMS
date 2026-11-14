// C9 T-16 repo: quality.autoverify_decisions (05-SCHEMA class A, append-only: INSERT + SELECT grants only; written only by the port impl, 07-SECURITY).
// One parameterised INSERT on the caller's tx (02-CV §8.1: a rollback of C5's transaction removes the row). tenant_id is the ARGUMENT (never a row field), bound explicitly on top of RLS.
// Errors are not caught here: the service maps them (fail closed). created_at uses the DB default.
export type Row = Record<string, any>;
export interface DecisionTx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }
export interface DecisionRepo { insertDecision(tx: DecisionTx, tenantId: string, row: Row): Promise<void> }

const SQL = `INSERT INTO quality.autoverify_decisions
  (id, tenant_id, decided_at, mode, version_id, result_id, analyte_id, instrument_id, decision, reasons, matched_rule_key, qc_status, qc_run_id, inputs, created_by)
  VALUES ($1, $2, $3::timestamptz, $4, $5, $6, $7, $8, $9, $10::text[], $11, $12, $13, $14::jsonb, $15)`;

export function createDecisionRepo(): DecisionRepo {
  return {
    async insertDecision(tx, tenantId, r) {
      await tx.query(SQL, [r['id'], tenantId, r['decided_at'], r['mode'], r['version_id'] ?? null, r['result_id'], r['analyte_id'], r['instrument_id'] ?? null, r['decision'],
        r['reasons'] ?? [], r['matched_rule_key'] ?? null, r['qc_status'], r['qc_run_id'] ?? null, JSON.stringify(r['inputs']), r['created_by']]);
    },
  };
}
