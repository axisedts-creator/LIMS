'use server';
// T0D-MSGDESK-1 (LD-321, LD-310): server actions of the message screens (engagement.yaml, live since T0B-MSGDESK-1). Online only.
//   createBroadcastTemplate (POST + Idempotency-Key), updateBroadcastTemplate (PATCH + If-Match), deactivateBroadcastTemplate (POST + If-Match),
//   previewBroadcastAudience (read-only POST, sends nothing), createBroadcast (POST + Idempotency-Key, a draft: nothing is sent),
//   requestBroadcastApproval / approveBroadcast / cancelBroadcast (POST + Idempotency-Key + If-Match).
// Sending needs a second person to approve; the API refuses the requester, a missing provider and more than 5000 recipients (LD-321).
// Every value is re-checked here (the browser is not trusted): the audience filter is the closed list of party kinds plus active_only, ids are uuids.
import 'server-only';
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import { KEY_RE } from '@/features/partners/server/types';
import { CHANNELS, PARTY_KINDS, isUuid, mask, type AudienceSample, type Broadcast, type PartyKind } from './broadcast.server';

export type MsgResult = { ok: true } | { ok: false; status: number; code: string; errors?: { path: string; message: string }[] };
export type CreatedResult = { ok: true; id: string; version: number } | Exclude<MsgResult, { ok: true }>;
export type PreviewResult = { ok: true; recipient_count: number; opted_out_count: number; sample: AudienceSample[] } | Exclude<MsgResult, { ok: true }>;

const bad = () => new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
const FIELD = /^\/?[a-z_]{1,40}$/;
const PLACEHOLDER = /\{\{\s*([^}]*?)\s*\}\}/g;
const ALLOWED = ['party_name', 'lab_name', 'lab_phone', 'send_date'];

function fail(e: unknown): Exclude<MsgResult, { ok: true }> {
  if (!(e instanceof ApiError)) throw e;
  const raw = Array.isArray(e.problem['errors']) ? (e.problem['errors'] as { path?: unknown; message?: unknown }[]) : [];
  const errors = raw
    .filter((x) => typeof x?.path === 'string' && FIELD.test(x.path) && typeof x.message === 'string')
    .map((x) => ({ path: `/${(x.path as string).replace(/^\//, '')}`, message: (x.message as string).slice(0, 300) }));
  return { ok: false, status: e.status, code: e.problem.code, ...(errors.length ? { errors } : {}) };
}
async function run(f: () => Promise<unknown>): Promise<MsgResult> {
  try { await f(); return { ok: true }; } catch (e) { return fail(e); }
}

const uuid = (v: unknown) => { if (!isUuid(v)) throw bad(); return v; };
const str = (v: unknown, max: number) => { if (typeof v !== 'string' || v.trim() === '' || v.length > max) throw bad(); return v.trim(); };
/** A body uses only the closed placeholder list (BroadcastPlaceholder). */
const body = (v: unknown) => { const b = str(v, 1000); for (const m of b.matchAll(PLACEHOLDER)) if (!ALLOWED.includes(m[1]!)) throw bad(); return b; };
function headers(o: { key?: string | undefined; version?: number | undefined }) {
  if (o.key !== undefined && !KEY_RE.test(o.key)) throw bad();
  if (o.version !== undefined && (!Number.isSafeInteger(o.version) || o.version < 1)) throw bad();
  return {
    'content-type': 'application/json',
    ...(o.key !== undefined ? { 'idempotency-key': o.key } : {}),
    ...(o.version !== undefined ? { 'if-match': `"${o.version}"` } : {}),
  };
}
const post = <T,>(path: string, payload: unknown, o: { key?: string; version?: number } = {}) =>
  serverFetch<T>(path, { method: 'POST', headers: headers(o), ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });

/** The closed audience filter: 1 to 4 known party kinds (no repeats) and active_only. */
function audience(v: unknown): { party_kinds: PartyKind[]; active_only: boolean } {
  const f = v as { party_kinds?: unknown; active_only?: unknown } | null;
  if (!f || typeof f !== 'object' || !Array.isArray(f.party_kinds) || f.party_kinds.length < 1 || f.party_kinds.length > 4) throw bad();
  if (f.party_kinds.some((k) => !PARTY_KINDS.includes(k as PartyKind)) || new Set(f.party_kinds).size !== f.party_kinds.length) throw bad();
  if (typeof f.active_only !== 'boolean') throw bad();
  return { party_kinds: f.party_kinds as PartyKind[], active_only: f.active_only };
}

const T = '/v1/engagement/broadcast-templates';
const B = '/v1/engagement/broadcasts';

export async function createTemplateAction(input: { name: unknown; channel: unknown; subject?: unknown; body: unknown }, key: string): Promise<MsgResult> {
  return run(async () => {
    if (!CHANNELS.includes(input?.channel as never)) throw bad();
    const b: Record<string, unknown> = { name: str(input.name, 120), channel: input.channel };
    if (input.channel === 'email' && input.subject !== undefined) b['subject'] = str(input.subject, 150);
    b['body'] = body(input.body);
    await post(T, b, { key });
  });
}

/** Only the changed fields (name, subject, body); the channel is fixed at creation. */
export async function updateTemplateAction(id: string, version: number, change: { name?: unknown; subject?: unknown; body?: unknown }): Promise<MsgResult> {
  return run(async () => {
    const b: Record<string, unknown> = {};
    if (change?.name !== undefined) b['name'] = str(change.name, 120);
    if (change?.subject !== undefined) b['subject'] = str(change.subject, 150);
    if (change?.body !== undefined) b['body'] = body(change.body);
    if (Object.keys(b).length === 0) throw bad();
    await serverFetch(`${T}/${uuid(id)}`, { method: 'PATCH', headers: headers({ version }), body: JSON.stringify(b) });
  });
}

export const deactivateTemplateAction = async (id: string, version: number): Promise<MsgResult> => run(() => post(`${T}/${uuid(id)}/deactivate`, undefined, { version }));

/** Counts and a masked sample; sends nothing, stores nothing. */
export async function previewAudienceAction(templateId: string | undefined, filter: unknown): Promise<PreviewResult> {
  try {
    const payload = { ...(templateId !== undefined ? { template_id: uuid(templateId) } : {}), audience_filter: audience(filter) };
    const r = await post<{ recipient_count: number; opted_out_count: number; sample: AudienceSample[] }>('/v1/engagement/broadcast-audience-previews', payload);
    return { ok: true, recipient_count: r.recipient_count, opted_out_count: r.opted_out_count, sample: r.sample.slice(0, 20).map((s) => ({ ...s, channel_address: mask(s.channel_address) })) };
  } catch (e) {
    return fail(e);
  }
}

/** A draft broadcast; nothing is sent. Returns the new id and version for the request-approval step. */
export async function createBroadcastAction(templateId: string, filter: unknown, key: string): Promise<CreatedResult> {
  try {
    const r = await post<Broadcast>(B, { template_id: uuid(templateId), audience_filter: audience(filter) }, { key });
    return { ok: true, id: r.id, version: r.version };
  } catch (e) {
    return fail(e);
  }
}

export const requestApprovalAction = async (id: string, version: number, key: string): Promise<MsgResult> => run(() => post(`${B}/${uuid(id)}/request-approval`, undefined, { key, version }));
export const approveBroadcastAction = async (id: string, version: number, key: string): Promise<MsgResult> => run(() => post(`${B}/${uuid(id)}/approve`, undefined, { key, version }));
export const cancelBroadcastAction = async (id: string, version: number, key: string): Promise<MsgResult> => run(() => post(`${B}/${uuid(id)}/cancel`, undefined, { key, version }));
