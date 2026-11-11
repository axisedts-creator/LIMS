// Khalti KPG-2 adapter: initiate + lookup (PG-T07; TRD §7.1, §7.3.1-7.3.3; REQ-SEC-047/048/056) + refundViaApi (PG-T15; TRD §7.4, UNVERIFIED shape V13).
// Body `status` is the signal (callGateway ignores the HTTP code when it is present); `Authorization: Key <secret>`;
// initiate body has the 5 documented fields only (no PII); the secret is only ever read inside SecretHandle.use().
import { LimsError } from '../../../core/errors.js';
import { assertAmountSupported } from '../domain/amount.js';
import type { SecretHandle } from '../service/credentials.js';
import { callGateway, type GatewayCallInput, type GatewayTimeouts } from './http.js';

/** refundOrigin = LIMS_PAYMENTS_KHALTI_REFUND_ORIGIN (scheme + host, no path); absent = no refund API call can be made. */
export interface KhaltiAdapterConfig { baseUrl: string; publicBaseUrl: string; timeouts: GatewayTimeouts; refundOrigin?: string }
export interface CallContext {
  timeoutClass?: 'inrequest' | 'job';
  sink?: GatewayCallInput['sink'];
  log?: GatewayCallInput['log'];
}
export interface IntentForGateway {
  intentId: string; amountPaisa: number; callbackToken: string; websiteUrl: string; purchaseOrderName: string;
}
export interface StoredIntent { intentId: string; gatewayTxnRef: string; amountPaisa: number; paymentUrl?: string }
export type IntentAction = { kind: 'redirect'; url: string };
export interface StoredRefund { refundId: string; intentId: string; transactionId: string; amountPaisa: number; fullRefund: boolean }
export type RefundApiOutcome = { kind: 'accepted' | 'rejected' | 'unknown'; detail?: string };
export type GatewayCheck =
  | { kind: 'answer'; statusRaw: string; amountPaisa?: number; secondaryRef?: string; refundedFlag: boolean }
  | { kind: 'transient'; reason: string }
  | { kind: 'auth_error' }
  | { kind: 'not_found' };

const MAX_PIDX = 64;
const TXN_ID = /^[A-Za-z0-9_-]{1,64}$/;   // goes into a URL path: no '.', '/', '?' or '#'
const REFUND_OK = 'Transaction refund successful.';
const DEFAULT_TTL_MS = 60 * 60 * 1000; // TRD §6.1 step 10: both expires_at and expires_in absent -> 60 min

const unavailable = (): LimsError => new LimsError('payments.gateway_not_available');
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function expiresAt(body: Record<string, unknown>): string {
  const at = typeof body['expires_at'] === 'string' ? Date.parse(body['expires_at']) : NaN;
  if (Number.isFinite(at)) return new Date(at).toISOString();
  const inSec = body['expires_in'];
  const ms = typeof inSec === 'number' && Number.isFinite(inSec) && inSec > 0 ? inSec * 1000 : DEFAULT_TTL_MS;
  return new Date(Date.now() + ms).toISOString();
}

export function createKhaltiAdapter(cfg: KhaltiAdapterConfig) {
  const base = cfg.baseUrl.endsWith('/') ? cfg.baseUrl : `${cfg.baseUrl}/`;
  const headers = (key: string): Record<string, string> => ({ Authorization: `Key ${key}`, 'Content-Type': 'application/json' });

  return {
    gateway: 'khalti' as const,

    async initiate(i: IntentForGateway, s: SecretHandle, c: CallContext = {}) {
      assertAmountSupported('khalti', i.amountPaisa); // defence in depth; no network on failure
      // Explicit field list: nothing else on `i` can reach the wire (no PHI, TRD §7.3.2).
      const body = JSON.stringify({
        return_url: `${cfg.publicBaseUrl.replace(/\/+$/, '')}/v1/payments/callbacks/khalti/${i.callbackToken}`,
        website_url: i.websiteUrl,
        amount: i.amountPaisa,
        purchase_order_id: i.intentId,
        purchase_order_name: i.purchaseOrderName,
      });
      const r = await s.use((key) => callGateway({
        gateway: 'khalti', operation: 'khalti_initiate', url: `${base}epayment/initiate/`, method: 'POST',
        headers: headers(key), body, timeoutClass: 'initiate', timeouts: cfg.timeouts, intentId: i.intentId,
        ...(c.sink ? { sink: c.sink } : {}), ...(c.log ? { log: c.log } : {}),
      }));
      if (r.outcome !== 'answer' || !isObj(r.json)) throw unavailable();
      const j = r.json;
      const { pidx, payment_url: paymentUrl } = j;
      if (j['error_key'] !== undefined) throw unavailable();
      if (typeof pidx !== 'string' || pidx.length === 0 || pidx.length > MAX_PIDX) throw unavailable();
      let https = false;
      try { https = typeof paymentUrl === 'string' && new URL(paymentUrl).protocol === 'https:'; } catch { /* not a URL */ }
      if (!https) throw unavailable();
      const url = paymentUrl as string;
      return { gatewayTxnRef: pidx, action: { kind: 'redirect', url } as IntentAction, expiresAt: expiresAt(j), paymentUrl: url };
    },

    buildAction(i: Pick<StoredIntent, 'paymentUrl'>, _s: SecretHandle): IntentAction {
      if (typeof i.paymentUrl !== 'string') throw unavailable();
      return { kind: 'redirect', url: i.paymentUrl };
    },

    /** Never throws on transport trouble. Only the stored pidx is sent; callback data is not an input. */
    async check(i: StoredIntent, s: SecretHandle, c: CallContext = {}): Promise<GatewayCheck> {
      const r = await s.use((key) => callGateway({
        gateway: 'khalti', operation: 'khalti_lookup', url: `${base}epayment/lookup/`, method: 'POST',
        headers: headers(key), body: JSON.stringify({ pidx: i.gatewayTxnRef }),
        timeoutClass: c.timeoutClass ?? 'inrequest', timeouts: cfg.timeouts, intentId: i.intentId,
        ...(c.sink ? { sink: c.sink } : {}), ...(c.log ? { log: c.log } : {}),
      }));
      if (r.outcome === 'auth_error') return { kind: 'auth_error' };
      if (r.outcome === 'not_found') return { kind: 'not_found' };
      if (r.outcome !== 'answer') return { kind: 'transient', reason: r.outcome };
      const j = r.json;
      if (!isObj(j) || typeof j['status'] !== 'string') return { kind: 'transient', reason: 'no_status' };
      const total = j['total_amount'];
      const txn = j['transaction_id'];
      return {
        kind: 'answer',
        statusRaw: j['status'],
        // REQ-SEC-048: only a positive safe JSON integer is trusted as paisa; anything else -> undefined -> amount_mismatch.
        ...(typeof total === 'number' && Number.isSafeInteger(total) && total > 0 ? { amountPaisa: total } : {}),
        ...(typeof txn === 'string' && txn !== '' ? { secondaryRef: txn } : {}),
        refundedFlag: j['refunded'] === true,
      };
    },

    /**
     * TRD §7.4 [UNVERIFIED V13]: ONE POST, never retried (idempotency undocumented), never throws on transport / HTTP trouble. 'accepted' only for a 2xx answer whose
     * body.detail is the documented success text; everything else is 'unknown' (no failure body is documented, so 'rejected' is not produced today). Confirmation is by lookup.
     * Bad input throws before any network call.
     */
    async refundViaApi(r: StoredRefund, s: SecretHandle, c: CallContext = {}): Promise<RefundApiOutcome> {
      if (!cfg.refundOrigin || typeof r.transactionId !== 'string' || !TXN_ID.test(r.transactionId)) throw unavailable();
      if (!r.fullRefund && !(typeof r.amountPaisa === 'number' && Number.isSafeInteger(r.amountPaisa) && r.amountPaisa >= 1)) throw unavailable();
      const origin = cfg.refundOrigin.replace(/\/+$/, '');
      const res = await s.use((key) => callGateway({
        gateway: 'khalti', operation: 'khalti_refund', url: `${origin}/api/merchant-transaction/${r.transactionId}/refund/`, method: 'POST',
        headers: headers(key), body: JSON.stringify(r.fullRefund ? {} : { amount: r.amountPaisa }),   // documented fields only: no ids, reason or mobile
        timeoutClass: c.timeoutClass ?? 'job', timeouts: cfg.timeouts, intentId: r.intentId,
        ...(c.sink ? { sink: c.sink } : {}), ...(c.log ? { log: c.log } : {}),
      }));
      const j = res.json;
      if (res.outcome === 'answer' && res.httpStatus !== null && res.httpStatus >= 200 && res.httpStatus < 300 && isObj(j) && j['detail'] === REFUND_OK) return { kind: 'accepted', detail: REFUND_OK };
      return { kind: 'unknown', detail: res.outcome };
    },
  };
}
