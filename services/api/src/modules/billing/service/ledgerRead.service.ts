// B11 listLedgerEntries, B16 listDues, B18 getDailyCash (02-TRD §5; openapi LedgerEntryPage / DuePage / DailyCash; PRD US-BL-11.1/.3; REQ-SEC-040).
// Read-only. Tenant and actor come from ctx only; every user value is validated first and then only ever a bound parameter.
// B18 groups the day's raw ledger rows in code, so the grid is exactly the ledger: entries = payments, reversals = reversal + refund rows
// (as billing.v_pub_payment_collection), gross = Σ payments, reversed = |Σ reversals + refunds|, net = gross - reversed. home_collection and B22 rows (no session) are in.
// [CONV] Gateway rows (collected_by NULL, 08 R8) are left out until CR-C4-BL08-003 is ruled (DailyCash rows need an Actor).
import { LimsError } from '../../../core/errors.js';
import { moneyOf, toPaisa } from '../domain/money/paisa.js';
import { billingRepo, type BillingRepo } from '../repository/index.js';
import type { BalanceCtx } from './balance.service.js';
import { bsText, cashSessionDto, DEFAULT_TZ, ledgerEntryDto, localDate, names } from './ledgerDto.js';
import { bad, decodeCursor, encodeCursor, isRec, iso, limitOf, STAFF_DISPLAY, UTC_INSTANT, uuid } from './invoiceRead.service.js';

type ReadRepo = Pick<BillingRepo, 'pageLedger' | 'listDues' | 'listLedgerForDay' | 'listCashSessionsForDay'>;
const ENTRY_KINDS = ['payment', 'reversal', 'refund'];
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function scope(ctx: BalanceCtx): { tx: never; tenantId: string } {
  if (typeof ctx?.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
  return { tx: ctx.tx as never, tenantId: ctx.tenantId };
}
const optUuid = (q: Record<string, any>, k: string): string | undefined => (q[k] === undefined ? undefined : uuid(q[k], `/${k}`));
function optInt(q: Record<string, any>, k: string, max: number): number | undefined {
  const raw = q[k];
  if (raw === undefined) return undefined;
  const n = typeof raw === 'string' && /^[0-9]{1,16}$/.test(raw) ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0 || n > max) throw bad(`/${k}`);
  return n;
}
function optInstant(q: Record<string, any>, k: string): string | undefined {
  const v = q[k];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !UTC_INSTANT.test(v) || Number.isNaN(Date.parse(v))) throw bad(`/${k}`);
  return v;
}
/** A real calendar date: 2026-13-45 and 2026-02-30 are refused. */
function isoDate(v: string): boolean {
  const m = ISO_DATE.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.getUTCFullYear() === +m[1]! && d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]!;
}

export function createLedgerReadService(deps: { repo?: ReadRepo } = {}) {
  const db = deps.repo ?? billingRepo;

  async function listLedgerEntries(ctx: BalanceCtx, rawQuery: unknown) {
    const { tx, tenantId } = scope(ctx);
    const q = isRec(rawQuery) ? rawQuery : {};
    const limit = limitOf(q['limit']);
    const after = q['cursor'] === undefined ? undefined : decodeCursor(q['cursor'], '-created_at', 'time');
    const collectedBy = optUuid(q, 'collected_by_membership_id');
    const centreId = optUuid(q, 'centre_id');
    const methodCode = q['method_code'];
    if (methodCode !== undefined && (typeof methodCode !== 'string' || methodCode.length < 1 || methodCode.length > 64)) throw bad('/method_code');
    const entryKind = q['entry_kind'];
    if (entryKind !== undefined && (typeof entryKind !== 'string' || !ENTRY_KINDS.includes(entryKind))) throw bad('/entry_kind');
    const from = optInstant(q, 'created_at_from');
    const to = optInstant(q, 'created_at_to');
    if (from !== undefined && to !== undefined && Date.parse(from) > Date.parse(to)) throw bad('/created_at_from');
    const rows = await db.pageLedger(tx, {
      tenantId, limit: limit + 1, ...(after === undefined ? {} : { after: { value: String(after.value), id: after.id } }),
      ...(collectedBy === undefined ? {} : { collectedBy }), ...(centreId === undefined ? {} : { centreId }), ...(methodCode === undefined ? {} : { methodCode }),
      ...(entryKind === undefined ? {} : { entryKind }), ...(from === undefined ? {} : { createdFrom: from }), ...(to === undefined ? {} : { createdTo: to }),
    });
    const data = rows.slice(0, limit);
    const last = data[data.length - 1];
    const page: { limit: number; next_cursor?: string } = { limit };
    // ponytail: the cursor carries created_at at ms precision and the query orders by the same ms-truncated key, so no row is skipped; two rows in one ms are ordered by id.
    if (rows.length > limit && last) page.next_cursor = encodeCursor('-created_at', iso(last['created_at']), String(last['id']));
    const display = await names(ctx, data.map((r) => r['collected_by_membership_id']));
    return { data: data.map((r) => ledgerEntryDto(r, display)), page };
  }

  async function listDues(ctx: BalanceCtx, rawQuery: unknown) {
    const { tx, tenantId } = scope(ctx);
    const q = isRec(rawQuery) ? rawQuery : {};
    const limit = limitOf(q['limit']);
    const after = q['cursor'] === undefined ? undefined : decodeCursor(q['cursor'], 'oldest_invoice_at', 'time');
    const centreId = optUuid(q, 'centre_id');
    const minDuePaisa = optInt(q, 'min_due_paisa', Number.MAX_SAFE_INTEGER);
    const olderThanDays = optInt(q, 'older_than_days', 3650);
    const rows = await db.listDues(tx, {
      tenantId, now: ctx.now(), limit: limit + 1, ...(after === undefined ? {} : { after: { value: String(after.value), id: after.id } }),
      ...(centreId === undefined ? {} : { centreId }), ...(minDuePaisa === undefined ? {} : { minDuePaisa }), ...(olderThanDays === undefined ? {} : { olderThanDays }),
    });
    const data = rows.slice(0, limit);
    const last = data[data.length - 1];
    const page: { limit: number; next_cursor?: string } = { limit };
    if (rows.length > limit && last) page.next_cursor = encodeCursor('oldest_invoice_at', iso(last['oldest_invoice_at']), String(last['order_id']));
    return {
      data: data.map((r) => ({
        order_id: r['order_id'], registration_no: r['registration_no'], patient_display: r['patient_display'], centre_id: r['centre_id'],
        invoiced: moneyOf(toPaisa(r['invoiced_paisa'])), paid: moneyOf(toPaisa(r['paid_paisa'])), credited: moneyOf(toPaisa(r['credited_paisa'])),
        balance_due: moneyOf(toPaisa(r['balance_due_paisa'])), oldest_invoice_at: iso(r['oldest_invoice_at']),
      })),
      page,
    };
  }

  async function getDailyCash(ctx: BalanceCtx, rawQuery: unknown) {
    const { tx, tenantId } = scope(ctx);
    const q = isRec(rawQuery) ? rawQuery : {};
    const centreId = optUuid(q, 'centre_id');
    const collectedBy = optUuid(q, 'collected_by_membership_id');
    if (q['business_date'] !== undefined && (typeof q['business_date'] !== 'string' || !isoDate(q['business_date']))) throw bad('/business_date');
    const tenant = await ctx.ports?.IdentityPort?.getTenantSettings(ctx, { keys: ['timezone'] });
    const timezone: string = typeof tenant?.timezone === 'string' ? tenant.timezone : DEFAULT_TZ;
    const businessDate: string = q['business_date'] ?? localDate(ctx.now(), timezone);

    const ledger = await db.listLedgerForDay(tx, { tenantId, businessDate, ...(centreId === undefined ? {} : { centreId }), ...(collectedBy === undefined ? {} : { collectedBy }) });
    const sessions = await db.listCashSessionsForDay(tx, {
      tenantId, businessDate, timezone, ...(centreId === undefined ? {} : { centreId }), ...(collectedBy === undefined ? {} : { membershipId: collectedBy }),
    });

    const groups = new Map<string, { who: string; method: string; entries: number; reversals: number; gross: number; reversed: number }>();
    for (const r of ledger) {
      const who = String(r['collected_by_membership_id']), method = String(r['method_code']), amount = toPaisa(r['amount_paisa']);
      const g = groups.get(who + '|' + method) ?? { who, method, entries: 0, reversals: 0, gross: 0, reversed: 0 };
      if (r['entry_kind'] === 'payment') { g.entries += 1; g.gross += amount; }
      else if (r['entry_kind'] === 'reversal' || r['entry_kind'] === 'refund') { g.reversals += 1; g.reversed += Math.abs(amount); }
      groups.set(who + '|' + method, g);
    }
    const display = await names(ctx, [...ledger.map((r) => r['collected_by_membership_id']), ...sessions.map((s) => s['membership_id'])]);
    const list = [...groups.values()].sort((a, b) => (a.who + a.method < b.who + b.method ? -1 : 1));
    const sum = (f: (g: (typeof list)[number]) => number) => list.reduce((t, g) => t + f(g), 0);
    return {
      business_date: businessDate, business_date_bs: bsText(businessDate),
      rows: list.map((g) => ({
        collected_by: { membership_id: g.who, display_name: display.get(g.who) ?? STAFF_DISPLAY }, method_code: g.method, entries: g.entries, reversals: g.reversals,
        gross: moneyOf(g.gross), reversed: moneyOf(g.reversed), net: moneyOf(g.gross - g.reversed),
      })),
      totals: { gross: moneyOf(sum((g) => g.gross)), reversed: moneyOf(sum((g) => g.reversed)), net: moneyOf(sum((g) => g.gross - g.reversed)) },
      sessions: sessions.map((s) => cashSessionDto(s, display)),
    };
  }
  return { listLedgerEntries, listDues, getDailyCash };
}
export type LedgerReadService = ReturnType<typeof createLedgerReadService>;
