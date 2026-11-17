// C9 T-15 repo: quality.autoverify_rule_sets / quality.autoverify_versions (05-SCHEMA §2). Every statement is parameterised, schema-qualified and carries
// `tenant_id = $1` explicitly on top of RLS (REQ-SEC-022/024, 02-CV §5.13). No DELETE anywhere: shadow rows and versions are kept (AC-11.4, D-55).
// Timestamps leave the DB as ISO-8601 UTC text. The partial unique indexes (one simulating / one active per tenant) surface as pg 23505; the service maps them.
export type Row = Record<string, any>;
export interface AutoverifyTx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }

export interface AutoverifyRepo {
  findRuleSet(tx: AutoverifyTx, tenantId: string): Promise<Row | undefined>;
  insertRuleSet(tx: AutoverifyTx, tenantId: string, row: Row): Promise<Row>;
  updateRuleSet(tx: AutoverifyTx, tenantId: string, id: string, patch: Row): Promise<Row>;
  listVersions(tx: AutoverifyTx, tenantId: string, ruleSetId: string): Promise<Row[]>;
  findVersion(tx: AutoverifyTx, tenantId: string, id: string): Promise<Row | undefined>;
  insertVersion(tx: AutoverifyTx, tenantId: string, row: Row): Promise<Row>;
  updateVersion(tx: AutoverifyTx, tenantId: string, id: string, expectedVersion: number, patch: Row): Promise<Row | undefined>;
  listUserLabels(tx: AutoverifyTx, tenantId: string, userIds: string[]): Promise<Array<{ user_id: string; display_name: string }>>;
}

const TS = (c: string) => `to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${c}`;
const SET_COLS = `id, tenant_id, active_version_id, simulating_version_id, is_active, version, ${TS('created_at')}, created_by, ${TS('updated_at')}, updated_by`;
const VER_META = `id, tenant_id, rule_set_id, version_no, status, rule_count, ${TS('simulation_started_at')}, simulation_started_by, ${TS('simulation_stopped_at')}, ${TS('activated_at')}, activated_by, ${TS('retired_at')}, retired_by, retire_reason, is_active, version, ${TS('created_at')}, created_by, ${TS('updated_at')}, updated_by`;
const VER_COLS = `${VER_META}, definition`;
/** The 200 newest summaries: the DTO caps `versions` at 200 and the definition (up to 1 MiB) is never needed for a summary. */
const SUMMARY_LIMIT = 200;

// created_at / updated_at come from the request clock (ctx.now()) so the row and the response agree and tests can pin time.
const SET_INSERT = ['id', 'created_at', 'created_by', 'updated_at', 'updated_by'] as const;
const VER_INSERT = ['id', 'rule_set_id', 'version_no', 'status', 'definition', 'rule_count', 'created_at', 'created_by', 'updated_at', 'updated_by'] as const;
/** Columns an update may SET (allowlist: a key outside it is a programming error, never request input). Identity/definition-freeze columns of an
 *  already-left-draft row are additionally refused by the trigger quality.enforce_version_frozen. */
const SET_SETTABLE: readonly string[] = ['active_version_id', 'simulating_version_id', 'updated_by'];
const VER_SETTABLE: readonly string[] = ['status', 'definition', 'rule_count', 'simulation_started_at', 'simulation_started_by', 'simulation_stopped_at', 'activated_at', 'activated_by', 'retired_at', 'retired_by', 'retire_reason', 'updated_by'];

const bindValue = (col: string, v: unknown): unknown => (col === 'definition' ? JSON.stringify(v) : v);
const placeholder = (col: string, n: number): string => (col === 'definition' ? `$${n}::jsonb` : `$${n}`);

export function createAutoverifyRepo(): AutoverifyRepo {
  return {
    async findRuleSet(tx, tenantId) {
      return (await tx.query(`SELECT ${SET_COLS} FROM quality.autoverify_rule_sets WHERE tenant_id = $1`, [tenantId])).rows[0];
    },

    async insertRuleSet(tx, tenantId, row) {
      const cols = SET_INSERT;
      const { rows } = await tx.query(
        `INSERT INTO quality.autoverify_rule_sets (tenant_id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING ${SET_COLS}`,
        [tenantId, ...cols.map((c) => row[c] ?? null)]);
      return rows[0]!;
    },

    async updateRuleSet(tx, tenantId, id, patch) {
      const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
      for (const k of keys) if (!SET_SETTABLE.includes(k)) throw new Error(`autoverify.repo: column ${k} is not updatable`);
      const set = [...keys.map((k, i) => `${k} = $${i + 3}`), 'version = version + 1', 'updated_at = now()'];
      const { rows } = await tx.query(
        `UPDATE quality.autoverify_rule_sets SET ${set.join(', ')} WHERE tenant_id = $1 AND id = $2 RETURNING ${SET_COLS}`,
        [tenantId, id, ...keys.map((k) => patch[k])]);
      return rows[0]!;
    },

    async listVersions(tx, tenantId, ruleSetId) {
      return (await tx.query(
        `SELECT ${VER_META} FROM quality.autoverify_versions WHERE tenant_id = $1 AND rule_set_id = $2 ORDER BY version_no DESC LIMIT ${SUMMARY_LIMIT}`,
        [tenantId, ruleSetId])).rows;
    },

    async findVersion(tx, tenantId, id) {
      return (await tx.query(`SELECT ${VER_COLS} FROM quality.autoverify_versions WHERE tenant_id = $1 AND id = $2`, [tenantId, id])).rows[0];
    },

    async insertVersion(tx, tenantId, row) {
      const cols = VER_INSERT;
      const { rows } = await tx.query(
        `INSERT INTO quality.autoverify_versions (tenant_id, ${cols.join(', ')}) VALUES ($1, ${cols.map((c, i) => placeholder(c, i + 2)).join(', ')}) RETURNING ${VER_COLS}`,
        [tenantId, ...cols.map((c) => bindValue(c, row[c] ?? null))]);
      return rows[0]!;
    },

    /** Optimistic lock in SQL: no row = stale version (or invisible row). `null` in the patch clears the column. */
    async updateVersion(tx, tenantId, id, expectedVersion, patch) {
      const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
      for (const k of keys) if (!VER_SETTABLE.includes(k)) throw new Error(`autoverify.repo: column ${k} is not updatable`);
      const values: unknown[] = [tenantId, id, ...keys.map((k) => bindValue(k, patch[k])), expectedVersion];
      const set = [...keys.map((k, i) => `${k} = ${placeholder(k, i + 3)}`), 'version = version + 1', 'updated_at = now()'];
      const { rows } = await tx.query(
        `UPDATE quality.autoverify_versions SET ${set.join(', ')} WHERE tenant_id = $1 AND id = $2 AND version = $${values.length} RETURNING ${VER_COLS}`, values);
      return rows[0];
    },

    /** [CONV] OPEN: the spec names no user-directory view for `*_by_display` (see .orchestra/cr/C9.T-15.md). Until one exists no label is returned and the service
     *  renders a neutral placeholder; nothing is read from tables C9 does not own and no view name is invented. */
    async listUserLabels() {
      return [];
    },
  };
}
