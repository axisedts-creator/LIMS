// B19 listCreditAccounts / getCreditAccount / updateCreditAccount, B20 listCreditCharges, B21 issuePeriodicInvoice, B22 recordCreditPartyPayment, B23 getCreditPartyStatement (02-TRD §5).
// Schema, auth, x-permission (billing.credit_party.read / .manage [privileged] / billing.payment.record) and Idempotency-Key presence are enforced by the core pipeline from
// contracts/openapi/billing.yaml; these map request -> service and fail closed without an authenticated request context. Bodies never carry tenant or collector.
import { LimsError } from '../../../core/errors.js';
import { createEvents } from '../../../core/events/publish.js';
import type { Handler, HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import { moneyOf, toPaisa } from '../domain/money/paisa.js';
import { createBillingEvents } from '../events/publish.js';
import type { BalanceCtx } from '../service/balance.service.js';
import { createCounterService } from '../service/counter.service.js';
import { createCreditService, type CreditService } from '../service/credit.service.js';
import { dateText, ledgerEntryDto, names } from '../service/ledgerDto.js';
import { createInvoiceReadService, decodeCursor, encodeCursor, iso, present } from '../service/invoiceRead.service.js';
import { ifMatch } from './settings.handlers.js';

type Row = Record<string, any>;
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});
let svc: CreditService | undefined;
const service = (): CreditService => (svc ??= createCreditService({ counter: createCounterService() as never, events: createBillingEvents(createEvents({ producer: 'billing' }) as never) }));

function bind(status: number, fn: (s: CreditService, ctx: BalanceCtx, req: HandlerRequest) => Promise<{ body: unknown; version?: number }>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> => {
    const c = hctx as unknown as Partial<BalanceCtx>;
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    const out = await fn(service(), c as BalanceCtx, req);
    return { status, body: out.body, ...(out.version === undefined ? {} : { headers: { etag: `"${out.version}"` } }) };
  };
}

/** CreditAccountDto: id = credit_party_id; party snapshot columns other than the name stay internal. */
const accountDto = (a: Row) => present({
  id: a['credit_party_id'], name: a['party_display_name'], credit_limit_paisa: a['credit_limit_paisa'] == null ? undefined : toPaisa(a['credit_limit_paisa']),
  credit_days: a['credit_days'], is_locked: a['is_locked'], lock_reason_code: a['lock_reason_code'], outstanding: moneyOf(a['outstandingPaisa']), version: Number(a['version']),
});
const chargeDto = (c: Row) => present({
  id: c['id'], credit_party_id: c['credit_party_id'], order_id: c['order_id'], invoice_id: c['invoice_id'], amount: moneyOf(toPaisa(c['gross_paisa']) - toPaisa(c['discount_paisa'])),
  period_month: dateText(c['period_month']).slice(0, 7), status: c['status'], created_at: iso(c['created_at']),
});
const pageOf = (limit: unknown, kind: string, nextAfter: string | undefined) => ({
  limit: typeof limit === 'string' && /^[0-9]{1,3}$/.test(limit) ? Number(limit) : typeof limit === 'number' ? limit : 50,
  ...(nextAfter === undefined ? {} : { next_cursor: encodeCursor(kind, 0, nextAfter) }),
});
const cursorId = (q: Record<string, any>, kind: string): string | undefined => (q['cursor'] === undefined ? undefined : decodeCursor(q['cursor'], kind, 'int').id);
const partyOf = (req: HandlerRequest) => obj(req.params)['credit_party_id'];

export const creditHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  listCreditAccounts: bind(200, async (s, ctx, req) => {
    const q = obj(req.query), after = cursorId(q, 'credit_accounts');
    const r = await s.listAccounts(ctx, { limit: q['limit'], ...(after === undefined ? {} : { afterPartyId: after }) });
    return { body: { data: r.data.map(accountDto), page: pageOf(q['limit'], 'credit_accounts', r.nextAfter) } };
  }),
  getCreditAccount: bind(200, async (s, ctx, req) => {
    const a = await s.getAccount(ctx, { creditPartyId: partyOf(req) });
    return { body: accountDto(a), version: Number(a['version']) };
  }),
  updateCreditAccount: bind(200, async (s, ctx, req) => {
    const version = ifMatch(req);
    if (version === undefined) throw new LimsError('common.precondition_required');
    const b = obj(req.body);
    const creditPartyId = partyOf(req);
    await s.updateAccount(ctx, {
      creditPartyId, expectedVersion: version, creditLimitPaisa: b['credit_limit_paisa'], creditDays: b['credit_days'], isLocked: b['is_locked'], lockReasonCode: b['lock_reason_code'],
    });
    const a = await s.getAccount(ctx, { creditPartyId }); // read back in the same transaction: carries the exposure
    return { body: accountDto(a), version: Number(a['version']) };
  }),
  listCreditCharges: bind(200, async (s, ctx, req) => {
    const q = obj(req.query), after = cursorId(q, 'credit_charges');
    const r = await s.listCharges(ctx, {
      creditPartyId: partyOf(req), limit: q['limit'], ...(q['status'] === undefined ? {} : { status: q['status'] }), ...(q['period_month'] === undefined ? {} : { periodMonth: q['period_month'] }),
      ...(after === undefined ? {} : { afterId: after }),
    });
    return { body: { data: r.data.map(chargeDto), page: pageOf(q['limit'], 'credit_charges', r.nextAfter) } };
  }),
  issuePeriodicInvoice: bind(201, async (s, ctx, req) => {
    const b = obj(req.body);
    const ref = await s.issuePeriodicInvoice(ctx, { creditPartyId: partyOf(req), periodMonth: b['period_month'], branchId: b['branch_id'] });
    // a repeat of the same month answers billing.credit_period_already_billed (409): the month is the natural idempotency key
    const { cbms_submissions: _omit, ...invoice } = (await createInvoiceReadService().getInvoice(ctx, { invoiceId: ref.invoiceId })) as Record<string, unknown>; // InvoiceDto has no B2-only cbms_submissions
    return { body: invoice };
  }),
  recordCreditPartyPayment: bind(201, async (s, ctx, req) => {
    const key = obj(req.headers)['idempotency-key'];
    if (typeof key !== 'string' || key === '') throw new LimsError('common.idempotency_key_required');
    const b = obj(req.body);
    const creditPartyId = partyOf(req);
    const r = await s.recordPartyPayment(ctx, {
      creditPartyId, invoiceId: b['invoice_id'], methodCode: b['method_code'], amountReceivedPaisa: b['amount_received_paisa'], ...(b['reference'] === undefined ? {} : { reference: b['reference'] }),
      idempotencyKey: `${String(creditPartyId)}:cpay:${key}`, // [CONV] the client key, namespaced per party: ledger_entries.idempotency_key is unique per tenant
    });
    return { body: ledgerEntryDto(r.entry, await names(ctx, [r.entry['collected_by_membership_id']])) };
  }),
  getCreditPartyStatement: bind(200, async (s, ctx, req) => {
    const q = obj(req.query);
    const r = await s.statement(ctx, {
      creditPartyId: partyOf(req), ...(q['from_month'] === undefined ? {} : { fromMonth: q['from_month'] }), ...(q['to_month'] === undefined ? {} : { toMonth: q['to_month'] }),
    });
    return {
      body: {
        rows: r.rows.map((x) => ({
          period_month: x.periodMonth, fiscal_year_bs: x.fiscalYearBs, invoiced: moneyOf(x.invoiced.amountPaisa), paid: moneyOf(x.paid.amountPaisa),
          credited: moneyOf(x.credited.amountPaisa), closing_balance: moneyOf(x.closingBalance.amountPaisa),
        })),
      },
    };
  }),
});
