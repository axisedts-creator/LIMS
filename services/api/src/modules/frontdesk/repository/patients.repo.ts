// frontdesk.patients (05-SCHEMA §3). Explicit tenant_id filter on every statement; RLS is the backstop.
import { getRow, insertRow, type Tx } from './shared.repo.js';

const COLS = ['id', 'patient_code', 'full_name', 'name_search', 'sex', 'birth_on', 'is_birth_on_estimated', 'phone_e164', 'email', 'address_text',
  'source', 'registered_centre_id', 'last_visit_at', 'duplicate_override_reason_code'] as const;

export const insertPatient = (tx: Tx, tenantId: string, row: Record<string, unknown>) => insertRow(tx, 'frontdesk.patients', COLS, tenantId, row);
export const getPatientById = (tx: Tx, tenantId: string, id: string) => getRow(tx, 'frontdesk.patients', tenantId, id);

/** FD-T11 batch read: rows visible to the tenant for these ids (missing / other-tenant ids simply do not come back). */
export async function getPatientsByIds(tx: Tx, tenantId: string, ids: readonly string[]): Promise<any[]> {
  if (ids.length === 0) return [];
  return (await tx.query('SELECT * FROM frontdesk.patients WHERE tenant_id = $1 AND id = ANY($2::uuid[])', [tenantId, ids])).rows;
}

// ---- FD-T04 (F1-F5) ----
const PAGE_ORDER = 'ORDER BY last_visit_at DESC NULLS LAST, id';
type Rows = Promise<any[]>;
export async function findPatientsByPhone(tx: Tx, tenantId: string, e164: string, limit: number): Rows {
  return (await tx.query(`SELECT * FROM frontdesk.patients WHERE tenant_id = $1 AND anonymised_at IS NULL AND phone_e164 = $2 ${PAGE_ORDER} LIMIT $3`, [tenantId, e164, limit])).rows;
}
export async function findPatientsByCode(tx: Tx, tenantId: string, code: string, limit: number): Rows {
  return (await tx.query(`SELECT * FROM frontdesk.patients WHERE tenant_id = $1 AND anonymised_at IS NULL AND patient_code = $2 ${PAGE_ORDER} LIMIT $3`, [tenantId, code, limit])).rows;
}
/** Owner of any order with this registration_no (orders RLS = tenant + centre backstop). */
export async function findPatientsByRegistrationNo(tx: Tx, tenantId: string, registrationNo: string, limit: number): Rows {
  return (await tx.query(`SELECT * FROM frontdesk.patients WHERE tenant_id = $1 AND anonymised_at IS NULL AND id IN
    (SELECT patient_id FROM frontdesk.orders WHERE tenant_id = $1 AND registration_no = $2) ${PAGE_ORDER} LIMIT $3`, [tenantId, registrationNo, limit])).rows;
}
/** Like searchPatientsByName but exact name first, then prefix, then most recent visit. LIKE metacharacters are literals. */
export async function searchPatientsByNameRanked(tx: Tx, tenantId: string, normalised: string, limit: number): Rows {
  const esc = normalised.replace(/[\\%_]/g, '\\$&');
  return (await tx.query(`SELECT * FROM frontdesk.patients WHERE tenant_id = $1 AND anonymised_at IS NULL AND name_search LIKE $2 ESCAPE '\\'
    ORDER BY (name_search = $3) DESC, (name_search LIKE $4 ESCAPE '\\') DESC, last_visit_at DESC NULLS LAST, name_search, id LIMIT $5`,
  [tenantId, `%${esc}%`, normalised, `${esc}%`, limit])).rows;
}
/** Dedupe pool (US-FD-02.2): same normalised name in the tenant, not anonymised, with a birth date; the domain predicate does the rest. */
export async function findDedupePool(tx: Tx, tenantId: string, nameSearch: string): Rows {
  return (await tx.query(`SELECT * FROM frontdesk.patients WHERE tenant_id = $1 AND anonymised_at IS NULL AND birth_on IS NOT NULL AND name_search = $2
    ORDER BY id LIMIT 50`, [tenantId, nameSearch])).rows;
}
const UPDATABLE = ['full_name', 'name_search', 'sex', 'birth_on', 'is_birth_on_estimated', 'phone_e164', 'email', 'address_text'] as const;
/** Optimistic update: null when the row is missing, anonymised or its version != expectedVersion. Column names come from UPDATABLE only. */
export async function updatePatientRow(tx: Tx, tenantId: string, id: string, expectedVersion: number, set: Record<string, unknown>): Promise<any | null> {
  const cols = UPDATABLE.filter((c) => c in set);
  const sets = cols.map((c, i) => `${c} = $${i + 4}`);
  const { rows } = await tx.query(`UPDATE frontdesk.patients SET ${[...sets, 'version = version + 1', 'updated_at = now()', 'updated_by = (SELECT app.current_actor_id())'].join(', ')}
    WHERE tenant_id = $1 AND id = $2 AND version = $3 AND anonymised_at IS NULL RETURNING *`, [tenantId, id, expectedVersion, ...cols.map((c) => set[c])]);
  return rows[0] ?? null;
}

/** Same normalisation as name_search (NFC, case-folded, single-spaced). */
export const normaliseName = (s: string): string => s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();

/** Substring match on name_search (trigram index); LIKE metacharacters in `query` are literals. Anonymised rows are never returned. */
export async function searchPatientsByName(tx: Tx, tenantId: string, query: string, limit: number): Promise<any[]> {
  const pattern = `%${normaliseName(query).replace(/[\\%_]/g, '\\$&')}%`;
  const { rows } = await tx.query(`SELECT * FROM frontdesk.patients
    WHERE tenant_id = $1 AND anonymised_at IS NULL AND name_search LIKE $2 ESCAPE '\\'
    ORDER BY name_search, id LIMIT $3`, [tenantId, pattern, limit]);
  return rows;
}
