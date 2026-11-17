// Outbound gateway HTTP wrapper (PG-T04; TRD §3.2, §7.6; REQ-SEC-056/098/101).
// One call = one fetch with a per-class timeout, a 1 MiB response cap, no redirects, never throws on network/timeout/parse
// failure. Stores/logs allowlisted fields only: no request headers/body, no key material, no raw response (ST-11).

export type GatewayName = 'esewa' | 'khalti';
export type GatewayOperation = 'khalti_initiate' | 'khalti_lookup' | 'esewa_status' | 'khalti_refund' | 'credential_test';
export type GatewayCallOutcome =
  | 'answer' | 'service_unavailable' | 'timeout' | 'network_error' | 'http_error' | 'auth_error' | 'not_found' | 'invalid_response';
export type TimeoutClass = 'initiate' | 'inrequest' | 'job';
export type RedactedScalar = string | number | boolean | null;
export type RedactedResponse = Record<string, RedactedScalar>;

export interface GatewayTimeouts { readonly initiateMs: number; readonly inrequestMs: number; readonly jobMs: number }

/** Row handed to `sink` (the caller persists it via gatewayCalls.repo). Shape mirrors payments.gateway_calls. */
export interface GatewayCallRecord {
  gateway: GatewayName;
  operation: GatewayOperation;
  attempt: number;
  httpStatus: number | null;
  outcome: GatewayCallOutcome;
  gatewayStatusRaw: string | null;
  responseRedacted: RedactedResponse | null;
  durationMs: number;
}

export interface GatewayCallInput {
  gateway: GatewayName;
  operation: GatewayOperation;
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutClass: TimeoutClass;
  timeouts: GatewayTimeouts;
  attempt?: number;
  intentId?: string;
  sink?: (row: GatewayCallRecord) => void | Promise<void>;
  log?: (fields: Record<string, string | number | null>) => void;
}

export interface GatewayResult {
  outcome: GatewayCallOutcome;
  httpStatus: number | null;
  durationMs: number;
  json?: unknown;
}

// Allowlists (TRD §7.6). Anything else — incl. Khalti `mobile`, payment_url, tokens, free text — is dropped.
const ALLOW: Readonly<Record<string, readonly string[]>> = Object.freeze({
  esewa_status: ['status', 'totalAmount', 'refId', 'scd', 'code', 'error_message'],
  khalti_lookup: ['status', 'total_amount', 'transaction_id', 'refunded', 'fee'],
  khalti_initiate: ['pidx', 'expires_at', 'expires_in', 'error_key'],
});

/** Schema CHECK is 2048 octets of jsonb::text, which adds ", " / ": " padding; keep headroom. */
const MAX_STORED_BYTES = 2000;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
export const MAX_STATUS_RAW_CHARS = 64;

const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));

/** Cut to `n` code points (char_length semantics; never splits a surrogate pair). */
export const cutChars = (s: string, n: number): string => {
  const cps = Array.from(s);
  return cps.length <= n ? s : cps.slice(0, n).join('');
};

export function redactResponse(gateway: string, operation: string, body: unknown): RedactedResponse | null {
  void gateway; // allowlists are keyed by operation, which implies the gateway
  if (!Object.hasOwn(ALLOW, operation)) return null;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const src = body as Record<string, unknown>;
  const out: RedactedResponse = {};
  for (const key of ALLOW[operation]!) {
    if (!Object.hasOwn(src, key)) continue;
    let v = src[key];
    if (operation === 'esewa_status' && key === 'totalAmount' && typeof v === 'number') v = String(v);
    if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[key] = v;
  }
  // Shrink the longest string until the stored JSON fits the schema cap.
  while (bytes(out) > MAX_STORED_BYTES) {
    let longest: string | null = null;
    for (const k of Object.keys(out)) {
      const v = out[k];
      if (typeof v === 'string' && v.length > 0 && (longest === null || v.length > (out[longest] as string).length)) longest = k;
    }
    if (longest === null) return {}; // only huge numbers left; store nothing rather than break the CHECK
    const cps = Array.from(out[longest] as string);
    out[longest] = cps.slice(0, Math.floor(cps.length / 2)).join('');
  }
  return out;
}

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

function classify(httpStatus: number, json: unknown): GatewayCallOutcome {
  const obj = json !== null && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : null;
  if (httpStatus >= 500) return 'service_unavailable';
  if (obj && typeof obj['status'] === 'string') return 'answer'; // a status-bearing body is an answer whatever the HTTP code (TRD §7.3.3)
  if (obj && obj['code'] === 0) return 'service_unavailable'; // eSewa "service unavailable"
  if (httpStatus === 401 || httpStatus === 403) return 'auth_error';
  if (httpStatus === 404) return 'not_found';
  if (httpStatus >= 200 && httpStatus < 300) return obj ? 'answer' : 'invalid_response';
  return 'http_error';
}

export async function callGateway(input: GatewayCallInput): Promise<GatewayResult> {
  const limit = input.timeouts[`${input.timeoutClass}Ms` as const];
  const ac = new AbortController();
  const started = performance.now();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, limit);

  let outcome: GatewayCallOutcome;
  let httpStatus: number | null = null;
  let json: unknown;
  let parsed = false;
  try {
    const res = await fetch(input.url, {
      method: input.method ?? 'GET',
      ...(input.headers ? { headers: input.headers } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      redirect: 'manual', // never replay Authorization to a redirect target
      signal: ac.signal,
    });
    httpStatus = res.status;
    const text = await readCapped(res, ac);
    try { json = JSON.parse(text); parsed = true; } catch { /* non-JSON body */ }
    outcome = classify(httpStatus, parsed ? json : undefined);
    if (!parsed && httpStatus < 500 && outcome === 'answer') outcome = 'invalid_response';
  } catch (e) {
    if (e instanceof TooLarge) outcome = 'invalid_response';
    else outcome = timedOut ? 'timeout' : 'network_error';
    if (timedOut) httpStatus = null;
  } finally {
    clearTimeout(timer);
  }
  const durationMs = Math.max(0, Math.round(performance.now() - started));
  const usable = outcome !== 'invalid_response' && parsed;

  const rawStatus = usable && json !== null && typeof json === 'object' && typeof (json as Record<string, unknown>)['status'] === 'string'
    ? cutChars((json as Record<string, string>)['status']!, MAX_STATUS_RAW_CHARS) : null;
  const row: GatewayCallRecord = {
    gateway: input.gateway, operation: input.operation, attempt: input.attempt ?? 1, httpStatus, outcome,
    gatewayStatusRaw: rawStatus,
    responseRedacted: usable ? redactResponse(input.gateway, input.operation, json) : null,
    durationMs,
  };
  try { await input.sink?.(row); } catch { /* logging must not change the call outcome; caller's tx handles its own errors */ }
  try {
    input.log?.({
      gateway: input.gateway, operation: input.operation, outcome, http_status: httpStatus, duration_ms: durationMs,
      ...(input.intentId !== undefined ? { intent_id: input.intentId } : {}),
    });
  } catch { /* ditto */ }

  return { outcome, httpStatus, durationMs, ...(usable ? { json } : {}) };
}
