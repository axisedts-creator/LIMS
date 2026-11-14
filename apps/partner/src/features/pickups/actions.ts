'use server';
// C13.T19 pickup write actions (K1 createPickupRequest, K4 cancelPickupRequest) through the partner BFF. Only { ok, code, issues } reaches the browser.
import 'server-only';
import { partnerApi } from '@/core/api';
import { isUuid } from '../common/api';

export interface PickupInput {
  manifest_ids: string[]; window_start: string; window_end: string; packages_count: number;
  notes?: string; contact_name?: string; contact_phone_e164?: string;
}
export type PickupResult = { ok: true } | { ok: false; code: string };

const KEY = /^[A-Za-z0-9_-]{8,64}$/;
const E164 = /^\+[1-9][0-9]{7,14}$/;
const CANCEL = new Set(['no_longer_needed', 'will_deliver_ourselves', 'manifest_withdrawn', 'other']); // 05-SCHEMA §7 pickup_cancel_reasons
const bad: PickupResult = { ok: false, code: 'common.validation_failed' };

export async function createPickupAction(input: PickupInput, idempotencyKey: string): Promise<PickupResult> {
  const ok =
    KEY.test(idempotencyKey) && Array.isArray(input?.manifest_ids) && input.manifest_ids.length >= 1 && input.manifest_ids.length <= 20 && input.manifest_ids.every(isUuid) &&
    Number.isInteger(input.packages_count) && input.packages_count >= 1 && input.packages_count <= 50 &&
    !Number.isNaN(Date.parse(input.window_start)) && !Number.isNaN(Date.parse(input.window_end)) &&
    (input.notes ?? '').length <= 500 && (input.contact_name ?? '').length <= 80 && (input.contact_phone_e164 === undefined || E164.test(input.contact_phone_e164));
  if (!ok) return bad;
  const r = await partnerApi('/v1/partners/pickup-requests', {
    method: 'POST', headers: { 'idempotency-key': idempotencyKey },
    body: {
      manifest_ids: input.manifest_ids, window_start: input.window_start, window_end: input.window_end, packages_count: input.packages_count,
      ...(input.notes ? { notes: input.notes } : {}), ...(input.contact_name ? { contact_name: input.contact_name } : {}), ...(input.contact_phone_e164 ? { contact_phone_e164: input.contact_phone_e164 } : {}),
    },
  });
  return r.ok ? { ok: true } : { ok: false, code: r.problem.code };
}

export async function cancelPickupAction(id: string, version: number, reasonCode: string, idempotencyKey: string): Promise<PickupResult> {
  if (!isUuid(id) || !Number.isInteger(version) || version < 0 || !CANCEL.has(reasonCode) || !KEY.test(idempotencyKey)) return bad;
  const r = await partnerApi(`/v1/partners/pickup-requests/${id}/cancel`, { method: 'POST', headers: { 'if-match': `"${version}"`, 'idempotency-key': idempotencyKey }, body: { reason_code: reasonCode } });
  return r.ok ? { ok: true } : { ok: false, code: r.problem.code };
}
