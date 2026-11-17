import { callApi } from '@/server/api';
import { forbidden, originAllowed } from '@/server/origin';
import { clearSession, getSession } from '@/server/session';

// POST only + Origin check. Ends the API session (P6) and clears the cookie in the same response.
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }): Promise<Response> {
  if (!originAllowed(req)) return forbidden();
  const { token } = await ctx.params;
  const session = await getSession();
  if (session) await callApi('POST', '/portal/sessions/end', { stage: 'session', credential: session });
  await clearSession();
  return new Response(null, { status: 303, headers: { location: `/r/${encodeURIComponent(token)}`, 'cache-control': 'no-store' } });
}
