'use server';
// Server actions of the portal link flow. Tokens stay on the server: the browser only ever holds the
// opaque link in its own URL and an HttpOnly session cookie (REQ-SEC-068). Next checks Origin on actions.
import { redirect } from 'next/navigation';
import { callApi, retryMinutes, token22, type ApiResult } from '@/server/api';
import { clearChallenge, getChallenge, setChallenge, setSession } from '@/server/session';

export interface CodeState {
  seq: number;
  error?: 'invalid' | 'exhausted' | 'generic';
}

const landing = (token: string, q = '') => `/r/${encodeURIComponent(token)}${q}`;
const refParam = (r: ApiResult): string => {
  const id = (r.body as { request_id?: string } | undefined)?.request_id;
  return id && /^[0-9a-f-]{36}$/i.test(id) ? `&ref=${id}` : '';
};

/** Failure of a link-stage call -> landing page state (invalid link, rate limit, generic error). */
function fail(token: string, r: ApiResult): never {
  if (r.status === 429) redirect(landing(token, `?e=rate&m=${retryMinutes(r)}`));
  if (r.status >= 400 && r.status < 500) redirect(landing(token, '?e=invalid'));
  redirect(landing(token, `?e=error${refParam(r)}`));
}

export async function sendCode(token: string): Promise<void> {
  if (!token22(token)) redirect(landing(token, '?e=invalid'));
  const r = await callApi<{ challenge_id: string; channel: 'sms' | 'email' }>('POST', '/portal/otp-challenges', { stage: 'link', credential: token, json: {} });
  if (r.status !== 202 || !r.body?.challenge_id) fail(token, r);
  await setChallenge(`${r.body.channel}:${r.body.challenge_id}`);
  redirect(`/r/${token}/code`);
}

export async function verifyCode(token: string, prev: CodeState, formData: FormData): Promise<CodeState> {
  const code = formData.get('code');
  const seq = prev.seq + 1;
  if (!token22(token)) redirect(landing(token, '?e=invalid'));
  if (typeof code !== 'string' || !/^[0-9]{6}$/.test(code)) return { seq, error: 'invalid' };
  const challengeId = (await getChallenge())?.split(':')[1];
  if (!challengeId) redirect(landing(token));
  const r = await callApi<{ session_token: string; absolute_expires_at: string; link_purpose?: string }>(
    'POST',
    `/portal/otp-challenges/${encodeURIComponent(challengeId)}/verify`,
    { stage: 'link', credential: token, json: { code } },
  );
  if (r.status === 200 && r.body?.session_token) {
    await setSession(r.body.session_token, r.body.absolute_expires_at, token);
    await clearChallenge();
    redirect(r.body.link_purpose === 'dues' ? `/r/${token}/dues` : `/r/${token}/report`); // 08 A21.1: a dues session sees the dues page only
  }
  if (r.status === 401) return { seq, error: r.code === 'auth.otp_attempts_exhausted' ? 'exhausted' : 'invalid' };
  if (r.status === 429 || r.status === 404) fail(token, r);
  return { seq, error: 'generic' };
}
