// PR-2 "Download slip (PDF)": GET /reports/{report_id}/slip/{access_slip_id}/file -> R6 downloadPatientAccessSlip through the BFF. The bytes pass through; the browser never gets a link or token
// (the URL / QR exist only inside the PDF, 08 A2.1). requirePartnerSession redirects/throws for any non-active session; the access token stays on the server.
import 'server-only';
import { requirePartnerSession } from '@/core/auth-guard';
import { hex, partnerApiOrigin } from '@/core/session';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const problem = (status: number, code: string) => Response.json({ code, status }, { status, headers: { 'cache-control': 'no-store' } });

export async function GET(_req: Request, { params }: { params: Promise<{ report_id: string; access_slip_id: string }> }): Promise<Response> {
  const { report_id: reportId, access_slip_id: slipId } = await params;
  if (!UUID.test(reportId) || !UUID.test(slipId)) return problem(400, 'common.validation_failed');
  const { accessToken } = await requirePartnerSession();
  let res: Response;
  try {
    res = await fetch(new URL(`/v1/partners/reports/${reportId}/access-slips/${slipId}/file`, partnerApiOrigin()), {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/pdf', 'x-request-id': crypto.randomUUID(), traceparent: `00-${hex(16)}-${hex(8)}-01` },
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return problem(503, 'common.dependency_unavailable');
  }
  if (!res.ok) {
    const j = (await res.json().catch(() => undefined)) as { code?: unknown } | undefined;
    return problem(res.status === 404 ? 404 : res.status >= 500 ? 503 : res.status, typeof j?.code === 'string' ? j.code : 'common.internal');
  }
  return new Response(res.body, {
    status: 200,
    headers: {
      'content-type': 'application/pdf', 'content-disposition': `attachment; filename="access-slip-${slipId}.pdf"`,
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    },
  });
}
