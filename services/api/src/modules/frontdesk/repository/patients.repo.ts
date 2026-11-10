// frontdesk.patients (05-SCHEMA §3). Explicit tenant_id filter on every statement; RLS is the backstop.
import { getRow, insertRow, type Tx } from './shared.repo.js';

const COLS = ['id', 'patient_code', 'full_name', 'name_search', 'sex', 'birth_on', 'is_birth_on_estimated', 'phone_e164', 'email', 'address_text',
  'source', 'registered_centre_id', 'last_visit_at', 'duplicate_override_reason_code'] as const;

export const insertPatient = (tx: Tx, tenantId: string, row: Record<string, unknown>) => insertRow(tx, 'frontdesk.patients', COLS, tenantId, row);
export const getPatientById = (tx: Tx, tenantId: string, id: string) => getRow(tx, 'frontdesk.patients', tenantId, id);

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
