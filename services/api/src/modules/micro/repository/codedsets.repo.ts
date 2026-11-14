// micro coded sets (05-SCHEMA §8): global g_cs_* + tenant cs_* resolved through the v_* views (tenant row shadows the global row by code).
// REQ-SEC-024: tenant statements bind tenant_id explicitly in addition to RLS. Static SQL only: every identifier below comes from the SETS
// whitelist, never from input; values are always parameters.
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;

export const SET_NAMES = [
  'organisms', 'organism_groups', 'antibiotics', 'media', 'specimen_sites', 'growth_codes', 'culture_outcomes',
  'isolate_withdraw_reasons', 'culture_cancel_reasons', 'record_ignore_reasons', 'ast_interpretations',
] as const;
export type SetName = (typeof SET_NAMES)[number];

export interface Extra {
  readonly name: string;
  readonly sql: 'text' | 'boolean';
}
const x = (name: string, sql: Extra['sql']): Extra => ({ name, sql });

export const EXTRAS: Readonly<Record<Exclude<SetName, 'ast_interpretations'>, readonly Extra[]>> = {
  organisms: [x('organism_group_code', 'text'), x('gram_class', 'text'), x('is_alert', 'boolean'), x('snomed_ct_concept_id', 'text')],
  organism_groups: [], media: [], specimen_sites: [], isolate_withdraw_reasons: [], culture_cancel_reasons: [], record_ignore_reasons: [],
  antibiotics: [x('antibiotic_class', 'text')],
  growth_codes: [x('indicates_growth', 'boolean')],
  culture_outcomes: [x('result_flag', 'text'), x('requires_isolate', 'boolean')],
};

const VIEW: Readonly<Record<Exclude<SetName, 'ast_interpretations'>, string>> = {
  organisms: 'v_organisms', organism_groups: 'v_organism_groups', antibiotics: 'v_antibiotics', media: 'v_media', specimen_sites: 'v_specimen_sites',
  growth_codes: 'v_growth_codes', culture_outcomes: 'v_culture_outcomes', isolate_withdraw_reasons: 'v_isolate_withdraw_reasons',
  culture_cancel_reasons: 'v_culture_cancel_reasons', record_ignore_reasons: 'v_record_ignore_reasons',
};

type Plain = Exclude<SetName, 'ast_interpretations'>;
const dtoCols = (s: Plain): string => ['code', 'display', 'sort_order', 'is_active', 'source', ...EXTRAS[s].map((e) => e.name)].join(', ');

/** Global + tenant rows of one set (tenant shadows global); `q` = case-insensitive code prefix. */
export async function listCodes(tx: Q, a: { setName: SetName; includeInactive: boolean; q?: string | undefined }): Promise<Array<Record<string, any>>> {
  if (a.setName === 'ast_interpretations') {
    const { rows } = await tx.query(
      `SELECT code, display, sort_order, is_active, 'global'::text AS source, standard FROM micro.g_cs_ast_interpretations
        WHERE ($1::boolean OR is_active) AND ($2::text IS NULL OR starts_with(lower(code), lower($2::text)))
        ORDER BY sort_order, standard, code LIMIT 2000`, [a.includeInactive, a.q ?? null]);
    return rows;
  }
  const { rows } = await tx.query(
    `SELECT ${dtoCols(a.setName)} FROM micro.${VIEW[a.setName]}
      WHERE ($1::boolean OR is_active) AND ($2::text IS NULL OR starts_with(lower(code), lower($2::text)))
      ORDER BY sort_order, code LIMIT 2000`, [a.includeInactive, a.q ?? null]);
  return rows;
}

/** An active code of the resolved (tenant-over-global) set, for referential validation of codes the DB cannot FK across the union. */
export async function activeCodeExists(tx: Q, a: { setName: 'organism_groups' | 'media' | 'specimen_sites'; code: string }): Promise<boolean> {
  const { rows } = await tx.query(`SELECT 1 FROM micro.${VIEW[a.setName]} WHERE code = $1 AND is_active LIMIT 1`, [a.code]);
  return rows.length > 0;
}

/** Rows of a resolved (tenant-over-global) view for the given codes, active or not (the caller decides). `$2` pins the view's claims tenant to ctx.tenantId (REQ-SEC-024). */
export async function codeRows(tx: Q, a: { view: 'media' | 'growth_codes' | 'specimen_sites' | 'organisms' | 'isolate_withdraw_reasons' | 'antibiotics' | 'organism_groups' | 'record_ignore_reasons' | 'culture_cancel_reasons'; tenantId: string; codes: string[] }): Promise<Map<string, Record<string, any>>> {
  if (a.codes.length === 0) return new Map();
  const cols = a.view === 'growth_codes' ? 'code, is_active, indicates_growth' : a.view === 'organisms' ? 'code, display, is_active, organism_group_code' : a.view === 'antibiotics' ? 'code, display, is_active' : 'code, is_active';
  const { rows } = await tx.query(`SELECT ${cols} FROM micro.${VIEW[a.view]} WHERE code = ANY($1::text[]) AND (SELECT app.current_tenant_id()) = $2::uuid`, [a.codes, a.tenantId]);
  return new Map(rows.map((r: Record<string, any>) => [r['code'], r]));
}

export async function findTenantCode(tx: Q, a: { tenantId: string; setName: Plain; code: string }): Promise<Record<string, any> | undefined> {
  const { rows } = await tx.query(`SELECT * FROM micro.cs_${a.setName} WHERE tenant_id = $1 AND code = $2`, [a.tenantId, a.code]);
  return rows[0];
}

/** `values` carries every extra column (null = absent). undefined = a concurrent request created the code first. */
export async function insertTenantCode(tx: Q, a: {
  tenantId: string; userId: string; id: string; setName: Plain; code: string; display: string; sortOrder: number; isActive: boolean; values: Readonly<Record<string, unknown>>;
}): Promise<Record<string, any> | undefined> {
  const ex = EXTRAS[a.setName];
  const cols = ['id', 'tenant_id', 'code', 'display', 'sort_order', 'is_active', ...ex.map((e) => e.name), 'created_by', 'updated_by'];
  const vals = [a.id, a.tenantId, a.code, a.display, a.sortOrder, a.isActive, ...ex.map((e) => a.values[e.name] ?? null), a.userId, a.userId];
  const { rows } = await tx.query(
    `INSERT INTO micro.cs_${a.setName} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
     ON CONFLICT (tenant_id, code) DO NOTHING RETURNING *`, vals);
  return rows[0];
}

/** An absent extra keeps the column. undefined = version mismatch. */
export async function updateTenantCode(tx: Q, a: {
  tenantId: string; userId: string; expectedVersion: number; setName: Plain; code: string; display: string; sortOrder: number; isActive: boolean; values: Readonly<Record<string, unknown>>;
}): Promise<Record<string, any> | undefined> {
  const ex = EXTRAS[a.setName];
  const sets = ex.map((e, i) => `${e.name} = COALESCE($${i + 8}::${e.sql}, ${e.name})`);
  const { rows } = await tx.query(
    `UPDATE micro.cs_${a.setName} SET display = $4, sort_order = $5, is_active = $6${sets.map((s) => `, ${s}`).join('')},
       version = version + 1, updated_at = now(), updated_by = $7
     WHERE tenant_id = $1 AND code = $2 AND version = $3 RETURNING *`,
    [a.tenantId, a.code, a.expectedVersion, a.display, a.sortOrder, a.isActive, a.userId, ...ex.map((e) => a.values[e.name] ?? null)]);
  return rows[0];
}
