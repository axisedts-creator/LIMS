import 'server-only';
// P3 recheckPaymentIntent, P4 resolvePaymentIntent (If-Match + Idempotency-Key), P5 cancelPaymentIntent (Idempotency-Key).
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9_-]{1,64}$/;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const RESOLUTIONS = ['settle', 'fail', 'record_exceeding_due'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];
const bad = () => new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
const path = (id: string, op: string) => {
  if (!UUID.test(id)) throw bad();
  return `/v1/payments/intents/${id}/${op}`;
};
const json = { 'content-type': 'application/json' };

export const recheckIntent = (id: string) => serverFetch<{ status?: string }>(path(id, 'recheck'), { method: 'POST', headers: json, body: '{}' });

export function resolveIntent(id: string, version: number, resolution: Resolution, reasonCode: string, note: string | undefined, key: string) {
  const p = path(id, 'resolve');
  if (!KEY.test(key) || !CODE.test(reasonCode) || !RESOLUTIONS.includes(resolution) || !Number.isSafeInteger(version) || version < 0) throw bad();
  const n = note?.trim();
  if (n && n.length > 500) throw bad();
  return serverFetch<{ status?: string }>(p, {
    method: 'POST',
    headers: { ...json, 'idempotency-key': key, 'if-match': `"${version}"` },
    body: JSON.stringify({ resolution, reason_code: reasonCode, ...(n ? { note: n } : {}) }),
  });
}

export function cancelIntent(id: string, reasonCode: string, key: string) {
  const p = path(id, 'cancel');
  if (!KEY.test(key) || !CODE.test(reasonCode)) throw bad();
  return serverFetch<{ status?: string }>(p, { method: 'POST', headers: { ...json, 'idempotency-key': key }, body: JSON.stringify({ reason_code: reasonCode }) });
}
