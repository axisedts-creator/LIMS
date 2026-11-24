// T0B-SALES-1 (LD-321): SQL of the sales hierarchy (partners.sales_designation, sales_representative, party_sales_assignment, service_area;
// migration 20261117210000). Every statement binds tenant_id explicitly (RLS is the second wall) and every request value is a bound parameter.
// Reads that the done_when pins: getSalesTree = ONE WITH RECURSIVE statement (depth cap + cycle guard), listRepresentativeClients = ONE paged statement.
export type Row = Record<string, any>;
export type Q = { query(text: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount?: number | null }> };

const ts = (c: string): string => `to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const day = (c: string): string => `to_char(${c}, 'YYYY-MM-DD')`;
/** LIKE prefix with the wildcards of the value escaped, clamped to max 128 chars */
export const prefix = (v: string): string => `${v.slice(0, 128).replace(/[\\%_]/g, '\\$&')}%`;

/** same key as the trigger partners.sales_representative__manager_guard (migration 20261117210000): all manager changes of a tenant run one at a time */
export const lockManagerChanges = (tx: Q, tenantId: string) =>
  tx.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('partners.sales_representative.manager:' || $1::text, 0))", [tenantId]);

// ---------------------------------------------------------------- designations
const D_COLS = `d.id, d.name, d.level, d.is_active, d.version, ${ts('d.created_at')} AS created_at, ${ts('d.updated_at')} AS updated_at`;
export async function getDesignation(tx: Q, tenantId: string, id: string, lock = false): Promise<Row | undefined> {
  return (await tx.query(`SELECT ${D_COLS} FROM partners.sales_designation d WHERE d.tenant_id = $1 AND d.id = $2${lock ? ' FOR NO KEY UPDATE' : ''}`, [tenantId, id])).rows[0];
}
/** level is unique over ALL rows of the tenant, inactive ones included (sales_designation__tenant_id_level__uq) */
export async function levelTaken(tx: Q, tenantId: string, level: number, exceptId?: string): Promise<boolean> {
  const { rows } = await tx.query('SELECT 1 FROM partners.sales_designation WHERE tenant_id = $1 AND level = $2 AND ($3::uuid IS NULL OR id <> $3::uuid)', [tenantId, level, exceptId ?? null]);
  return rows.length > 0;
}
export async function insertDesignation(tx: Q, tenantId: string, r: { id: string; name: string; level: number; actorId: string }): Promise<void> {
  await tx.query('INSERT INTO partners.sales_designation (id, tenant_id, name, level, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $5)', [r.id, tenantId, r.name, r.level, r.actorId]);
}
export async function listDesignations(tx: Q, tenantId: string, f: { level?: number; isActive?: boolean; q?: string; after?: { level: number }; limit: number }): Promise<Row[]> {
  const v: unknown[] = [tenantId]; const w = ['d.tenant_id = $1'];
  const add = (x: unknown): string => { v.push(x); return `$${v.length}`; };
  if (f.level !== undefined) w.push(`d.level = ${add(f.level)}`);
  if (f.isActive !== undefined) w.push(`d.is_active = ${add(f.isActive)}`);
  if (f.q !== undefined) w.push(`d.name ILIKE ${add(prefix(f.q))}`);
  if (f.after) w.push(`d.level > ${add(f.after.level)}`);
  return (await tx.query(`SELECT ${D_COLS} FROM partners.sales_designation d WHERE ${w.join(' AND ')} ORDER BY d.level ASC LIMIT ${add(f.limit + 1)}`, v)).rows;
}

// ---------------------------------------------------------------- representatives
const R_COLS = `r.id, r.name, r.phone, r.email, r.user_id, r.designation_id, d.level AS designation_level, r.manager_id, ${day('r.joining_date')} AS joining_date, `
  + `r.is_active, r.version, ${ts('r.created_at')} AS created_at, ${ts('r.updated_at')} AS updated_at`;
const R_FROM = 'FROM partners.sales_representative r JOIN partners.sales_designation d ON d.tenant_id = r.tenant_id AND d.id = r.designation_id';
export async function getRepresentative(tx: Q, tenantId: string, id: string, lock?: 'FOR NO KEY UPDATE' | 'FOR SHARE'): Promise<Row | undefined> {
  // lock on r only (OF r): a deactivation (NO KEY UPDATE) and an assignment / manager pick (SHARE) of the same row run one after the other
  return (await tx.query(`SELECT ${R_COLS} ${R_FROM} WHERE r.tenant_id = $1 AND r.id = $2${lock ? ` ${lock} OF r` : ''}`, [tenantId, id])).rows[0];
}
/** true when walking up from `managerId` reaches `repId` (the new manager sits under the representative = a loop). Hop cap + visited guard: corrupt data never hangs. */
export async function wouldLoop(tx: Q, tenantId: string, repId: string, managerId: string): Promise<boolean> {
  const { rows } = await tx.query(
    'WITH RECURSIVE up (id, manager_id, seen) AS ('
    + ' SELECT r.id, r.manager_id, ARRAY[r.id] FROM partners.sales_representative r WHERE r.tenant_id = $1 AND r.id = $2'
    + ' UNION ALL SELECT r.id, r.manager_id, up.seen || r.id FROM up JOIN partners.sales_representative r ON r.tenant_id = $1 AND r.id = up.manager_id'
    + ' WHERE NOT r.id = ANY (up.seen) AND cardinality(up.seen) < 10000)'
    + ' SELECT EXISTS (SELECT 1 FROM up WHERE up.id = $3) AS hit', [tenantId, managerId, repId]);
  return rows[0]?.['hit'] === true;
}
export async function insertRepresentative(tx: Q, tenantId: string, r: Row): Promise<void> {
  await tx.query('INSERT INTO partners.sales_representative (id, tenant_id, name, phone, email, user_id, designation_id, manager_id, joining_date, created_by, updated_by) '
    + 'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)',
  [r['id'], tenantId, r['name'], r['phone'] ?? null, r['email'] ?? null, r['user_id'] ?? null, r['designation_id'], r['manager_id'] ?? null, r['joining_date'] ?? null, r['actorId']]);
}
/** open or future assignments of the representative on `today` (tenant date): ends today or later, or no end */
export async function hasActiveClients(tx: Q, tenantId: string, repId: string, today: string): Promise<boolean> {
  const { rows } = await tx.query('SELECT 1 FROM partners.party_sales_assignment WHERE tenant_id = $1 AND representative_id = $2 AND (effective_to IS NULL OR effective_to >= $3::date) LIMIT 1',
    [tenantId, repId, today]);
  return rows.length > 0;
}
/** representatives the caller may see: the active representative rows linked to the user and everything under them (cycle guarded) */
const SCOPE_CTE = 'scope (id, seen) AS ('
  + ' SELECT m.id, ARRAY[m.id] FROM partners.sales_representative m WHERE m.tenant_id = $1 AND m.user_id = $2 AND m.is_active'
  + ' UNION ALL SELECT c.id, s.seen || c.id FROM scope s JOIN partners.sales_representative c ON c.tenant_id = $1 AND c.manager_id = s.id'
  + ' WHERE NOT c.id = ANY (s.seen) AND cardinality(s.seen) < 10000)';
export async function inOwnSubtree(tx: Q, tenantId: string, userId: string, repId: string): Promise<boolean> {
  const { rows } = await tx.query(`WITH RECURSIVE ${SCOPE_CTE} SELECT EXISTS (SELECT 1 FROM scope WHERE scope.id = $3) AS hit`, [tenantId, userId, repId]);
  return rows[0]?.['hit'] === true;
}
export async function listRepresentatives(tx: Q, tenantId: string, f: { scopeUserId?: string; q?: string; designationId?: string; managerId?: string; isActive?: boolean; after?: { name: string; id: string }; limit: number }): Promise<Row[]> {
  const v: unknown[] = [tenantId]; const w = ['r.tenant_id = $1'];
  const add = (x: unknown): string => { v.push(x); return `$${v.length}`; };
  if (f.scopeUserId !== undefined) { add(f.scopeUserId); w.push('r.id IN (SELECT id FROM scope)'); }   // $2 of SCOPE_CTE
  if (f.q !== undefined) w.push(`r.name ILIKE ${add(prefix(f.q))}`);
  if (f.designationId !== undefined) w.push(`r.designation_id = ${add(f.designationId)}`);
  if (f.managerId !== undefined) w.push(`r.manager_id = ${add(f.managerId)}`);
  if (f.isActive !== undefined) w.push(`r.is_active = ${add(f.isActive)}`);
  if (f.after) w.push(`(r.name, r.id) > (${add(f.after.name)}, ${add(f.after.id)}::uuid)`);
  const cte = f.scopeUserId !== undefined ? `WITH RECURSIVE ${SCOPE_CTE} ` : '';
  return (await tx.query(`${cte}SELECT ${R_COLS} ${R_FROM} WHERE ${w.join(' AND ')} ORDER BY r.name, r.id LIMIT ${add(f.limit + 1)}`, v)).rows;
}

/**
 * The manager tree as a flat depth-first list: ONE WITH RECURSIVE statement. Roots: `rootId`, else the caller's own active representative rows
 * (`ownUserId`), else every representative without a manager. depth 1 = root; the walk stops at `maxDepth` (cap 8) and never re-enters a node
 * of its own path (cycle guard). Order = the id path (uuid[]), a preorder: a manager before its reports, subtrees contiguous; siblings by id
 * (UUIDv7 = creation order). The root is always listed; other inactive nodes only with includeInactive or when an active node sits below them.
 * ponytail: the "active node below" test is O(n^2) inside the statement; fine for sales teams of a few thousand, add a materialised flag if a tenant outgrows it.
 */
export async function salesTree(tx: Q, tenantId: string, f: { rootId?: string; ownUserId?: string; maxDepth: number; includeInactive: boolean; after?: string[]; limit: number }): Promise<Row[]> {
  const root = f.rootId !== undefined ? 'r.id = $2::uuid' : f.ownUserId !== undefined ? 'r.user_id = $2::uuid AND r.is_active' : 'r.manager_id IS NULL AND $2::uuid IS NULL';
  const { rows } = await tx.query(
    'WITH RECURSIVE t (id, name, designation_id, manager_id, is_active, depth, path) AS ('
    + ` SELECT r.id, r.name, r.designation_id, r.manager_id, r.is_active, 1, ARRAY[r.id] FROM partners.sales_representative r WHERE r.tenant_id = $1 AND ${root}`
    + ' UNION ALL SELECT c.id, c.name, c.designation_id, c.manager_id, c.is_active, t.depth + 1, t.path || c.id'
    + ' FROM t JOIN partners.sales_representative c ON c.tenant_id = $1 AND c.manager_id = t.id'
    + ' WHERE t.depth < $3 AND NOT c.id = ANY (t.path))'
    + ' SELECT t.id, t.name, t.designation_id, d.level AS designation_level, t.manager_id, t.depth, t.is_active, t.path::text[] AS path'
    + ' FROM t JOIN partners.sales_designation d ON d.tenant_id = $1 AND d.id = t.designation_id'
    + ' WHERE (t.depth = 1 OR t.is_active OR $4::boolean OR EXISTS (SELECT 1 FROM t b WHERE b.is_active AND b.id <> t.id AND t.id = ANY (b.path)))'
    + ' AND ($5::uuid[] IS NULL OR t.path > $5::uuid[])'
    + ' ORDER BY t.path LIMIT $6',
    [tenantId, f.rootId ?? f.ownUserId ?? null, f.maxDepth, f.includeInactive, f.after ?? null, f.limit + 1]);
  return rows;
}

// ---------------------------------------------------------------- party assignments
const A_COLS = `a.id, a.party_kind, a.party_id, a.representative_id, ${day('a.effective_from')} AS effective_from, ${day('a.effective_to')} AS effective_to, a.version, `
  + `${ts('a.created_at')} AS created_at, ${ts('a.updated_at')} AS updated_at`;
export async function getAssignment(tx: Q, tenantId: string, id: string, lock = false): Promise<Row | undefined> {
  return (await tx.query(`SELECT ${A_COLS} FROM partners.party_sales_assignment a WHERE a.tenant_id = $1 AND a.id = $2${lock ? ' FOR NO KEY UPDATE' : ''}`, [tenantId, id])).rows[0];
}
/** the party master of each kind of the split model (credit party, partner, doctor; referrer = a partner's referrer row) in this tenant */
export async function partyExists(tx: Q, tenantId: string, kind: string, id: string): Promise<boolean> {
  const table = { credit_party: 'catalog.credit_parties', partner: 'partners.partners', doctor: 'catalog.doctors', referrer: 'partners.partner_referrers' }[kind];
  if (!table) return false;
  return (await tx.query(`SELECT 1 FROM ${table} WHERE tenant_id = $1 AND id = $2`, [tenantId, id])).rows.length > 0;
}
export async function overlaps(tx: Q, tenantId: string, a: { kind: string; partyId: string; repId: string; from: string; to: string | null; exceptId?: string }): Promise<boolean> {
  const { rows } = await tx.query('SELECT 1 FROM partners.party_sales_assignment WHERE tenant_id = $1 AND party_kind = $2 AND party_id = $3 AND representative_id = $4'
    + " AND ($7::uuid IS NULL OR id <> $7::uuid) AND effective_from <= coalesce($6::date, 'infinity'::date) AND $5::date <= coalesce(effective_to, 'infinity'::date) LIMIT 1",
  [tenantId, a.kind, a.partyId, a.repId, a.from, a.to, a.exceptId ?? null]);
  return rows.length > 0;
}
export async function insertAssignment(tx: Q, tenantId: string, a: { id: string; kind: string; partyId: string; repId: string; from: string; to: string | null; actorId: string }): Promise<void> {
  await tx.query('INSERT INTO partners.party_sales_assignment (id, tenant_id, party_kind, party_id, representative_id, effective_from, effective_to, created_by, updated_by) '
    + 'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)', [a.id, tenantId, a.kind, a.partyId, a.repId, a.from, a.to, a.actorId]);
}

/**
 * The client list of one representative on `asOf` (inclusive window, open end): ONE paged statement, no per row work.
 * party_name from the party master of its kind; outstanding_paisa = issued invoices of the party's credit party (a partner bills through its credit party)
 * minus its ledger entries (payments +, refunds / reversals -); last_bill_date = latest issued invoice, date in the tenant time zone. Doctor / referrer: 0, no date.
 */
export async function listClients(tx: Q, tenantId: string, f: { repId: string; asOf: string; kind?: string; tz: string; after?: string; limit: number }): Promise<Row[]> {
  const { rows } = await tx.query(
    `SELECT a.id AS assignment_id, a.party_kind, a.party_id, ${day('a.effective_from')} AS effective_from, ${day('a.effective_to')} AS effective_to,`
    + " COALESCE(cp.name, p.name, dr.display_name, rf.display_name, '-') AS party_name,"
    + ' (COALESCE(inv.billed, 0) - COALESCE(led.paid, 0))::bigint AS outstanding_paisa,'
    + " to_char((inv.last_at AT TIME ZONE $4::text)::date, 'YYYY-MM-DD') AS last_bill_date"
    + ' FROM partners.party_sales_assignment a'
    + " LEFT JOIN catalog.credit_parties cp ON a.party_kind = 'credit_party' AND cp.tenant_id = a.tenant_id AND cp.id = a.party_id"
    + " LEFT JOIN partners.partners p ON a.party_kind = 'partner' AND p.tenant_id = a.tenant_id AND p.id = a.party_id"
    + " LEFT JOIN catalog.doctors dr ON a.party_kind = 'doctor' AND dr.tenant_id = a.tenant_id AND dr.id = a.party_id"
    + " LEFT JOIN partners.partner_referrers rf ON a.party_kind = 'referrer' AND rf.tenant_id = a.tenant_id AND rf.id = a.party_id"
    + ' CROSS JOIN LATERAL (SELECT COALESCE(cp.id, p.credit_party_id) AS id) bill'
    + " LEFT JOIN LATERAL (SELECT sum(i.net_paisa) AS billed, max(i.issued_at) AS last_at FROM billing.invoices i WHERE i.tenant_id = a.tenant_id AND i.credit_party_id = bill.id AND i.status = 'issued') inv ON bill.id IS NOT NULL"
    + ' LEFT JOIN LATERAL (SELECT sum(l.amount_paisa) AS paid FROM billing.ledger_entries l WHERE l.tenant_id = a.tenant_id AND l.credit_party_id = bill.id) led ON bill.id IS NOT NULL'
    + ' WHERE a.tenant_id = $1 AND a.representative_id = $2 AND a.effective_from <= $3::date AND (a.effective_to IS NULL OR a.effective_to >= $3::date)'
    + ' AND ($5::text IS NULL OR a.party_kind = $5::text) AND ($6::uuid IS NULL OR a.id > $6::uuid)'
    + ' ORDER BY a.id LIMIT $7',
    [tenantId, f.repId, f.asOf, f.tz, f.kind ?? null, f.after ?? null, f.limit + 1]);
  return rows;
}

// ---------------------------------------------------------------- service areas
const S_COLS = `s.id, s.name, s.district, s.area_text, s.centre_id, s.is_active, s.version, ${ts('s.created_at')} AS created_at, ${ts('s.updated_at')} AS updated_at`;
export async function getServiceArea(tx: Q, tenantId: string, id: string, lock = false): Promise<Row | undefined> {
  return (await tx.query(`SELECT ${S_COLS} FROM partners.service_area s WHERE s.tenant_id = $1 AND s.id = $2${lock ? ' FOR NO KEY UPDATE' : ''}`, [tenantId, id])).rows[0];
}
export async function centreExists(tx: Q, tenantId: string, centreId: string): Promise<boolean> {
  return (await tx.query('SELECT 1 FROM core.collection_centres WHERE tenant_id = $1 AND id = $2', [tenantId, centreId])).rows.length > 0;
}
export async function insertServiceArea(tx: Q, tenantId: string, s: { id: string; name: string; district: string; areaText: string | null; centreId: string | null; actorId: string }): Promise<void> {
  await tx.query('INSERT INTO partners.service_area (id, tenant_id, name, district, area_text, centre_id, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)',
    [s.id, tenantId, s.name, s.district, s.areaText, s.centreId, s.actorId]);
}
export async function listServiceAreas(tx: Q, tenantId: string, f: { district?: string; centreId?: string; isActive?: boolean; q?: string; after?: { name: string; id: string }; limit: number }): Promise<Row[]> {
  const v: unknown[] = [tenantId]; const w = ['s.tenant_id = $1'];
  const add = (x: unknown): string => { v.push(x); return `$${v.length}`; };
  if (f.district !== undefined) w.push(`lower(s.district) = lower(${add(f.district)})`);
  if (f.centreId !== undefined) w.push(`s.centre_id = ${add(f.centreId)}`);
  if (f.isActive !== undefined) w.push(`s.is_active = ${add(f.isActive)}`);
  if (f.q !== undefined) w.push(`s.name ILIKE ${add(prefix(f.q))}`);
  if (f.after) w.push(`(s.name, s.id) > (${add(f.after.name)}, ${add(f.after.id)}::uuid)`);
  return (await tx.query(`SELECT ${S_COLS} FROM partners.service_area s WHERE ${w.join(' AND ')} ORDER BY s.name, s.id LIMIT ${add(f.limit + 1)}`, v)).rows;
}

// ---------------------------------------------------------------- shared optimistic update
/** UPDATE <table> SET ... WHERE tenant_id = $1 AND id = $2 AND version = $3; 0 rows = someone else changed it first */
export async function bump(tx: Q, table: 'sales_designation' | 'sales_representative' | 'party_sales_assignment' | 'service_area', tenantId: string, id: string, version: number,
  patch: Record<string, unknown>, actorId: string): Promise<boolean> {
  const args: unknown[] = [tenantId, id, version]; const sets: string[] = [];
  for (const [k, x] of Object.entries(patch)) { args.push(x); sets.push(`${k} = $${args.length}`); }   // keys come from code allow-lists only, never from the request
  args.push(actorId); sets.push(`updated_by = $${args.length}`);
  const sql = `UPDATE partners.${table} SET ${sets.join(', ')}, version = version + 1, updated_at = now() WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING id`;
  const r = await tx.query(sql, args);
  return r.rows.length > 0;
}
