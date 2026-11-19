// T0B-MSGDESK-1 (LD-321, LD-325; contract T0C-MSGDESK-1): broadcast templates, audience preview, draft, second person approval, one outbox row per recipient.
// Order in every write: shape (400) -> If-Match (428/400) -> row lock + lookup (404) -> state (409) -> second person (403) -> version (409) -> template (422)
//   -> provider (422) -> audience + 5000 cap (422) -> guarded UPDATE -> recipients -> NotificationPort. Any throw rolls the request tx back (no half state).
// No personal data in logs or errors: addresses, party names and template text are never logged; responses mask every address.
// [CONV] pins of the T0B-MSGDESK-1 tests: requested_by / approved_by = actor id; a draft stores the count only, the recipient rows (the frozen list)
//   are written at approval; the provider is an active non-recording reporting.channel_accounts row of the template channel; active_only defaults to true;
//   cancelBroadcast checks If-Match only when sent (the pipeline enforces its presence); city and priority are refused (no source column yet, CR).
// OPEN (.orchestra/cr/T0B-MSGDESK-1.md): no opt out source exists for these parties, so opted_out_count is 0; reporting.deliveries has no broadcast purpose,
//   template code or client recipient kind, so the real NotificationPort refuses the call and the approval rolls back (fail closed, nothing sent).
// ponytail: the approval queues all recipients inside the request (<= 5000 outbox calls); move the drain to a worker job if approval latency matters.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../core/errors.js';
import * as repo from '../repository/broadcast.repo.js';
import type { Channel, PartyKind, Row } from '../repository/broadcast.repo.js';

export interface BroadcastCtx {
  readonly tenantId: string;
  readonly actor: { readonly type: string; readonly id: string };
  readonly tx: any;
  readonly now: () => unknown;
  readonly ports: { NotificationPort?: Record<string, (ctx: unknown, input: object) => Promise<{ deliveryId: string; status: string; replayed?: boolean }>> };
  readonly core?: { tenant?(ctx: unknown): Promise<{ displayName?: string }>; branches?(ctx: unknown, i: object): Promise<ReadonlyArray<{ phoneDisplay?: string; isActive?: boolean }>> };
  readonly log?: { info(o: object, m?: string): void };
}
type Out = { status: number; body: Record<string, unknown> };
type Obj = Record<string, unknown>;

export const RECIPIENT_CAP = 5000;
export const PLACEHOLDERS = ['party_name', 'lab_name', 'lab_phone', 'send_date'] as const;
const CHANNELS: readonly Channel[] = ['sms', 'whatsapp', 'email'];
const KINDS: readonly PartyKind[] = ['laboratory', 'franchise', 'client', 'lab_user'];
const B_STATUS = ['draft', 'pending_approval', 'approved', 'sending', 'sent', 'cancelled'];
const R_STATUS = ['queued', 'sent', 'failed', 'skipped'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A tag opener: markup can run script or load a resource; plain text "5 < 10" passes. */
const MARKUP = /<\s*[a-zA-Z!/?]/;
const PORT_OF: Record<Channel, string> = { sms: 'sendSms', whatsapp: 'sendWhatsAppTemplate', email: 'sendEmailLink' };
// Recipient shapes of the NotificationPort (03-IC §4.8). client has no outbox recipient kind yet (CR item 3): the real port refuses it, fail closed.
const RECIPIENT_OF: Record<PartyKind, (id: string) => object> = {
  laboratory: (id) => ({ kind: 'partner', partnerId: id }),
  franchise: (id) => ({ kind: 'centre', centreId: id }),
  lab_user: (id) => ({ kind: 'staff', membershipId: id }),
  client: (id) => ({ kind: 'client', creditPartyId: id }),
};

const fail = (path: string): never => { throw new LimsError('common.validation_failed', undefined, [{ path, code: 'common.field_invalid', message: 'Field invalid' }]); };
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const chars = (s: string) => [...s].length;
const iso = (v: unknown) => new Date(v as string).toISOString();
const notFound = () => new LimsError('common.not_found');
const transition = () => new LimsError('engagement.broadcast_invalid_transition');

// ---------- value rules ----------
function text(v: unknown, path: string, max: number): string {
  if (typeof v !== 'string' || chars(v.trim()) < 1 || chars(v) > max) return fail(path);
  if (MARKUP.test(v)) return fail(path); // plain text only (contract: no HTML)
  return v;
}
/** Every {{ opens a placeholder; it must be exactly {{name}} with name from the closed list. Returns the names in first-use order. */
export function placeholdersOf(s: string): string[] {
  const out: string[] = [];
  for (let i = s.indexOf('{{'); i !== -1; i = s.indexOf('{{', i + 2)) {
    const m = /^\{\{([a-z_]+)\}\}/.exec(s.slice(i));
    if (!m || !(PLACEHOLDERS as readonly string[]).includes(m[1]!)) throw new LimsError('engagement.broadcast_placeholder_unknown');
    if (!out.includes(m[1]!)) out.push(m[1]!);
  }
  return out;
}
export function ifMatch(headers: unknown, required = true): number | undefined {
  const h = isObj(headers) ? headers['if-match'] : undefined;
  if (h === undefined) { if (required) throw new LimsError('common.precondition_required'); return undefined; }
  const m = typeof h === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(h) : null;
  if (!m || Number(m[1]) > 2147483647) return fail('/If-Match');
  return Number(m[1]);
}
const pathId = (params: unknown, name: string): string => {
  const v = isObj(params) ? params[name] : undefined;
  if (typeof v !== 'string' || !UUID.test(v)) throw notFound(); // a non uuid id never matches a row
  return v;
};
function pageArgs(q: unknown): { query: Obj; limit: number; offset: number } {
  const query = isObj(q) ? q : {};
  const raw = query['limit'];
  const limit = raw === undefined ? 50 : typeof raw === 'number' ? raw : typeof raw === 'string' && /^[0-9]{1,3}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail('/limit');
  let offset = 0;
  if (query['cursor'] !== undefined) {
    try {
      const o = (JSON.parse(Buffer.from(String(query['cursor']), 'base64url').toString('utf8')) as { o?: unknown } | null)?.o;
      if (typeof o !== 'number' || !Number.isInteger(o) || o < 0 || o > 1_000_000) throw new Error('cursor');
      offset = o;
    } catch { throw new LimsError('common.invalid_cursor'); }
  }
  return { query, limit, offset };
}
const page = (rows: Row[], limit: number, offset: number, map: (r: Row) => Obj) => ({
  data: rows.slice(0, limit).map(map),
  page: { limit, ...(rows.length > limit ? { next_cursor: Buffer.from(JSON.stringify({ o: offset + limit })).toString('base64url') } : {}) },
});
const bool = (v: unknown, path: string): boolean | undefined => {
  if (v === undefined) return undefined;
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  return fail(path);
};
const oneOf = <T extends string>(v: unknown, list: readonly T[], path: string): T | undefined => {
  if (v === undefined) return undefined;
  return typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : fail(path);
};

interface Filter { kinds: PartyKind[]; activeOnly: boolean; stored: Obj }
/** Closed filter: party_kinds (1..4 distinct kinds), active_only (default true). city and priority have no source column yet: refused, never ignored (CR). */
function parseFilter(v: unknown): Filter {
  if (!isObj(v)) return fail('/audience_filter');
  for (const k of Object.keys(v)) if (!['party_kinds', 'city', 'priority', 'active_only'].includes(k)) fail(`/audience_filter/${k}`);
  const pk = v['party_kinds'];
  if (!Array.isArray(pk) || pk.length < 1 || pk.length > 4 || new Set(pk).size !== pk.length || !pk.every((k) => (KINDS as readonly unknown[]).includes(k))) fail('/audience_filter/party_kinds');
  if (v['city'] !== undefined) fail('/audience_filter/city');
  if (v['priority'] !== undefined) fail('/audience_filter/priority');
  const ao = v['active_only'];
  if (ao !== undefined && typeof ao !== 'boolean') fail('/audience_filter/active_only');
  const kinds = pk as PartyKind[];
  return { kinds, activeOnly: ao !== false, stored: { party_kinds: [...kinds], ...(ao !== undefined ? { active_only: ao } : {}) } };
}

// ---------- masking and rendering ----------
/** Phone: '*' x (len - 4) + last 4. Email: first character, '***', then the domain. Never the full value. */
export function maskAddress(a: string): string {
  const at = a.indexOf('@');
  if (at > 0) return `${a[0]}***${a.slice(at)}`.slice(0, 120);
  return a.length > 4 ? '*'.repeat(a.length - 4) + a.slice(-4) : '*'.repeat(Math.max(1, a.length));
}
const HTML: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Values are escaped for the channel: HTML for email, control characters removed for sms / whatsapp. */
export function renderValue(v: string, channel: Channel): string {
  const flat = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return channel === 'email' ? flat.replace(/[&<>"']/g, (c) => HTML[c]!) : flat;
}

// ---------- DTOs ----------
const templateDto = (r: Row): Obj => ({
  id: r['id'], name: r['name'], channel: r['channel'], ...(r['subject'] != null ? { subject: r['subject'] } : {}), body: r['body'],
  placeholders: placeholdersOf(`${r['body']}${r['subject'] ?? ''}`), is_active: r['is_active'], version: r['version'], created_at: iso(r['created_at']), updated_at: iso(r['updated_at']),
});
const broadcastDto = (r: Row): Obj => ({
  id: r['id'], template_id: r['template_id'], audience_filter: r['audience_filter'], status: r['status'], recipient_count: r['recipient_count'],
  opted_out_count: r['opted_out_count'], requested_by: r['requested_by'], ...(r['approved_by'] != null ? { approved_by: r['approved_by'] } : {}),
  ...(r['approved_at'] != null ? { approved_at: iso(r['approved_at']) } : {}), created_at: iso(r['created_at']), updated_at: iso(r['updated_at']), version: r['version'],
});
const recipientDto = (r: Row): Obj => ({
  id: r['id'], broadcast_id: r['broadcast_id'], party_kind: r['party_kind'], party_id: r['party_id'], channel_address: maskAddress(String(r['channel_address'])),
  status: r['status'], ...(r['skip_reason'] != null ? { skip_reason: r['skip_reason'] } : {}), ...(r['outbox_id'] != null ? { outbox_id: r['outbox_id'] } : {}),
});

// ---------- shared steps ----------
async function activeTemplate(ctx: BroadcastCtx, id: unknown): Promise<Row> {
  if (typeof id !== 'string' || !UUID.test(id)) return fail('/template_id');
  const t = await repo.getTemplate(ctx.tx, { tenantId: ctx.tenantId, id });
  if (!t) throw notFound();
  if (t['is_active'] !== true) throw new LimsError('engagement.broadcast_template_inactive');
  return t;
}
async function countWithinCap(ctx: BroadcastCtx, f: Filter, channel: Channel): Promise<number> {
  const n = await repo.audienceCount(ctx.tx, { tenantId: ctx.tenantId, kinds: f.kinds, activeOnly: f.activeOnly, channel });
  if (n > RECIPIENT_CAP) throw new LimsError('engagement.broadcast_recipient_limit');
  return n;
}
async function labValues(ctx: BroadcastCtx): Promise<{ lab_name: string; lab_phone: string; send_date: string }> {
  const t = typeof ctx.core?.tenant === 'function' ? await ctx.core.tenant(ctx) : undefined;
  const br = typeof ctx.core?.branches === 'function' ? await ctx.core.branches(ctx, { activeOnly: true }) : [];
  return { lab_name: t?.displayName ?? '', lab_phone: br.find((b) => b.phoneDisplay)?.phoneDisplay ?? '', send_date: new Date(ctx.now() as string).toISOString().slice(0, 10) };
}

export function createBroadcastService() {
  return {
    // ----- templates -----
    async listTemplates(ctx: BroadcastCtx, q: unknown): Promise<Out> {
      const { query, limit, offset } = pageArgs(q);
      const isActive = bool(query['is_active'], '/is_active');
      const channel = oneOf(query['channel'], CHANNELS, '/channel');
      const rows = await repo.listTemplates(ctx.tx, { tenantId: ctx.tenantId, ...(isActive !== undefined ? { isActive } : {}), ...(channel ? { channel } : {}), limit, offset });
      return { status: 200, body: page(rows, limit, offset, templateDto) };
    },

    async createTemplate(ctx: BroadcastCtx, body: unknown): Promise<Out> {
      if (!isObj(body)) return fail('/');
      const name = text(body['name'], '/name', 120);
      const channel = oneOf(body['channel'], CHANNELS, '/channel') ?? fail('/channel');
      const tbody = text(body['body'], '/body', 1000);
      const subject = channel === 'email' ? text(body['subject'], '/subject', 150) : null; // sms / whatsapp ignore a subject
      placeholdersOf(`${tbody}${subject ?? ''}`);
      const row = await repo.insertTemplate(ctx.tx, { id: uuidv7(), tenantId: ctx.tenantId, name: name.trim(), channel, subject, body: tbody, actorId: ctx.actor.id });
      return { status: 201, body: templateDto(row) };
    },

    async updateTemplate(ctx: BroadcastCtx, input: { params: unknown; headers: unknown; body: unknown }): Promise<Out> {
      const expected = ifMatch(input.headers)!;
      const id = pathId(input.params, 'template_id');
      const b = input.body;
      if (!isObj(b) || !['name', 'subject', 'body'].some((k) => b[k] !== undefined)) return fail('/');
      const name = b['name'] !== undefined ? text(b['name'], '/name', 120).trim() : undefined;
      const tbody = b['body'] !== undefined ? text(b['body'], '/body', 1000) : undefined;
      const subj = b['subject'] !== undefined ? text(b['subject'], '/subject', 150) : undefined;
      const cur = await repo.getTemplate(ctx.tx, { tenantId: ctx.tenantId, id, lock: true });
      if (!cur) throw notFound();
      const subject = cur['channel'] === 'email' ? (subj ?? cur['subject']) : null;
      const next = tbody ?? cur['body'];
      placeholdersOf(`${next}${subject ?? ''}`);
      if (cur['version'] !== expected) throw new LimsError('common.version_conflict');
      const row = await repo.updateTemplate(ctx.tx, { tenantId: ctx.tenantId, id, version: expected, name: name ?? cur['name'], subject, body: next, isActive: cur['is_active'], actorId: ctx.actor.id });
      if (!row) throw new LimsError('common.version_conflict');
      return { status: 200, body: templateDto(row) };
    },

    async deactivateTemplate(ctx: BroadcastCtx, input: { params: unknown; headers: unknown }): Promise<Out> {
      const expected = ifMatch(input.headers)!;
      const id = pathId(input.params, 'template_id');
      const cur = await repo.getTemplate(ctx.tx, { tenantId: ctx.tenantId, id, lock: true });
      if (!cur) throw notFound();
      if (cur['version'] !== expected) throw new LimsError('common.version_conflict');
      if (cur['is_active'] !== true) return { status: 200, body: templateDto(cur) }; // already inactive: nothing to write
      const row = await repo.updateTemplate(ctx.tx, { tenantId: ctx.tenantId, id, version: expected, name: cur['name'], subject: cur['subject'], body: cur['body'], isActive: false, actorId: ctx.actor.id });
      if (!row) throw new LimsError('common.version_conflict');
      return { status: 200, body: templateDto(row) };
    },

    // ----- audience and broadcasts -----
    /** Counts and a masked sample in ONE statement; writes nothing, sends nothing. */
    async preview(ctx: BroadcastCtx, body: unknown): Promise<Out> {
      if (!isObj(body)) return fail('/');
      const f = parseFilter(body['audience_filter']);
      const channel: Channel = body['template_id'] !== undefined ? (await activeTemplate(ctx, body['template_id']))['channel'] : 'sms';
      const p = await repo.audiencePreview(ctx.tx, { tenantId: ctx.tenantId, kinds: f.kinds, activeOnly: f.activeOnly, channel, sample: 20 });
      return { status: 200, body: { recipient_count: p.count, opted_out_count: 0,
        sample: p.rows.map((r) => ({ party_kind: r['party_kind'], party_id: r['party_id'], channel_address: maskAddress(String(r['address'])) })) } };
    },

    async create(ctx: BroadcastCtx, body: unknown): Promise<Out> {
      if (!isObj(body)) return fail('/');
      const f = parseFilter(body['audience_filter']);
      const t = await activeTemplate(ctx, body['template_id']);
      const n = await countWithinCap(ctx, f, t['channel']);
      const row = await repo.insertBroadcast(ctx.tx, { id: uuidv7(), tenantId: ctx.tenantId, templateId: t['id'], filter: f.stored, recipientCount: n, optedOut: 0, actorId: ctx.actor.id });
      return { status: 201, body: broadcastDto(row) };
    },

    async requestApproval(ctx: BroadcastCtx, input: { params: unknown; headers: unknown }): Promise<Out> {
      const expected = ifMatch(input.headers)!;
      const id = pathId(input.params, 'broadcast_id');
      const cur = await repo.getBroadcast(ctx.tx, { tenantId: ctx.tenantId, id, lock: true });
      if (!cur) throw notFound();
      if (cur['status'] !== 'draft') throw transition();
      if (cur['version'] !== expected) throw new LimsError('common.version_conflict');
      const t = await activeTemplate(ctx, cur['template_id']);
      const n = await countWithinCap(ctx, parseFilter(cur['audience_filter']), t['channel']);
      const row = await repo.moveBroadcast(ctx.tx, { tenantId: ctx.tenantId, id, version: expected, from: ['draft'], to: 'pending_approval', actorId: ctx.actor.id, recipientCount: n, optedOut: 0 });
      if (!row) throw new LimsError('common.version_conflict');
      return { status: 200, body: broadcastDto(row) };
    },

    /** Second person approval: freezes the list, then one NotificationPort call (one outbox row) per queued recipient, key = broadcast id + recipient id. */
    async approve(ctx: BroadcastCtx, input: { params: unknown; headers: unknown }): Promise<Out> {
      const expected = ifMatch(input.headers)!;
      const id = pathId(input.params, 'broadcast_id');
      const cur = await repo.getBroadcast(ctx.tx, { tenantId: ctx.tenantId, id, lock: true }); // concurrent approvers queue here; the losers then see the new status
      if (!cur) throw notFound();
      if (cur['status'] !== 'pending_approval') throw transition();
      if (cur['requested_by'] === ctx.actor.id) throw new LimsError('engagement.broadcast_self_approval');
      if (cur['version'] !== expected) throw new LimsError('common.version_conflict');
      const t = await activeTemplate(ctx, cur['template_id']);
      const channel = t['channel'] as Channel;
      if (!(await repo.hasProvider(ctx.tx, { tenantId: ctx.tenantId, channel }))) throw new LimsError('engagement.broadcast_provider_not_configured');
      const send = ctx.ports?.NotificationPort?.[PORT_OF[channel]];
      if (typeof send !== 'function') throw new LimsError('common.service_unavailable');
      const f = parseFilter(cur['audience_filter']);
      const list = await repo.audienceRows(ctx.tx, { tenantId: ctx.tenantId, kinds: f.kinds, activeOnly: f.activeOnly, channel, max: RECIPIENT_CAP + 1 });
      if (list.length > RECIPIENT_CAP) throw new LimsError('engagement.broadcast_recipient_limit');

      const approved = await repo.moveBroadcast(ctx.tx, { tenantId: ctx.tenantId, id, version: expected, from: ['pending_approval'], to: 'approved', actorId: ctx.actor.id,
        recipientCount: list.length, optedOut: 0, approve: true });
      if (!approved) throw transition();
      const recipients = list.map((r) => ({ id: uuidv7(), kind: r['party_kind'] as PartyKind, partyId: r['party_id'] as string, address: r['address'] as string,
        name: String(r['party_name'] ?? ''), status: 'queued' as const, skipReason: null }));
      await repo.insertRecipients(ctx.tx, { tenantId: ctx.tenantId, broadcastId: id, actorId: ctx.actor.id, rows: recipients });

      const used = placeholdersOf(`${t['body']}${t['subject'] ?? ''}`);
      const lab = used.some((p) => p !== 'party_name') ? await labValues(ctx) : undefined;
      const outbox: Array<{ id: string; outboxId: string; status: 'queued' | 'failed' }> = [];
      for (const r of recipients) {
        const values: Record<string, string> = { party_name: r.name, ...(lab ?? {}) };
        const params = Object.fromEntries(used.map((p) => [p, renderValue(values[p] ?? '', channel)]));
        // CR .orchestra/cr/T0B-MSGDESK-1.md item 3: the outbox has no broadcast template code or purpose yet, so none is invented here.
        const res = await send(ctx, { recipient: RECIPIENT_OF[r.kind](r.partyId), params, idempotencyKey: `broadcast:${id}:${r.id}` });
        outbox.push({ id: r.id, outboxId: res.deliveryId, status: res.status === 'queued' ? 'queued' : 'failed' });
      }
      await repo.setOutbox(ctx.tx, { tenantId: ctx.tenantId, broadcastId: id, rows: outbox });
      // approved -> sending while the outbox drains; nothing to send -> sent at once.
      const row = await repo.moveBroadcast(ctx.tx, { tenantId: ctx.tenantId, id, version: approved['version'], from: ['approved'], to: recipients.length ? 'sending' : 'sent', actorId: ctx.actor.id });
      if (!row) throw transition();
      ctx.log?.info({ event: 'broadcast_approved', broadcast_id: id, recipients: recipients.length }, 'broadcast_approved');
      return { status: 200, body: broadcastDto(row) };
    },

    async cancel(ctx: BroadcastCtx, input: { params: unknown; headers: unknown }): Promise<Out> {
      const expected = ifMatch(input.headers, false);
      const id = pathId(input.params, 'broadcast_id');
      const cur = await repo.getBroadcast(ctx.tx, { tenantId: ctx.tenantId, id, lock: true });
      if (!cur) throw notFound();
      if (!['draft', 'pending_approval', 'approved'].includes(cur['status'])) throw transition();
      if (expected !== undefined && cur['version'] !== expected) throw new LimsError('common.version_conflict');
      const row = await repo.moveBroadcast(ctx.tx, { tenantId: ctx.tenantId, id, version: cur['version'], from: ['draft', 'pending_approval', 'approved'], to: 'cancelled', actorId: ctx.actor.id });
      if (!row) throw transition();
      return { status: 200, body: broadcastDto(row) };
    },

    async list(ctx: BroadcastCtx, q: unknown): Promise<Out> {
      const { query, limit, offset } = pageArgs(q);
      const status = oneOf(query['status'], B_STATUS, '/status');
      const rows = await repo.listBroadcasts(ctx.tx, { tenantId: ctx.tenantId, ...(status ? { status } : {}), limit, offset });
      return { status: 200, body: page(rows, limit, offset, broadcastDto) };
    },

    async listRecipients(ctx: BroadcastCtx, input: { params: unknown; query: unknown }): Promise<Out> {
      const id = pathId(input.params, 'broadcast_id');
      const { query, limit, offset } = pageArgs(input.query);
      const status = oneOf(query['status'], R_STATUS, '/status');
      if (!(await repo.getBroadcast(ctx.tx, { tenantId: ctx.tenantId, id }))) throw notFound();
      const rows = await repo.listRecipients(ctx.tx, { tenantId: ctx.tenantId, broadcastId: id, ...(status ? { status } : {}), limit, offset });
      return { status: 200, body: page(rows, limit, offset, recipientDto) };
    },
  };
}
export type BroadcastService = ReturnType<typeof createBroadcastService>;
