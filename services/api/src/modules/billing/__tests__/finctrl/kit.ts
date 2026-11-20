// T0B-FINCTRL-1 (LD-321, LD-310, LD-325) kit on top of ../accounts/helpers.ts (helper, not a test): discount policy masters, hold / release, fiscal year, cash carry forward.
// Real PG17 under RLS, synthetic data only. Fixtures are committed by the superuser; the API under test only sees them through RLS.
// CONV pins (also in .orchestra/notes/T0B-FINCTRL-1-tests.md; the writer may dispute them through the ruling path):
//   - user_id of user_discount_limit / discount_authority = core.users.id; the actor of a request is a membership, its user is core.memberships.user_id.
//   - tenant settings come from IdentityPort.getTenantSettings: `require_discount_reason` (boolean, absent = true) and `fiscal_year_start_bs` ({ month, day }, absent = { month: 4, day: 1 } = Shrawan 1).
import { CENTRE, SYS_ACTOR, TENANT_A, TENANT_B, T, fire, idem, ifm, ok, req, seed, superTx, tag, uid, world, type Who, type World } from '../accounts/helpers.js';

export { CENTRE, SYS_ACTOR, TENANT_A, TENANT_B, T, fire, idem, ifm, ok, req, seed, superTx, tag, uid, world };
export type { Who, World };

export const DAY = '2026-11-17';
/** YYYY-MM-DD + n days (UTC arithmetic, no time zone). */
export const addDays = (d: string, n: number): string => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export interface Person { userId: string; membershipId: string; tenant: string }
/** An active staff member: a user and its membership. */
export async function person(tenant = TENANT_A): Promise<Person> {
  const userId = uid(), membershipId = uid();
  await seed('core.users', { id: userId, tenant_id: tenant, display_name: `Synthetic Staff ${tag()}` });
  await seed('core.memberships', { id: membershipId, tenant_id: tenant, user_id: userId, actor_type: 'user', status: 'active', all_centres: true });
  return { userId, membershipId, tenant };
}

export const dbRows = (tenant: string, sql: string, values: unknown[] = []) => superTx(async (tx) => (await tx.query(sql, [tenant, ...values])).rows, tenant);
export const rowAudit = (tenant: string, table: string, rowId: string) =>
  dbRows(tenant, `SELECT action FROM audit.audit_log WHERE tenant_id = $1 AND schema_name = 'billing' AND table_name = $2 AND row_id = $3 ORDER BY occurred_at, id`, [table, rowId]).then((r) => r.map((x: any) => x.action as string));
/** every audit record (row audit or access log) that names `id`. */
export async function auditCount(tenant: string, table: string, id: string): Promise<number> {
  const a = await dbRows(tenant, `SELECT count(*)::int AS c FROM audit.audit_log WHERE tenant_id = $1 AND table_name = $2 AND row_id = $3`, [table, id]);
  const b = await dbRows(tenant, `SELECT count(*)::int AS c FROM audit.access_log WHERE tenant_id = $1 AND entity_id = $2`, [id]);
  return Number(a[0].c) + Number(b[0].c);
}

// ---------------------------------------------------------------- slabs
export const slabBody = (partyId: string, over: Record<string, unknown> = {}) => ({
  party_kind: 'credit_party', party_id: partyId, amount_from_paisa: 0, amount_to_paisa: 100_000, discount_bp: 500, effective_from: '2026-01-01', ...over,
});
export const mkSlab = (tenant: string, body: Record<string, unknown>, who: Who = {}) => fire('createPartyDiscountSlab', req({ headers: idem(), body }), { tenant, ...who });
export const updSlab = (tenant: string, id: string, version: number | string, body: Record<string, unknown>, who: Who = {}) =>
  fire('updatePartyDiscountSlab', req({ params: { party_discount_slab_id: id }, headers: typeof version === 'number' ? ifm(version) : {}, body }), { tenant, ...who });
export const offSlab = (tenant: string, id: string, version: number | string, who: Who = {}) =>
  fire('deactivatePartyDiscountSlab', req({ params: { party_discount_slab_id: id }, headers: typeof version === 'number' ? ifm(version) : {} }), { tenant, ...who });
export const listSlabs = (tenant: string, query: Record<string, unknown> = {}) => fire('listPartyDiscountSlabs', req({ query }), { tenant });
export const resolve = (tenant: string, partyId: string, amount: number | string, onDate?: string, kind = 'credit_party') =>
  fire('resolveDiscountSlab', req({ query: { party_kind: kind, party_id: partyId, amount_paisa: String(amount), ...(onDate ? { on_date: onDate } : {}) } }), { tenant });

// ---------------------------------------------------------------- limits, authorities, reasons
export const putLimit = (tenant: string, userId: string, body: Record<string, unknown>, version?: number, who: Who = {}) =>
  fire('setUserDiscountLimit', req({ params: { user_id: userId }, headers: version === undefined ? {} : ifm(version), body }), { tenant, ...who });
export const listLimits = (tenant: string, query: Record<string, unknown> = {}) => fire('listUserDiscountLimits', req({ query }), { tenant });
export const mkAuthority = (tenant: string, body: Record<string, unknown>, who: Who = {}) => fire('createDiscountAuthority', req({ headers: idem(), body }), { tenant, ...who });
export const offAuthority = (tenant: string, id: string, version: number | string, who: Who = {}) =>
  fire('deactivateDiscountAuthority', req({ params: { discount_authority_id: id }, headers: typeof version === 'number' ? ifm(version) : {} }), { tenant, ...who });
export const listAuthorities = (tenant: string, query: Record<string, unknown> = {}) => fire('listDiscountAuthorities', req({ query }), { tenant });
export const myPolicy = (tenant: string, who: Who = {}) => fire('getMyDiscountPolicy', req({}), { tenant, ...who });
export const mkReason = (tenant: string, body: Record<string, unknown>, who: Who = {}) => fire('createDiscountReason', req({ headers: idem(), body }), { tenant, ...who });
export const updReason = (tenant: string, id: string, version: number | string, body: Record<string, unknown>, who: Who = {}) =>
  fire('updateDiscountReason', req({ params: { discount_reason_id: id }, headers: typeof version === 'number' ? ifm(version) : {}, body }), { tenant, ...who });
export const listReasons = (tenant: string, query: Record<string, unknown> = {}) => fire('listDiscountReasons', req({ query }), { tenant });

// ---------------------------------------------------------------- hold / release
const holdOp = (op: string) => (tenant: string, id: string, body: unknown = { reason: 'Synthetic query on the cheque' }, who: Who = {}) =>
  fire(op, req({ params: { account_ledger_entry_id: id }, headers: idem(), body }), { tenant, ...who });
export const hold = holdOp('holdLedgerEntry');
export const release = holdOp('releaseLedgerEntry');
export const dbEntry = async (tenant: string, id: string) => (await dbRows(tenant, 'SELECT * FROM billing.account_ledger_entries WHERE tenant_id = $1 AND id = $2', [id]))[0];
export const listEntries = (tenant: string, query: Record<string, unknown>) => fire('listAccountLedgerEntries', req({ query }), { tenant });

// ---------------------------------------------------------------- cash sessions (seeded by the owner, the open path is the real one)
export async function seedClosedSession(w: { tenant: string; centre: string }, membershipId: string, o: { openedAt: string; closedAt: string; cashPaisa: number; previous?: number; deposit?: number }): Promise<string> {
  const id = uid();
  await superTx(async (tx) => {
    const [b] = (await tx.query(`SELECT id FROM core.branches WHERE tenant_id = $1 LIMIT 1`, [w.tenant])).rows;
    await tx.query(`INSERT INTO billing.cash_sessions (id, tenant_id, branch_id, centre_id, membership_id, status, opened_at, closed_at, expected, counted, variance_paisa, previous_outstanding_cash_paisa, deposit_paisa, created_by, updated_by)
      VALUES ($1,$2,$3,$4,$5,'closed',$6::timestamptz,$7::timestamptz,$8::jsonb,$8::jsonb,0,$9,$10,$5,$5)`,
    [id, w.tenant, b.id, w.centre, membershipId, o.openedAt, o.closedAt, JSON.stringify([{ method_code: 'cash', amount_paisa: o.cashPaisa }]), o.previous ?? 0, o.deposit ?? 0]);
  }, w.tenant);
  return id;
}
export const sessionRow = async (tenant: string, id: string) => (await dbRows(tenant, 'SELECT * FROM billing.cash_sessions WHERE tenant_id = $1 AND id = $2', [id]))[0];
