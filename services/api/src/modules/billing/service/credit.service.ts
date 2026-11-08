// B19 credit accounts, B20 charges, B21 issuePeriodicInvoice, B22 credit-party payment, B23 statement (02-TRD §5, §6.3, §8.1, §12; PRD US-FD-04, US-BL-10; 05-SCHEMA
// credit_accounts, credit_charges, invoices__subject__ck, ledger_entries__subject__ck, v_pub_credit_party_statement; 08 A13 D-1 / P-5; CR-C4-007).
// One caller transaction (ctx.tx). B21 order: validate -> account -> charges FOR UPDATE -> pattern dry run -> number LAST -> invoice, lines, charges marked, activity, CBMS job, event.
// Any throw rolls everything back, the counter bump with it (gapless, D-25); this service never retries. Tenant and actor come from ctx only.
// [CONV] Taxable credit charges: charges carry no tax rate and C4 never guesses one (08 R18) -> catalog.tax_config_missing until a rate source is ruled; exempt charges bill as-is.
import { createHash } from 'node:crypto';
import type { IsoUtc } from '../../../../../../packages/shared-ts/src/bsdate/index.js';
import { formatBs, instantToBs } from '../../../../../../packages/shared-ts/src/bsdate/index.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError, isLimsError, type FieldError } from '../../../core/errors.js';
import { fiscalYearOf } from '../domain/fiscalYear.js';
import { formatDocumentNumber, seriesKey, type SeriesScope } from '../domain/numberFormat.js';
import { moneyOf, toPaisa } from '../domain/money/paisa.js';
import type { BillingEvents } from '../events/publish.js';
import { billingRepo, type BillingRepo } from '../repository/index.js';
import type { BalanceCtx } from './balance.service.js';
import { DEFAULT_TZ, dateText, localDate } from './ledgerDto.js';
import { isRec, limitOf, UUID } from './invoiceRead.service.js';

interface Counter { allocate(tx: never, input: { tenantId: string; series: string; fiscalYearBs: string; actorId: string; invoiceNoPattern?: string; timezone?: string }): Promise<{ lastNo: number; allocatedAt: string }> }
type Row = Record<string, any>;
type Npr = { amountPaisa: number; currency: 'NPR' };
const npr = (amountPaisa: number): Npr => ({ amountPaisa, currency: 'NPR' });

const PERIOD = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
const BRANCH_CODE = /^[A-Za-z0-9_-]{1,20}$/;      // invoices__series__ck
const REASON_CODE = /^[A-Za-z0-9_.-]{1,64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const CARD_DIGITS = /[0-9]{13,19}/;               // ledger_entries__ref__ck (REQ-SEC-056)
const BRANCH_FK = 'invoices__branch__fk';
const MAX_DAYS = 365;                             // credit_accounts__days__ck (openapi says 3650: the DB is the tighter rule)
const MAX_STATEMENT_MONTHS = 24;

const invalid = (...paths: string[]): LimsError =>
  new LimsError('common.validation_failed', undefined, paths.map((path): FieldError => ({ path, code: 'common.field_invalid', message: 'Field invalid' })));

function scope(ctx: BalanceCtx): { tx: never; tenantId: string; actorId: string } {
  if (typeof ctx?.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
  return { tx: ctx.tx as never, tenantId: ctx.tenantId, actorId: ctx.actor.id };
}
const partyId = (raw: unknown, errors: string[]): string => {
  const v = isRec(raw) ? raw['creditPartyId'] : undefined;
  if (typeof v !== 'string' || !UUID.test(v)) errors.push('/credit_party_id');
  return v as string;
};
const monthIndex = (m: string): number => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
const monthText = (i: number): string => `${String(Math.floor(i / 12)).padStart(4, '0')}-${String((i % 12) + 1).padStart(2, '0')}`;
const optMonth = (v: unknown, path: string, errors: string[]): string | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !PERIOD.test(v)) { errors.push(path); return undefined; }
  return v;
};

export function createCreditService(deps: { repo?: BillingRepo; counter: Counter; events: BillingEvents }) {
  const repo = deps.repo ?? billingRepo;

  async function account(ctx: BalanceCtx, creditPartyId: string): Promise<Row> {
    const { tx, tenantId } = scope(ctx);
    const a = await repo.getCreditAccount(tx, { tenantId, creditPartyId }) as Row | undefined;
    if (!a) throw new LimsError('common.not_found'); // unknown party and another tenant's party look the same (A11)
    return a;
  }
  const outstanding = async (ctx: BalanceCtx, creditPartyId: string): Promise<number> =>
    toPaisa(await repo.sumOpenCreditExposure(scope(ctx).tx, { tenantId: ctx.tenantId, creditPartyId }));

  // ---- B19 ----
  async function listAccounts(ctx: BalanceCtx, raw: unknown) {
    const { tx, tenantId } = scope(ctx);
    const q = isRec(raw) ? raw : {};
    const limit = limitOf(q['limit']);
    const after = q['afterPartyId'];
    if (after !== undefined && (typeof after !== 'string' || !UUID.test(after))) throw invalid('/cursor');
    const rows = await repo.listCreditAccounts(tx, { tenantId, limit: limit + 1, ...(after === undefined ? {} : { afterPartyId: after }) }) as Row[];
    const page = rows.slice(0, limit);
    // ponytail: one exposure query per row (<= 200); fold into the list SQL if this page is ever hot.
    const data: Array<Row & { outstandingPaisa: number }> = [];
    for (const a of page) data.push({ ...a, outstandingPaisa: await outstanding(ctx, String(a['credit_party_id'])) });
    const last = page[page.length - 1];
    return { data, ...(rows.length > limit && last ? { nextAfter: String(last['credit_party_id']) } : {}) };
  }

  async function getAccount(ctx: BalanceCtx, raw: unknown) {
    scope(ctx);
    const errors: string[] = [];
    const id = partyId(raw, errors);
    if (errors.length) throw invalid(...errors);
    const a = await account(ctx, id);
    return { ...a, outstandingPaisa: await outstanding(ctx, id) } as Row & { outstandingPaisa: number };
  }

  async function updateAccount(ctx: BalanceCtx, raw: unknown) {
    const { tx, tenantId, actorId } = scope(ctx);
    const errors: string[] = [];
    const id = partyId(raw, errors);
    const i = isRec(raw) ? raw : {};
    const version = i['expectedVersion'];
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) errors.push('/if_match');
    const limit = i['creditLimitPaisa'] ?? null;
    if (limit !== null && !(typeof limit === 'number' && Number.isSafeInteger(limit) && limit >= 0)) errors.push('/credit_limit_paisa');
    const days = i['creditDays'] ?? null;
    if (days !== null && !(typeof days === 'number' && Number.isInteger(days) && days >= 0 && days <= MAX_DAYS)) errors.push('/credit_days');
    const locked = i['isLocked'];
    if (typeof locked !== 'boolean') errors.push('/is_locked');
    const reason = i['lockReasonCode'];
    if (reason !== undefined && (typeof reason !== 'string' || !REASON_CODE.test(reason))) errors.push('/lock_reason_code');
    else if (typeof locked === 'boolean' && locked !== (reason !== undefined)) errors.push('/lock_reason_code'); // credit_accounts__lock__ck: a lock needs a reason, an open account has none
    if (errors.length) throw invalid(...errors);

    const old = await account(ctx, id);
    if (old['version'] !== version) throw new LimsError('common.version_conflict');
    const stays = old['is_locked'] === true && locked === true; // an unchanged lock keeps its who / when
    const row = await repo.updateCreditAccount(tx, {
      tenantId, creditPartyId: id, expectedVersion: version as number, creditLimitPaisa: limit as number | null, creditDays: days as number | null, isLocked: locked as boolean,
      lockReasonCode: (reason as string | undefined) ?? null, ...(stays ? { lockedAt: old['locked_at'] ?? null, lockedBy: old['locked_by'] ?? null } : {}), userId: actorId,
    }) as Row | undefined;
    if (!row) throw new LimsError('common.version_conflict');
    await repo.insertActivity(tx, {
      id: uuidv7(), tenant_id: tenantId, centre_id: null, action: 'credit_account_changed', document_kind: 'credit_account', document_id: id, document_no: null,
      actor_id: actorId, actor_membership_id: ctx.actor.membershipId ?? null, actor_type: ctx.actor.type, occurred_at: ctx.now(), request_id: ctx.requestId ?? null,
      details: { credit_party_id: id, is_locked: locked, lock_reason_code: reason ?? null, credit_limit_paisa: limit, credit_days: days }, created_by: actorId, // ids and codes only: no party name / PAN
    });
    return row;
  }

  // ---- B20 ----
  async function listCharges(ctx: BalanceCtx, raw: unknown) {
    const { tx, tenantId } = scope(ctx);
    const errors: string[] = [];
    const id = partyId(raw, errors);
    const q = isRec(raw) ? raw : {};
    const period = optMonth(q['periodMonth'], '/period_month', errors);
    const status = q['status'];
    if (status !== undefined && (typeof status !== 'string' || status.length < 1 || status.length > 32 || CONTROL.test(status))) errors.push('/status');
    const after = q['afterId'];
    if (after !== undefined && (typeof after !== 'string' || !UUID.test(after))) errors.push('/cursor');
    if (errors.length) throw invalid(...errors);
    const limit = limitOf(q['limit']);
    await account(ctx, id);
    const rows = await repo.listCreditChargesByParty(tx, {
      tenantId, creditPartyId: id, limit: limit + 1, ...(status === undefined ? {} : { status }), ...(period === undefined ? {} : { periodMonth: `${period}-01` }), ...(after === undefined ? {} : { afterId: after }),
    }) as Row[];
    const data = rows.slice(0, limit);
    const last = data[data.length - 1];
    return { data, ...(rows.length > limit && last ? { nextAfter: String(last['id']) } : {}) };
  }

  // ---- B21 ----
  async function issuePeriodicInvoice(ctx: BalanceCtx, raw: unknown) {
    const { tx, tenantId, actorId } = scope(ctx);
    const errors: string[] = [];
    const id = partyId(raw, errors);
    const i = isRec(raw) ? raw : {};
    const period = optMonth(i['periodMonth'], '/period_month', errors);
    if (period === undefined && !errors.includes('/period_month')) errors.push('/period_month');
    const branchId = i['branchId'];
    if (typeof branchId !== 'string' || !UUID.test(branchId)) errors.push('/branch_id');
    // [CR-pending] CR-C4-BL13 (.orchestra/cr/BL-T13.md): 03-APP-FLOW §2.14 wants an ACTIVE branch; no 03-IC port exposes branch active-ness, so only the FK (branch of this tenant) is enforced
    const branchCode = i['branchCode']; // [CONV] interim, same as issue(): C0 has not named the {branch} source
    if (branchCode !== undefined && (typeof branchCode !== 'string' || !BRANCH_CODE.test(branchCode))) errors.push('/branch_code');
    if (errors.length) throw invalid(...errors);

    const acct = await account(ctx, id);
    const charges = await repo.lockUninvoicedCreditCharges(tx, { tenantId, creditPartyId: id, periodMonth: `${period}-01` }) as Row[];
    if (charges.length === 0) throw new LimsError('billing.credit_period_already_billed'); // also: month already billed, or nothing was ever charged
    // [CR-pending] CR-C4-BL13 (.orchestra/cr/BL-T13.md): fail-closed interim; priceFor needs `priority`, which a credit_charges row does not carry
    if (charges.some((c) => c['vat_treatment'] !== 'exempt' || c['other_tax_code'] != null)) throw new LimsError('catalog.tax_config_missing');

    const idp = ctx.ports?.IdentityPort;
    if (!idp) throw new LimsError('common.internal');
    const nowIso = ctx.now();
    const tenant = await idp.getTenantSettings(ctx, { keys: ['numbering', 'ird', 'branding', 'timezone'] });
    const settings = (await repo.getBillingSettings(tx, { tenantId })) ?? { invoice_series_scope: 'tenant', prices_include_tax: false };
    const invScope = settings['invoice_series_scope'];
    if (invScope !== 'tenant' && invScope !== 'branch') throw new LimsError('common.internal');
    const pattern = tenant?.numbering?.invoiceNoPattern;
    const sellerName = [tenant?.branding?.legalName, tenant?.branding?.displayName].find((n) => typeof n === 'string' && n.trim() !== '');
    if (typeof pattern !== 'string') throw new LimsError('billing.numbering_pattern_invalid');
    if (typeof sellerName !== 'string') throw new LimsError('common.internal'); // tenant branding not configured
    const timezone: string = typeof tenant?.timezone === 'string' ? tenant.timezone : DEFAULT_TZ;
    const fy = fiscalYearOf(nowIso as IsoUtc, timezone);
    const fmt = (seq: number) => formatDocumentNumber(pattern, { fy, seq, scope: invScope as SeriesScope, ...(branchCode === undefined ? {} : { branch: branchCode as string }) });
    try { fmt(1); } // dry run BEFORE allocating, so a broken pattern consumes nothing
    catch (e) { throw isLimsError(e, 'common.validation_failed') ? new LimsError('billing.numbering_pattern_invalid') : e; }
    const series = seriesKey('INV', invScope as SeriesScope, branchCode as string | undefined);
    const cbmsRequired = tenant?.ird?.cbmsRealtimeRequired !== false; // unknown = required: never silently skip the tax authority
    const addressLines: unknown = tenant?.branding?.addressLines;

    // one line per charge, in bill order (the repo returns charged_at, id); exempt only (guarded above), so vat = 0 and net = gross - discount
    const invoiceId = uuidv7();
    const lines = charges.map((c, n) => {
      const gross = toPaisa(c['gross_paisa']), discount = toPaisa(c['discount_paisa']);
      return {
        id: uuidv7(), tenant_id: tenantId, invoice_id: invoiceId, centre_id: null, line_no: n + 1, line_kind: 'credit_charge', order_item_id: null, orderable_id: c['orderable_id'] ?? null,
        orderable_kind: null, credit_charge_id: c['id'], code: c['code'], name: `${c['code']} — ${c['patient_display_name']}`, department_id: c['department_id'] ?? null, hs_code: null, quantity: 1,
        unit_price_paisa: toPaisa(c['unit_price_paisa']), gross_paisa: gross, discount_paisa: discount, exempt_paisa: gross - discount, taxable_paisa: 0, vat_treatment: 'exempt',
        vat_rate_bp: null, vat_paisa: 0, other_tax_code: null, other_tax_rate_bp: null, other_tax_paisa: 0, net_paisa: gross - discount, created_by: actorId,
      };
    });
    const sum = (k: 'gross_paisa' | 'discount_paisa' | 'exempt_paisa' | 'net_paisa') => lines.reduce((t, l) => t + l[k], 0);
    const gross = sum('gross_paisa'), discount = sum('discount_paisa'), exempt = sum('exempt_paisa'), net = sum('net_paisa');
    const fingerprint = createHash('sha256').update(JSON.stringify([id, period, charges.map((c) => [c['id'], c['gross_paisa'], c['discount_paisa']])])).digest('hex');

    // ---- allocation LAST: no repo call between this line and insertInvoice (TRD §12) ----
    const { lastNo, allocatedAt } = await deps.counter.allocate(tx, { tenantId, series, fiscalYearBs: fy.long, actorId, invoiceNoPattern: pattern, timezone });
    const invoiceNo = fmt(lastNo);
    try {
      await repo.insertInvoice(tx, {
        id: invoiceId, tenant_id: tenantId, branch_id: branchId, centre_id: null, series, fiscal_year_bs: fy.long, invoice_seq: lastNo, invoice_no: invoiceNo, invoice_kind: 'tax_invoice',
        purpose: 'periodic_credit', order_id: null, patient_id: null, credit_party_id: id, is_periodic_credit_bill: true, period_month: `${period}-01`, referrer_id: null,
        buyer_name: acct['party_display_name'], buyer_pan: acct['party_pan'] ?? null, buyer_address: acct['party_address'] ?? null, seller_name: sellerName, seller_pan: tenant?.ird?.pan ?? null,
        seller_address: Array.isArray(addressLines) && addressLines.length > 0 ? addressLines.join(', ') : null, issued_at: allocatedAt,
        invoice_date_bs: formatBs(instantToBs(allocatedAt as IsoUtc, timezone)), gross_paisa: gross, discount_paisa: discount, exempt_paisa: exempt, taxable_paisa: 0, vat_paisa: 0,
        other_tax_paisa: 0, net_paisa: net, prices_include_tax: settings['prices_include_tax'] === true, quote_fingerprint: fingerprint, status: 'issued', is_active: true, print_count: 0,
        cbms_state: cbmsRequired ? 'pending' : 'not_required', cbms_attempts: 0, created_by: actorId, updated_by: actorId,
      });
    } catch (e) {
      const x = e as { code?: unknown; constraint?: unknown; message?: unknown } | null;
      if (x?.code === '23503' && (x.constraint === BRANCH_FK || (typeof x.message === 'string' && x.message.includes(BRANCH_FK)))) throw invalid('/branch_id'); // not a branch of this tenant
      throw e;
    }
    await repo.insertInvoiceLines(tx, lines);
    const moved = await repo.markCreditChargesInvoiced(tx, {
      tenantId, links: lines.map((l) => ({ chargeId: l.credit_charge_id as string, invoiceId, invoiceLineId: l.id })), invoicedAt: allocatedAt, userId: actorId,
    });
    if (moved !== lines.length) throw new LimsError('common.version_conflict'); // a charge left 'uninvoiced' under the lock: roll the whole bill back
    await repo.insertActivity(tx, {
      id: uuidv7(), tenant_id: tenantId, centre_id: null, action: 'periodic_invoice_issued', document_kind: 'invoice', document_id: invoiceId, document_no: invoiceNo,
      actor_id: actorId, actor_membership_id: ctx.actor.membershipId ?? null, actor_type: ctx.actor.type, occurred_at: allocatedAt, request_id: ctx.requestId ?? null,
      details: { credit_party_id: id, period_month: period, charge_count: lines.length }, created_by: actorId,
    });
    if (cbmsRequired) await repo.enqueueCbmsSync(tx, { tenantId, documentKind: 'invoice', documentId: invoiceId }); // never marked synced here (US-BL-13.1)
    // D-1 / P-5: no order_id, no centre_id; branch_id = the request's; no buyer or patient data (REQ-SEC-006)
    await deps.events.invoiceIssued(ctx as never, {
      invoice_id: invoiceId, invoice_no: invoiceNo, fiscal_year_bs: fy.long, invoice_kind: 'tax_invoice', branch_id: branchId, credit_party_id: id, is_periodic_credit_bill: true,
      issued_at: allocatedAt,
      totals: { gross: moneyOf(gross), discount: moneyOf(discount), exempt: moneyOf(exempt), taxable: moneyOf(0), vat: moneyOf(0), other_tax: moneyOf(0), net: moneyOf(net) },
    });
    return {
      invoiceId, invoiceNo, fiscalYearBs: fy.long, issuedAt: allocatedAt,
      totals: { gross: npr(gross), discount: npr(discount), exempt: npr(exempt), taxable: npr(0), vat: npr(0), otherTax: npr(0), net: npr(net) },
    };
  }

  // ---- B22 ----
  async function recordPartyPayment(ctx: BalanceCtx, raw: unknown) {
    const { tx, tenantId, actorId } = scope(ctx);
    const errors: string[] = [];
    const id = partyId(raw, errors);
    const i = isRec(raw) ? raw : {};
    const invoiceId = i['invoiceId'];
    if (typeof invoiceId !== 'string' || !UUID.test(invoiceId)) errors.push('/invoice_id');
    const amount = i['amountReceivedPaisa'];
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 1) errors.push('/amount_received_paisa');
    const methodCode = i['methodCode'];
    if (typeof methodCode !== 'string' || methodCode.length < 1 || methodCode.length > 64 || CONTROL.test(methodCode)) errors.push('/method_code');
    const key = i['idempotencyKey'];
    if (typeof key !== 'string' || key.length < 1 || key.length > 255 || CONTROL.test(key)) errors.push('/idempotency_key');
    let reference: string | undefined;
    if (i['reference'] !== undefined) {
      const t = typeof i['reference'] === 'string' ? i['reference'].trim() : undefined;
      if (t === undefined || t.length > 100 || CONTROL.test(t) || CARD_DIGITS.test(t)) errors.push('/reference'); // never echo the value
      else if (t !== '') reference = t;
    }
    if (errors.length) throw invalid(...errors);
    const collector = ctx.actor.membershipId;
    if (collector === undefined) throw new LimsError('auth.forbidden'); // ledger_entries__collector__ck: manual money has a collector

    // the bill first (locked: payments on one bill serialise, and a concurrent same-key call replays below); another party's, order or tenant's invoice is "not found"
    const inv = await repo.getPeriodicInvoiceForUpdate(tx, { tenantId, creditPartyId: id, invoiceId: invoiceId as string }) as Row | undefined;
    if (!inv) throw new LimsError('common.not_found');
    const prior = await repo.findLedgerByIdempotencyKey(tx, { tenantId, idempotencyKey: key as string }) as Row | undefined;
    if (prior) {
      if (prior['invoice_id'] !== invoiceId || prior['credit_party_id'] !== id || prior['method_code'] !== methodCode || toPaisa(prior['amount_paisa']) !== amount) throw new LimsError('common.idempotency_key_reused');
      return { ledgerEntryId: String(prior['id']), duplicate: true, entry: prior };
    }
    const method = await repo.getPaymentMethod(tx, { tenantId, code: methodCode as string });
    if (!method || method.is_active !== true) throw invalid('/method_code');
    if (method.requires_reference && reference === undefined) throw invalid('/reference');
    const due = toPaisa(inv['net_paisa']) - toPaisa(inv['credited_total_paisa']) - toPaisa(await repo.sumLedgerByInvoice(tx, { tenantId, invoiceId: invoiceId as string }));
    if ((amount as number) > due) throw new LimsError('billing.payment_exceeds_due'); // a cancelled bill is fully credited, so its due is 0

    const idp = ctx.ports?.IdentityPort;
    if (!idp) throw new LimsError('common.internal');
    const nowIso = ctx.now();
    const tenant = await idp.getTenantSettings(ctx, { keys: ['timezone'] });
    const timezone: string = typeof tenant?.timezone === 'string' ? tenant.timezone : DEFAULT_TZ;
    const ledgerId = uuidv7();
    const row = await repo.insertLedgerEntry(tx, {
      id: ledgerId, tenantId, branchId: inv['branch_id'], centreId: null, orderId: null, invoiceId: invoiceId as string, creditPartyId: id, entryKind: 'payment', captureKind: 'manual',
      methodCode: methodCode as string, amountPaisa: amount as number, fiscalYearBs: fiscalYearOf(nowIso as IsoUtc, timezone).long, businessDate: localDate(nowIso, timezone),
      collectedByMembershipId: collector, userId: actorId, idempotencyKey: key as string, cashSessionId: null, referenceText: reference ?? null,
    });
    if (!row) throw new LimsError('common.internal');
    await repo.insertActivity(tx, {
      id: uuidv7(), tenant_id: tenantId, centre_id: null, action: 'payment_recorded', document_kind: 'ledger_entry', document_id: ledgerId, document_no: null,
      actor_id: actorId, actor_membership_id: collector, actor_type: ctx.actor.type, occurred_at: nowIso, request_id: ctx.requestId ?? null,
      details: { credit_party_id: id, invoice_id: invoiceId, method_code: methodCode, amount_paisa: amount }, created_by: actorId, // never the reference text
    });
    return { ledgerEntryId: ledgerId, duplicate: false, entry: row };
  }

  // ---- B23 ----
  async function statement(ctx: BalanceCtx, raw: unknown) {
    const { tx, tenantId } = scope(ctx);
    const errors: string[] = [];
    const id = partyId(raw, errors);
    const q = isRec(raw) ? raw : {};
    const from = optMonth(q['fromMonth'], '/from_month', errors);
    const to = optMonth(q['toMonth'], '/to_month', errors);
    if (!errors.length && from !== undefined && to !== undefined && monthIndex(from) > monthIndex(to)) errors.push('/from_month');
    if (errors.length) throw invalid(...errors);
    await account(ctx, id);

    const tenant = to === undefined ? await ctx.ports?.IdentityPort?.getTenantSettings(ctx, { keys: ['timezone'] }) : undefined;
    const toI = to !== undefined ? monthIndex(to)
      : monthIndex(localDate(ctx.now(), typeof tenant?.timezone === 'string' ? tenant.timezone : DEFAULT_TZ).slice(0, 7)); // current month in the tenant time zone
    const fromI = from !== undefined ? monthIndex(from) : toI - (MAX_STATEMENT_MONTHS - 1);
    if (toI - fromI + 1 > MAX_STATEMENT_MONTHS) throw new LimsError('billing.export_too_large');
    const rows = await repo.readCreditPartyStatement(tx, { tenantId, creditPartyId: id, fromMonth: `${monthText(fromI)}-01`, toMonth: `${monthText(toI)}-01` }) as Row[];
    return {
      rows: rows.map((r) => ({
        periodMonth: dateText(r['period_month']).slice(0, 7), fiscalYearBs: String(r['fiscal_year_bs']), invoiced: npr(toPaisa(r['invoiced_paisa'])), paid: npr(toPaisa(r['paid_paisa'])),
        credited: npr(toPaisa(r['credited_paisa'])), closingBalance: npr(toPaisa(r['closing_balance_paisa'])),
      })),
    };
  }

  return { listAccounts, getAccount, updateAccount, listCharges, issuePeriodicInvoice, recordPartyPayment, statement };
}
export type CreditService = ReturnType<typeof createCreditService>;
