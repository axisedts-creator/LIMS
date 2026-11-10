// Label lookups on published directory views only (02-TRD §3/§6; 03-IC §6 view columns; 08 R12d; 07-SECURITY REQ-SEC-013/081).
// One bound SELECT per call, explicit column allowlist, tenant always `$1`, ids one bound array (`= ANY($2)`).
// No is_active predicate: inactive rows keep their label (X11).

export interface LabelsTx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }
export interface LabelsInput { readonly tenantId: string; readonly ids?: readonly string[] | undefined }

export interface DepartmentRow { department_id: string; name: string; is_active: boolean }
export interface TestRow { test_id: string; code: string; name: string; department_id: string | null; is_active: boolean }
export interface ReferrerRow { referrer_id: string; display_name: string; is_active: boolean; canonical_referrer_id: string | null }
export interface InstrumentRow { instrument_id: string; centre_id: string; instrument_code: string; display_name: string; is_active: boolean }

async function select<T>(tx: LabelsTx, cols: string, view: string, idCol: string | null, input: LabelsInput): Promise<T[]> {
  if (idCol && input.ids && input.ids.length === 0) return []; // [] -> [] (never widen to the whole tenant)
  const byIds = idCol && input.ids ? ` AND ${idCol} = ANY($2)` : '';
  const values: unknown[] = byIds ? [input.tenantId, [...input.ids!]] : [input.tenantId];
  return (await tx.query(`SELECT ${cols} FROM ${view} WHERE tenant_id = $1${byIds}`, values)).rows as T[];
}

export const listDepartments = (tx: LabelsTx, a: { tenantId: string }) =>
  select<DepartmentRow>(tx, 'department_id, name, is_active', 'catalog.v_pub_department', null, a);
export const listTests = (tx: LabelsTx, a: LabelsInput) =>
  select<TestRow>(tx, 'test_id, code, name, department_id, is_active', 'catalog.v_pub_test_directory', 'test_id', a);
export const listReferrers = (tx: LabelsTx, a: LabelsInput) =>
  select<ReferrerRow>(tx, 'referrer_id, display_name, is_active, canonical_referrer_id', 'catalog.v_pub_referrer_directory', 'referrer_id', a);
/** #17: case-insensitive "contains" on display_name. The term is one bound LIKE pattern; % _ \ are escaped so they match literally. */
export async function searchReferrers(tx: LabelsTx, a: { readonly tenantId: string; readonly query: string; readonly limit?: number | undefined }): Promise<ReferrerRow[]> {
  const pattern = `%${a.query.replace(/[\\%_]/g, '\\$&')}%`;
  const limit = Math.min(Math.max(1, Math.trunc(a.limit ?? 20)), 20);
  return (await tx.query(
    `SELECT referrer_id, display_name, is_active, canonical_referrer_id FROM catalog.v_pub_referrer_directory
WHERE tenant_id = $1 AND display_name ILIKE $2 ESCAPE '\\' ORDER BY display_name, referrer_id LIMIT $3`,
    [a.tenantId, pattern, limit],
  )).rows as ReferrerRow[];
}
export const listInstruments =(tx: LabelsTx, a: LabelsInput) =>
  select<InstrumentRow>(tx, 'instrument_id, centre_id, instrument_code, display_name, is_active', 'instruments.v_pub_instrument_directory', 'instrument_id', a);
