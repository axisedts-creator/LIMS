// eSewa ePay v2 adapter (PG-T06; TRD §7.1, §7.2.2-§7.2.4; REQ-SEC-047/048/049/056/101).
// Reports facts only (sign, form action, signature check, status check); the service decides outcomes (PG-T14).
// No floating point anywhere: amounts go through domain/amount.ts (exact decimal).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { formatRupees, rupeesTextToPaisa } from '../domain/amount.js';
import type { SecretHandle } from '../service/credentials.js';
import {
  MAX_RESPONSE_BYTES, MAX_STATUS_RAW_CHARS, cutChars, redactResponse,
  type GatewayCallOutcome, type GatewayCallRecord, type GatewayTimeouts, type TimeoutClass,
} from './http.js';

export interface StoredIntent {
  readonly id: string;
  readonly gatewayTxnRef: string;
  readonly amountPaisa: number;
  readonly productCode: string;
  readonly callbackToken: string;
}
export interface IntentAction { kind: 'form_post'; url: string; fields: Record<string, string>; launchUrl: string }
export type GatewayCheck =
  | { kind: 'answer'; statusRaw: string; amountPaisa?: number; secondaryRef?: string }
  | { kind: 'transient'; reason: string };
export interface CallContext {
  timeoutClass: Exclude<TimeoutClass, 'initiate'>;
  attempt?: number;
  sink?: (row: GatewayCallRecord) => void | Promise<void>;
  log?: (fields: Record<string, string | number | null>) => void;
}
export interface EsewaAdapterConfig {
  formUrl: string;
  statusUrl: string;
  publicBase: string; // no trailing slash
  timeouts: GatewayTimeouts;
  allowFractionalRupees?: boolean;
}

const REQUEST_NAMES = ['total_amount', 'transaction_uuid', 'product_code'] as const;
const REQUIRED_KEYS = ['status', 'signature', 'total_amount', 'transaction_uuid', 'product_code', 'signed_field_names'] as const;
const MAX_CALLBACK_BYTES = 4096;
const SIG_BYTES = 32;
const TOTAL_AMOUNT_RE = /"totalAmount"\s*:\s*(-?\d+(?:\.\d+)?)/;

/** base64(HMAC-SHA256(secret, "n=v,n=v")) in the given name order (TRD §7.2.2). */
export function esewaSign(secret: string, fields: Readonly<Record<string, string>>, names: readonly string[]): string {
  return createHmac('sha256', secret).update(names.map((n) => `${n}=${fields[n]}`).join(',')).digest('base64');
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

class TooLarge extends Error {}

async function readCapped(res: Response, ac: AbortController): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) { ac.abort(); throw new TooLarge(); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createEsewaAdapter(cfg: EsewaAdapterConfig) {
  const amountText = (paisa: number): string => formatRupees(paisa, { allowFractional: cfg.allowFractionalRupees === true });

  async function buildAction(i: StoredIntent, s: SecretHandle): Promise<IntentAction> {
    const a = amountText(i.amountPaisa);
    const token = encodeURIComponent(i.callbackToken);
    const fields: Record<string, string> = {
      amount: a, tax_amount: '0', product_service_charge: '0', product_delivery_charge: '0',
      product_code: i.productCode, total_amount: a, transaction_uuid: i.gatewayTxnRef,
      success_url: `${cfg.publicBase}/v1/payments/callbacks/esewa/${token}/success`,
      failure_url: `${cfg.publicBase}/v1/payments/callbacks/esewa/${token}/failure`,
      signed_field_names: REQUEST_NAMES.join(','),
    };
    fields['signature'] = await s.use((secret) => esewaSign(secret, fields, REQUEST_NAMES));
    return { kind: 'form_post', url: cfg.formUrl, fields, launchUrl: `${cfg.publicBase}/v1/payments/launch/${token}` };
  }

  async function verifyCallbackSignature(
    payloadB64: string, s: SecretHandle, i: StoredIntent,
  ): Promise<{ valid: boolean; fields?: Readonly<Record<string, string>> }> {
    const invalid = { valid: false } as const;
    if (typeof payloadB64 !== 'string') return invalid;
    const raw = Buffer.from(payloadB64, 'base64');
    if (raw.length === 0 || raw.length > MAX_CALLBACK_BYTES) return invalid;
    let doc: unknown;
    try { doc = JSON.parse(raw.toString('utf8')); } catch { return invalid; }
    if (!isPlainObject(doc)) return invalid;
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(doc)) {
      if (typeof v !== 'string') return invalid; // all fields are strings
      fields[k] = v;
    }
    if (!REQUIRED_KEYS.every((k) => Object.hasOwn(fields, k))) return invalid;
    const names = fields['signed_field_names']!.split(',');
    if (!REQUEST_NAMES.every((n) => names.includes(n))) return invalid; // REQ-SEC-049
    if (!names.every((n) => Object.hasOwn(fields, n))) return invalid;

    const expected = Buffer.from(await s.use((secret) => esewaSign(secret, fields, names)), 'base64');
    const provided = Buffer.from(fields['signature']!, 'base64');
    if (provided.length !== SIG_BYTES || expected.length !== SIG_BYTES) return invalid; // length check before timingSafeEqual
    if (!timingSafeEqual(provided, expected)) return invalid;

    if (fields['transaction_uuid'] !== i.gatewayTxnRef || fields['product_code'] !== i.productCode) return invalid;
    return { valid: true, fields };
  }

  async function check(i: StoredIntent, _s: SecretHandle, ctx: CallContext): Promise<GatewayCheck> {
    // The status check needs no secret (TRD §7.2.4 / P22); the handle is never read here.
    const url = new URL(cfg.statusUrl);
    url.searchParams.set('product_code', i.productCode);
    url.searchParams.set('total_amount', amountText(i.amountPaisa));
    url.searchParams.set('transaction_uuid', i.gatewayTxnRef);

    const ac = new AbortController();
    const started = performance.now();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ac.abort(); }, cfg.timeouts[`${ctx.timeoutClass}Ms`]);
    let outcome: GatewayCallOutcome;
    let httpStatus: number | null = null;
    let text = '';
    let json: unknown;
    let parsed = false;
    try {
      const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: ac.signal });
      httpStatus = res.status;
      text = await readCapped(res, ac);
      try { json = JSON.parse(text); parsed = true; } catch { /* non-JSON body */ }
      const obj = parsed && isPlainObject(json) ? json : null;
      if (httpStatus >= 500) outcome = 'service_unavailable';
      else if (obj && typeof obj['status'] === 'string') outcome = 'answer'; // status-bearing body is an answer whatever the HTTP code
      else if (obj && obj['code'] === 0) outcome = 'service_unavailable';
      else if (httpStatus === 401 || httpStatus === 403) outcome = 'auth_error';
      else if (httpStatus === 404) outcome = 'not_found';
      else outcome = httpStatus >= 200 && httpStatus < 300 ? 'invalid_response' : 'http_error';
    } catch (e) {
      outcome = e instanceof TooLarge ? 'invalid_response' : timedOut ? 'timeout' : 'network_error';
      if (timedOut) httpStatus = null;
    } finally {
      clearTimeout(timer);
    }
    const durationMs = Math.max(0, Math.trunc(performance.now() - started));
    const obj = outcome !== 'invalid_response' && parsed && isPlainObject(json) ? json : null;
    const statusRaw = obj && typeof obj['status'] === 'string' ? obj['status'] : null;

    const row: GatewayCallRecord = {
      gateway: 'esewa', operation: 'esewa_status', attempt: ctx.attempt ?? 1, httpStatus, outcome,
      gatewayStatusRaw: statusRaw === null ? null : cutChars(statusRaw, MAX_STATUS_RAW_CHARS),
      responseRedacted: obj ? redactResponse('esewa', 'esewa_status', obj) : null,
      durationMs,
    };
    try { await ctx.sink?.(row); } catch { /* evidence logging must not change the outcome */ }
    try {
      ctx.log?.({ gateway: 'esewa', operation: 'esewa_status', outcome, http_status: httpStatus, duration_ms: durationMs, intent_id: i.id });
    } catch { /* ditto */ }

    if (outcome !== 'answer' || obj === null || statusRaw === null) return { kind: 'transient', reason: outcome };

    // Exact decimal from the raw text; scd present but different = identity mismatch, never a matching amount.
    const m = TOTAL_AMOUNT_RE.exec(text);
    const scdOk = obj['scd'] === undefined || obj['scd'] === i.productCode;
    const paisa = m && scdOk ? rupeesTextToPaisa(m[1]!) : undefined;
    const ref = obj['refId'];
    return {
      kind: 'answer', statusRaw,
      ...(paisa !== undefined ? { amountPaisa: paisa } : {}),
      ...(typeof ref === 'string' && ref !== '' ? { secondaryRef: ref } : {}),
    };
  }

  return { gateway: 'esewa' as const, buildAction, verifyCallbackSignature, check };
}
