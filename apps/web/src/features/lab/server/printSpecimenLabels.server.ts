'use server';
// C5 T-10 BFF for the label page: #14a requestOrderLabelPrint (readiness only, writes nothing, no key) and #14 printSpecimenLabels (counted once per printed specimen on the server).
// The bearer token stays server-side (serverFetch). Neither call carries a replay key: #14a is a read-only POST, and a reprint must be counted again (03-APP-FLOW §3.1 step 3).
// Errors become { ok:false, status, code, requestId } (a thrown ApiError loses its code across the action boundary). Ids are checked as UUIDs before they reach a path or body.
import 'server-only';
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import type { OrderLabelPrintResponse, PrintLabelsResponse } from '../components/labels/labelTypes';
import type { ActionResult } from './types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (): ActionResult<never> => ({ ok: false, status: 400, code: 'common.validation_failed' });

async function run<T>(f: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await f() };
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    const id = e.problem.request_id;
    return { ok: false, status: e.status, code: e.problem.code, ...(typeof id === 'string' ? { requestId: id } : {}) };
  }
}

/** #14a. 409 common.version_conflict ("specimens not created yet") comes back as { ok:false, status:409 }: the caller polls. */
export async function requestOrderLabelPrint(orderId: string): Promise<ActionResult<OrderLabelPrintResponse>> {
  if (!UUID.test(orderId)) return { ok: false, status: 404, code: 'common.not_found' };
  return run(() => serverFetch<OrderLabelPrintResponse>(`/v1/lab/orders/${orderId}/label-prints`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
}

/** #14 for specific specimens; copies absent = the tenant default (label_copies_default). */
export async function printSpecimenLabels(body: { specimenIds: string[]; copies?: number }): Promise<ActionResult<PrintLabelsResponse>> {
  const ids = body?.specimenIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 200 || !ids.every((i) => typeof i === 'string' && UUID.test(i))) return bad();
  if (body.copies !== undefined && (!Number.isInteger(body.copies) || body.copies < 1 || body.copies > 5)) return bad();
  const payload = { specimen_ids: ids, ...(body.copies !== undefined ? { copies: body.copies } : {}) };
  return run(() => serverFetch<PrintLabelsResponse>('/v1/lab/specimens/labels', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }));
}
