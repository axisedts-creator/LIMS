import 'server-only';
// S17 "Export CSV" (TRD #93, AC-21.8; 07-SECURITY PE-3, REQ-SEC-081/-096): a same-origin download that proxies GET /v1/inventory/reports/{code}/export.csv with the session
// bearer, which never reaches the browser. The API writes the CSV (50,000-row cap, formula neutralisation, access_log entry); this route forwards it byte for byte.
// The path cannot be steered (report_code is checked against the contract list and only report filters are forwarded) and an upstream redirect is never followed.
// Failure (review item 4): "Export CSV" is a plain link, so any upstream non-200 answers 303 back to /inventory/reports?<same page query>&export_error=<code>, where <code> is
// the upstream problem code if it is a contract x-error-code for #93, else common.internal. Upstream text is never echoed; ReportsView shows the ProblemBanner.
import { getAccessToken } from '@/core/session/server';
import { EXPORT_ERROR_CODES, fromReportQuery, toPageQuery } from '@/features/inventory/reportQuery';
import { isReportCode, reportExportPath, reportQuery } from '@/features/inventory/server/reports.server';

export const dynamic = 'force-dynamic';

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } as const;
const empty = (status: number) => new Response(null, { status, headers: HEADERS });

async function problemCode(up: Response): Promise<string> {
  try {
    const c: unknown = ((await up.json()) as { code?: unknown } | null)?.code;
    return typeof c === 'string' && EXPORT_ERROR_CODES.has(c) ? c : 'common.internal';
  } catch {
    return 'common.internal';
  }
}

export async function GET(req: Request, ctx: { params: Promise<{ report_code: string }> }): Promise<Response> {
  const { report_code: code } = await ctx.params;
  if (!isReportCode(code)) return empty(400);
  const token = await getAccessToken();
  const origin = process.env.LIMS_ORIGIN_API;
  if (!token) return empty(401);

  const q = reportQuery(Object.fromEntries(new URL(req.url).searchParams));
  const back = (err: string) => {
    const to = new URL(`/inventory/reports?${toPageQuery(code, fromReportQuery(q))}`, req.url);
    to.searchParams.set('export_error', err);
    return new Response(null, { status: 303, headers: { ...HEADERS, location: to.toString() } });
  };
  if (!origin) return back('common.internal');

  let up: Response;
  try {
    up = await fetch(new URL(reportExportPath(code, q), origin), { headers: { authorization: `Bearer ${token}`, accept: 'text/csv' }, cache: 'no-store', redirect: 'error' });
  } catch {
    return back('common.internal');
  }
  if (up.status !== 200) return back(await problemCode(up));

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
