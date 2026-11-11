// BL-T13 test helpers (not a test file). Builds on t08.helpers.ts (BL-T06 world + ledger fakes) and adds credit accounts, credit charges, branches and the
// DB rules the credit flow must respect. ASSUMED seams (spec fixes behaviour, not signatures; writer: object via a dispute if wrong). All repo fns take
// (tx, args), carry tenantId from ctx only, return snake_case rows (bigint columns as strings, period_month as 'YYYY-MM-01'):
//   creditAccounts.repo   getCreditAccount(tx,{tenantId,creditPartyId}) (exists) | listCreditAccounts(tx,{tenantId,afterPartyId?,limit}) -> rows ordered by credit_party_id
//                         updateCreditAccount(tx,{tenantId,creditPartyId,expectedVersion,creditLimitPaisa,creditDays,isLocked,lockReasonCode,lockedAt?,lockedBy?,userId}) -> row | undefined (undefined = version moved)
//                         lockCreditAccountsOverdue(tx,{tenantId,now}) lives in the worker task, not here.
//   creditCharges.repo    listCreditChargesByParty(tx,{tenantId,creditPartyId,status?,periodMonth?,afterId?,limit}) -> rows ordered by id
//                         lockUninvoicedCreditCharges(tx,{tenantId,creditPartyId,periodMonth}) -> uninvoiced rows of that A.D. month ('YYYY-MM-01'), SELECT … FOR UPDATE, ordered charged_at,id
//                         markCreditChargesInvoiced(tx,{tenantId,links:[{chargeId,invoiceId,invoiceLineId}],invoicedAt,userId}) -> number (uninvoiced -> invoiced only)
//   invoices.repo         getPeriodicInvoiceForUpdate(tx,{tenantId,creditPartyId,invoiceId}) -> invoice row | undefined (periodic bill of THAT party only; FOR UPDATE)
//   ledger.repo           sumLedgerByInvoice(tx,{tenantId,invoiceId}) -> string (signed sum, paisa) ; insertLedgerEntry accepts creditPartyId (centreId/orderId/cashSessionId null)
//   statement             readCreditPartyStatement(tx,{tenantId,creditPartyId,fromMonth,toMonth}) -> rows of billing.v_pub_credit_party_statement
//                         {period_month,fiscal_year_bs,invoiced_paisa,paid_paisa,credited_paisa,closing_balance_paisa}, months inclusive ('YYYY-MM-01'), ordered by period_month
// ASSUMED service seam: createCreditService({repo,counter,events}) ->
//   listAccounts(ctx,{afterPartyId?,limit?}) -> {data:[CreditAccountDto-ish camelCase rows], nextAfter?}   (B19 list; DTO mapping is the handler's job)
//   getAccount(ctx,{creditPartyId}) -> the account row (snake_case) + outstandingPaisa:number (= repo.sumOpenCreditExposure)
//   updateAccount(ctx,{creditPartyId,expectedVersion,creditLimitPaisa?,creditDays?,isLocked,lockReasonCode?}) -> the account row (snake_case, new version)
//   listCharges(ctx,{creditPartyId,status?,periodMonth?:'YYYY-MM',afterId?,limit?}) -> rows
//   issuePeriodicInvoice(ctx,{creditPartyId,periodMonth:'YYYY-MM',branchId,branchCode?}) -> { invoiceId, invoiceNo, fiscalYearBs, issuedAt, totals }   (B21)
//   recordPartyPayment(ctx,{creditPartyId,invoiceId,methodCode,amountReceivedPaisa,reference?,idempotencyKey}) -> { ledgerEntryId, duplicate }       (B22)
//   statement(ctx,{creditPartyId,fromMonth?:'YYYY-MM',toMonth?:'YYYY-MM'}) -> { rows:[{periodMonth,fiscalYearBs,invoiced,paid,credited,closingBalance}] }  Money = {amountPaisa,currency}  (B23)
// Synthetic data only.
import { pgError } from '../../../../core/events/__tests__/helpers.js';
import { BASE, IDS, makeLedgerWorld, METHODS, TENANT_A, V7, type LedgerOpts } from './t08.helpers.js';

export { BASE, IDS, METHODS, TENANT_A, V7 };
export { errCode, money, npr, USER, MEMBERSHIP } from './t08.helpers.js';
export const TENANT_B = '0190a000-0000-7000-8000-00000000bbbb';
export const PARTY = V7('000000b00001');
export const PARTY2 = V7('000000b00002');
export const PARTY_B = V7('000000b000b1');
export const BRANCH2 = V7('000000010002');
export const FOREIGN_BRANCH = V7('0000000100ff');
export const CH = (n: number) => V7(`0000000d${String(n).padStart(4, '0')}`);

const COMPONENTS = ['gross_paisa', 'discount_paisa', 'exempt_paisa', 'taxable_paisa', 'vat_paisa', 'other_tax_paisa', 'net_paisa'] as const;
export const sumCol = (rows: any[], c: (typeof COMPONENTS)[number]) => rows.reduce((t, r) => t + Number(r[c]), 0);

export const account = (over: Record<string, unknown> = {}) => ({
  tenant_id: TENANT_A, credit_party_id: PARTY, party_code: 'SYN-CORP', party_display_name: 'Synthetic Corp', party_pan: '987654321', party_address: 'Synthetic Road 7',
  credit_limit_paisa: null, credit_days: 30, is_locked: false, lock_reason_code: null, locked_at: null, locked_by: null, version: 1, is_active: true, ...over,
});
/** An uninvoiced exempt credit charge of NPR 1,000.00 for A.D. month 2026-10 (exempt: the tax-rate source for taxable charges is a spec gap, see notes). */
export const charge = (n: number, over: Record<string, unknown> = {}) => ({
  id: CH(n), tenant_id: TENANT_A, credit_party_id: PARTY, order_id: V7(`0000000500${String(n).padStart(2, '0')}`), order_item_id: V7(`0000000600${String(n).padStart(2, '0')}`),
  branch_id: IDS.branch, centre_id: IDS.centre, referrer_id: null, patient_display_name: 'Synthetic Patient', line_kind: 'orderable', orderable_id: IDS.orderable1, code: 'CBC',
  name: 'Complete blood count', department_id: null, unit_price_paisa: 100000, gross_paisa: 100000, discount_paisa: 0, vat_treatment: 'exempt', other_tax_code: null,
  charged_at: `2026-10-${String(1 + (n % 28)).padStart(2, '0')}T05:00:00.000Z`, period_month: '2026-10-01', status: 'uninvoiced', invoice_id: null, invoice_line_id: null,
  invoiced_at: null, voided_at: null, version: 1, is_active: true, ...over,
});

export function makeT13World(opts: LedgerOpts & { accounts?: any[]; charges?: any[]; branches?: Array<{ tenant_id: string; id: string }> } = {}) {
  const w = makeLedgerWorld({ invoiceNet: null, ...opts });
  const st = w.s as any;
  st.accounts = structuredClone(opts.accounts ?? [account()]);
  st.charges = structuredClone(opts.charges ?? []);
  st.branches = structuredClone(opts.branches ?? [{ tenant_id: TENANT_A, id: IDS.branch }, { tenant_id: TENANT_A, id: BRANCH2 }]);
  st.statementRows = [] as any[];
  const A = (): any[] => (w.s as any).accounts;
  const C = (): any[] => (w.s as any).charges;
  const rec = (name: string, a: any) => {
    if (typeof a?.tenantId !== 'string' && typeof a?.tenant_id !== 'string') throw new Error(`fake repo: ${name} called without a tenant id`);
    w.repoCalls.push({ name, args: a });
  };
  const mine = <T extends { tenant_id: string }>(rows: T[], tenantId: string) => rows.filter((r) => r.tenant_id === tenantId);
  const r: any = w.repo;

  // ---- DB rules on the periodic invoice (invoices__subject__ck, __totals__ck, __branch__fk) and on its lines ----
  const baseInsert = r.insertInvoice;
  r.insertInvoice = async (tx: unknown, row: any) => {
    if (row.purpose === 'periodic_credit') {
      const ok = row.order_id == null && row.patient_id == null && row.centre_id == null && typeof row.credit_party_id === 'string' && row.is_periodic_credit_bill === true
        && typeof row.period_month === 'string';
      if (!ok) throw pgError('23514', 'violates check constraint "invoices__subject__ck"');
      if (row.gross_paisa - row.discount_paisa !== row.exempt_paisa + row.taxable_paisa
        || row.net_paisa !== row.exempt_paisa + row.taxable_paisa + row.vat_paisa + row.other_tax_paisa) throw pgError('23514', 'violates check constraint "invoices__totals__ck"');
      if (!(w.s as any).branches.some((b: any) => b.tenant_id === row.tenant_id && b.id === row.branch_id)) {
        throw Object.assign(pgError('23503', 'violates foreign key constraint "invoices__branch__fk"'), { constraint: 'invoices__branch__fk' });
      }
    }
    const out = await baseInsert(tx, row);
    const stored = w.s.invoices[w.s.invoices.length - 1];
    Object.assign(stored, { version: 1, credited_total_paisa: 0, ...stored });
    return out;
  };
  const baseLines = r.insertInvoiceLines;
  r.insertInvoiceLines = async (tx: unknown, rows: any[]) => {
    for (const l of rows) {
      if (l.line_kind !== 'credit_charge') continue;
      const ok = l.credit_charge_id != null && l.order_item_id == null && l.centre_id == null && l.quantity === 1 && l.net_paisa === l.exempt_paisa + l.taxable_paisa + l.vat_paisa + l.other_tax_paisa
        && l.gross_paisa - l.discount_paisa === l.exempt_paisa + l.taxable_paisa;
      if (!ok) throw pgError('23514', 'violates check constraint "invoice_lines (credit_charge)"');
    }
    return baseLines(tx, rows);
  };

  Object.assign(r, {
    async getCreditAccount(_tx: unknown, a: any) { rec('getCreditAccount', a); const x = mine(A(), a.tenantId).find((q) => q.credit_party_id === a.creditPartyId); return x && structuredClone(x); },
    async upsertCreditAccount(_tx: unknown, a: any) {
      rec('upsertCreditAccount', a);
      if (!mine(A(), a.tenantId).some((q) => q.credit_party_id === a.creditPartyId)) A().push(account({ tenant_id: a.tenantId, credit_party_id: a.creditPartyId, party_code: a.partyCode, party_display_name: a.partyName, party_pan: a.pan ?? null, party_address: a.address ?? null }));
    },
    async listCreditAccounts(_tx: unknown, a: any) {
      rec('listCreditAccounts', a);
      return structuredClone(mine(A(), a.tenantId).filter((q) => a.afterPartyId === undefined || q.credit_party_id > a.afterPartyId).sort((p, q) => (p.credit_party_id < q.credit_party_id ? -1 : 1)).slice(0, a.limit));
    },
    async updateCreditAccount(_tx: unknown, a: any) {
      rec('updateCreditAccount', a);
      const x = mine(A(), a.tenantId).find((q) => q.credit_party_id === a.creditPartyId);
      if (!x || x.version !== a.expectedVersion) return undefined;
      if (a.isLocked !== (a.lockReasonCode != null)) throw pgError('23514', 'violates check constraint "credit_accounts__lock__ck"');
      if (a.creditLimitPaisa != null && !(Number(a.creditLimitPaisa) >= 0)) throw pgError('23514', 'violates check constraint "credit_accounts__limit__ck"');
      if (a.creditDays != null && !(a.creditDays >= 0 && a.creditDays <= 365)) throw pgError('23514', 'violates check constraint "credit_accounts__days__ck"');
      Object.assign(x, { credit_limit_paisa: a.creditLimitPaisa == null ? null : String(a.creditLimitPaisa), credit_days: a.creditDays ?? null, is_locked: a.isLocked, lock_reason_code: a.lockReasonCode ?? null,
        locked_at: a.isLocked ? (a.lockedAt ?? BASE) : null, locked_by: a.isLocked ? (a.lockedBy ?? a.userId) : null, version: x.version + 1, updated_by: a.userId });
      return structuredClone(x);
    },
    async listCreditChargesByParty(_tx: unknown, a: any) {
      rec('listCreditChargesByParty', a);
      return structuredClone(mine(C(), a.tenantId).filter((c) => c.credit_party_id === a.creditPartyId && (a.status === undefined || c.status === a.status)
        && (a.periodMonth === undefined || c.period_month === a.periodMonth) && (a.afterId === undefined || c.id > a.afterId)).sort((p, q) => (p.id < q.id ? -1 : 1)).slice(0, a.limit));
    },
    async lockUninvoicedCreditCharges(_tx: unknown, a: any) {
      rec('lockUninvoicedCreditCharges', a);
      return structuredClone(mine(C(), a.tenantId).filter((c) => c.credit_party_id === a.creditPartyId && c.period_month === a.periodMonth && c.status === 'uninvoiced')
        .sort((p, q) => (p.charged_at === q.charged_at ? (p.id < q.id ? -1 : 1) : p.charged_at < q.charged_at ? -1 : 1)));
    },
    async markCreditChargesInvoiced(_tx: unknown, a: any) {
      rec('markCreditChargesInvoiced', a);
      let n = 0;
      for (const l of a.links) {
        const c = mine(C(), a.tenantId).find((x) => x.id === l.chargeId);
        if (!c) continue;
        if (c.status !== 'uninvoiced') throw Object.assign(pgError('P0001', 'immutable_row'), { detail: 'billing.credit_charges' }); // credit_charges_lifecycle_guard
        Object.assign(c, { status: 'invoiced', invoice_id: l.invoiceId, invoice_line_id: l.invoiceLineId, invoiced_at: a.invoicedAt, version: c.version + 1, updated_by: a.userId });
        n += 1;
      }
      return n;
    },
    async getPeriodicInvoiceForUpdate(_tx: unknown, a: any) {
      rec('getPeriodicInvoiceForUpdate', a);
      const i = w.s.invoices.find((x: any) => x.tenant_id === a.tenantId && x.id === a.invoiceId && x.is_periodic_credit_bill === true && x.credit_party_id === a.creditPartyId);
      return i && structuredClone(i);
    },
    async sumLedgerByInvoice(_tx: unknown, a: any) {
      rec('sumLedgerByInvoice', a);
      return String((w as any).ledger().filter((e: any) => e.tenant_id === a.tenantId && e.invoice_id === a.invoiceId).reduce((t: number, e: any) => t + e.amount_paisa, 0));
    },
    // open exposure = uninvoiced charges (gross - discount) + issued periodic bills (net - credited - paid); same rule as creditAccounts.repo.sumOpenCreditExposure
    async sumOpenCreditExposure(_tx: unknown, a: any) {
      rec('sumOpenCreditExposure', a);
      const unb = mine(C(), a.tenantId).filter((c) => c.credit_party_id === a.creditPartyId && c.status === 'uninvoiced').reduce((t, c) => t + Number(c.gross_paisa) - Number(c.discount_paisa), 0);
      const inv = w.s.invoices.filter((i: any) => i.tenant_id === a.tenantId && i.credit_party_id === a.creditPartyId && i.is_periodic_credit_bill && i.status === 'issued')
        .reduce((t: number, i: any) => t + Math.max(0, Number(i.net_paisa) - Number(i.credited_total_paisa ?? 0)
          - (w as any).ledger().filter((e: any) => e.tenant_id === a.tenantId && e.invoice_id === i.id).reduce((s: number, e: any) => s + e.amount_paisa, 0)), 0);
      return String(unb + inv);
    },
    async readCreditPartyStatement(_tx: unknown, a: any) {
      rec('readCreditPartyStatement', a);
      return structuredClone(mine((w.s as any).statementRows, a.tenantId).filter((x: any) => x.credit_party_id === a.creditPartyId && x.period_month >= a.fromMonth && x.period_month <= a.toMonth)
        .sort((p: any, q: any) => (p.period_month < q.period_month ? -1 : 1)));
    },
  });
  // insertLedgerEntry: keep the BL-T08 fake (sign / collector / reference CHECKs) and add the ledger_entries__subject__ck of credit-party payments
  const baseLedger = r.insertLedgerEntry;
  r.insertLedgerEntry = async (tx: unknown, e: any) => {
    if (e.orderId == null && !(typeof e.creditPartyId === 'string' && typeof e.invoiceId === 'string')) throw pgError('23514', 'violates check constraint "ledger_entries__subject__ck"');
    const row = await baseLedger(tx, e);
    const stored = (w as any).ledger().find((x: any) => x.id === e.id);
    if (stored) stored.credit_party_id = e.creditPartyId ?? null;
    return { ...row, credit_party_id: e.creditPartyId ?? null };
  };

  return Object.assign(w, {
    accounts: A, charges: C,
    addAccount(over: Record<string, unknown> = {}) { A().push(account(over)); },
    addCharge(n: number, over: Record<string, unknown> = {}) { C().push(charge(n, over)); },
    addCharges(from: number, count: number, over: Record<string, unknown> = {}) { for (let n = from; n < from + count; n += 1) C().push(charge(n, over)); },
    invoicesOf: (party = PARTY) => w.s.invoices.filter((i: any) => i.credit_party_id === party),
    activity: () => w.s.activity as any[],
    wrote: () => w.repoCalls.filter((c) => /^(insert|mark|update|upsert|enqueue|resolve)/.test(c.name)).map((c) => c.name),
  });
}
export type T13World = ReturnType<typeof makeT13World>;
