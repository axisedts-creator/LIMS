import 'server-only';
// S17 "Export CSV" (TRD #93, AC-21.8; 07-SECURITY PE-3, REQ-SEC-081/-096): a same-origin download that proxies GET /v1/inventory/reports/{code}/export.csv with the session
// bearer, which never reaches the browser. The API writes the CSV (50,000-row cap, formula neutralisation, access_log entry); this route forwards it byte for byte.
// Upstream error text is never echoed (403 / 404 / 422 keep their status with an empty body; anything else is 502), the path cannot be steered (report_code is checked
// against the contract list and only report filters are forwarded), and an upstream redirect is never followed.
import { getAccessToken } from '@/core/session/server';
import { isReportCode, reportExportPath, reportQuery } from '@/features/inventory/server/reports.server';

export const dynamic = 'force-dynamic';

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } as const;
const empty = (status: number) => new Response(null, { status, headers: HEADERS });

export async function GET(req: Request, ctx: { params: Promise<{ report_code: string }> }): Promise<Response> {
  const { report_code: code } = await ctx.params;
  if (!isReportCode(code)) return empty(400);
  const token = await getAccessToken();
  const origin = process.env.LIMS_ORIGIN_API;
  if (!token) return empty(401);
  if (!origin) return empty(502);

  const q = reportQuery(Object.fromEntries(new URL(req.url).searchParams));
  let up: Response;
  try {
    up = await fetch(new URL(reportExportPath(code, q), origin), { headers: { authorization: `Bearer ${token}`, accept: 'text/csv' }, cache: 'no-store', redirect: 'error' });
  } catch {
    return empty(502);
  }
  if (up.status === 401) return empty(401);
  if (up.status === 403 || up.status === 404 || up.status === 422) return empty(up.status);
  if (up.status !== 200) return empty(502);

  const disposition = up.headers.get('content-disposition');
  return new Response(up.body, {
    status: 200,
    headers: {
      ...HEADERS,
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': disposition && /^attachment\b/i.test(disposition) ? disposition : `attachment; filename="${code}.csv"`,
    },
  });
}
