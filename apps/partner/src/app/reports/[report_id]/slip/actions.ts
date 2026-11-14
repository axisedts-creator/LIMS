'use server';
// PR-2 slip server actions: R4 request and R5 poll through the partner BFF (partnerApi: session, CSRF, path guard). Only { id, state, link_expires_at, failure_code } reaches the browser;
// the API never returns a link and this layer would drop one anyway (explicit allowlist). The PDF itself comes from the R6 route handler next to this file.
import 'server-only';
import { partnerApi } from '@/core/api';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SlipView { id: string; state: string; link_expires_at?: string; failure_code?: string }
export type SlipResult = { ok: true; slip: SlipView } | { ok: false; code: string };

const view = (d: any): SlipView => ({
  id: String(d.id), state: String(d.state),
  ...(typeof d.link_expires_at === 'string' ? { link_expires_at: d.link_expires_at } : {}),
  ...(typeof d.failure_code === 'string' ? { failure_code: d.failure_code } : {}),
});

/** R4 POST /v1/partners/reports/{report_id}/access-slips (Idempotency-Key per page visit). */
export async function requestSlip(reportId: string, idempotencyKey: string): Promise<SlipResult> {
  if (!UUID.test(reportId) || !/^[A-Za-z0-9_-]{8,64}$/.test(idempotencyKey)) return { ok: false, code: 'common.validation_failed' };
  const r = await partnerApi(`/v1/partners/reports/${reportId}/access-slips`, { method: 'POST', body: {}, headers: { 'idempotency-key': idempotencyKey } });
  return r.ok ? { ok: true, slip: view(r.data) } : { ok: false, code: r.problem.code };
}

/** R5 GET /v1/partners/reports/{report_id}/access-slips/{access_slip_id} (ponytail: a poll touches the session like any call; send x-lims-background if TRD §5.4 idle handling must ignore it). */
export async function readSlip(reportId: string, slipId: string): Promise<SlipResult> {
  if (!UUID.test(reportId) || !UUID.test(slipId)) return { ok: false, code: 'common.validation_failed' };
  const r = await partnerApi(`/v1/partners/reports/${reportId}/access-slips/${slipId}`);
  return r.ok ? { ok: true, slip: view(r.data) } : { ok: false, code: r.problem.code };
}
