'use server';
// Server actions for W11. Only ApiError is mapped to { ok:false, code } (a thrown ApiError loses its code across the action boundary in production);
// anything else rethrows to the error boundary. The API re-checks engagement.enquiry.respond on every call. The reply text is never logged.
import 'server-only';
import { ApiError } from '@/core/api/server-fetch';
import { UUID_RE, closeEnquiry, replyEnquiry, type StaffEnquiry } from './enquiries.server';

export type ActionResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string };

const KEY = /^[A-Za-z0-9_-]{1,64}$/;
const reject = (): ActionResult<never> => ({ ok: false, status: 400, code: 'common.validation_failed' });
async function api<T>(run: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await run() };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, status: e.status, code: e.problem.code };
    throw e;
  }
}

/** N3. `version` is the one the thread was read at (If-Match); message 1..2000 characters. */
export async function replyEnquiryAction(id: string, version: number, message: string, key: string): Promise<ActionResult<StaffEnquiry>> {
  const n = typeof message === 'string' ? [...message].length : 0;
  if (!UUID_RE.test(String(id)) || !Number.isInteger(version) || !KEY.test(String(key)) || n < 1 || n > 2000) return reject();
  return api(() => replyEnquiry(id, version, message, key));
}

/** N4. */
export async function closeEnquiryAction(id: string, version: number): Promise<ActionResult<StaffEnquiry>> {
  if (!UUID_RE.test(String(id)) || !Number.isInteger(version)) return reject();
  return api(() => closeEnquiry(id, version));
}
