// BL-T07 real-implementation harness for packages/fakes/contract-tests/BillingCommandPort.contract.ts (not a test file).
// Returns the C0 ContractHarness shape over the REAL createBillingCommandPort({ repo, counter, events }) with in-memory repo/counter seams
// (the BL-T06/T08 "billing world") plus ctx.ports fakes for FrontdeskPort (order existence, tenant-scoped) and CatalogPort (credit party).
// ASSUMED impl seam (writer: dispute via .orchestra/notes if wrong):
//   ports/BillingCommandPort.impl.ts exports createBillingCommandPort(deps: { repo?, counter, events: BillingEvents }) -> BillingCommandPortV1
//   (same dependency shape as createInvoiceService / createLedgerService; it composes them + computeQuote; every call runs in ctx.tx).
// ASSUMED repo seams added by BL-T07 (all (tx, args), tenantId in args; rows snake_case like node-pg; bigint columns as strings):
//   repo.getCreditAccount(tx,{tenantId,creditPartyId})     -> {credit_party_id,is_locked,credit_limit_paisa:string|null} | undefined   (exists today)
//   repo.sumOpenCreditExposure(tx,{tenantId,creditPartyId})-> string   (uninvoiced charges + unpaid periodic invoices of the party, paisa)
//   repo.upsertCreditAccount(tx,{tenantId,creditPartyId,partyCode,partyName,pan?,address?,userId}) -> void
//   repo.insertCreditCharges(tx,rows[])                    -> void  (snake_case billing.credit_charges columns; status 'uninvoiced')
//   repo.listCreditChargesByOrder(tx,{tenantId,orderId})   -> [{id,order_item_id,credit_party_id,amount_paisa,status:'uninvoiced'|'invoiced'|'voided',invoice_id,invoice_line_id}]
//   repo.voidCreditChargesByIds(tx,{tenantId,ids,reasonCode,userId}) -> number
//   repo.listInvoicesByOrder(tx,{tenantId,orderId})        -> [{id,status}]
//   repo.listInvoiceLinesByOrder(tx,{tenantId,orderId})    -> [{id,invoice_id,order_item_id}]
//   repo.insertCreditNoteTask(tx,row)                      -> void  (snake_case billing.credit_note_tasks: id,tenant_id,invoice_id,invoice_line_ids,order_id,cause,reason_code,required,status)
// The harness also copies LimsError.detail to .safeDetail on rejections (the shared suite reads safeDetail; core errors call it detail).
// Synthetic data only.
import { makeCtxFor, type ContractHarness } from '../../../../../../../packages/fakes/src/harness';
import { LimsError } from '../../../../core/errors.js';
import { createBillingEvents } from '../../events/publish.js';
import { checkFiscalYear } from '../../domain/fiscalYear.js';
import { IDS, makeLedgerWorld } from '../../service/__tests__/t08.helpers.js';

export interface CreditPartyFixture { id: string; tenantId: string; allowsCredit: boolean; isActive: boolean; isLocked: boolean; creditLimitPaisa: number | null; outstandingPaisa: number }
export interface CreditChargeFixture { id: string; tenantId: string; orderId: string; orderItemId: string | null; creditPartyId: string; amountPaisa: number;
  periodicInvoiceId: string | null; invoiceLineId: string | null; voided: boolean }

export function makeContractWorld() {
  const w: any = makeLedgerWorld({ invoiceNet: null });
  const st = w.s as any;
  st.orders = [] as Array<{ id: string; tenantId: string }>;
  st.parties = [] as CreditPartyFixture[];
  st.accounts = [] as any[];
  st.charges = [] as any[];
  st.tasks = [] as any[];
  st.counters = new Map<string, number>();
  const r: any = w.repo;
  const key = (a: any) => `${a.tenantId}|${a.creditPartyId}`;

  r.getCreditAccount = async (_tx: unknown, a: any) => st.accounts.find((x: any) => x.tenant_id === a.tenantId && x.credit_party_id === a.creditPartyId);
  r.sumOpenCreditExposure = async (_tx: unknown, a: any) => {
    const p = st.parties.find((x: CreditPartyFixture) => x.tenantId === a.tenantId && x.id === a.creditPartyId);
    const open = st.charges.filter((c: any) => c.tenant_id === a.tenantId && c.credit_party_id === a.creditPartyId && c.status === 'uninvoiced').reduce((t: number, c: any) => t + Number(c.amount_paisa), 0);
    return String((p?.outstandingPaisa ?? 0) + open);
  };
  r.upsertCreditAccount = async (_tx: unknown, a: any) => {
    w.repoCalls.push({ name: 'upsertCreditAccount', args: a });
    if (!st.accounts.some((x: any) => `${x.tenant_id}|${x.credit_party_id}` === key(a))) {
      st.accounts.push({ tenant_id: a.tenantId, credit_party_id: a.creditPartyId, is_locked: false, credit_limit_paisa: null, party_code: a.partyCode, party_name: a.partyName, pan: a.pan ?? null, address: a.address ?? null });
    }
  };
  r.insertCreditCharges = async (_tx: unknown, rows: any[]) => { w.repoCalls.push({ name: 'insertCreditCharges', args: { tenantId: rows[0]?.tenant_id } }); st.charges.push(...structuredClone(rows)); };
  r.listCreditChargesByOrder = async (_tx: unknown, a: any) => structuredClone(st.charges.filter((c: any) => c.tenant_id === a.tenantId && c.order_id === a.orderId));
  r.voidCreditChargesByIds = async (_tx: unknown, a: any) => {
    let n = 0;
    for (const c of st.charges) if (c.tenant_id === a.tenantId && a.ids.includes(c.id) && c.status === 'uninvoiced') { c.status = 'voided'; c.void_reason_code = a.reasonCode; n++; }
    return n;
  };
  r.listInvoicesByOrder = async (_tx: unknown, a: any) => st.invoices.filter((i: any) => i.tenant_id === a.tenantId && i.order_id === a.orderId).map((i: any) => ({ id: i.id, status: i.status }));
  r.listInvoiceLinesByOrder = async (_tx: unknown, a: any) => {
    const ids = new Set(st.invoices.filter((i: any) => i.tenant_id === a.tenantId && i.order_id === a.orderId).map((i: any) => i.id));
    return st.lines.filter((l: any) => l.tenant_id === a.tenantId && ids.has(l.invoice_id)).map((l: any) => ({ id: l.id, invoice_id: l.invoice_id, order_item_id: l.order_item_id }));
  };
  r.insertCreditNoteTask = async (_tx: unknown, row: any) => { w.repoCalls.push({ name: 'insertCreditNoteTask', args: { tenantId: row.tenant_id } }); st.tasks.push(structuredClone(row)); };

  /** Whatever ctx the current port call runs with: the counter reads its clock (injected `now`), like the real allocatedAt. */
  const cur: { now: () => string } = { now: () => '2026-11-05T04:15:00.000Z' };
  /** Per-series gapless counter + the real fiscal-year rollover rule (counter.service step 3): nothing is bumped when the FY moved. */
  const counter = {
    async allocate(_tx: unknown, input: any) {
      w.counterCalls.push({ ...input });
      const allocatedAt = cur.now();
      if (!checkFiscalYear(allocatedAt as never, input.timezone ?? 'Asia/Kathmandu', input.fiscalYearBs).ok) throw Object.assign(new LimsError('billing.counter_busy', 'fiscal_year_rollover'), { retryAfterSeconds: 1 });
      const k = `${input.tenantId}|${input.series}|${input.fiscalYearBs}`;
      const n = (st.counters.get(k) ?? 0) + 1;
      st.counters.set(k, n);
      return { lastNo: n, allocatedAt };
    },
  };

  const fakePorts = {
    FrontdeskPort: {
      async getOrderSummary(c: any, i: { orderId: string }) {
        if (!st.orders.some((o: any) => o.tenantId === c.tenantId && o.id === i.orderId)) throw new LimsError('common.not_found');
        return { orderId: i.orderId, registrationNo: 'R-0001', patientId: IDS.patient, branchId: IDS.branch, centreId: IDS.centre, visitType: 'opd', billingMode: 'cash', priority: 'routine', status: 'registered', source: 'front_desk', items: [] };
      },
    },
    CatalogPort: {
      async getCreditParty(c: any, i: { creditPartyId: string; purpose: string }) {
        const p = st.parties.find((x: CreditPartyFixture) => x.tenantId === c.tenantId && x.id === i.creditPartyId);
        if (!p) throw new LimsError('common.not_found');
        return { creditPartyId: p.id, code: 'SYN-PARTY', name: 'Synthetic Credit Party', kind: 'company', allowsCredit: p.allowsCredit, isActive: p.isActive,
          ...(i.purpose === 'billing' ? { pan: '123456789', billingAddressText: 'Synthetic Street 1' } : {}) };
      },
    },
  };

  /** harness ctx -> the ctx a handler would hand the port: event-db tx, cashier membership, tenant settings port. */
  const enrich = (c: any) => {
    cur.now = c.now;
    const base: any = w.ctx();
    return { ...c, tx: base.tx, actor: { ...c.actor, membershipId: c.actor.membershipId ?? c.actor.id }, ports: { ...base.ports, ...fakePorts, ...c.ports } };
  };
  const deps = { repo: w.repo, counter, events: createBillingEvents(w.events as never) } as never;
  return Object.assign(w, { deps, enrich, counter, fakePorts, st });
}
export type ContractWorld = ReturnType<typeof makeContractWorld>;

const withSafeDetail = (e: any) => { if (e && typeof e === 'object' && e.detail !== undefined && e.safeDetail === undefined) e.safeDetail = e.detail; return e; };

/** () => Promise<ContractHarness> over the real implementation (dynamic import: the harness self-tests pass before the impl exists). */
export function realHarness(): () => Promise<ContractHarness> {
  return async () => {
    const world = makeContractWorld();
    const mod: any = await import('../../ports/BillingCommandPort.impl.js');
    const real = mod.createBillingCommandPort(world.deps);
    const impl: any = new Proxy({}, {
      get: (_t, m: string) => async (c: any, i: unknown) => { try { return await real[m](world.enrich(c), i); } catch (e) { throw withSafeDetail(e); } },
    });
    const st = world.st;
    return {
      impl,
      ctxFor: makeCtxFor(),
      events: { ofType: (t: string) => world.db.events.filter((e: any) => e.eventType === t).map((e: any) => e.envelope) } as never,
      async seed(f: any) {
        for (const o of f.orders ?? []) st.orders.push(o);
        for (const p of f.creditParties ?? []) {
          st.parties.push(p);
          if (p.isLocked || p.creditLimitPaisa !== null) st.accounts.push({ tenant_id: p.tenantId, credit_party_id: p.id, is_locked: p.isLocked, credit_limit_paisa: p.creditLimitPaisa === null ? null : String(p.creditLimitPaisa) });
        }
        for (const i of f.invoices ?? []) {
          st.invoices.push({ id: i.id, tenant_id: i.tenantId, order_id: i.orderId, purpose: i.purpose, status: 'issued', net_paisa: i.netPaisa, invoice_no: i.invoiceNo, fiscal_year_bs: i.fiscalYearBs, issued_at: i.issuedAt });
        }
        for (const c of f.creditCharges ?? []) {
          st.charges.push({ id: c.id, tenant_id: c.tenantId, order_id: c.orderId, order_item_id: c.orderItemId, credit_party_id: c.creditPartyId, amount_paisa: c.amountPaisa,
            status: c.voided ? 'voided' : c.periodicInvoiceId ? 'invoiced' : 'uninvoiced', invoice_id: c.periodicInvoiceId, invoice_line_id: c.invoiceLineId });
        }
      },
      rollback() { /* the shared suite never rolls back; atomicity is asserted in BillingCommandPort.contract.test.ts */ },
    } as ContractHarness;
  };
}
