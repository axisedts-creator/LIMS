// W6 poll endpoint (BFF): the client polls here every 5 s with X-Lims-Background (middleware maps it to touch:false).
// Same-origin session cookie only; the bearer token stays on the server. Permission engagement.queue.operate is re-checked here.
import { NextResponse } from 'next/server';
import { ApiError } from '@/core/api/server-fetch';
import * as api from '@/features/engagement/server/queue.server';

export async function GET(req: Request) {
  const centreId = new URL(req.url).searchParams.get('centre_id') ?? '';
  const noStore = { 'cache-control': 'no-store' };
  if (!api.UUID_RE.test(centreId)) return NextResponse.json({ code: 'common.validation_failed' }, { status: 400, headers: noStore });
  if (!(await api.has(api.OPERATE))) return NextResponse.json({ code: 'auth.forbidden' }, { status: 403, headers: noStore });
  try {
    return NextResponse.json({ data: await api.listTokens(centreId) }, { headers: noStore });
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    return NextResponse.json({ code: e.problem.code }, { status: e.status, headers: noStore });
  }
}
