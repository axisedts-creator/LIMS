// T0D-OFFLINE-3 (LD-322 decision 1): offline registration, receipts (provisional numbers), collection and accession.
// One outbox append per write (operation + local record, one transaction); online refusal codes; a refused order spends nothing.
import { provisionalNumber, type NextNumber, type Numbers } from './numbers';
import { uuidV7Factory, type ConflictItem, type AttentionItem, type Operation, type Outbox, type ReservedNumbers } from './outbox';
import type { Prefetcher } from './prefetch';
import { OfflineError, req, type OfflineStore, type SealedRecord } from './store';

/** CreateRegistrationRequest keys (contracts/openapi/frontdesk.yaml): nothing else travels in the payload */
const REG_KEYS = ['patient', 'centre_id', 'visit_type', 'billing_mode', 'credit_party_id', 'referrer_id', 'priority', 'collection_mode', 'items', 'discounts', 'buyer_pan',
  'payments', 'collection_at', 'collected_by_membership_id', 'collected_by_name', 'sample_not_collected', 'sample_remark', 'remark_description', 'clinical_history',
  'patient_history', 'mr_number', 'external_reference', 'insurance_code', 'insurance_claim_amount_paisa', 'visiting_charge_paisa'] as const;
// online only fields
const ONLINE_ONLY_FIELDS = ['coupon_code', 'redeem_reward_points', 'trf_attachment_ids', 'discount_approval_id'] as const;
const MAX_ITEMS = 50;
const MAX_PAYMENTS = 5;
const SEARCH_LIMIT = 20;

/* eslint-disable @typescript-eslint/no-explicit-any -- checked here */
type Any = any;
export type RecordStatus = { state: 'pending' } | { state: 'conflict'; code?: string | undefined; conflict_id: string } | { state: 'rejected'; code: string };
export interface FlowsOptions { store: OfflineStore; outbox: Outbox; prefetcher?: Prefetcher; numbers: Numbers; deviceId: string; permissions: readonly string[]; now?: () => number }

const fail = (code: string): never => { throw new OfflineError(code); };
const bad = () => fail('common.validation_failed');
const str = (v: unknown) => typeof v === 'string' && v.trim() !== '';
const paisa = (v: unknown) => Number.isSafeInteger(v) && (v as number) > 0;
const pct = (p: number, bp: number) => Math.round((p * bp) / 10_000);
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
const lab = (it: Any, n: NextNumber) => ({ orderable_id: it.orderable_id, value: n.value, provisional: n.provisional, ...(n.mark ? { mark: n.mark } : {}) });

export function createOfflineFlows(o: FlowsOptions) {
  const { store, outbox, numbers } = o;
  const now = o.now ?? Date.now;
  const newId = outbox.nextId ?? uuidV7Factory(now);
  const can = (p: string) => { if (!o.permissions.includes(p)) fail('auth.forbidden'); if (!store.isUnlocked()) fail('offline.locked'); };
  const list = async (type: string): Promise<Any[]> => {
    const keys = (await store.keys('refdata')).filter((k) => k.startsWith(`${type}:`));
    return (await Promise.all(keys.map((k) => store.get('refdata', k)))).filter(Boolean);
  };

  /** the ACTIVE version: highest published version already in effect (not a future one) */
  async function priceList(): Promise<Any | null> {
    const t = now();
    const v = (await list('price_list_version')).filter((p) => p.status === 'published' && Array.isArray(p.items) && !(Date.parse(p.effective_from) > t));
    return v.sort((a, b) => b.version_no - a.version_no)[0] ?? null;
  }

  async function quote(input: Any) {
    const items: Any[] = Array.isArray(input?.items) ? input.items : [];
    const pl = await priceList();
    const price = new Map<string, number>((pl?.items ?? []).map((i: Any) => [i.orderable_id, i.unit_price_paisa]));
    const lines = items.map((i) => ({ orderable_id: i?.orderable_id, gross: price.get(i?.orderable_id) }));
    if (!pl || lines.some((l) => !Number.isSafeInteger(l.gross))) return { ok: false as const, code: 'catalog.no_price' };
    const disc = lines.map(() => 0);
    let left = lines.reduce((a, l) => a + l.gross!, 0);
    const gross = left;
    for (const d of Array.isArray(input?.discounts) ? input.discounts : []) { // the server order: line discounts first, then bill discounts on what is left
      const amount = (base: number) => (d?.kind === 'amount' ? d.amount_paisa : d?.kind === 'percent' ? pct(base, d.percent_bp) : NaN);
      if (d?.scope === 'line') {
        const i = lines.findIndex((l) => l.orderable_id === d.orderable_id);
        const a = i < 0 ? NaN : amount(lines[i]!.gross! - disc[i]!);
        if (!Number.isSafeInteger(a) || a < 0 || a > lines[i]!.gross! - disc[i]!) bad();
        disc[i]! += a; left -= a;
      }
    }
    for (const d of Array.isArray(input?.discounts) ? input.discounts : []) {
      if (d?.scope === 'line') continue;
      const a = d?.scope === 'bill' ? (d.kind === 'amount' ? d.amount_paisa : d.kind === 'percent' ? pct(left, d.percent_bp) : NaN) : NaN;
      if (!Number.isSafeInteger(a) || a < 0 || a > left) bad();
      left -= a;
    }
    const discount = gross - left;
    const limit = Number.isSafeInteger(pl.discount_limit_percent_bp) ? pl.discount_limit_percent_bp : 0;
    const within = discount === 0 || (gross > 0 && discount * 10_000 <= limit * gross);
    // CR (tests note): the server fingerprint also covers tax lines the cache does not hold; a mismatch surfaces as common.version_conflict at sync
    const fp = hex(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([pl.id, lines, input?.discounts ?? [], gross, discount]))));
    return {
      ok: true as const, gross_paisa: gross, discount_paisa: discount, net_paisa: left, price_list_version_id: pl.id as string, quote_fingerprint: fp,
      discount_evaluation: { within_limit: within, approval_required: !within, limit_percent_bp: limit },
    };
  }

  async function lists() {
    const [pending, conflicts, attention] = await Promise.all([outbox.pending(), outbox.conflicts(), outbox.needsAttention()]);
    return { pending, conflicts, attention } as { pending: Operation[]; conflicts: ConflictItem[]; attention: AttentionItem[] };
  }
  /** pending first, then conflict, then rejected; keyed by op id and by entity id */
  async function statusMap(): Promise<Record<string, RecordStatus>> {
    const l = await lists(); const m: Record<string, RecordStatus> = {};
    // T0D-OFFLINE-4 (LD-322): a result.enter has no entity id; its result ids are payload.entries[].result_id
    const ids = (op: Operation) => (op.op_type === 'result.enter' ? ((op.payload as Any)?.entries ?? []).map((e: Any) => e?.result_id) : []);
    const put = (op: Operation, s: RecordStatus) => { for (const k of [op.op_id, op.entity_id, ...ids(op)]) if (typeof k === 'string' && k && !m[k]) m[k] = s; };
    for (const op of l.pending) put(op, { state: 'pending' });
    for (const c of l.conflicts) put(c, { state: 'conflict', code: c.code, conflict_id: c.conflict_id });
    for (const a of l.attention) put(a, { state: 'rejected', code: a.code });
    return m;
  }

  /** a state move: one operation per (type, record, version) */
  async function move(perm: string, op_type: string, input: Any, payload: Record<string, unknown>, valid = true) {
    can(perm);
    if (!valid || !str(input?.specimen_id) || !Number.isSafeInteger(input?.version) || input.version < 0) bad();
    if ((await outbox.pending()).some((p) => p.op_type === op_type && p.entity_id === input.specimen_id && p.base_version === input.version)) return { ok: true, queued: false, duplicate: true };
    const op = await outbox.append({ op_type, entity_id: input.specimen_id, base_version: input.version, payload });
    return { ok: true, queued: true, op_id: op.op_id };
  }

  const flows = {
    numbers,
    async searchPatients(q: string) {
      const s = String(q ?? '').trim().toLowerCase();
      if (!s) return [];
      const digits = /^[+\d\s-]+$/.test(s) ? s.replace(/\D/g, '') : '';
      const live = await statusMap();
      const local = (await list('order')).filter((r) => r.patient && live[r.op_id]).map((r) => r.patient);
      return [...(await list('patient')), ...local].filter((p) => String(p.full_name ?? '').toLowerCase().includes(s) || String(p.patient_code ?? '').toLowerCase().includes(s)
        || (digits.length >= 4 && String(p.phone_e164 ?? '').replace(/\D/g, '').includes(digits))).slice(0, SEARCH_LIMIT);
    },
    async searchTests(q: string) {
      const s = String(q ?? '').trim().toLowerCase();
      if (!s) return [];
      const pl = await priceList();
      const price = new Map<string, number>((pl?.items ?? []).map((i: Any) => [i.orderable_id, i.unit_price_paisa]));
      return (await list('test')).filter((t) => String(t.code ?? '').toLowerCase().includes(s) || String(t.name ?? '').toLowerCase().includes(s))
        .slice(0, SEARCH_LIMIT).map((t) => ({ ...t, unit_price_paisa: price.get(t.id) ?? null }));
    },
    quote: async (input: Any) => { try { return await quote(input); } catch (e) { if (e instanceof OfflineError) return { ok: false as const, code: e.code }; throw e; } },

    async registerOrder(input: Any) {
      can('frontdesk.registration.create');
      const items: Any[] = input?.items; const payments: Any[] = input?.payments ?? []; const np = input?.patient?.new_patient;
      if (!Array.isArray(items) || items.length < 1 || items.length > MAX_ITEMS || items.some((i) => !str(i?.orderable_id))) bad();
      if (!str(input?.centre_id) || !Array.isArray(payments) || payments.length > MAX_PAYMENTS) bad();
      if (payments.some((p) => !str(p?.method_code) || !paisa(p?.amount_received_paisa))) bad();
      if (np ? !str(np.full_name) : !str(input?.patient?.patient_id)) bad();
      for (const k of ONLINE_ONLY_FIELDS) { const v = input[k]; if (v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)) fail('sync.offline_not_allowed'); }
      const q = await quote(input);
      if (!q.ok) fail(q.code);
      const qt = q as Exclude<typeof q, { ok: false }>;
      if (qt.discount_evaluation.approval_required) fail('frontdesk.discount_approval_required');
      if (payments.reduce((a, p) => a + p.amount_received_paisa, 0) > qt.net_paisa) bad();

      const op_id = newId();
      const pat = np ? await numbers.next('patient_id') : null;
      const codes = await Promise.all(items.map(() => numbers.next('lab_code')));
      const reserved: ReservedNumbers = {};
      if (pat && !pat.provisional) reserved.patient_id = pat.number!;
      const blockCodes = codes.filter((c) => !c.provisional).map((c) => c.number!);
      if (blockCodes.length) reserved.lab_codes = blockCodes;
      const payload: Record<string, unknown> = {};
      for (const k of REG_KEYS) if (input[k] !== undefined) payload[k] = input[k];
      payload['quote_fingerprint'] = qt.quote_fingerprint;
      const out = {
        op_id, order_local_id: op_id, invoice_no: provisionalNumber(o.deviceId, op_id, 'INV'),
        receipt_nos: payments.map((_p, i) => provisionalNumber(o.deviceId, op_id, i ? `RC${i + 1}` : 'RC')),
        lab_codes: items.map((it, i) => lab(it, codes[i]!)), ...(pat ? { patient_code: pat.value } : {}),
      };
      const local = {
        ...out, created_at: new Date(now()).toISOString(), centre_id: input.centre_id, items, payments, price_list_version_id: qt.price_list_version_id,
        gross_paisa: qt.gross_paisa, discount_paisa: qt.discount_paisa, net_paisa: qt.net_paisa,
        ...(np ? { patient: { ...np, id: op_id, patient_code: pat!.value, local: true } } : { patient_id: input.patient.patient_id }),
      };
      await outbox.append({ op_id, op_type: 'registration.create_order', payload, ...(Object.keys(reserved).length ? { reserved_numbers: reserved } : {}) },
        [{ store: 'refdata', key: `order:${op_id}`, value: local }]);
      return out;
    },

    async recordReceipt(input: Any) {
      can('billing.payment.record');
      if (!str(input?.order_id) || !str(input?.method_code) || !paisa(input?.amount_received_paisa)) bad();
      if (input.balance_due_paisa !== undefined && input.amount_received_paisa > input.balance_due_paisa) fail('billing.payment_exceeds_due');
      const op_id = newId();
      const payload = { method_code: input.method_code, amount_received_paisa: input.amount_received_paisa, ...(str(input.reference) ? { reference: input.reference } : {}) };
      await outbox.append({ op_id, op_type: 'billing.record_receipt', entity_id: input.order_id, payload });
      return { op_id, receipt_no: provisionalNumber(o.deviceId, op_id, 'RC') };
    },

    markCollected: (input: Any) => move('lab.specimen.collect', 'collection.mark_collected', input, { collected_at: new Date(now()).toISOString() }),
    receiveSpecimen: (input: Any) => move('lab.specimen.receive', 'accession.receive', input, { processing_centre_id: input?.processing_centre_id }, str(input?.processing_centre_id)),

    localOrder: (id: string) => store.get<Any>('refdata', `order:${id}`),
    async statusOf(id: string): Promise<RecordStatus | null> { return (await statusMap())[id] ?? null; },
    statusMap,
    /** the final number once the server mapping arrived, else the number itself (every reprint) */
    async display(n: string): Promise<string> {
      if (typeof n !== 'string' || !n.startsWith('OFF-') || !store.isUnlocked()) return n;
      const r = (await store.transact(['mappings'], 'readonly', (s) => req(s('mappings').get(n)))) as SealedRecord | undefined;
      return r ? ((await store.decryptRecord<{ final_number?: string }>('mappings', r)).final_number ?? n) : n;
    },
  };
  return flows;
}

export type OfflineFlows = ReturnType<typeof createOfflineFlows>;
