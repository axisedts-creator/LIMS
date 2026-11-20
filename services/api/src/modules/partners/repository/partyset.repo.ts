// T0B-PARTYSET-1 (LD-321): SQL of partners.party_commercial_setting, party_onboarding, non_compliance_penalty, non_compliance_event (migration 20261117220000)
// and the reads of the party masters (split model) the service needs. Every statement binds tenant_id explicitly (RLS is the second wall); every request
// value is a bound parameter; column names come from code allow-lists only.
export type Row = Record<string, any>;
export type Q = { query(text: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount?: number | null }> };

const ts = (c: string): string => `to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const day = (c: string): string => `to_char(${c}, 'YYYY-MM-DD')`;
const escapeLike = (v: string): string => v.replace(/[\\%_]/g, '\\$&');

// ---------------------------------------------------------------- party masters (split model)
const MASTER: Readonly<Record<string, { table: string; name: string }>> = Object.freeze({
  partner: { table: 'partners.partners', name: 'name' },
  credit_party: { table: 'catalog.credit_parties', name: 'name' },
  doctor: { table: 'catalog.doctors', name: 'display_name' },
  referrer: { table: 'partners.partner_referrers', name: 'display_name' },
});
export async function partyExists(tx: Q, tenantId: string, kind: string, id: string): Promise<boolean> {
  const m = MASTER[kind];
  if (!m) return false;
  return (await tx.query(`SELECT 1 FROM ${m.table} WHERE tenant_id = $1 AND id = $2`, [tenantId, id])).rows.length > 0;
}
/** the stored government ID number of a party (column per kind; undefined = the party has no such column / is unknown) */
const ID_COLUMN: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  partner: { tax_number: 'tax_number', national_id_number: 'national_id_number' },
  credit_party: { tax_number: 'pan' },
  doctor: { national_id_number: 'national_id_number' },
});
export async function idNumberOf(tx: Q, tenantId: string, kind: string, id: string, field: string): Promise<{ exists: boolean; value: string | null }> {
  const m = MASTER[kind];
  if (!m) return { exists: false, value: null };
  const col = ID_COLUMN[kind]?.[field];
  const { rows } = await tx.query(`SELECT ${col ?? 'NULL::text'} AS v FROM ${m.table} WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rows.length === 0 ? { exists: false, value: null } : { exists: true, value: typeof rows[0]!['v'] === 'string' && rows[0]!['v'] !== '' ? rows[0]!['v'] : null };
}

// ---------------------------------------------------------------- settings
export const SETTING_COLS = ['auto_release_reports', 'whatsapp_enabled', 'insurance_enabled', 'print_exception', 'auto_block_overdue', 'lab_number_scheme_code', 'billing_cycle',
  'invoice_payment_days', 'invoice_blocking_days', 'invoice_warning_days', 'interest_bp_per_day', 'commission_bp', 'tds_bp', 'priority', 'header_footer_mode'] as const;
const S_SELECT = `s.id, s.party_kind, s.party_id, ${SETTING_COLS.map((c) => `s.${c}`).join(', ')}, s.version, ${ts('s.updated_at')} AS updated_at`;
export async function getSetting(tx: Q, tenantId: string, kind: string, partyId: string, lock = false): Promise<Row | undefined> {
  return (await tx.query(`SELECT ${S_SELECT} FROM partners.party_commercial_setting s WHERE s.tenant_id = $1 AND s.party_kind = $2 AND s.party_id = $3${lock ? ' FOR NO KEY UPDATE' : ''}`,
    [tenantId, kind, partyId])).rows[0];
}
/** first save: ON CONFLICT DO NOTHING (a concurrent first save of the same party won: the caller answers a conflict) */
export async function insertSetting(tx: Q, tenantId: string, id: string, kind: string, partyId: string, v: Row, actorId: string): Promise<boolean> {
  const cols = ['id', 'tenant_id', 'party_kind', 'party_id', ...SETTING_COLS, 'created_by', 'updated_by'];
  const vals = [id, tenantId, kind, partyId, ...SETTING_COLS.map((c) => v[c]), actorId, actorId];
  const { rows } = await tx.query(`INSERT INTO partners.party_commercial_setting (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) `
    + 'ON CONFLICT (tenant_id, party_kind, party_id) DO NOTHING RETURNING id', vals);
  return rows.length > 0;
}

// ---------------------------------------------------------------- onboarding
const NAME_OF = "COALESCE(p.name, cp.name, dr.display_name, rf.display_name)";
const O_FROM = 'FROM partners.party_onboarding o'
  + " LEFT JOIN partners.partners p ON o.party_kind = 'partner' AND p.tenant_id = o.tenant_id AND p.id = o.party_id"
  + " LEFT JOIN catalog.credit_parties cp ON o.party_kind = 'credit_party' AND cp.tenant_id = o.tenant_id AND cp.id = o.party_id"
  + " LEFT JOIN catalog.doctors dr ON o.party_kind = 'doctor' AND dr.tenant_id = o.tenant_id AND dr.id = o.party_id"
  + " LEFT JOIN partners.partner_referrers rf ON o.party_kind = 'referrer' AND rf.tenant_id = o.tenant_id AND rf.id = o.party_id";
const O_COLS = `o.id, o.party_kind, o.party_id, ${NAME_OF} AS party_name, o.status, o.reason, o.decided_by, ${ts('o.decided_at')} AS decided_at, o.version, o.created_by, `
  + `${ts('o.created_at')} AS created_at, to_char(o.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_key`;
export async function getOnboarding(tx: Q, tenantId: string, id: string, lock = false): Promise<Row | undefined> {
  return (await tx.query(`SELECT ${O_COLS} ${O_FROM} WHERE o.tenant_id = $1 AND o.id = $2${lock ? ' FOR NO KEY UPDATE OF o' : ''}`, [tenantId, id])).rows[0];
}
export async function listOnboarding(tx: Q, tenantId: string, f: { status?: string; kind?: string; q?: string; after?: { key: string; id: string }; limit: number }): Promise<Row[]> {
  const v: unknown[] = [tenantId]; const w = ['o.tenant_id = $1'];
  const add = (x: unknown): string => { v.push(x); return `$${v.length}`; };
  if (f.status !== undefined) w.push(`o.status = ${add(f.status)}`);
  if (f.kind !== undefined) w.push(`o.party_kind = ${add(f.kind)}`);
  if (f.q !== undefined) w.push(`${NAME_OF} ILIKE ${add(`%${escapeLike(f.q)}%`)}`);
  if (f.after) w.push(`(o.created_at, o.id) > (${add(f.after.key)}::timestamptz, ${add(f.after.id)}::uuid)`);
  return (await tx.query(`SELECT ${O_COLS} ${O_FROM} WHERE ${w.join(' AND ')} ORDER BY o.created_at ASC, o.id ASC LIMIT ${add(f.limit + 1)}`, v)).rows;
}
export async function decideOnboarding(tx: Q, tenantId: string, id: string, version: number, a: { status: string; reason: string | null; actorId: string }): Promise<boolean> {
  const { rows } = await tx.query('UPDATE partners.party_onboarding SET status = $4, reason = $5, decided_by = $6, decided_at = now(), version = version + 1, updated_at = now(), updated_by = $6 '
    + 'WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING id', [tenantId, id, version, a.status, a.reason, a.actorId]);
  return rows.length > 0;
}

// ---------------------------------------------------------------- penalties
const P_COLS = `n.id, n.code, n.name, n.amount_paisa, n.is_active, n.version, ${ts('n.created_at')} AS created_at, ${ts('n.updated_at')} AS updated_at`;
export async function getPenalty(tx: Q, tenantId: string, id: string, lock = false): Promise<Row | undefined> {
  return (await tx.query(`SELECT ${P_COLS} FROM partners.non_compliance_penalty n WHERE n.tenant_id = $1 AND n.id = $2${lock ? ' FOR NO KEY UPDATE' : ''}`, [tenantId, id])).rows[0];
}
export async function codeTaken(tx: Q, tenantId: string, code: string): Promise<boolean> {
  return (await tx.query('SELECT 1 FROM partners.non_compliance_penalty WHERE tenant_id = $1 AND code = $2', [tenantId, code])).rows.length > 0;
}
export async function insertPenalty(tx: Q, tenantId: string, p: { id: string; code: string; name: string; amount: number; actorId: string }): Promise<void> {
  await tx.query('INSERT INTO partners.non_compliance_penalty (id, tenant_id, code, name, amount_paisa, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $6)',
    [p.id, tenantId, p.code, p.name, p.amount, p.actorId]);
}
export async function listPenalties(tx: Q, tenantId: string, f: { isActive?: boolean; q?: string; after?: { code: string; id: string }; limit: number }): Promise<Row[]> {
  const v: unknown[] = [tenantId]; const w = ['n.tenant_id = $1'];
  const add = (x: unknown): string => { v.push(x); return `$${v.length}`; };
  if (f.isActive !== undefined) w.push(`n.is_active = ${add(f.isActive)}`);
  if (f.q !== undefined) { const e = escapeLike(f.q); w.push(`(n.code ILIKE ${add(`${e}%`)} OR n.name ILIKE ${add(`%${e}%`)})`); }
  if (f.after) w.push(`(n.code, n.id) > (${add(f.after.code)}, ${add(f.after.id)}::uuid)`);
  return (await tx.query(`SELECT ${P_COLS} FROM partners.non_compliance_penalty n WHERE ${w.join(' AND ')} ORDER BY n.code ASC, n.id ASC LIMIT ${add(f.limit + 1)}`, v)).rows;
}

// ---------------------------------------------------------------- events
const E_COLS = `e.id, e.party_kind, e.party_id, e.penalty_id, ${day('e.event_date')} AS event_date, e.amount_paisa, e.reason, e.status, e.ledger_entry_id, e.decided_by, e.version, `
  + `${ts('e.created_at')} AS created_at`;
export async function getEvent(tx: Q, tenantId: string, id: string, lock = false): Promise<Row | undefined> {
  return (await tx.query(`SELECT ${E_COLS} FROM partners.non_compliance_event e WHERE e.tenant_id = $1 AND e.id = $2${lock ? ' FOR NO KEY UPDATE' : ''}`, [tenantId, id])).rows[0];
}
export async function insertEvent(tx: Q, tenantId: string, e: { id: string; kind: string; partyId: string; penaltyId: string; date: string; amount: number; reason: string | null; actorId: string }): Promise<void> {
  await tx.query('INSERT INTO partners.non_compliance_event (id, tenant_id, party_kind, party_id, penalty_id, event_date, amount_paisa, reason, created_by, updated_by) '
    + 'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)', [e.id, tenantId, e.kind, e.partyId, e.penaltyId, e.date, e.amount, e.reason, e.actorId]);
}
export async function listEvents(tx: Q, tenantId: string, f: { kind?: string; partyId?: string; penaltyId?: string; status?: string; from?: string; to?: string;
  after?: { date: string; id: string }; limit: number }): Promise<Row[]> {
  const v: unknown[] = [tenantId]; const w = ['e.tenant_id = $1'];
  const add = (x: unknown): string => { v.push(x); return `$${v.length}`; };
  if (f.kind !== undefined) w.push(`e.party_kind = ${add(f.kind)}`);
  if (f.partyId !== undefined) w.push(`e.party_id = ${add(f.partyId)}::uuid`);
  if (f.penaltyId !== undefined) w.push(`e.penalty_id = ${add(f.penaltyId)}::uuid`);
  if (f.status !== undefined) w.push(`e.status = ${add(f.status)}`);
  if (f.from !== undefined) w.push(`e.event_date >= ${add(f.from)}::date`);
  if (f.to !== undefined) w.push(`e.event_date <= ${add(f.to)}::date`);
  if (f.after) w.push(`(e.event_date, e.id) < (${add(f.after.date)}::date, ${add(f.after.id)}::uuid)`);
  return (await tx.query(`SELECT ${E_COLS} FROM partners.non_compliance_event e WHERE ${w.join(' AND ')} ORDER BY e.event_date DESC, e.id DESC LIMIT ${add(f.limit + 1)}`, v)).rows;
}
/** the credit party whose account ledger a partner / credit party event is charged to (doctor / referrer: none) */
export async function ledgerPartyOf(tx: Q, tenantId: string, kind: string, partyId: string): Promise<string | undefined> {
  if (kind === 'credit_party') return partyId;
  if (kind !== 'partner') return undefined;
  return (await tx.query('SELECT credit_party_id FROM partners.partners WHERE tenant_id = $1 AND id = $2', [tenantId, partyId])).rows[0]?.['credit_party_id'] ?? undefined;
}
/** [CONV] the centre an account ledger entry of the party is booked at: the partner's receiving centre (for a credit party: its partner's, oldest first) */
export async function centreOfParty(tx: Q, tenantId: string, kind: string, partyId: string): Promise<string | undefined> {
  const col = kind === 'partner' ? 'id' : 'credit_party_id';
  return (await tx.query(`SELECT receiving_centre_id FROM partners.partners WHERE tenant_id = $1 AND ${col} = $2 ORDER BY created_at, id LIMIT 1`, [tenantId, partyId])).rows[0]?.['receiving_centre_id'] ?? undefined;
}
/** LD-321 / tests note (1): the tenant's account particular the penalty is posted under (code NON_COMPLIANCE_PENALTY); undefined = none configured */
export async function penaltyParticular(tx: Q, tenantId: string): Promise<string | undefined> {
  return (await tx.query("SELECT id FROM billing.account_particulars WHERE tenant_id = $1 AND code = 'NON_COMPLIANCE_PENALTY'", [tenantId])).rows[0]?.['id'] ?? undefined;
}

// ---------------------------------------------------------------- shared optimistic update
export async function bump(tx: Q, table: 'non_compliance_penalty' | 'non_compliance_event' | 'party_commercial_setting', tenantId: string, id: string, version: number,
  patch: Record<string, unknown>, actorId: string): Promise<boolean> {
  const args: unknown[] = [tenantId, id, version]; const sets: string[] = [];
  for (const [k, x] of Object.entries(patch)) { args.push(x); sets.push(`${k} = $${args.length}`); }   // keys from code allow-lists only, never from the request
  args.push(actorId); sets.push(`updated_by = $${args.length}`);
  const r = await tx.query(`UPDATE partners.${table} SET ${sets.join(', ')}, version = version + 1, updated_at = now() WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING id`, args);
  return r.rows.length > 0;
}
