// T0B-MSGDESK-1 (LD-321; contract T0C-MSGDESK-1): partner "message to lab" tickets. /admin = staff (actor type user), /me = partner actors.
// Order: actor type (403, no SQL) -> IdentityPort.assertRole (403) -> partnerContext.require (partner side: the party comes from the session, never the body)
//   -> shape (400) -> If-Match (428/400, close / reopen) -> lookup (404: unknown, other party, other tenant) -> transition (409) -> version (409) -> guarded UPDATE -> message.
// Transitions: lab reply new | replied -> replied; partner reply new | replied -> new; close new | replied -> closed; reopen closed -> new; a closed ticket takes no reply.
// Every message and status change UPDATEs the ticket (last_message_at / status, version + 1), so its row audit (partner_ticket__audit) records each one.
// Subject and message text are stored as parameters and never logged, audited or echoed in an error. Body keys outside the contract are ignored (the pipeline rejects them).
// [CONV] timestamps come from the database clock (now()), so the thread order is the commit order of the requests.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../core/errors.js';
import type { HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import { partnerContext } from './partner-context.service.js';
import { bad, ifMatch, isObj, uuidParam } from './partner-user.service.js';
import { listParams, page } from './referrer.service.js';

type Q = { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> };
type Row = Record<string, any>;
type Who = 'lab' | 'partner';

const PERM = { read: 'partners.ticket.read', manage: 'partners.ticket.manage' } as const;
const STATUSES = ['new', 'replied', 'closed'];
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const T_COLS = 'id, party_kind, party_id, subject, status, last_message_at, version, created_by, created_at, updated_at';
const M_COLS = 'id, ticket_id, sender_kind, body, created_by, created_at';

const GET_SQL = `SELECT ${T_COLS} FROM partners.partner_ticket WHERE tenant_id = $1 AND id = $2`;
const PARTNER_SQL = 'SELECT id FROM partners.partners WHERE tenant_id = $1 AND id = $2';
const INSERT_SQL = `INSERT INTO partners.partner_ticket (id, tenant_id, party_kind, party_id, subject, status, last_message_at, created_by, updated_by)
  VALUES ($1, $2, 'partner', $3, $4, 'new', now(), $5, $5)`;
const MSG_SQL = `INSERT INTO partners.partner_ticket_message (id, tenant_id, ticket_id, sender_kind, body, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${M_COLS}`;
const MSGS_SQL = `SELECT ${M_COLS} FROM (SELECT ${M_COLS} FROM partners.partner_ticket_message WHERE tenant_id = $1 AND ticket_id = $2 ORDER BY created_at DESC, id DESC LIMIT 200) m
  ORDER BY created_at, id`;
/** Guarded move: only from `from` (and at `version` when given); 0 rows = a concurrent request changed the ticket first. */
const MOVE_SQL = `UPDATE partners.partner_ticket SET status = $3, version = version + 1, updated_at = now(), updated_by = $4,
    last_message_at = CASE WHEN $6::boolean THEN now() ELSE last_message_at END
  WHERE tenant_id = $1 AND id = $2 AND status = ANY($5::text[]) AND ($7::int IS NULL OR version = $7) RETURNING ${T_COLS}`;

const forbidden = () => new LimsError('auth.forbidden');
const notFound = () => new LimsError('common.not_found');
const transition = () => new LimsError('partners.ticket_invalid_transition');
const iso = (v: unknown) => new Date(v as string).toISOString();
const has = (v: unknown) => v !== null && v !== undefined;

/** Actor type + permission (+ partner context). Returns the caller's partner id on the partner side. */
async function gate(ctx: HandlerContext, who: Who, permission: string): Promise<string | undefined> {
  if (ctx.actor?.type !== (who === 'partner' ? 'partner' : 'user') || !ctx.tenantId || !ctx.tx || !ctx.actor.id) throw forbidden(); // before any SQL
  if (!ctx.ports?.IdentityPort) throw new LimsError('common.service_unavailable');
  await ctx.ports.IdentityPort.assertRole(ctx, { permission } as never);
  return who === 'partner' ? (await partnerContext.require(ctx)).partnerId : undefined;
}
function text(v: unknown, path: string, max: number): string {
  if (typeof v !== 'string' || [...v.trim()].length < 1 || [...v].length > max) throw bad(path);
  return v;
}
const ticketDto = (r: Row) => ({
  id: r['id'], party_kind: r['party_kind'], party_id: r['party_id'], subject: r['subject'], status: r['status'], created_by: r['created_by'],
  created_at: iso(r['created_at']), updated_at: iso(r['updated_at']), ...(has(r['last_message_at']) ? { last_message_at: iso(r['last_message_at']) } : {}), version: r['version'],
});
const messageDto = (m: Row) => ({ id: m['id'], ticket_id: m['ticket_id'], sender_kind: m['sender_kind'], body: m['body'], created_by: m['created_by'], created_at: iso(m['created_at']) });
const out = (status: number, body: Record<string, unknown>, version?: unknown): HandlerResult =>
  ({ status, body, headers: { 'Cache-Control': 'no-store', ...(typeof version === 'number' ? { etag: `"${version}"` } : {}) } });

/** The ticket as this actor sees it (RLS: a partner sees only its own party; the explicit party filter is defence in depth). */
async function find(ctx: HandlerContext, id: string, partnerId?: string): Promise<Row> {
  const r = (await (ctx.tx as Q).query(GET_SQL, [ctx.tenantId, id])).rows[0];
  if (!r || (partnerId !== undefined && r['party_id'] !== partnerId)) throw notFound();
  return r;
}
async function detail(ctx: HandlerContext, t: Row): Promise<HandlerResult> {
  const msgs = (await (ctx.tx as Q).query(MSGS_SQL, [ctx.tenantId, t['id']])).rows;
  return out(200, { ticket: ticketDto(t), messages: msgs.map(messageDto) }, t['version']);
}

async function open(req: HandlerRequest, ctx: HandlerContext, who: Who): Promise<HandlerResult> {
  const own = await gate(ctx, who, PERM.manage);
  const b = isObj(req.body) ? req.body : {};
  let partyId = own;
  if (who === 'lab') {
    if (b['party_kind'] !== 'partner') throw bad('/party_kind');
    partyId = uuidParam(b, 'party_id');
  }
  const subject = text(b['subject'], '/subject', 150);
  const body = text(b['body'], '/body', 2000);
  const tx = ctx.tx as Q;
  if (who === 'lab' && !(await tx.query(PARTNER_SQL, [ctx.tenantId, partyId])).rows.length) throw notFound();
  const id = uuidv7();
  await tx.query(INSERT_SQL, [id, ctx.tenantId, partyId, subject, ctx.actor!.id]);
  await tx.query(MSG_SQL, [uuidv7(), ctx.tenantId, id, who, body, ctx.actor!.id]);
  const t = await find(ctx, id);
  return out(201, ticketDto(t), t['version']);
}

async function reply(req: HandlerRequest, ctx: HandlerContext, who: Who): Promise<HandlerResult> {
  const own = await gate(ctx, who, PERM.manage);
  const id = uuidParam(req.params, 'ticket_id');
  const body = text(isObj(req.body) ? req.body['body'] : undefined, '/body', 2000);
  const cur = await find(ctx, id, own);
  if (cur['status'] === 'closed') throw transition();
  // lab answer -> replied; partner message -> new (the lab has to look again). sender_kind comes from the actor, never the body.
  const moved = (await (ctx.tx as Q).query(MOVE_SQL, [ctx.tenantId, id, who === 'lab' ? 'replied' : 'new', ctx.actor!.id, ['new', 'replied'], true, null])).rows[0];
  if (!moved) throw transition(); // closed meanwhile
  const m = (await (ctx.tx as Q).query(MSG_SQL, [uuidv7(), ctx.tenantId, id, who, body, ctx.actor!.id])).rows[0];
  return out(201, messageDto(m));
}

async function move(req: HandlerRequest, ctx: HandlerContext, from: readonly string[], to: string): Promise<HandlerResult> {
  await gate(ctx, 'lab', PERM.manage);
  const expected = ifMatch(req.headers);
  const id = uuidParam(req.params, 'ticket_id');
  const cur = await find(ctx, id);
  if (!from.includes(cur['status'])) throw transition();
  if (cur['version'] !== expected) throw new LimsError('common.version_conflict');
  const row = (await (ctx.tx as Q).query(MOVE_SQL, [ctx.tenantId, id, to, ctx.actor!.id, from, false, expected])).rows[0];
  if (!row) throw new LimsError('common.version_conflict'); // a concurrent close / reopen won
  return out(200, ticketDto(row), row['version']);
}

async function list(req: HandlerRequest, ctx: HandlerContext, who: Who): Promise<HandlerResult> {
  const own = await gate(ctx, who, PERM.read);
  const { query, limit, offset } = listParams(req.query, who === 'lab'
    ? ['status', 'party_kind', 'party_id', 'created_from', 'created_to', 'cursor', 'limit'] : ['status', 'cursor', 'limit']);
  const v: unknown[] = [ctx.tenantId];
  let w = '';
  const s = query['status'];
  if (s !== undefined) { if (typeof s !== 'string' || !STATUSES.includes(s)) throw bad('/status'); v.push(s); w += ` AND status = $${v.length}`; }
  if (query['party_kind'] !== undefined && query['party_kind'] !== 'partner') throw bad('/party_kind');
  const party = own ?? (query['party_id'] !== undefined ? uuidParam(query, 'party_id') : undefined);
  if (party !== undefined) { v.push(party); w += ` AND party_kind = 'partner' AND party_id = $${v.length}`; }
  for (const [k, op, plus] of [['created_from', '>=', ''], ['created_to', '<', " + interval '1 day'"]] as const) {
    const d = query[k];
    if (d === undefined) continue;
    if (typeof d !== 'string' || !DATE.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) throw bad(`/${k}`);
    v.push(d); w += ` AND created_at ${op} ($${v.length}::date${plus})`;
  }
  v.push(limit + 1, offset);
  // only fixed fragments and $n placeholders reach the text; every value is bound (ST13)
  const sql = `SELECT ${T_COLS} FROM partners.partner_ticket WHERE tenant_id = $1${w} ORDER BY coalesce(last_message_at, created_at) DESC, id DESC LIMIT $${v.length - 1} OFFSET $${v.length}`;
  const rows = (await (ctx.tx as Q).query(sql, v)).rows;
  return out(200, { data: rows.slice(0, limit).map(ticketDto), page: page(limit, offset, rows.length) });
}

async function get(req: HandlerRequest, ctx: HandlerContext, who: Who): Promise<HandlerResult> {
  const own = await gate(ctx, who, PERM.read);
  return detail(ctx, await find(ctx, uuidParam(req.params, 'ticket_id'), own));
}

export const ticketHandlers = {
  createPartnerTicket: (req: HandlerRequest, ctx: HandlerContext) => open(req, ctx, 'lab'),
  listPartnerTickets: (req: HandlerRequest, ctx: HandlerContext) => list(req, ctx, 'lab'),
  getPartnerTicket: (req: HandlerRequest, ctx: HandlerContext) => get(req, ctx, 'lab'),
  replyPartnerTicket: (req: HandlerRequest, ctx: HandlerContext) => reply(req, ctx, 'lab'),
  closePartnerTicket: (req: HandlerRequest, ctx: HandlerContext) => move(req, ctx, ['new', 'replied'], 'closed'),
  reopenPartnerTicket: (req: HandlerRequest, ctx: HandlerContext) => move(req, ctx, ['closed'], 'new'),
  listMyPartnerTickets: (req: HandlerRequest, ctx: HandlerContext) => list(req, ctx, 'partner'),
  createMyPartnerTicket: (req: HandlerRequest, ctx: HandlerContext) => open(req, ctx, 'partner'),
  getMyPartnerTicket: (req: HandlerRequest, ctx: HandlerContext) => get(req, ctx, 'partner'),
  replyMyPartnerTicket: (req: HandlerRequest, ctx: HandlerContext) => reply(req, ctx, 'partner'),
};
