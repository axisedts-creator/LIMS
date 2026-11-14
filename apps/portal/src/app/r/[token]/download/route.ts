import { callApi, retryMinutes, token22, type PortalReport } from '@/server/api';
import { getSession } from '@/server/session';

const NO_STORE = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const redirectTo = (path: string) => new Response(null, { status: 303, headers: { location: path, ...NO_STORE } });

// Streams the latest released PDF as an attachment (AC-11.6). The session token never leaves the server.
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await ctx.params;
  const landing = `/r/${encodeURIComponent(token)}`;
  const session = await getSession();
  if (!token22(token) || !session) return redirectTo(landing);
  const rep = await callApi<PortalReport>('GET', '/portal/report', { stage: 'session', credential: session });
  if (rep.status === 401 || rep.status === 404) return redirectTo(landing);
  const versionId = rep.body?.download?.report_version_id;
  if (rep.status !== 200 || !versionId) return new Response('Something went wrong. Please try again later.', { status: 502, headers: NO_STORE });
  const pdf = await callApi('GET', `/portal/report-versions/${encodeURIComponent(versionId)}/pdf`, { stage: 'session', credential: session, raw: true });
  if (pdf.status === 429) return new Response(`Too many downloads. Please try again in ${retryMinutes(pdf)} minutes.`, { status: 429, headers: NO_STORE });
  if (pdf.status === 401) return redirectTo(landing);
  if (pdf.status !== 200 || !pdf.res?.body) return new Response('Something went wrong. Please try again later.', { status: 502, headers: NO_STORE });
  return new Response(pdf.res.body, {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': pdf.res.headers.get('content-disposition') ?? 'attachment; filename="report.pdf"',
      ...NO_STORE,
    },
  });
}
