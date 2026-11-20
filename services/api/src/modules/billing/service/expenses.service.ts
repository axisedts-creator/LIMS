// T0B-ACCT-2 (LD-313, founder blanket authority LD-310) lab accounting part 2: expense types, expenses, cash transfers between users or centres, daily
// collection summary (contracts/openapi/billing.yaml, T0C-ACCT-1). Records only: no money is moved.
// LD-313 (b): every posting is an append only account ledger entry in paisa, in the request transaction; a correction is a reversal entry.
//   createExpense  -> ONE debit entry (party user_pocket = the actor, payment_mode cash, the expense type particular), linked by expenses.ledger_entry_id.
//   cancelExpense  -> ONE reversal of that entry (once, under the expense row lock); the expense row is kept (never deleted).
//   cash transfer  -> starts pending and posts nothing; accept posts a balanced pair (debit sender pocket, credit receiver pocket) with the status change;
//                     reject / cancel post nothing; a decided transfer is terminal (409 common.immutable_record).
// [CONV] pins of notes/T0B-ACCT-2-tests.md: pockets are user_pocket entries (party_id = membership id or centre id); the pair posts on the tenant particular
//   CASH_TRANSFER; negative pockets need IdentityPort featureFlags.allow_negative_pockets (default off); administrator = role tenant_admin.
// Nothing here logs; remark / description / reason_text never reach a log or an audit detail (ids only, LD-324 c).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../core/errors.js';
import { loadBillingConfig } from '../config.js';
import { fiscalYearLabel as fiscalYearLabelOf, fyStartOf } from '../domain/fiscalYear.js';
import { toPaisa } from '../domain/money/paisa.js';
import * as accounts from '../repository/accounts.repo.js';
import * as repo from '../repository/expenses.repo.js';
import { Checker, auditOf, decode, encode, fail, isUniqueViolation, notFound, pathId, receiptNoOf, scope } from './accounts.service.js';
import type { BalanceCtx } from './balance.service.js';
import { DEFAULT_TZ, localDate } from './ledgerDto.js';
import { iso, isRec, limitOf, present, UUID } from './invoiceRead.service.js';

type Row = Record<string, any>;
type Tx = Parameters<typeof repo.getType>[0];

const KINDS = ['user', 'centre'] as const;
const T_STATUSES = ['pending', 'accepted', 'rejected', 'cancelled'] as const;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;          // _common.yaml IsoUtc
const TRANSFER_PARTICULAR = 'CASH_TRANSFER';                             // [CONV] tests pin
const ADMIN_ROLE = 'tenant_admin';                                       // [CONV] tests pin
const immutable = () => new LimsError('common.immutable_record');
const forbidden = () => new LimsError('auth.forbidden');

const isUtc = (v: unknown): v is string => typeof v === 'string' && ISO_UTC.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString() === v;
function utc(c: Checker, k: string, required = false): string | undefined {
  if (!c.has(k, required)) return undefined;
  return isUtc(c.src[k]) ? c.src[k] : (c.flag(k), undefined);
}
const idCursor = (q: Row, sort: string): string | undefined =>
  (q['cursor'] === undefined ? undefined : decode<string>(q['cursor'], sort, (k) => typeof k === 'string' && UUID.test(k)));
function page<T>(rows: Row[], limit: number, sort: string, dto: (r: Row) => T) {
  const data = rows.slice(0, limit);
  return { data: data.map(dto), page: { limit, ...(rows.length > limit ? { next_cursor: encode(sort, data[data.length - 1]!['id']) } : {}) } };
}
const bodyOf = (c: Checker, body: unknown, optional = false) => { if (!isRec(body) && !(optional && body === undefined)) c.flag(''); };

// ---------------------------------------------------------------- DTOs
const typeDto = (r: Row) => ({
  id: r['id'], name: r['name'], account_particular_id: r['account_particular_id'], is_active: r['is_active'] === true, version: Number(r['version']),
  created_at: iso(r['created_at']), updated_at: iso(r['updated_at']),
});
const expenseDto = (r: Row) => present({
  id: r['id'], centre_id: r['centre_id'], expense_at: iso(r['expense_at']), expense_type_id: r['expense_type_id'], amount_paisa: toPaisa(r['amount_paisa']),
  description: r['description'], ledger_entry_id: r['ledger_entry_id'], cancelled_at: r['cancelled_at'] == null ? undefined : iso(r['cancelled_at']),
  cancel_reason_text: r['cancel_reason_text'], version: Number(r['version']), created_by: r['created_by'], created_at: iso(r['created_at']),
});
const transferDto = (r: Row) => present({
  id: r['id'], from_kind: r['from_kind'], from_id: r['from_id'], to_kind: r['to_kind'], to_id: r['to_id'], amount_paisa: toPaisa(r['amount_paisa']), status: r['status'],
  remark: r['remark'], decided_by: r['decided_by'], decided_at: r['decided_at'] == null ? undefined : iso(r['decided_at']), version: Number(r['version']),
  created_by: r['created_by'], created_at: iso(r['created_at']),
});

// ---------------------------------------------------------------- ctx helpers
type Identity = {
  getTenantSettings?(ctx: unknown, i: { keys: readonly string[] }): Promise<any>;
  getActor?(ctx: unknown): Promise<{ roles?: readonly string[]; centreScope?: { all?: boolean; centreIds?: readonly string[] } }>;
};
const identity = (ctx: BalanceCtx): Identity => ((ctx.ports as { IdentityPort?: Identity } | undefined)?.IdentityPort ?? {});
async function settings(ctx: BalanceCtx): Promise<{ tz: string; allowNegative: boolean }> {
  const s = await identity(ctx).getTenantSettings?.(ctx, { keys: ['timezone', 'featureFlags'] });
  return { tz: typeof s?.timezone === 'string' && s.timezone !== '' ? s.timezone : DEFAULT_TZ, allowNegative: s?.featureFlags?.allow_negative_pockets === true };
}
async function actorInfo(ctx: BalanceCtx) {
  const getActor = identity(ctx).getActor;
  if (typeof getActor !== 'function') throw forbidden();                 // fail closed: no identity, no decision
  const a = await getActor.call(identity(ctx), ctx);
  return { roles: a?.roles ?? [], all: a?.centreScope?.all === true, centreIds: a?.centreScope?.centreIds ?? [] };
}
const nowIso = (ctx: BalanceCtx): string => iso((ctx.now as () => unknown)());

/** Post one account ledger entry (receipt number under the tenant lock already held by the caller via nextReceiptSeq) and access-audit it. */
async function post(ctx: BalanceCtx, tx: Tx, e: Omit<accounts.NewEntry, 'id' | 'receiptNo' | 'receiptSeq' | 'bankName' | 'referenceNo' | 'paymentDetails' | 'fiscalYearLabel'> & { seq: number }) {
  const { seq, ...rest } = e;
  // T0B-FINCTRL-1 done_when 5: every ledger row carries the server set fiscal year label of its own entry_date (tenant start, default Shrawan 1)
  const s = await identity(ctx).getTenantSettings?.(ctx, { keys: ['fiscal_year_start_bs'] });
  let fiscalYearLabel: string;
  try { fiscalYearLabel = fiscalYearLabelOf(e.entryDate as never, fyStartOf(s?.fiscal_year_start_bs)); } catch { throw fail(['/entry_date']); }
  const row = await accounts.insertEntry(tx, { ...rest, id: uuidv7(), bankName: null, referenceNo: null, paymentDetails: null, receiptNo: receiptNoOf(seq), receiptSeq: seq, fiscalYearLabel });
  const audit = e.reversesEntryId
    ? { action: 'account_entry.reverse', detail: { reverses_entry_id: e.reversesEntryId } }
    : { action: 'account_entry.create' };
  await auditOf(ctx)({ ...audit, entityType: 'account_ledger_entry', entityId: row['id'], centreId: e.centreId, outcome: 'allowed' });
  return row;
}

// ---------------------------------------------------------------- service
export interface ExpensesDeps { readonly maxEntryPaisa?: number }

export function createExpensesService(deps: ExpensesDeps = {}) {
  const maxEntry = () => deps.maxEntryPaisa ?? loadBillingConfig().accountEntryMaxPaisa;

  async function balanceOk(ctx: BalanceCtx, tx: Tx, tenantId: string, partyId: string, amount: number, allowNegative: boolean) {
    if (allowNegative) return;
    if (BigInt(await repo.pocketBalance(tx, tenantId, partyId)) < BigInt(amount)) throw fail(['/amount_paisa']);
  }

  /** Lock the transfer, then: 404 unknown / other tenant -> 403 not allowed -> 409 no longer pending. */
  async function lockFor(ctx: BalanceCtx, rawId: unknown, allowed: (t: Row, actorId: string) => Promise<boolean>) {
    const { tx, tenantId, actorId } = scope(ctx);
    const t = await repo.lockTransfer(tx, tenantId, pathId(rawId, 'cash_transfer_id'));
    if (!t) throw notFound();
    if (!(await allowed(t, actorId))) throw forbidden();
    if (t['status'] !== 'pending') throw immutable();
    return { tx, tenantId, actorId, t };
  }
  /** Only the receiver decides (user: the actor is to_id; centre: the actor's centre scope holds to_id), never the creator (separation of duties). */
  const isReceiver = async (t: Row, actorId: string, ctx: BalanceCtx): Promise<boolean> => {
    if (t['created_by'] === actorId) return false;
    if (t['to_kind'] === 'user') return t['to_id'] === actorId;
    const a = await actorInfo(ctx);
    return a.all || a.centreIds.includes(t['to_id']);
  };

  return {
    // ------------------------------------------------ expense types
    async listTypes(ctx: BalanceCtx, rawQuery: unknown) {
      const { tx, tenantId } = scope(ctx);
      const q = isRec(rawQuery) ? rawQuery : {};
      const limit = limitOf(q['limit']);
      const c = new Checker(q);
      c.only(['is_active', 'cursor', 'limit']);
      const isActive = c.bool('is_active');
      c.done();
      const before = idCursor(q, 'expense_types');
      const rows = await repo.listTypes(tx, { tenantId, limit: limit + 1, ...(isActive === undefined ? {} : { isActive }), ...(before ? { beforeId: before } : {}) });
      return page(rows, limit, 'expense_types', typeDto);
    },
    async createType(ctx: BalanceCtx, body: unknown) {
      const { tx, tenantId, actorId } = scope(ctx);
      const c = new Checker(isRec(body) ? body : {});
      bodyOf(c, body);
      c.only(['name', 'account_particular_id', 'is_active']);
      const name = c.text('name', 200, true);
      const particularId = c.uuid('account_particular_id', true);
      const isActive = c.bool('is_active');
      c.done();
      if (!(await accounts.getParticular(tx, tenantId, particularId!))) throw notFound();
      try {
        return typeDto(await repo.insertType(tx, { id: uuidv7(), tenantId, name: name!, particularId: particularId!, isActive: isActive ?? true, actorId }));
      } catch (e) {
        if (isUniqueViolation(e, 'expense_types__tenant_id_lower_name__uq')) throw fail(['/name']);
        throw e;
      }
    },
    async updateType(ctx: BalanceCtx, i: { id: unknown; expectedVersion: number | undefined; body: unknown }) {
      const { tx, tenantId, actorId } = scope(ctx);
      const id = pathId(i.id, 'expense_type_id');
      if (!(await repo.getType(tx, tenantId, id))) throw notFound();
      if (i.expectedVersion === undefined) throw new LimsError('common.precondition_required');
      if (!Number.isSafeInteger(i.expectedVersion) || i.expectedVersion < 1) throw fail(['/If-Match']);
      const c = new Checker(isRec(i.body) ? i.body : {});
      bodyOf(c, i.body);
      c.only(['name', 'account_particular_id', 'is_active']);
      const name = c.text('name', 200);
      const particularId = c.uuid('account_particular_id');
      const isActive = c.bool('is_active');
      if (name === undefined && particularId === undefined && isActive === undefined && c.errors.length === 0) c.flag('');   // minProperties 1
      c.done();
      if (particularId !== undefined && !(await accounts.getParticular(tx, tenantId, particularId))) throw notFound();
      let row: Row | undefined;
      try {
        row = await repo.updateType(tx, { tenantId, id, version: i.expectedVersion, actorId, ...(name === undefined ? {} : { name }),
          ...(particularId === undefined ? {} : { particularId }), ...(isActive === undefined ? {} : { isActive }) });
      } catch (e) {
        if (isUniqueViolation(e, 'expense_types__tenant_id_lower_name__uq')) throw fail(['/name']);
        throw e;
      }
      if (!row) throw new LimsError('common.version_conflict');
      return typeDto(row);
    },

    // ------------------------------------------------ expenses
    /** done_when 2: the expense and its ONE debit entry commit together (same request transaction). */
    async createExpense(ctx: BalanceCtx, body: unknown) {
      const { tx, tenantId, actorId } = scope(ctx);
      const c = new Checker(isRec(body) ? body : {});
      bodyOf(c, body);
      c.only(['centre_id', 'expense_at', 'expense_type_id', 'amount_paisa', 'description']);
      const centreId = c.uuid('centre_id', true);
      const expenseAt = utc(c, 'expense_at', true);
      const typeId = c.uuid('expense_type_id', true);
      const amount = c.paisa('amount_paisa', maxEntry(), true);
      const description = c.text('description', 2000);
      c.done();
      if (!(await accounts.centreExists(tx, tenantId, centreId!))) throw notFound();
      const type = await repo.getType(tx, tenantId, typeId!);
      if (!type) throw notFound();
      if (type['is_active'] !== true) throw fail(['/expense_type_id']);
      const particular = await accounts.particularUsable(tx, tenantId, type['account_particular_id']);
      if (!particular?.active) throw fail(['/expense_type_id']);                 // the type's particular (or its group) is inactive
      const { tz } = await settings(ctx);
      const seq = await accounts.nextReceiptSeq(tx, tenantId);
      const entry = await post(ctx, tx, {
        tenantId, centreId: centreId!, partyKind: 'user_pocket', partyId: actorId, entryDate: localDate(expenseAt!, tz), particularId: type['account_particular_id'],
        entryType: 'debit', amountPaisa: amount!, paymentMode: 'cash', comments: null, reversesEntryId: null, actorId, seq,
      });
      return expenseDto(await repo.insertExpense(tx, { id: uuidv7(), tenantId, centreId: centreId!, expenseAt: expenseAt!, typeId: typeId!, amountPaisa: amount!,
        description: description ?? null, ledgerEntryId: entry['id'], actorId }));
    },
    async listExpenses(ctx: BalanceCtx, rawQuery: unknown) {
      const { tx, tenantId } = scope(ctx);
      const q = isRec(rawQuery) ? rawQuery : {};
      const limit = limitOf(q['limit']);
      const c = new Checker(q);
      c.only(['centre_id', 'expense_type_id', 'expense_at_from', 'expense_at_to', 'include_cancelled', 'cursor', 'limit']);
      const centreId = c.uuid('centre_id');
      const typeId = c.uuid('expense_type_id');
      const from = utc(c, 'expense_at_from');
      const to = utc(c, 'expense_at_to');
      const inc = c.bool('include_cancelled');
      if (from !== undefined && to !== undefined && from > to) c.flag('expense_at_from');
      c.done();
      const before = idCursor(q, 'expenses');
      const rows = await repo.listExpenses(tx, { tenantId, limit: limit + 1, includeCancelled: inc === true, ...(centreId ? { centreId } : {}), ...(typeId ? { typeId } : {}),
        ...(from ? { from } : {}), ...(to ? { to } : {}), ...(before ? { beforeId: before } : {}) });
      return page(rows, limit, 'expenses', expenseDto);
    },
    /** done_when 2: cancelled once (row lock + cancelled_at IS NULL guard); posts the reversal of the debit entry; the expense is never deleted. */
    async cancelExpense(ctx: BalanceCtx, i: { id: unknown; body: unknown }) {
      const { tx, tenantId, actorId } = scope(ctx);
      const id = pathId(i.id, 'expense_id');
      const c = new Checker(isRec(i.body) ? i.body : {});
      bodyOf(c, i.body, true);
      c.only(['reason_text']);
      const reason = c.text('reason_text', 500);
      c.done();
      const e = await repo.lockExpense(tx, tenantId, id);
      if (!e) throw notFound();
      if (e['cancelled_at'] != null) throw immutable();
      if (e['ledger_entry_id']) {
        const seq = await accounts.nextReceiptSeq(tx, tenantId);
        const orig = await accounts.getEntry(tx, tenantId, e['ledger_entry_id']);
        // [CONV] already reversed through reverseAccountLedgerEntry: the ledger is already net zero, so the cancel posts nothing more
        if (orig && orig['status'] !== 'reversed' && orig['reverses_entry_id'] == null) {
          const { tz } = await settings(ctx);
          await post(ctx, tx, {
            tenantId, centreId: orig['centre_id'], partyKind: orig['party_kind'], partyId: orig['party_id'], entryDate: localDate(nowIso(ctx), tz),
            particularId: orig['account_particular_id'], entryType: orig['entry_type'] === 'credit' ? 'debit' : 'credit', amountPaisa: toPaisa(orig['amount_paisa']),
            paymentMode: orig['payment_mode'], comments: reason ?? null, reversesEntryId: orig['id'], actorId, seq,
          });
        }
      }
      const row = await repo.cancelExpense(tx, { tenantId, id, at: nowIso(ctx), reason: reason ?? null, actorId });
      if (!row) throw immutable();
      return expenseDto(row);
    },

    // ------------------------------------------------ cash transfers
    async createTransfer(ctx: BalanceCtx, body: unknown) {
      const { tx, tenantId, actorId } = scope(ctx);
      const c = new Checker(isRec(body) ? body : {});
      bodyOf(c, body);
      c.only(['from_kind', 'from_id', 'to_kind', 'to_id', 'amount_paisa', 'remark']);
      const fromKind = c.oneOf('from_kind', KINDS, true);
      const fromId = c.uuid('from_id', true);
      const toKind = c.oneOf('to_kind', KINDS, true);
      const toId = c.uuid('to_id', true);
      const amount = c.paisa('amount_paisa', Number.MAX_SAFE_INTEGER, true);
      const remark = c.text('remark', 1000);
      if (fromKind !== undefined && fromKind === toKind && fromId !== undefined && fromId === toId) c.flag('to_id');    // from and to must differ
      c.done();
      if (!(await repo.endpointExists(tx, tenantId, fromKind!, fromId!))) throw notFound();
      if (!(await repo.endpointExists(tx, tenantId, toKind!, toId!))) throw notFound();
      await balanceOk(ctx, tx, tenantId, fromId!, amount!, (await settings(ctx)).allowNegative);
      return transferDto(await repo.insertTransfer(tx, { id: uuidv7(), tenantId, fromKind: fromKind!, fromId: fromId!, toKind: toKind!, toId: toId!, amountPaisa: amount!,
        remark: remark ?? null, actorId }));
    },
    async listTransfers(ctx: BalanceCtx, rawQuery: unknown) {
      const { tx, tenantId } = scope(ctx);
      const q = isRec(rawQuery) ? rawQuery : {};
      const limit = limitOf(q['limit']);
      const c = new Checker(q);
      c.only(['status', 'from_id', 'to_id', 'cursor', 'limit']);
      const status = c.oneOf('status', T_STATUSES);
      const fromId = c.uuid('from_id');
      const toId = c.uuid('to_id');
      c.done();
      const before = idCursor(q, 'cash_transfers');
      const rows = await repo.listTransfers(tx, { tenantId, limit: limit + 1, ...(status ? { status } : {}), ...(fromId ? { fromId } : {}), ...(toId ? { toId } : {}),
        ...(before ? { beforeId: before } : {}) });
      return page(rows, limit, 'cash_transfers', transferDto);
    },
    /** done_when 3: under the row lock and the tenant ledger lock: balance re-checked, then the balanced pair + the status change, one transaction. */
    async acceptTransfer(ctx: BalanceCtx, rawId: unknown) {
      const { tx, tenantId, actorId, t } = await lockFor(ctx, rawId, (row, a) => isReceiver(row, a, ctx));
      const particularId = await repo.particularByCode(tx, tenantId, TRANSFER_PARTICULAR);
      if (!particularId) throw fail(['/cash_transfer_id']);                       // the tenant has no CASH_TRANSFER particular configured
      const fallback = (ctx as { centreId?: unknown }).centreId;
      const centreId = t['to_kind'] === 'centre' ? t['to_id'] : t['from_kind'] === 'centre' ? t['from_id'] : fallback;
      if (typeof centreId !== 'string' || !UUID.test(centreId)) throw fail(['/cash_transfer_id']);
      const { tz, allowNegative } = await settings(ctx);
      const amount = toPaisa(t['amount_paisa']);
      const seq = await accounts.nextReceiptSeq(tx, tenantId);                     // tenant ledger lock: the balance read below is current
      await balanceOk(ctx, tx, tenantId, t['from_id'], amount, allowNegative);
      const at = nowIso(ctx);
      const base = { tenantId, centreId, partyKind: 'user_pocket', entryDate: localDate(at, tz), particularId, amountPaisa: amount, paymentMode: 'cash', comments: null, reversesEntryId: null, actorId };
      await post(ctx, tx, { ...base, partyId: t['from_id'], entryType: 'debit', seq });
      await post(ctx, tx, { ...base, partyId: t['to_id'], entryType: 'credit', seq: seq + 1 });
      const row = await repo.decideTransfer(tx, { tenantId, id: t['id'], status: 'accepted', at, actorId });
      if (!row) throw immutable();
      return transferDto(row);
    },
    async rejectTransfer(ctx: BalanceCtx, rawId: unknown) {
      const { tx, tenantId, actorId, t } = await lockFor(ctx, rawId, (row, a) => isReceiver(row, a, ctx));
      const row = await repo.decideTransfer(tx, { tenantId, id: t['id'], status: 'rejected', at: nowIso(ctx), actorId });
      if (!row) throw immutable();
      return transferDto(row);
    },
    /** Only the creator, the sending user or an administrator cancels, only while pending; nothing is posted. */
    async cancelTransfer(ctx: BalanceCtx, rawId: unknown) {
      const { tx, tenantId, actorId, t } = await lockFor(ctx, rawId, async (row, a) =>
        row['created_by'] === a || (row['from_kind'] === 'user' && row['from_id'] === a) || (await actorInfo(ctx)).roles.includes(ADMIN_ROLE));
      const row = await repo.decideTransfer(tx, { tenantId, id: t['id'], status: 'cancelled', at: nowIso(ctx), actorId });
      if (!row) throw immutable();
      return transferDto(row);
    },

    // ------------------------------------------------ daily collection summary
    async dailySummary(ctx: BalanceCtx, rawQuery: unknown) {
      const { tx, tenantId } = scope(ctx);
      const q = isRec(rawQuery) ? rawQuery : {};
      const c = new Checker(q);
      c.only(['centre_id', 'day']);
      const centreId = c.uuid('centre_id', true);
      const day = c.date('day', true);
      c.done();
      if (!(await accounts.centreExists(tx, tenantId, centreId!))) throw notFound();
      const rows = (await repo.dailyCollection(tx, { tenantId, centreId: centreId!, day: day! })).map((r) => ({
        payment_mode: r['payment_mode'] as string, entry_count: Number(r['entry_count']), total_paisa: toPaisa(r['total_paisa']),
      }));
      return { centre_id: centreId, day, rows, total_paisa: rows.reduce((s, r) => s + r.total_paisa, 0) };
    },
  };
}
export type ExpensesService = ReturnType<typeof createExpensesService>;
