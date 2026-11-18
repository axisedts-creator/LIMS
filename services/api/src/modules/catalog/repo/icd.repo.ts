// T0B-PARTYSET-1 (LD-321): SQL of the per tenant ICD master catalog.icd_code (migration 20261117220000). tenant_id bound in every statement (RLS second wall);
// every request value is a bound parameter.
export type Row = Record<string, any>;
export type Q = { query(text: string, values?: unknown[]): Promise<{ rows: Row[] }> };

const ts = (c: string): string => `to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const esc = (v: string): string => v.replace(/[\\%_]/g, '\\$&');
const COLS = `i.id, i.code, i.title, i.chapter, i.is_active, i.version, ${ts('i.created_at')} AS created_at, ${ts('i.updated_at')} AS updated_at`;

export async function get(tx: Q, tenantId: string, id: string, lock = false): Promise<Row | undefined> {
  return (await tx.query(`SELECT ${COLS} FROM catalog.icd_code i WHERE i.tenant_id = $1 AND i.id = $2${lock ? ' FOR NO KEY UPDATE' : ''}`, [tenantId, id])).rows[0];
}
export async function codeTaken(tx: Q, tenantId: string, code: string): Promise<boolean> {
  return (await tx.query('SELECT 1 FROM catalog.icd_code WHERE tenant_id = $1 AND code = $2', [tenantId, code])).rows.length > 0;
}
export async function insert(tx: Q, tenantId: string, r: { id: string; code: string; title: string; chapter: string | null; actorId: string }): Promise<void> {
  await tx.query('INSERT INTO catalog.icd_code (id, tenant_id, code, title, chapter, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $6)',
    [r.id, tenantId, r.code, r.title, r.chapter, r.actorId]);
}
export async function list(tx: Q, tenantId: string, f: { q?: string; chapter?: string; isActive?: boolean; after?: { code: string; id: string }; limit: number }): Promise<Row[]> {
  const v: unknown[] = [tenantId]; const w = ['i.tenant_id = $1'];
  const add = (x: unknown): string => { v.push(x); return `$${v.length}`; };
  if (f.q !== undefined) { const e = esc(f.q); w.push(`(i.code ILIKE ${add(`${e}%`)} OR i.title ILIKE ${add(`%${e}%`)})`); }
  if (f.chapter !== undefined) w.push(`i.chapter = ${add(f.chapter)}`);
  if (f.isActive !== undefined) w.push(`i.is_active = ${add(f.isActive)}`);
  if (f.after) w.push(`(i.code, i.id) > (${add(f.after.code)}, ${add(f.after.id)}::uuid)`);
  return (await tx.query(`SELECT ${COLS} FROM catalog.icd_code i WHERE ${w.join(' AND ')} ORDER BY i.code ASC, i.id ASC LIMIT ${add(f.limit + 1)}`, v)).rows;
}
/** active codes only; best match first: exact code, code prefix, title prefix, title contains */
export async function search(tx: Q, tenantId: string, q: string, limit: number): Promise<Row[]> {
  const e = esc(q);
  return (await tx.query(`SELECT ${COLS} FROM catalog.icd_code i WHERE i.tenant_id = $1 AND i.is_active AND (i.code ILIKE $2 OR i.title ILIKE $3) `
    + 'ORDER BY CASE WHEN upper(i.code) = upper($4) THEN 0 WHEN i.code ILIKE $2 THEN 1 WHEN i.title ILIKE $5 THEN 2 ELSE 3 END, i.code ASC, i.id ASC LIMIT $6',
  [tenantId, `${e}%`, `%${e}%`, q, `${e}%`, limit])).rows;
}
export async function bump(tx: Q, tenantId: string, id: string, version: number, patch: Record<string, unknown>, actorId: string): Promise<boolean> {
  const args: unknown[] = [tenantId, id, version]; const sets: string[] = [];
  for (const [k, x] of Object.entries(patch)) { args.push(x); sets.push(`${k} = $${args.length}`); }   // keys from code allow-lists only
  args.push(actorId); sets.push(`updated_by = $${args.length}`);
  return (await tx.query(`UPDATE catalog.icd_code SET ${sets.join(', ')}, version = version + 1, updated_at = now() WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING id`, args)).rows.length > 0;
}
