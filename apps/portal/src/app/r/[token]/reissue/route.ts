import { callApi, token22 } from '@/server/api';
import { forbidden, originAllowed } from '@/server/origin';

// POST only; Origin must be the portal origin (REQ-SEC-091/092). The answer never depends on what the API said (AC-11.5).
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await ctx.params;
  if (!originAllowed(req)) return forbidden();
  if (token22(token)) await callApi('POST', '/portal/link-reissues', { stage: 'link', credential: token, json: {} });
  return new Response(null, { status: 303, headers: { location: `/r/${encodeURIComponent(token)}?r=1`, 'cache-control': 'no-store' } });
}
