// E48 listMyEnquiries, E49 createMyEnquiry, E50 getMyEnquiry, E51 replyMyEnquiry (patient); N1 listEnquiries, N2 getEnquiry, N3 replyEnquiry, N4 closeEnquiry (staff)
// (02-TRD §4.13, §5; 03-APP-FLOW §4.5; 05-SCHEMA enquiries / enquiry_messages; PRD US-EN-18.1-18.4; 07-SECURITY §3 P3 free text, §6 probes, REQ-SEC-100 open-enquiry cap).
// Tenant and actor come from ctx only. Free text (subject / message) is stored as a parameter and never logged, audited, labelled or put into a notification; errors carry fixed text.
// [CONV] Order for E51 / N3 / N4: If-Match shape (428/400) -> id (400) -> body (400) -> row lock + lookup (404) -> state (409 engagement.enquiry_invalid_transition) -> version (409 common.version_conflict) -> write.
// [CONV] Open-limit (E49): max 5 enquiries with status 'open' per account, counted under a per-account advisory lock; the 6th -> 409 engagement.enquiry_invalid_transition (TRD E49).
// [CONV] A reply that keeps the status still appends the message and bumps version / last_message_at: patient reply -> 'open', staff reply -> 'answered'. Close adds no message and notifies nobody.
// [CONV] Staff reply writes one in-app notification {enquiry_reply, enquiry:<id>} (no text, no SMS); expires 180 days after creation (as the other notifications).
// ponytail: category_code is pattern-checked only (cs_enquiry_categories membership not enforced); a thread is read up to 200 messages (the schema maxItems). Upgrade: coded-set check / thread cap if C16 wants them.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError, type FieldError } from '../../../core/errors.js';
import { canTransition, isTerminal, type EnquiryStatus } from '../domain/enquiry.state.js';
import * as defaultRepo from '../repository/enquiry.repo.js';
import type { Row } from '../repository/enquiry.repo.js';
import { invalid, isUuid, parseIfMatch, type SlotCtx } from './slot.service.js';

export type EnquiryCtx = SlotCtx;
export type EnquiryRepo = typeof defaultRepo;
type Out = { status: number; body: Record<string, unknown> };

const OPEN_LIMIT = 5;
const NOTIFICATION_TTL_MS = 180 * 86_400_000;
const CATEGORY = /^[a-z0-9_]{1,64}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;
const STATUSES: readonly string[] = ['open', 'answered', 'closed'];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const iso = (v: unknown): string => new Date(v as string | Date).toISOString();
const len = (s: string): number => [...s].length; // characters, not UTF-16 units
const fe = (path: string, code: string, message: string): FieldError => ({ path, code, message });
const unknownField = (): never => { throw new LimsError('common.validation_failed', undefined, [fe('/', 'common.unknown_field', 'Unknown field')]); };

function scope(ctx: EnquiryCtx): { tx: any; tenantId: string; actorId: string; now: string } {
  if (typeof ctx?.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || !ctx.tx || typeof ctx.now !== 'function') throw new LimsError('auth.unauthenticated');
  return { tx: ctx.tx, tenantId: ctx.tenantId, actorId: ctx.actor.id, now: iso(ctx.now()) };
}
/** FK / RLS / CHECK refusals mean the target is not visible or not valid for this actor; anything else fails closed without SQL text. */
function mapDbError(e: unknown): never {
  if (e instanceof LimsError) throw e;
  const code = (e as { code?: unknown } | null)?.code;
  if (code === '23503' || code === '42501') throw new LimsError('common.not_found');
  if (code === '23514') return invalid('/', 'common.field_invalid', 'Field invalid');
  throw new LimsError('common.internal');
}

function text(v: unknown, path: string, max: number): string {
  if (typeof v !== 'string' || len(v) < 1 || len(v) > max) return invalid(path);
  return v;
}
function parseMessageBody(body: unknown): string {
  if (!isObj(body)) return invalid('/');
  for (const k of Object.keys(body)) if (k !== 'message') unknownField();
  return text(body['message'], '/message', 2000);
}
function parseCreate(body: unknown): { categoryCode: string; subject: string; message: string; profileId?: string } {
  if (!isObj(body)) return invalid('/');
  for (const k of Object.keys(body)) if (!['category_code', 'subject', 'message', 'profile_id'].includes(k)) unknownField();
  const c = body['category_code'];
  if (typeof c !== 'string' || !CATEGORY.test(c)) invalid('/category_code');
  const subject = text(body['subject'], '/subject', 120);
  const message = text(body['message'], '/message', 2000);
  const p = body['profile_id'];
  if (p !== undefined && !isUuid(p)) invalid('/profile_id');
  return { categoryCode: c as string, subject, message, ...(p !== undefined ? { profileId: p as string } : {}) };
}
function parsePage(q: unknown, withFilters: boolean): { limit: number; after?: { lastMessageAt: string; id: string }; status?: string; categoryCode?: string } {
  const query = isObj(q) ? q : {};
  const raw = query['limit'];
  const limit = raw === undefined ? 50 : typeof raw === 'string' && raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) invalid('/limit');
  let after: { lastMessageAt: string; id: string } | undefined;
  const c = query['cursor'];
  if (c !== undefined) {
    try {
      if (typeof c !== 'string' || !CURSOR.test(c)) throw new Error('shape');
      const [at, id] = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as unknown[];
      if (typeof at !== 'string' || !Number.isFinite(Date.parse(at)) || !isUuid(id)) throw new Error('shape');
      after = { lastMessageAt: at, id };
    } catch { invalid('/cursor'); }
  }
  const out: ReturnType<typeof parsePage> = { limit, ...(after ? { after } : {}) };
  if (withFilters) {
    const s = query['status'], cat = query['category_code'], sort = query['sort'];
    if (s !== undefined && (typeof s !== 'string' || !STATUSES.includes(s))) invalid('/status');
    if (cat !== undefined && (typeof cat !== 'string' || !CATEGORY.test(cat))) invalid('/category_code');
    if (sort !== undefined && sort !== '-last_message_at') invalid('/sort');
    if (s !== undefined) out.status = s as string;
    if (cat !== undefined) out.categoryCode = cat as string;
  }
  return out;
}
const encodeCursor = (r: Row) => Buffer.from(JSON.stringify([iso(r['last_message_at']), r['id']])).toString('base64url');

export function createEnquiryService(deps: { repo?: EnquiryRepo } = {}) {
  const repo = deps.repo ?? defaultRepo;

  /** profile_id on the wire is the caller's link id for the enquiry's patient (patients never see patient_id). */
  const linkIds = async (tx: any, tenantId: string, accountId: string): Promise<Map<string, string>> =>
    new Map((await repo.linksOfAccount(tx, { tenantId, accountId })).map((l) => [l['patient_id'] as string, l['id'] as string]));
  const accountOf = async (tx: any, tenantId: string, membershipId: string): Promise<string> => {
    const a = await repo.accountOfMembership(tx, { tenantId, membershipId });
    if (!a) throw new LimsError('common.not_found');
    return a['id'] as string;
  };

  const summary = (r: Row, links?: Map<string, string>): Record<string, unknown> => {
    const profile = links && r['patient_id'] != null ? links.get(r['patient_id']) : undefined;
    return { id: r['id'], category_code: r['category_code'], subject: r['subject'], status: r['status'], ...(profile !== undefined ? { profile_id: profile } : {}), last_message_at: iso(r['last_message_at']), version: r['version'] };
  };
  const thread = async (tx: any, tenantId: string, r: Row, links?: Map<string, string>): Promise<Record<string, unknown>> => {
    const msgs = (await repo.messagesOf(tx, { tenantId, enquiryId: r['id'] })).map((m) => ({ author_kind: m['author_kind'], body: m['body'], created_at: iso(m['created_at']) }));
    return { ...summary(r, links), ...(!links && r['patient_id'] != null ? { patient_id: r['patient_id'] } : {}), messages: msgs };
  };
  const page = (rows: Row[], limit: number, links?: Map<string, string>) => {
    const slice = rows.slice(0, limit);
    return { data: slice.map((r) => summary(r, links)), page: { limit, ...(rows.length > limit ? { next_cursor: encodeCursor(slice[slice.length - 1]!) } : {}) } };
  };

  /** Shared by E51 / N3 / N4: shape checks, then row lock, state, version. `who` decides the row filter (patient: own account). */
  async function lockFor(tx: any, tenantId: string, id: string, accountId?: string): Promise<Row> {
    const cur = await repo.getEnquiry(tx, { tenantId, id, ...(accountId !== undefined ? { accountId } : {}), lock: true });
    if (!cur) throw new LimsError('common.not_found');
    return cur;
  }

  async function reply(ctx: EnquiryCtx, input: { id: unknown; headers: unknown; body: unknown }, who: 'patient' | 'staff'): Promise<Out> {
    const { tx, tenantId, actorId, now } = scope(ctx);
    const expected = parseIfMatch(input.headers);
    if (!isUuid(input.id)) return invalid('/enquiry_id');
    const message = parseMessageBody(input.body);
    try {
      const accountId = who === 'patient' ? await accountOf(tx, tenantId, actorId) : undefined;
      const cur = await lockFor(tx, tenantId, input.id, accountId);
      if (isTerminal(cur['status'] as EnquiryStatus)) throw new LimsError('engagement.enquiry_invalid_transition'); // closed: no reply (US-EN-18.4)
      if (cur['version'] !== expected) throw new LimsError('common.version_conflict');
      const to: EnquiryStatus = who === 'patient' ? 'open' : 'answered';
      await repo.insertMessage(tx, { id: uuidv7(), tenantId, enquiryId: cur['id'], accountId: cur['account_id'], authorKind: who, authorId: who === 'patient' ? cur['account_id'] : actorId, body: message, now, createdBy: actorId });
      const row = await repo.updateStatus(tx, { tenantId, id: cur['id'], expectedVersion: expected, status: to, now, updatedBy: actorId });
      if (!row) throw new LimsError('common.version_conflict'); // cannot happen under the row lock
      if (who === 'staff') {
        // notifications INSERT is SYS only (05-SCHEMA §5.2, 02-TRD §4.9): a refusal here is not "enquiry not found" — fail closed as 500 until CR-C16-T-N1 names the system-actor path.
        await repo.insertReplyNotification(tx, { id: uuidv7(), tenantId, accountId: cur['account_id'], patientId: cur['patient_id'] ?? null, enquiryId: cur['id'], seq: row['version'], now, expiresAt: new Date(Date.parse(now) + NOTIFICATION_TTL_MS).toISOString(), createdBy: actorId })
          .catch(() => { throw new LimsError('common.internal'); });
      }
      return { status: 200, body: await thread(tx, tenantId, row, who === 'patient' ? await linkIds(tx, tenantId, accountId!) : undefined) };
    } catch (e) { return mapDbError(e); }
  }

  return {
    /** E48 */
    async listMine(ctx: EnquiryCtx, q: unknown): Promise<Out> {
      const { tx, tenantId, actorId } = scope(ctx);
      const p = parsePage(q, false);
      try {
        const accountId = await accountOf(tx, tenantId, actorId);
        const rows = await repo.listEnquiries(tx, { tenantId, accountId, ...(p.after ? { after: p.after } : {}), limit: p.limit + 1 });
        return { status: 200, body: page(rows, p.limit, await linkIds(tx, tenantId, accountId)) };
      } catch (e) { return mapDbError(e); }
    },

    /** E50 */
    async getMine(ctx: EnquiryCtx, input: { id: unknown }): Promise<Out> {
      const { tx, tenantId, actorId } = scope(ctx);
      if (!isUuid(input.id)) return invalid('/enquiry_id');
      try {
        const accountId = await accountOf(tx, tenantId, actorId);
        const cur = await repo.getEnquiry(tx, { tenantId, id: input.id, accountId });
        if (!cur) throw new LimsError('common.not_found');
        return { status: 200, body: await thread(tx, tenantId, cur, await linkIds(tx, tenantId, accountId)) };
      } catch (e) { return mapDbError(e); }
    },

    /** E49: body (400) -> enquiries_enabled (403) -> profile (404) -> open-limit (409) -> rows. */
    async create(ctx: EnquiryCtx, input: { body: unknown }): Promise<Out> {
      const { tx, tenantId, actorId, now } = scope(ctx);
      const v = parseCreate(input.body);
      try {
        const st = await repo.getSettings(tx, { tenantId });
        if (!st || st['enquiries_enabled'] !== true) throw new LimsError('common.feature_disabled');
        const accountId = await accountOf(tx, tenantId, actorId);
        let patientId: string | null = null;
        if (v.profileId !== undefined) {
          const link = (await repo.linksOfAccount(tx, { tenantId, accountId, status: 'active' })).find((l) => l['id'] === v.profileId);
          if (!link) throw new LimsError('common.not_found'); // another account's / suspended / unknown link: no oracle
          patientId = link['patient_id'] as string;
        }
        await repo.lockAccountEnquiries(tx, { tenantId, accountId });
        if ((await repo.countByStatus(tx, { tenantId, accountId, status: 'open' })) >= OPEN_LIMIT) throw new LimsError('engagement.enquiry_invalid_transition');
        const id = uuidv7();
        await repo.insertEnquiry(tx, { id, tenantId, accountId, patientId, categoryCode: v.categoryCode, subject: v.subject, now, createdBy: actorId });
        await repo.insertMessage(tx, { id: uuidv7(), tenantId, enquiryId: id, accountId, authorKind: 'patient', authorId: accountId, body: v.message, now, createdBy: actorId });
        const row = await repo.getEnquiry(tx, { tenantId, id, accountId });
        if (!row) throw new LimsError('common.internal');
        return { status: 201, body: await thread(tx, tenantId, row, await linkIds(tx, tenantId, accountId)) };
      } catch (e) { return mapDbError(e); }
    },

    /** E51 */
    replyMine: (ctx: EnquiryCtx, input: { id: unknown; headers: unknown; body: unknown }) => reply(ctx, input, 'patient'),
    /** N3 */
    replyStaff: (ctx: EnquiryCtx, input: { id: unknown; headers: unknown; body: unknown }) => reply(ctx, input, 'staff'),

    /** N1 */
    async list(ctx: EnquiryCtx, q: unknown): Promise<Out> {
      const { tx, tenantId } = scope(ctx);
      const p = parsePage(q, true);
      try {
        const rows = await repo.listEnquiries(tx, { tenantId, ...(p.status ? { status: p.status } : {}), ...(p.categoryCode ? { categoryCode: p.categoryCode } : {}), ...(p.after ? { after: p.after } : {}), limit: p.limit + 1 });
        return { status: 200, body: page(rows, p.limit) };
      } catch (e) { return mapDbError(e); }
    },

    /** N2 */
    async get(ctx: EnquiryCtx, input: { id: unknown }): Promise<Out> {
      const { tx, tenantId } = scope(ctx);
      if (!isUuid(input.id)) return invalid('/enquiry_id');
      try {
        const cur = await repo.getEnquiry(tx, { tenantId, id: input.id });
        if (!cur) throw new LimsError('common.not_found');
        return { status: 200, body: await thread(tx, tenantId, cur) };
      } catch (e) { return mapDbError(e); }
    },

    /** N4: open | answered -> closed; closed -> 409. */
    async close(ctx: EnquiryCtx, input: { id: unknown; headers: unknown }): Promise<Out> {
      const { tx, tenantId, actorId, now } = scope(ctx);
      const expected = parseIfMatch(input.headers);
      if (!isUuid(input.id)) return invalid('/enquiry_id');
      try {
        const cur = await lockFor(tx, tenantId, input.id);
        if (!canTransition(cur['status'] as EnquiryStatus, 'closed')) throw new LimsError('engagement.enquiry_invalid_transition');
        if (cur['version'] !== expected) throw new LimsError('common.version_conflict');
        const row = await repo.closeRow(tx, { tenantId, id: cur['id'], expectedVersion: expected, now, updatedBy: actorId });
        if (!row) throw new LimsError('common.version_conflict');
        return { status: 200, body: await thread(tx, tenantId, row) };
      } catch (e) { return mapDbError(e); }
    },
  };
}
export type EnquiryService = ReturnType<typeof createEnquiryService>;
