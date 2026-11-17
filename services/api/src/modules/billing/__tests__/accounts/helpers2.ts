// T0B-ACCT-2 (LD-313, LD-310) kit on top of helpers.ts (helper, not a test): expense types, expenses, cash transfers, daily collection summary.
// Real PG17 under RLS, synthetic data only. Fixtures are committed by the superuser; the API under test only sees them through RLS.
import { CENTRE, SYS_ACTOR, TENANT_A, TENANT_B, fire, idem, ifm, ok, req, seed, superTx, tag, uid, world, type Who, type World } from './helpers.js';

export const T = 280_000;
export { CENTRE, SYS_ACTOR, TENANT_A, TENANT_B, fire, idem, ifm, ok, req, seed, superTx, tag, uid, world };
export type { Who, World };

/** CONV pin (notes T0B-ACCT-2-tests.md): the pair of an accepted cash transfer is posted on the tenant particular with this code. */
export const TRANSFER_PARTICULAR = 'CASH_TRANSFER';
export const NOW_ISO = '2026-11-17T06:00:00.000Z';

export interface Staff { id: string; tenant: string }
/** An active staff membership (a user pocket owner). */
export async function staff(tenant = TENANT_A): Promise<Staff> {
  const userId = uid(), id = uid();
  await seed('core.users', { id: userId, tenant_id: tenant, display_name: `Synthetic Staff ${tag()}` });
  await seed('core.memberships', { id, tenant_id: tenant, user_id: userId, actor_type: 'user', status: 'active', all_centres: true });
  return { id, tenant };
}

/** The tenant particular the accepted transfer posts on (idempotent per tenant). */
export async function transferParticular(tenant = TENANT_A): Promise<void> {
  const g = uid();
  await seed('billing.account_groups', { id: g, tenant_id: tenant, code: 'CASH_TRANSFERS', name: 'Synthetic cash transfers', nature: 'asset' });
  const [row] = await superTx(async (tx) => (await tx.query(`SELECT id FROM billing.account_groups WHERE tenant_id = $1 AND code = 'CASH_TRANSFERS'`, [tenant])).rows, tenant);
  await seed('billing.account_particulars', { id: uid(), tenant_id: tenant, account_group_id: row.id, code: TRANSFER_PARTICULAR, name: 'Synthetic cash transfer' });
}

/** An expense group + particular + an active expense type (via the API) in tenant `side`. */
export interface ExpWorld extends World { typeId: string; expenseParticularId: string }
export async function expWorld(side: 'a' | 'b' = 'a'): Promise<ExpWorld> {
  const w = await world(side);
  const gid = uid(), pid = uid();
  await seed('billing.account_groups', { id: gid, tenant_id: w.tenant, code: `EG_${tag()}`, name: 'Synthetic expense group', nature: 'expense' });
  await seed('billing.account_particulars', { id: pid, tenant_id: w.tenant, account_group_id: gid, code: `EP_${tag()}`, name: 'Synthetic expense particular' });
  const t = ok(await createType(w.tenant, { name: `Synthetic Electricity ${tag()}`, account_particular_id: pid }), 201);
  return { ...w, typeId: t.id, expenseParticularId: pid };
}

export const createType = (tenant: string, body: Record<string, unknown>, who: Who = {}) => fire('createExpenseType', req({ headers: idem(), body }), { tenant, ...who });
export const updateType = (tenant: string, id: string, version: number | string, body: Record<string, unknown>, who: Who = {}) =>
  fire('updateExpenseType', req({ params: { expense_type_id: id }, headers: typeof version === 'number' ? ifm(version) : {}, body }), { tenant, ...who });
export const listTypes = (tenant: string, query: Record<string, unknown> = {}) => fire('listExpenseTypes', req({ query }), { tenant });

export const expenseBody = (w: ExpWorld, over: Record<string, unknown> = {}) => ({ centre_id: w.centre, expense_at: NOW_ISO, expense_type_id: w.typeId, amount_paisa: 25_000, description: 'Synthetic electricity bill', ...over });
export const createExpense = (w: ExpWorld, over: Record<string, unknown> = {}, who: Who = {}) => fire('createExpense', req({ headers: idem(), body: expenseBody(w, over) }), { tenant: w.tenant, ...who });
export const cancelExpense = (tenant: string, id: string, body: Record<string, unknown> = { reason_text: 'Synthetic duplicate entry' }, who: Who = {}) =>
  fire('cancelExpense', req({ params: { expense_id: id }, headers: idem(), body }), { tenant, ...who });
export const listExpenses = (tenant: string, query: Record<string, unknown> = {}) => fire('listExpenses', req({ query }), { tenant });

/** Owner side truth (no RLS). */
export const dbRows = (tenant: string, sql: string, values: unknown[] = []) => superTx(async (tx) => (await tx.query(sql, [tenant, ...values])).rows, tenant);
export const ledgerOf = (tenant: string, partyId: string) => dbRows(tenant, `SELECT * FROM billing.account_ledger_entries WHERE tenant_id = $1 AND party_id = $2 ORDER BY receipt_seq`, [partyId]);
/** signed pocket balance in paisa of a user (or centre) pocket: credits - debits of its account ledger entries (reversals are ordinary opposite rows). */
export async function pocket(tenant: string, partyId: string): Promise<number> {
  const [r] = await dbRows(tenant, `SELECT COALESCE(SUM(CASE entry_type WHEN 'credit' THEN amount_paisa ELSE -amount_paisa END), 0)::text AS s FROM billing.account_ledger_entries WHERE tenant_id = $1 AND party_kind = 'user_pocket' AND party_id = $2`, [partyId]);
  return Number(r.s);
}
export const ledgerCount = async (tenant: string): Promise<number> => Number((await dbRows(tenant, 'SELECT count(*)::text AS c FROM billing.account_ledger_entries WHERE tenant_id = $1'))[0].c);
export const auditActions = (tenant: string, table: string, rowId: string) =>
  dbRows(tenant, `SELECT action FROM audit.audit_log WHERE tenant_id = $1 AND schema_name = 'billing' AND table_name = $2 AND row_id = $3 ORDER BY occurred_at, id`, [table, rowId]).then((r) => r.map((x: any) => x.action as string));

/** Fund a pocket (user membership id or centre id) with a credit entry through the API (T0B-ACCT-2 extends findParty: a user_pocket party is an active membership or a centre of the tenant). */
export async function fund(w: World, partyId: string, paisa: number): Promise<any> {
  return ok(await fire('createAccountLedgerEntry', req({ headers: idem(), body: {
    centre_id: w.centre, party_kind: 'user_pocket', party_id: partyId, entry_date: '2026-11-17', account_particular_id: w.particularId, entry_type: 'credit', amount_paisa: paisa, payment_mode: 'cash' } }), { tenant: w.tenant }), 201);
}

/** A credit_party account ledger entry (credit by default) through the API, 201 asserted. */
export async function fundCredit(w: World, over: Record<string, unknown>): Promise<any> {
  return ok(await fire('createAccountLedgerEntry', req({ headers: idem(), body: {
    centre_id: w.centre, party_kind: 'credit_party', party_id: w.partyId, entry_date: '2026-11-17', account_particular_id: w.particularId, entry_type: 'credit', amount_paisa: 1000, payment_mode: 'cash', ...over } }), { tenant: w.tenant }), 201);
}

export const mkTransfer = (tenant: string, body: Record<string, unknown>, who: Who = {}) => fire('createCashTransfer', req({ headers: idem(), body }), { tenant, ...who });
export const tBody = (from: string, to: string, over: Record<string, unknown> = {}) => ({ from_kind: 'user', from_id: from, to_kind: 'user', to_id: to, amount_paisa: 50_000, remark: 'Synthetic hand over', ...over });
const decide = (op: string) => (tenant: string, id: string, who: Who = {}) => fire(op, req({ params: { cash_transfer_id: id }, headers: idem() }), { tenant, ...who });
export const accept = decide('acceptCashTransfer');
export const reject = decide('rejectCashTransfer');
export const cancelT = decide('cancelCashTransfer');
export const listT = (tenant: string, query: Record<string, unknown> = {}) => fire('listCashTransfers', req({ query }), { tenant });
export const summaryOf = (tenant: string, centre: string, day: string) => fire('getDailyCollectionSummary', req({ query: { centre_id: centre, day } }), { tenant });

/** A tenant graph for transfers: funded sender, a receiver, the transfer particular. */
export interface TWorld extends World { sender: Staff; receiver: Staff; stranger: Staff }
export async function tWorld(side: 'a' | 'b' = 'a', fundPaisa = 1_000_000): Promise<TWorld> {
  const w = await world(side);
  await transferParticular(w.tenant);
  const [sender, receiver, stranger] = [await staff(w.tenant), await staff(w.tenant), await staff(w.tenant)];
  if (fundPaisa > 0) await fund(w, sender.id, fundPaisa);
  return { ...w, sender, receiver, stranger };
}
