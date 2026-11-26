// PHLEBO-UI-FULL-1: phlebotomist job applications (founder request 2026-11-26).
// Anonymous side (patientPreAuth = tenant only, permission homecollection.application.submit): create -> upload document
// pieces -> submit. It never reads or writes the tables: every statement is one of the DEFINER functions of migration
// 20261126010000, which check the upload token (only its SHA-256 is stored). Staff side (homecollection.application.manage):
// list, get, download a document, decide. Applicant data (name, phone, email, documents) is never logged.
import { createHash, randomBytes } from 'node:crypto';
import { LimsError } from '../../core/errors.js';
import { bad, isObj, noExtra } from './device.service.js';
import { MAX_PIECE_BYTES, discardPieces, finishDocument, readDocument, removeDocument, writePiece } from './application.store.js';
import { expectedVersionOf } from './route.service.js';
import { uuidv7 } from '../../../../../packages/shared-ts/src/uuidv7/index.js';

const PERM_SUBMIT = 'homecollection.application.submit';
const PERM_MANAGE = 'homecollection.application.manage';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PHONE = /^\+9779[678][0-9]{8}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const KINDS = ['licence', 'training_certificate', 'identity', 'photo'] as const;
const TYPES = ['image/jpeg', 'image/png', 'application/pdf'] as const;
const SLOTS = ['morning', 'afternoon', 'evening'] as const;
const NO_STORE = { 'cache-control': 'no-store' };

type Obj = Record<string, any>;
type Result = { status: number; body?: unknown; headers?: Record<string, string> };
interface Ctx {
  readonly tenantId: string; readonly tx: { query(t: string, v?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> };
  readonly actor: { readonly id: string; readonly type?: string; readonly membershipId?: string }; readonly now: () => Date;
  readonly rateLimit?: { consume(tier: string, key: string): Promise<void> };
  readonly db?: { tx<T>(fn: (c: any) => Promise<T>): Promise<T> };
  readonly ports: { readonly IdentityPort: { assertRole(ctx: unknown, r: { permission: string }): Promise<void> } };
  readonly core?: { readonly memberships?: { list(ctx: unknown, i: Obj): Promise<ReadonlyArray<{ membershipId: string; displayName: string }>> } };
}

function ctxOf(c: unknown): Ctx {
  const x = c as Partial<Ctx> | null;
  if (typeof x?.tenantId !== 'string' || !x.tx || typeof x.actor?.id !== 'string' || !x.ports?.IdentityPort) throw new LimsError('auth.unauthenticated');
  return x as Ctx;
}
const text = (v: unknown, min: number, max: number, path: string): string => {
  if (typeof v !== 'string') throw bad(path);
  const s = v.trim();
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s) || [...s].length < min || [...s].length > max) throw bad(path);
  return s;
};
const idOf = (params: unknown, name: string): string => {
  const v = isObj(params) ? params[name] : undefined;
  if (typeof v !== 'string' || !UUID.test(v)) throw bad(`/${name}`);
  return v;
};
const tokenHash = (headers: unknown): Buffer => {
  const t = isObj(headers) ? headers['x-lims-application-token'] : undefined;
  if (typeof t !== 'string' || !TOKEN.test(t)) throw new LimsError('auth.unauthenticated');
  return createHash('sha256').update(t).digest();
};
const one = async (ctx: Ctx, sql: string, values: unknown[]): Promise<string> => String((await ctx.tx.query(sql, values)).rows[0]?.['r'] ?? 'denied');

// ---------------------------------------------------------------------------------------------- anonymous side

export async function createPhleboApplication(hctx: unknown, body: unknown): Promise<Result> {
  const ctx = ctxOf(hctx);
  await ctx.ports.IdentityPort.assertRole(ctx, { permission: PERM_SUBMIT });
  if (!isObj(body)) throw bad('');
  noExtra(body, ['full_name', 'phone_e164', 'email', 'area', 'employment_type', 'shift_count', 'day_slots']);
  const fullName = text(body['full_name'], 3, 120, '/full_name');
  const phone = body['phone_e164'];
  if (typeof phone !== 'string' || !PHONE.test(phone)) throw bad('/phone_e164');
  const email = text(body['email'], 6, 254, '/email').toLowerCase();
  if (!EMAIL.test(email)) throw bad('/email');
  const area = text(body['area'], 1, 120, '/area');
  const employment = body['employment_type'];
  if (employment !== 'full_time' && employment !== 'part_time') throw bad('/employment_type');
  let shift: string | null = null;
  let slots: string[] = [];
  if (employment === 'part_time') {
    shift = body['shift_count'];
    if (shift !== 'single' && shift !== 'double') throw bad('/shift_count');
    const raw = body['day_slots'];
    if (!Array.isArray(raw) || raw.some((s) => !SLOTS.includes(s)) || new Set(raw).size !== raw.length || raw.length !== (shift === 'single' ? 1 : 2)) throw bad('/day_slots');
    slots = SLOTS.filter((s) => raw.includes(s));
  } else if (body['shift_count'] !== undefined || body['day_slots'] !== undefined) throw bad('/shift_count');

  if (!ctx.rateLimit) throw new LimsError('common.service_unavailable');   // never serve an anonymous write without the limiter
  await ctx.rateLimit.consume('otp_request', `p:${phone}`);                 // 3 / hour / phone

  const id = uuidv7();
  const token = randomBytes(32).toString('base64url');
  const r = await one(ctx, 'SELECT app.homecollection_application_create($1, $2, $3, $4, $5, $6, $7, $8, $9) AS r',
    [id, fullName, phone, email, area, employment, shift, slots, createHash('sha256').update(token).digest()]);
  if (r === 'exists') throw new LimsError('homecollection.application_exists');
  if (r !== 'created') throw new LimsError('auth.forbidden');
  return { status: 201, body: { application_id: id, upload_token: token }, headers: NO_STORE };
}

export async function uploadPhleboApplicationDocumentChunk(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const ctx = ctxOf(hctx);
  await ctx.ports.IdentityPort.assertRole(ctx, { permission: PERM_SUBMIT });
  const applicationId = idOf(params, 'application_id');
  const documentId = idOf(params, 'document_id');
  const hash = tokenHash(headers);
  if (!isObj(body)) throw bad('');
  noExtra(body, ['kind', 'file_name', 'content_type', 'index', 'last', 'data']);
  const kind = body['kind'];
  if (!KINDS.includes(kind)) throw bad('/kind');
  const contentType = body['content_type'];
  if (!TYPES.includes(contentType) || (kind === 'photo' && contentType === 'application/pdf')) throw new LimsError('common.unsupported_media_type');
  const fileName = text(body['file_name'], 1, 120, '/file_name').replace(/[\\/:*?"<>|]/g, '_');
  const index = body['index'];
  if (!Number.isInteger(index) || index < 0 || index > 7) throw bad('/index');
  if (typeof body['last'] !== 'boolean') throw bad('/last');
  const data = body['data'];
  if (typeof data !== 'string' || data.length < 4 || data.length > 699052 || !BASE64.test(data)) throw bad('/data');
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_PIECE_BYTES) throw new LimsError('common.payload_too_large');

  // Token first: nothing is written to disk for an unknown application, a wrong token or a finished application.
  const state = (await ctx.tx.query('SELECT kind, n FROM app.homecollection_application_upload_state($1, $2)', [applicationId, hash])).rows;
  if (state.length === 0) throw new LimsError('auth.unauthenticated');
  const have = Number(state.find((s) => s['kind'] === kind)?.['n'] ?? 0);
  if (have >= (kind === 'training_certificate' ? 5 : kind === 'identity' ? 2 : 1)) throw new LimsError('homecollection.application_incomplete');

  await writePiece(ctx.tenantId, applicationId, documentId, index, bytes);
  if (!body['last']) return { status: 200, body: { complete: false }, headers: NO_STORE };

  const saved = await finishDocument(ctx.tenantId, applicationId, documentId, index + 1, contentType);
  let r: string;
  try {
    r = await one(ctx, 'SELECT app.homecollection_application_add_document($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) AS r',
      [applicationId, hash, documentId, kind, fileName, contentType, saved.byteSize, saved.storedSize, saved.sha256, saved.storagePath]);
  } catch (e) {
    await removeDocument(ctx.tenantId, applicationId, documentId);
    throw e;
  }
  if (r !== 'added') {
    await removeDocument(ctx.tenantId, applicationId, documentId);
    throw new LimsError(r === 'too_many' ? 'homecollection.application_incomplete' : 'auth.unauthenticated');
  }
  return { status: 200, body: { complete: true }, headers: NO_STORE };
}

export async function submitPhleboApplication(hctx: unknown, params: unknown, headers: unknown): Promise<Result> {
  const ctx = ctxOf(hctx);
  await ctx.ports.IdentityPort.assertRole(ctx, { permission: PERM_SUBMIT });
  const r = await one(ctx, 'SELECT app.homecollection_application_submit($1, $2, $3) AS r', [idOf(params, 'application_id'), tokenHash(headers), uuidv7()]);
  if (r === 'incomplete') throw new LimsError('homecollection.application_incomplete');
  if (r !== 'submitted') throw new LimsError('auth.unauthenticated');
  return { status: 204, headers: NO_STORE };
}

// ---------------------------------------------------------------------------------------------- staff side

const iso = (v: unknown): string | undefined => (v ? new Date(v as string).toISOString() : undefined);

function toDto(a: Obj, docs: Obj[], decidedBy?: string): Obj {
  return {
    id: a['id'], version: a['version'], status: a['status'],
    full_name: a['full_name'], phone_e164: a['phone_e164'], email: a['email'], area: a['area'],
    employment_type: a['employment_type'],
    ...(a['shift_count'] ? { shift_count: a['shift_count'] } : {}),
    day_slots: a['day_slots'] ?? [],
    ...(a['submitted_at'] ? { submitted_at: iso(a['submitted_at']) } : {}),
    ...(a['decided_at'] ? { decided_at: iso(a['decided_at']) } : {}),
    ...(decidedBy ? { decided_by_display: decidedBy } : {}),
    ...(a['decision_note'] ? { decision_note: a['decision_note'] } : {}),
    documents: docs.filter((d) => d['application_id'] === a['id']).map((d) => ({
      id: d['id'], kind: d['kind'], file_name: d['file_name'], content_type: d['content_type'], byte_size: d['byte_size'],
    })),
  };
}

async function staff(hctx: unknown): Promise<Ctx> {
  const ctx = ctxOf(hctx);
  await ctx.ports.IdentityPort.assertRole(ctx, { permission: PERM_MANAGE });
  return ctx;
}

async function docsOf(ctx: Ctx, ids: string[]): Promise<Obj[]> {
  if (ids.length === 0) return [];
  return (await ctx.tx.query(
    'SELECT id, application_id, kind, file_name, content_type, byte_size, sha256 FROM homecollection.phlebo_application_documents WHERE tenant_id = $1 AND application_id = ANY($2::uuid[]) ORDER BY created_at, id',
    [ctx.tenantId, ids])).rows;
}

async function nameOf(ctx: Ctx, membershipId: unknown): Promise<string | undefined> {
  if (typeof membershipId !== 'string' || !ctx.db || !ctx.core?.memberships) return undefined;
  try {
    const rows = await ctx.db.tx((x) => ctx.core!.memberships!.list(x, { membershipIds: [membershipId], activeOnly: false }));
    return rows.find((r) => r.membershipId === membershipId)?.displayName;
  } catch { return undefined; }
}

export async function listPhleboApplications(hctx: unknown, query: unknown): Promise<Result> {
  const ctx = await staff(hctx);
  const status = isObj(query) ? query['status'] : undefined;
  if (status !== undefined && status !== 'submitted' && status !== 'approved' && status !== 'rejected') throw bad('/status');
  // 'uploading' rows are unfinished and never shown.
  const rows = (await ctx.tx.query(
    `SELECT * FROM homecollection.phlebo_applications WHERE tenant_id = $1 AND status <> 'uploading' AND ($2::text IS NULL OR status = $2)
      ORDER BY submitted_at DESC NULLS LAST, id DESC LIMIT 200`, [ctx.tenantId, status ?? null])).rows;
  const count = (await ctx.tx.query(`SELECT count(*)::integer AS n FROM homecollection.phlebo_applications WHERE tenant_id = $1 AND status = 'submitted'`, [ctx.tenantId])).rows[0];
  const docs = await docsOf(ctx, rows.map((r) => r['id']));
  return { status: 200, body: { items: rows.map((r) => toDto(r, docs)), submitted_count: Number(count?.['n'] ?? 0) }, headers: NO_STORE };
}

async function load(ctx: Ctx, id: string): Promise<Obj> {
  const a = (await ctx.tx.query(`SELECT * FROM homecollection.phlebo_applications WHERE tenant_id = $1 AND id = $2 AND status <> 'uploading'`, [ctx.tenantId, id])).rows[0];
  if (!a) throw new LimsError('common.not_found');
  return a;
}

export async function getPhleboApplication(hctx: unknown, params: unknown): Promise<Result> {
  const ctx = await staff(hctx);
  const a = await load(ctx, idOf(params, 'application_id'));
  return { status: 200, body: toDto(a, await docsOf(ctx, [a['id']]), await nameOf(ctx, a['decided_by'])), headers: { ...NO_STORE, etag: `"${a['version']}"` } };
}

export async function downloadPhleboApplicationDocument(hctx: unknown, params: unknown): Promise<Result> {
  const ctx = await staff(hctx);
  const a = await load(ctx, idOf(params, 'application_id'));
  const documentId = idOf(params, 'document_id');
  const d = (await docsOf(ctx, [a['id']])).find((x) => x['id'] === documentId);
  if (!d) throw new LimsError('common.not_found');
  const bytes = await readDocument(ctx.tenantId, a['id'], documentId, d['sha256']);
  const ext = d['content_type'] === 'application/pdf' ? 'pdf' : d['content_type'] === 'image/png' ? 'png' : 'jpg';
  return {
    status: 200, body: bytes,
    // The stored name is never echoed into a header: a fixed, safe name is built from the kind.
    headers: { 'content-type': d['content_type'], 'content-disposition': `attachment; filename="${d['kind']}-${documentId.slice(-6)}.${ext}"`, 'x-content-type-options': 'nosniff', ...NO_STORE },
  };
}

/** Reject is final here. Approve only records the decision; creating the account is the next step (approval service). */
export async function decidePhleboApplication(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const ctx = await staff(hctx);
  const id = idOf(params, 'application_id');
  const expected = expectedVersionOf(headers);
  if (!isObj(body)) throw bad('');
  noExtra(body, ['decision', 'note']);
  const decision = body['decision'];
  if (decision !== 'approve' && decision !== 'reject') throw bad('/decision');
  const note = body['note'] === undefined ? null : text(body['note'], 1, 500, '/note');
  if (decision === 'reject' && note === null) throw bad('/note');
  const me = ctx.actor.membershipId;
  if (!me) throw new LimsError('auth.forbidden');

  const a = await load(ctx, id);
  if (a['status'] !== 'submitted') throw new LimsError('homecollection.application_incomplete');
  if (a['version'] !== expected) throw new LimsError('common.version_conflict');
  const u = (await ctx.tx.query(
    `UPDATE homecollection.phlebo_applications
        SET status = $4, decided_at = $5, decided_by = $6, decision_note = $7, version = version + 1, updated_at = now(), updated_by = (SELECT app.current_actor_id())
      WHERE tenant_id = $1 AND id = $2 AND version = $3 AND status = 'submitted' RETURNING *`,
    [ctx.tenantId, id, expected, decision === 'approve' ? 'approved' : 'rejected', ctx.now(), me, note])).rows[0];
  if (!u) throw new LimsError('common.version_conflict');
  return { status: 200, body: toDto(u, await docsOf(ctx, [id]), await nameOf(ctx, me)), headers: { ...NO_STORE, etag: `"${u['version']}"` } };
}

export { discardPieces };
