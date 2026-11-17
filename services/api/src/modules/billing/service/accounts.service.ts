// T0B-ACCT-1 (LD-313, founder blanket authority LD-310) lab accounting: account groups and particulars, the append only accounting ledger with reversal,
// party statement and account summary (contracts/openapi/billing.yaml, T0C-ACCT-1). Records only: no money is moved.
// Tenant and actor come from ctx only; the body never decides tenant, status, receipt number, creator or reversal link. Every user value is validated
// here first (handlers are also called without the core pipeline) and then only ever a bound parameter.
// LD-313 (b): ledger entries are integers in paisa and append only; a correction is a reversal entry (opposite type, same amount / centre / party /
// particular, reverses_entry_id = the original) in the same transaction, once per entry; the original reads as 'reversed' (derived, never written).
// done_when 3: statement = one query for the opening balance + one for the rows (window function), exact integer (BigInt) running balance.
// done_when 6: nothing here logs; the free text columns (comments, bank_name, reference_no, payment_details) never reach a log line.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError, type FieldError } from '../../../core/errors.js';
import { loadBillingConfig } from '../config.js';
import { toPaisa } from '../domain/money/paisa.js';
import * as repo from '../repository/accounts.repo.js';
import type { BalanceCtx } from './balance.service.js';
import { DEFAULT_TZ, localDate } from './ledgerDto.js';
import { iso, isRec, limitOf, present, UUID } from './invoiceRead.service.js';

type Row = Record<string, any>;
type Tx = Parameters<typeof repo.getGroup>[0];

const NATURES = ['income', 'expense', 'asset', 'liability'] as const;
const PARTY_KINDS = ['credit_party', 'franchise', 'user_pocket', 'laboratory'] as const;
const ENTRY_TYPES = ['credit', 'debit'] as const;
const STATUSES = ['submitted', 'approved', 'rejected', 'reversed'] as const;
const CODE = /^[A-Z0-9_]{1,32}$/;
const PAYMENT_MODE = /^[a-z][a-z0-9_]{0,49}$/;
const CARD_RUN = /[0-9]{13}/;                                   // contract pattern: never a 13+ digit run (card number, REQ-SEC-056)
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;
/** [CONV] payment modes that need the bank fields; cash carries none; any other mode may carry them. */
const BANK_MODES = new Set(['bank_transfer', 'cheque']);
const STATEMENT_MAX_ROWS = 1000;                                // contract: more rows -> common.validation_failed (narrow the range)
const RECEIPT_PREFIX = 'ACC-';                                  // contract example ACC-000001

// ---------------------------------------------------------------- validation helpers (400 with a JSON pointer, no value echoed)
const fail = (paths: string[]): LimsError =>
  new LimsError('common.validation_failed', undefined, paths.map((path): FieldError => ({ path, code: 'common.field_invalid', message: 'Field invalid' })));
const unknownField = (k: string): FieldError => ({ path: `/${k}`, code: 'common.unknown_field', message: 'Unknown field' });
const requiredField = (k: string): FieldError => ({ path: `/${k}`, code: 'common.field_required', message: 'Field required' });

class Checker {
  readonly errors: FieldError[] = [];
  readonly src: Row;
  constructor(src: Row) { this.src = src; }
  private bad(k: string) { this.errors.push({ path: `/${k}`, code: 'common.field_invalid', message: 'Field invalid' }); return undefined; }
  only(keys: readonly string[]) { for (const k of Object.keys(this.src)) if (!keys.includes(k)) this.errors.push(unknownField(k)); return this; }
  has(k: string, required: boolean): boolean {
    if (this.src[k] !== undefined) return true;
    if (required) this.errors.push(requiredField(k));
    return false;
  }
  text(k: string, max: number, required = false, re?: RegExp, forbid?: RegExp): string | undefined {
    if (!this.has(k, required)) return undefined;
    const v = this.src[k];
    if (typeof v !== 'string' || v.length < 1 || v.length > max || (re && !re.test(v)) || (forbid && forbid.test(v))) return this.bad(k);
    return v;
  }
  oneOf<T extends string>(k: string, set: readonly T[], required = false): T | undefined {
    if (!this.has(k, required)) return undefined;
    return set.includes(this.src[k]) ? this.src[k] : this.bad(k);
  }
  uuid(k: string, required = false): string | undefined {
    if (!this.has(k, required)) return undefined;
    const v = this.src[k];
    return typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : this.bad(k);
  }
  bool(k: string, required = false): boolean | undefined {
    if (!this.has(k, required)) return undefined;
    const v = this.src[k];
    if (typeof v === 'boolean') return v;
    if (v === 'true' || v === 'false') return v === 'true';
    return this.bad(k);
  }
  date(k: string, required = false): string | undefined {
    if (!this.has(k, required)) return undefined;
    const v = this.src[k];
    return isCalendarDate(v) ? v : this.bad(k);
  }
  /** integer paisa, 1..max; a number only (never a string, a float or null). */
  paisa(k: string, max: number, required = false): number | undefined {
    if (!this.has(k, required)) return undefined;
    const v = this.src[k];
    return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= max ? v : this.bad(k);
  }
  flag(k: string) { return this.bad(k); }
  done() { if (this.errors.length > 0) throw new LimsError('common.validation_failed', undefined, this.errors); }
}

function isCalendarDate(v: unknown): v is string {
  if (typeof v !== 'string' || !ISO_DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
const addDays = (date: string, n: number): string => new Date(Date.parse(`${date}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);

function scope(ctx: BalanceCtx): { tx: Tx; tenantId: string; actorId: string } {
  if (typeof ctx?.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
  return { tx: ctx.tx as Tx, tenantId: ctx.tenantId, actorId: ctx.actor.id };
}
const notFound = (): LimsError => new LimsError('common.not_found');
const pathId = (v: unknown, k: string): string => { if (typeof v !== 'string' || !UUID.test(v)) throw fail([`/${k}`]); return v.toLowerCase(); };
const isUniqueViolation = (e: unknown, constraint?: string): boolean =>
  isRec(e) && e['code'] === '23505' && (constraint === undefined || e['constraint'] === constraint);

// ---------------------------------------------------------------- cursors: base64url(JSON [sort, key])
const encode = (sort: string, key: string | number): string => Buffer.from(JSON.stringify([sort, key]), 'utf8').toString('base64url');
function decode<T extends string | number>(raw: unknown, sort: string, ok: (k: unknown) => boolean): T {
  const invalid = () => new LimsError('common.invalid_cursor');
  if (typeof raw !== 'string' || !CURSOR.test(raw)) throw invalid();
  let v: unknown;
  try { v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { throw invalid(); }
  if (!Array.isArray(v) || v.length !== 2 || v[0] !== sort || !ok(v[1])) throw invalid();
  return v[1] as T;
}
const codeCursor = (q: Row, sort: string): string | undefined => (q['cursor'] === undefined ? undefined : decode<string>(q['cursor'], sort, (k) => typeof k === 'string' && CODE.test(k)));

// ---------------------------------------------------------------- DTOs (money as safe integers, optional keys omitted, dates as text)
const versionOf = (v: unknown): number => Number(v);
const groupDto = (r: Row) => ({
  id: r['id'], code: r['code'], name: r['name'], nature: r['nature'], is_active: r['is_active'] === true, version: versionOf(r['version']),
  created_at: iso(r['created_at']), updated_at: iso(r['updated_at']),
});
const particularDto = (r: Row) => ({
  id: r['id'], account_group_id: r['account_group_id'], code: r['code'], name: r['name'], is_active: r['is_active'] === true, version: versionOf(r['version']),
  created_at: iso(r['created_at']), updated_at: iso(r['updated_at']),
});
export const entryDto = (r: Row) => present({
  id: r['id'], centre_id: r['centre_id'], party_kind: r['party_kind'], party_id: r['party_id'], entry_date: r['entry_date'], account_particular_id: r['account_particular_id'],
  entry_type: r['entry_type'], amount_paisa: toPaisa(r['amount_paisa']), payment_mode: r['payment_mode'], bank_name: r['bank_name'], reference_no: r['reference_no'],
  payment_details: r['payment_details'], comments: r['comments'], status: r['status'], reverses_entry_id: r['reverses_entry_id'], receipt_no: r['receipt_no'],
  created_by: r['created_by'], last_modified_by: r['last_modified_by'], created_at: iso(r['created_at']),
});
/** A signed BigInt balance as the contract's non-negative amount + side (credit when >= 0). */
const sided = (b: bigint): { paisa: number; side: 'credit' | 'debit' } => ({ paisa: toPaisa(String(b < 0n ? -b : b)), side: b < 0n ? 'debit' : 'credit' });

// ---------------------------------------------------------------- service
export interface AccountsDeps { readonly maxEntryPaisa?: number }

export function createAccountsService(deps: AccountsDeps = {}) {
  const maxEntry = () => deps.maxEntryPaisa ?? loadBillingConfig().accountEntryMaxPaisa;

  async function today(ctx: BalanceCtx): Promise<string> {
    const idp = ctx.ports?.IdentityPort;
    const s = idp ? await idp.getTenantSettings(ctx, { keys: ['timezone'] }) : undefined;
    const tz = typeof s?.timezone === 'string' && s.timezone !== '' ? s.timezone : DEFAULT_TZ;
    return localDate(iso((ctx.now as () => unknown)()), tz);
  }

  /** Optimistic update shared by both masters: 428 without If-Match, 400 malformed, 404 unknown / other tenant, 409 stale. */
  async function patchMaster(ctx: BalanceCtx, i: { id: unknown; idKey: string; expectedVersion: number | undefined; body: unknown },
    get: (tx: Tx, t: string, id: string) => Promise<Row | undefined>, update: (tx: Tx, a: any) => Promise<Row | undefined>) {
    const { tx, tenantId, actorId } = scope(ctx);
    const id = pathId(i.id, i.idKey);
    if (!(await get(tx, tenantId, id))) throw notFound();                                          // the path resource first: an unknown / other tenant id is 404
    if (i.expectedVersion === undefined) throw new LimsError('common.precondition_required');
    if (!Number.isSafeInteger(i.expectedVersion) || i.expectedVersion < 1) throw fail(['/If-Match']);
    const c = new Checker(isRec(i.body) ? i.body : {});
    if (!isRec(i.body)) c.flag('');
    c.only(['name', 'is_active']);
    const name = c.text('name', 200);
    const isActive = c.bool('is_active');
    if (name === undefined && isActive === undefined && c.errors.length === 0) c.flag('');       // minProperties 1
    c.done();
    const row = await update(tx, { tenantId, id, version: i.expectedVersion, actorId, ...(name === undefined ? {} : { name }), ...(isActive === undefined ? {} : { isActive }) });
    if (row) return row;
    throw new LimsError('common.version_conflict');
  }

  return {
    // ------------------------------------------------ account groups
    async listGroups(ctx: BalanceCtx, rawQuery: unknown) {
      const { tx, tenantId } = scope(ctx);
      const q = isRec(rawQuery) ? rawQuery : {};
      const limit = limitOf(q['limit']);
      const c = new Checker(q);
      const nature = c.oneOf('nature', NATURES);
      const isActive = c.bool('is_active');
      c.done();
      const after = codeCursor(q, 'account_groups');
      const rows = await repo.listGroups(tx, { tenantId, limit: limit + 1, ...(nature ? { nature } : {}), ...(isActive === undefined ? {} : { isActive }), ...(after ? { afterCode: after } : {}) });
      const data = rows.slice(0, limit);
      return { data: data.map(groupDto), page: { limit, ...(rows.length > limit ? { next_cursor: encode('account_groups', data[data.length - 1]!['code']) } : {}) } };
    },
    async createGroup(ctx: BalanceCtx, body: unknown) {
      const { tx, tenantId, actorId } = scope(ctx);
      const c = new Checker(isRec(body) ? body : {});
      if (!isRec(body)) c.flag('');
      c.only(['code', 'name', 'nature', 'is_active']);
      const code = c.text('code', 32, true, CODE);
      const name = c.text('name', 200, true);
      const nature = c.oneOf('nature', NATURES, true);
      const isActive = c.bool('is_active');
      c.done();
      try {
        return groupDto(await repo.insertGroup(tx, { id: uuidv7(), tenantId, code: code!, name: name!, nature: nature!, isActive: isActive ?? true, actorId }));
      } catch (e) {
        if (isUniqueViolation(e, 'account_groups__tenant_id_code__uq')) throw fail(['/code']);       // contract: duplicate code -> common.validation_failed
        throw e;
      }
    },
    async updateGroup(ctx: BalanceCtx, i: { id: unknown; expectedVersion: number | undefined; body: unknown }) {
      return groupDto(await patchMaster(ctx, { ...i, idKey: 'account_group_id' }, repo.getGroup, repo.updateGroup));
    },

    // ------------------------------------------------ account particulars
    async listParticulars(ctx: BalanceCtx, rawQuery: unknown) {
      const { tx, tenantId } = scope(ctx);
      const q = isRec(rawQuery) ? rawQuery : {};
      const limit = limitOf(q['limit']);
      const c = new Checker(q);
      const groupId = c.uuid('account_group_id');
      const isActive = c.bool('is_active');
      c.done();
      const after = codeCursor(q, 'account_particulars');
      const rows = await repo.listParticulars(tx, { tenantId, limit: limit + 1, ...(groupId ? { groupId } : {}), ...(isActive === undefined ? {} : { isActive }), ...(after ? { afterCode: after } : {}) });
      const data = rows.slice(0, limit);
      return { data: data.map(particularDto), page: { limit, ...(rows.length > limit ? { next_cursor: encode('account_particulars', data[data.length - 1]!['code']) } : {}) } };
    },
    async createParticular(ctx: BalanceCtx, body: unknown) {
      const { tx, tenantId, actorId } = scope(ctx);
      const c = new Checker(isRec(body) ? body : {});
      if (!isRec(body)) c.flag('');
      c.only(['account_group_id', 'code', 'name', 'is_active']);
      const groupId = c.uuid('account_group_id', true);
      const code = c.text('code', 32, true, CODE);
      const name = c.text('name', 200, true);
      const isActive = c.bool('is_active');
      c.done();
      if (!(await repo.getGroup(tx, tenantId, groupId!))) throw notFound();                          // contract: unknown group -> common.not_found
      try {
        return particularDto(await repo.insertParticular(tx, { id: uuidv7(), tenantId, groupId: groupId!, code: code!, name: name!, isActive: isActive ?? true, actorId }));
      } catch (e) {
        if (isUniqueViolation(e, 'account_particulars__tenant_id_code__uq')) throw fail(['/code']);
        throw e;
      }
    },
    async updateParticular(ctx: BalanceCtx, i: { id: unknown; expectedVersion: number | undefined; body: unknown }) {
      return particularDto(await patchMaster(ctx, { ...i, idKey: 'account_particular_id' }, repo.getParticular, repo.updateParticular));
    },

    // ------------------------------------------------ ledger entries (append only)
    async createEntry(ctx: BalanceCtx, body: unknown) {
      const { tx, tenantId, actorId } = scope(ctx);
      const c = new Checker(isRec(body) ? body : {});
      if (!isRec(body)) c.flag('');
      c.only(['centre_id', 'party_kind', 'party_id', 'entry_date', 'account_particular_id', 'entry_type', 'amount_paisa', 'payment_mode', 'bank_name', 'reference_no', 'payment_details', 'comments']);
      const centreId = c.uuid('centre_id', true);
      const partyKind = c.oneOf('party_kind', PARTY_KINDS, true);
      const partyId = c.uuid('party_id', true);
      const entryDate = c.date('entry_date', true);
      const particularId = c.uuid('account_particular_id', true);
      const entryType = c.oneOf('entry_type', ENTRY_TYPES, true);
      const amount = c.paisa('amount_paisa', maxEntry(), true);
      const mode = c.text('payment_mode', 50, true, PAYMENT_MODE);
      const bankName = c.text('bank_name', 200);
      const referenceNo = c.text('reference_no', 100, false, undefined, CARD_RUN);
      const details = c.text('payment_details', 1000, false, undefined, CARD_RUN);
      const comments = c.text('comments', 2000);
      // done_when 5: bank fields only when the payment mode needs them
      if (mode === 'cash') for (const k of ['bank_name', 'reference_no', 'payment_details']) if (isRec(body) && body[k] !== undefined) c.flag(k);
      if (mode !== undefined && BANK_MODES.has(mode) && isRec(body) && body['bank_name'] === undefined) c.errors.push(requiredField('bank_name'));
      c.done();
      // done_when 5: entry_date at most 1 day after today in the tenant time zone
      if (entryDate! > addDays(await today(ctx), 1)) throw fail(['/entry_date']);
      if (!(await repo.centreExists(tx, tenantId, centreId!))) throw notFound();
      const particular = await repo.particularUsable(tx, tenantId, particularId!);
      if (!particular) throw notFound();
      if (!particular.active) throw fail(['/account_particular_id']);                               // inactive particular or inactive group
      if (!(await repo.findParty(tx, tenantId, partyKind!, partyId!))) throw notFound();
      // contract: credit limit and blocked party are NOT enforced here (records only)
      const seq = await repo.nextReceiptSeq(tx, tenantId);
      const row = await repo.insertEntry(tx, {
        id: uuidv7(), tenantId, centreId: centreId!, partyKind: partyKind!, partyId: partyId!, entryDate: entryDate!, particularId: particularId!, entryType: entryType!,
        amountPaisa: amount!, paymentMode: mode!, bankName: bankName ?? null, referenceNo: referenceNo ?? null, paymentDetails: details ?? null, comments: comments ?? null,
        reversesEntryId: null, receiptNo: receiptNoOf(seq), receiptSeq: seq, actorId,
      });
      return entryDto(row);
    },

    async getEntry(ctx: BalanceCtx, rawId: unknown) {
      const { tx, tenantId } = scope(ctx);
      const row = await repo.getEntry(tx, tenantId, pathId(rawId, 'account_ledger_entry_id'));
      if (!row) throw notFound();
      return entryDto(row);
    },

    async listEntries(ctx: BalanceCtx, rawQuery: unknown) {
      const { tx, tenantId } = scope(ctx);
      const q = isRec(rawQuery) ? rawQuery : {};
      const limit = limitOf(q['limit']);
      const c = new Checker(q);
      const f: repo.EntryFilter = { tenantId, limit: limit + 1 };
      const set = <K extends keyof repo.EntryFilter>(k: K, v: repo.EntryFilter[K] | undefined) => { if (v !== undefined) f[k] = v; };
      set('centreId', c.uuid('centre_id')); set('partyKind', c.oneOf('party_kind', PARTY_KINDS)); set('partyId', c.uuid('party_id'));
      set('particularId', c.uuid('account_particular_id')); set('entryType', c.oneOf('entry_type', ENTRY_TYPES)); set('status', c.oneOf('status', STATUSES));
      set('dateFrom', c.date('entry_date_from')); set('dateTo', c.date('entry_date_to'));
      if (f.dateFrom !== undefined && f.dateTo !== undefined && f.dateFrom > f.dateTo) c.flag('entry_date_from');
      c.done();
      if (q['cursor'] !== undefined) f.beforeSeq = decode<number>(q['cursor'], 'account_ledger_entries', (k) => Number.isSafeInteger(k) && (k as number) > 0);
      const rows = await repo.listEntries(tx, f);
      const data = rows.slice(0, limit);
      return { data: data.map(entryDto), page: { limit, ...(rows.length > limit ? { next_cursor: encode('account_ledger_entries', Number(data[data.length - 1]!['receipt_seq'])) } : {}) } };
    },

    /** LD-313 (b), done_when 2: one opposite entry linked by reverses_entry_id, in the request transaction; never twice, never a reversal of a reversal. */
    async reverseEntry(ctx: BalanceCtx, i: { id: unknown; body: unknown }) {
      const { tx, tenantId, actorId } = scope(ctx);
      const id = pathId(i.id, 'account_ledger_entry_id');
      const c = new Checker(isRec(i.body) ? i.body : {});
      if (!isRec(i.body)) c.flag('');
      c.only(['reason_text']);
      const reason = c.text('reason_text', 500, true);
      c.done();
      const today0 = await today(ctx);
      // The tenant receipt lock is taken BEFORE the original is read: every ledger insert of the tenant is serialised by it, so a concurrent reversal of the
      // same entry is committed (and seen by the read below) before this one proceeds -> 409, never a second row.
      if (!(await repo.getEntry(tx, tenantId, id))) throw notFound();
      const seq = await repo.nextReceiptSeq(tx, tenantId);
      const orig = await repo.getEntry(tx, tenantId, id);                                          // re-read under the lock (derived status is current)
      if (!orig) throw notFound();
      if (orig['reverses_entry_id'] != null || orig['status'] === 'reversed') throw new LimsError('billing.ledger_reversal_invalid');
      try {
        const row = await repo.insertEntry(tx, {
          id: uuidv7(), tenantId, centreId: orig['centre_id'], partyKind: orig['party_kind'], partyId: orig['party_id'],
          entryDate: today0,                                                                            // [CONV] a correction is dated the day it is made; the original period stays as posted
          particularId: orig['account_particular_id'], entryType: orig['entry_type'] === 'credit' ? 'debit' : 'credit', amountPaisa: toPaisa(orig['amount_paisa']),
          paymentMode: orig['payment_mode'], bankName: orig['bank_name'] ?? null, referenceNo: orig['reference_no'] ?? null, paymentDetails: orig['payment_details'] ?? null,
          comments: reason!,                                                                            // contract example: the reversal's comments carry reason_text
          reversesEntryId: id, receiptNo: receiptNoOf(seq), receiptSeq: seq, actorId,
        });
        return entryDto(row);
      } catch (e) {
        if (isUniqueViolation(e, 'account_ledger_entries__tenant_id_reverses__uq')) throw new LimsError('billing.ledger_reversal_invalid');
        throw e;
      }
    },

    // ------------------------------------------------ statement / summary
    async statement(ctx: BalanceCtx, rawQuery: unknown) {
      const { tx, tenantId } = scope(ctx);
      const q = isRec(rawQuery) ? rawQuery : {};
      const c = new Checker(q);
      const partyKind = c.oneOf('party_kind', PARTY_KINDS, true);
      const partyId = c.uuid('party_id', true);
      const from = c.date('from', true);
      const to = c.date('to', true);
      if (from !== undefined && to !== undefined && from > to) c.flag('from');
      c.done();
      if (!(await repo.findParty(tx, tenantId, partyKind!, partyId!))) throw notFound();
      const p = { tenantId, partyKind: partyKind!, partyId: partyId! };
      const opening = BigInt(await repo.openingBalance(tx, { ...p, from: from! }));
      const rows = await repo.statementRows(tx, { ...p, from: from!, to: to!, limit: STATEMENT_MAX_ROWS + 1 });
      if (rows.length > STATEMENT_MAX_ROWS) throw fail(['/from']);                                  // contract: narrow the range
      let credit = 0n, debit = 0n, closing = opening;
      const out = rows.map((r) => {
        const amount = BigInt(r['amount_paisa']);
        if (r['entry_type'] === 'credit') credit += amount; else debit += amount;
        closing = opening + BigInt(r['running']);
        const bal = sided(closing);
        return present({
          entry_id: r['id'], entry_date: r['entry_date'], receipt_no: r['receipt_no'], entry_type: r['entry_type'], account_particular_id: r['account_particular_id'],
          reverses_entry_id: r['reverses_entry_id'], status: r['status'],
          credit_paisa: r['entry_type'] === 'credit' ? toPaisa(r['amount_paisa']) : 0, debit_paisa: r['entry_type'] === 'debit' ? toPaisa(r['amount_paisa']) : 0,
          balance_paisa: bal.paisa, balance_side: bal.side,
        });
      });
      const o = sided(opening), cl = sided(closing);
      return {
        party_kind: partyKind, party_id: partyId, from, to, opening_balance_paisa: o.paisa, opening_balance_side: o.side, rows: out,
        closing_balance_paisa: cl.paisa, closing_balance_side: cl.side, total_credit_paisa: toPaisa(String(credit)), total_debit_paisa: toPaisa(String(debit)),
      };
    },

    async summary(ctx: BalanceCtx, rawQuery: unknown) {
      const { tx, tenantId } = scope(ctx);
      const q = isRec(rawQuery) ? rawQuery : {};
      const c = new Checker(q);
      const partyKind = c.oneOf('party_kind', PARTY_KINDS, true);
      const partyId = c.uuid('party_id', true);
      c.done();
      const party = await repo.findParty(tx, tenantId, partyKind!, partyId!);
      if (!party) throw notFound();
      const out = sided(BigInt(await repo.outstanding(tx, { tenantId, partyKind: partyKind!, partyId: partyId! })));
      // contract AccountSummary: limit 0 = no limit set; other party kinds have limit 0 and is_blocked false
      return {
        party_kind: partyKind, party_id: partyId, credit_limit_paisa: party.creditLimitPaisa === null ? 0 : toPaisa(party.creditLimitPaisa),
        outstanding_paisa: out.paisa, outstanding_side: out.side, is_blocked: party.isLocked,
      };
    },
  };
}
export type AccountsService = ReturnType<typeof createAccountsService>;

/** done_when 4: 'ACC-' + receipt_seq padded to 6 digits (more digits once the tenant passes 999999). */
const receiptNoOf = (seq: number): string => `${RECEIPT_PREFIX}${String(seq).padStart(6, '0')}`;
