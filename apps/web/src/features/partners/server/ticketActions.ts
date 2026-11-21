'use server';
// T0D-MSGDESK-1 (LD-321): server actions of the lab side Ticket Inbox (partners.yaml createPartnerTicket, replyPartnerTicket, closePartnerTicket,
// reopenPartnerTicket; live since T0B-MSGDESK-1). Every write carries the caller's Idempotency-Key; close and reopen carry If-Match "<version>".
// sender_kind is derived by the API from the actor (staff = lab), never sent. Only a uuid reaches a path. Online only.
import 'server-only';
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import { isUuid } from './sales.server';
import { KEY_RE } from './types';

export type TicketResult = { ok: true } | { ok: false; status: number; code: string; errors?: { path: string; message: string }[] };

const bad = () => new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
const FIELD = /^\/?[a-z_]{1,40}$/;
const uuid = (v: unknown) => { if (typeof v !== 'string' || !isUuid(v)) throw bad(); return v; };
const str = (v: unknown, max: number) => { if (typeof v !== 'string' || v.trim() === '' || v.length > max) throw bad(); return v.trim(); };

async function run(f: () => Promise<unknown>): Promise<TicketResult> {
  try {
    await f();
    return { ok: true };
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    const raw = Array.isArray(e.problem['errors']) ? (e.problem['errors'] as { path?: unknown; message?: unknown }[]) : [];
    const errors = raw
      .filter((x) => typeof x?.path === 'string' && FIELD.test(x.path) && typeof x.message === 'string')
      .map((x) => ({ path: `/${(x.path as string).replace(/^\//, '')}`, message: (x.message as string).slice(0, 300) }));
    return { ok: false, status: e.status, code: e.problem.code, ...(errors.length ? { errors } : {}) };
  }
}
function post(path: string, payload: unknown, key: string, version?: number) {
  if (!KEY_RE.test(key)) throw bad();
  if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) throw bad();
  return serverFetch<unknown>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key, ...(version !== undefined ? { 'if-match': `"${version}"` } : {}) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
}

const A = '/v1/partners/admin/tickets';

export async function createTicketAction(input: { party_id: unknown; subject: unknown; body: unknown }, key: string): Promise<TicketResult> {
  return run(() => post(A, { party_kind: 'partner', party_id: uuid(input?.party_id), subject: str(input?.subject, 150), body: str(input?.body, 2000) }, key));
}
export const replyTicketAction = async (id: string, text: unknown, key: string): Promise<TicketResult> =>
  run(async () => post(`${A}/${uuid(id)}/messages`, { body: str(text, 2000) }, key));
export const closeTicketAction = async (id: string, version: number, key: string): Promise<TicketResult> => run(async () => post(`${A}/${uuid(id)}/close`, undefined, key, version));
export const reopenTicketAction = async (id: string, version: number, key: string): Promise<TicketResult> => run(async () => post(`${A}/${uuid(id)}/reopen`, undefined, key, version));
