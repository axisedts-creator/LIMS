'use server';
// T0D-MSGDESK-1 partner ticket write actions (createMyPartnerTicket, replyMyPartnerTicket) through the partner BFF. Own tickets only: the session decides the party.
// Only { ok, code } reaches the browser; only { subject, body } / { body } is ever sent.
import 'server-only';
import { partnerApi } from '@/core/api';
import { isUuid } from '../common/api';

export type TicketResult = { ok: true } | { ok: false; code: string };

const KEY = /^[A-Za-z0-9_-]{8,64}$/;
const bad: TicketResult = { ok: false, code: 'common.validation_failed' };
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const field = (o: unknown, k: string): unknown => (o !== null && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined);

export async function createTicketAction(input: unknown, idempotencyKey: string): Promise<TicketResult> {
  const subject = field(input, 'subject');
  const body = field(input, 'body');
  if (!KEY.test(String(idempotencyKey)) || !text(subject, 150) || !text(body, 2000)) return bad;
  const r = await partnerApi('/v1/partners/me/tickets', { method: 'POST', headers: { 'idempotency-key': idempotencyKey }, body: { subject, body } });
  return r.ok ? { ok: true } : { ok: false, code: r.problem.code };
}

export async function replyTicketAction(ticketId: string, input: unknown, idempotencyKey: string): Promise<TicketResult> {
  const body = field(input, 'body');
  if (!isUuid(ticketId) || !KEY.test(String(idempotencyKey)) || !text(body, 2000)) return bad;
  const r = await partnerApi(`/v1/partners/me/tickets/${ticketId}/messages`, { method: 'POST', headers: { 'idempotency-key': idempotencyKey }, body: { body } });
  return r.ok ? { ok: true } : { ok: false, code: r.problem.code };
}
