// T0B-CONTENT-1 (LD-313, contract T0C-CONTENT-1): portal content (news, banner, offer, contact) and profile images. Tenant and actor come from ctx only.
// Every body rule of the contract is re-checked here (defence in depth: the handler tests run without the ajv pipeline). Error details are fixed text.
// Markdown: validateMarkdown on write, and again on the public read (a stored body that fails it is never served) - one shared helper (safeMarkdown.ts).
import { LimsError, type FieldError } from '../../../core/errors.js';
import * as defaultRepo from '../repository/content.repo.js';
import type { ContentFields, Key } from '../repository/content.repo.js';
import { isUuid, parseIfMatch } from './queue.service.js';
import { MARKDOWN_MAX_CHARS, validateMarkdown } from './safeMarkdown.js';

export interface ContentCtx { readonly tenantId: string; readonly actor: { readonly type: string; readonly id: string }; readonly tx: unknown }
export type ContentRepo = typeof defaultRepo;

const KINDS = ['news', 'banner', 'offer', 'contact'];
const PROFILE_KINDS = ['doctor', 'centre', 'staff'];
const CREATE_KEYS = new Set(['kind', 'title', 'body', 'image_attachment_id', 'link_url', 'starts_on', 'ends_on', 'sort_order']);
const UPDATE_KEYS = new Set([...CREATE_KEYS, 'is_active']);
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const LINK_URL = /^https:\/\/[^\s<>"]+$/;
const PUBLIC_KEYS = ['id', 'kind', 'title', 'body', 'image_attachment_id', 'link_url', 'starts_on', 'ends_on', 'published_at'] as const;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fe = (path: string, code: string, message: string): FieldError => ({ path, code, message });
const invalid = (path: string, code = 'common.field_invalid', message = 'Field invalid'): never => { throw new LimsError('common.validation_failed', undefined, [fe(path, code, message)]); };
const iso = (v: unknown): string => new Date(v as string | Date).toISOString();

function scope(ctx: ContentCtx): { tx: any; tenantId: string; userId: string } {
  if (typeof ctx?.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
  return { tx: ctx.tx, tenantId: ctx.tenantId, userId: ctx.actor.id };
}

function isDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Body -> column values. Unknown keys (id, tenant_id, version, created_by, published_at, ...) are refused: mass assignment. */
function parseFields(body: unknown, allowed: Set<string>): ContentFields {
  if (!isObj(body)) return invalid('/');
  for (const k of Object.keys(body)) if (!allowed.has(k)) invalid(`/${k.slice(0, 64)}`, 'common.unknown_field', 'Unknown field');
  const f: ContentFields = {};
  const b = body;
  if (b['kind'] !== undefined) { if (typeof b['kind'] !== 'string' || !KINDS.includes(b['kind'])) invalid('/kind'); f.kind = b['kind'] as string; }
  if (b['title'] !== undefined) {
    const t = b['title'];
    if (typeof t !== 'string' || t.length < 1 || t.length > 200 || /[<>]/.test(t) || CONTROL.test(t)) invalid('/title');
    f.title = t as string;
  }
  if (b['body'] !== undefined) {
    if (typeof b['body'] !== 'string' || b['body'].length > MARKDOWN_MAX_CHARS || !validateMarkdown(b['body']).ok) invalid('/body');
    f.body = b['body'] as string;
  }
  if (b['image_attachment_id'] !== undefined) { if (!isUuid(b['image_attachment_id'])) invalid('/image_attachment_id'); f.image_attachment_id = (b['image_attachment_id'] as string).toLowerCase(); }
  if (b['link_url'] !== undefined) {
    const u = b['link_url'];
    if (typeof u !== 'string' || u.length < 9 || u.length > 2048 || !LINK_URL.test(u) || CONTROL.test(u)) invalid('/link_url');
    f.link_url = u as string;
  }
  for (const k of ['starts_on', 'ends_on'] as const) if (b[k] !== undefined) { if (!isDate(b[k])) invalid(`/${k}`); f[k] = b[k] as string; }
  if (b['sort_order'] !== undefined) {
    const s = b['sort_order'];
    if (typeof s !== 'number' || !Number.isInteger(s) || s < 0 || s > 100000) invalid('/sort_order');
    f.sort_order = s as number;
  }
  if (b['is_active'] !== undefined) { if (typeof b['is_active'] !== 'boolean') invalid('/is_active'); f.is_active = b['is_active'] as boolean; }
  return f;
}

function checkWindow(startsOn: unknown, endsOn: unknown): void {
  if (typeof startsOn === 'string' && typeof endsOn === 'string' && endsOn < startsOn) invalid('/ends_on');
}

/** a foreign asset answers exactly like an unknown one (no enumeration) */
async function checkAsset(repo: ContentRepo, tx: any, tenantId: string, id: string | undefined): Promise<void> {
  if (id !== undefined && !(await repo.assetUsable(tx, { tenantId, id }))) invalid('/image_attachment_id');
}

function toBody(r: Record<string, any>): Record<string, unknown> {
  const out: Record<string, unknown> = { id: r['id'], kind: r['kind'], title: r['title'] };
  for (const k of ['body', 'image_attachment_id', 'link_url', 'starts_on', 'ends_on'] as const) if (r[k] != null) out[k] = r[k];
  out['sort_order'] = r['sort_order']; out['is_active'] = r['is_active'];
  if (r['published_at'] != null) out['published_at'] = iso(r['published_at']);
  out['created_by'] = r['created_by']; out['created_at'] = iso(r['created_at']); out['updated_at'] = iso(r['updated_at']); out['version'] = r['version'];
  return out;
}

/** PortalContentPublic: no staff, audit or concurrency fields; a stored body that is not clean Markdown is dropped, never served. */
function toPublic(r: Record<string, any>): Record<string, unknown> {
  const full = toBody(r); const out: Record<string, unknown> = {};
  for (const k of PUBLIC_KEYS) if (full[k] !== undefined) out[k] = full[k];
  if (typeof out['body'] === 'string' && !validateMarkdown(out['body']).ok) delete out['body'];
  return out;
}

function toImage(r: Record<string, any>): Record<string, unknown> {
  return { profile_kind: r['profile_kind'], profile_id: r['profile_id'], image_attachment_id: r['image_attachment_id'], is_active: r['is_active'], updated_at: iso(r['updated_at']) };
}

function parseLimit(v: unknown): number {
  const n = v === undefined ? 50 : typeof v === 'number' ? v : typeof v === 'string' && /^[0-9]{1,4}$/.test(v) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 200) invalid('/limit');
  return n;
}
function parseActive(v: unknown): boolean | undefined {
  if (v === undefined) return undefined;
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  return invalid('/is_active');
}
function parseKind(v: unknown, kinds: string[], path: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !kinds.includes(v)) invalid(path);
  return v as string;
}

const encode = (parts: unknown[]): string => Buffer.from(JSON.stringify(parts)).toString('base64url');
function decode(c: unknown, check: (p: unknown[]) => boolean): unknown[] | undefined {
  if (c === undefined) return undefined;
  try {
    if (typeof c !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(c)) throw new Error('shape');
    const p = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(p) || !check(p)) throw new Error('shape');
    return p;
  } catch { throw new LimsError('common.invalid_cursor'); }
}
const contentKey = (c: unknown): Key | undefined => {
  const p = decode(c, (x) => x.length === 3 && typeof x[0] === 'string' && KINDS.includes(x[0]) && Number.isInteger(x[1]) && isUuid(x[2]));
  return p ? { kind: p[0] as string, sortOrder: p[1] as number, id: p[2] as string } : undefined;
};

function page<T>(rows: Record<string, any>[], limit: number, map: (r: Record<string, any>) => T, key: (r: Record<string, any>) => unknown[]) {
  const data = rows.slice(0, limit);
  return { data: data.map(map), page: { limit, ...(rows.length > limit ? { next_cursor: encode(key(data[data.length - 1]!)) } : {}) } };
}

export function createContentService(deps: { repo?: ContentRepo } = {}) {
  const repo = deps.repo ?? defaultRepo;
  const contentId = (v: unknown): string => (isUuid(v) ? v.toLowerCase() : invalid('/content_id'));

  return {
    async list(ctx: ContentCtx, q: unknown) {
      const { tx, tenantId } = scope(ctx);
      const query = isObj(q) ? q : {};
      const kind = parseKind(query['kind'], KINDS, '/kind'); const isActive = parseActive(query['is_active']);
      const limit = parseLimit(query['limit']); const after = contentKey(query['cursor']);
      const rows = await repo.listContent(tx, { tenantId, ...(kind ? { kind } : {}), ...(isActive === undefined ? {} : { isActive }), ...(after ? { after } : {}), limit: limit + 1 });
      return page(rows, limit, toBody, (r) => [r['kind'], r['sort_order'], r['id']]);
    },

    /** listMyPortalContent: the patient actor only (a staff actor is refused, never served the staff view); RLS and the WHERE both apply the window. */
    async listPublic(ctx: ContentCtx, q: unknown) {
      const { tx, tenantId } = scope(ctx);
      if (ctx.actor.type !== 'patient') throw new LimsError('auth.forbidden');
      const query = isObj(q) ? q : {};
      const kind = parseKind(query['kind'], KINDS, '/kind');
      const limit = parseLimit(query['limit']); const after = contentKey(query['cursor']);
      const rows = await repo.listContent(tx, { tenantId, publicOnly: true, ...(kind ? { kind } : {}), ...(after ? { after } : {}), limit: limit + 1 });
      return page(rows, limit, toPublic, (r) => [r['kind'], r['sort_order'], r['id']]);
    },

    async create(ctx: ContentCtx, body: unknown) {
      const { tx, tenantId, userId } = scope(ctx);
      const f = parseFields(body, CREATE_KEYS);
      if (f.kind === undefined) invalid('/kind', 'common.field_required', 'Field required');
      if (f.title === undefined) invalid('/title', 'common.field_required', 'Field required');
      checkWindow(f.starts_on, f.ends_on);
      await checkAsset(repo, tx, tenantId, f.image_attachment_id);
      return toBody(await repo.insertContent(tx, { tenantId, userId, f: { ...f, kind: f.kind!, title: f.title!, sort_order: f.sort_order ?? 0 } }));
    },

    async update(ctx: ContentCtx, input: { id: unknown; headers: unknown; body: unknown }) {
      const { tx, tenantId, userId } = scope(ctx);
      const id = contentId(input.id);
      const expected = parseIfMatch(input.headers);
      const f = parseFields(input.body, UPDATE_KEYS);
      if (Object.keys(f).length === 0) invalid('/', 'common.field_required', 'At least one field');
      const cur = await repo.getContent(tx, { tenantId, id });
      if (!cur) throw new LimsError('common.not_found');
      if (cur['version'] !== expected) throw new LimsError('common.version_conflict');
      checkWindow(f.starts_on ?? cur['starts_on'], f.ends_on ?? cur['ends_on']);
      await checkAsset(repo, tx, tenantId, f.image_attachment_id);
      const row = await repo.updateContent(tx, { tenantId, userId, id, expectedVersion: expected, f });
      if (!row) throw new LimsError('common.version_conflict');
      return toBody(row);
    },

    async deactivate(ctx: ContentCtx, input: { id: unknown; headers: unknown }) {
      const { tx, tenantId, userId } = scope(ctx);
      const id = contentId(input.id);
      const expected = parseIfMatch(input.headers);
      const cur = await repo.getContent(tx, { tenantId, id });
      if (!cur) throw new LimsError('common.not_found');
      if (cur['version'] !== expected) throw new LimsError('common.version_conflict');
      const row = await repo.updateContent(tx, { tenantId, userId, id, expectedVersion: expected, f: { is_active: false } });
      if (!row) throw new LimsError('common.version_conflict');
      return toBody(row);
    },

    /** The list must name every item of the kind (inactive included) exactly once; position = sort_order (0 based). Atomic: refusal writes nothing. */
    async reorder(ctx: ContentCtx, body: unknown) {
      const { tx, tenantId, userId } = scope(ctx);
      if (!isObj(body)) return invalid('/');
      for (const k of Object.keys(body)) if (k !== 'kind' && k !== 'ids') invalid(`/${k.slice(0, 64)}`, 'common.unknown_field', 'Unknown field');
      const kind = parseKind(body['kind'], KINDS, '/kind');
      if (kind === undefined) return invalid('/kind', 'common.field_required', 'Field required');
      const raw = body['ids'];
      if (!Array.isArray(raw) || raw.length < 1 || raw.length > 500 || !raw.every(isUuid)) return invalid('/ids');
      const ids = (raw as string[]).map((x) => x.toLowerCase());
      if (new Set(ids).size !== ids.length) invalid('/ids');
      const existing = new Set(await repo.lockKind(tx, { tenantId, kind }));
      if (existing.size !== ids.length || !ids.every((x) => existing.has(x))) invalid('/ids');
      const rows = await repo.applyOrder(tx, { tenantId, userId, kind, ids });
      return { data: rows.map(toBody), page: { limit: Math.min(200, Math.max(1, rows.length)) } };
    },

    async listImages(ctx: ContentCtx, q: unknown) {
      const { tx, tenantId } = scope(ctx);
      const query = isObj(q) ? q : {};
      const kind = parseKind(query['profile_kind'], PROFILE_KINDS, '/profile_kind');
      const pid = query['profile_id'];
      if (pid !== undefined && !isUuid(pid)) invalid('/profile_id');
      const isActive = parseActive(query['is_active']); const limit = parseLimit(query['limit']);
      const p = decode(query['cursor'], (x) => x.length === 2 && typeof x[0] === 'string' && PROFILE_KINDS.includes(x[0]) && isUuid(x[1]));
      const rows = await repo.listProfileImages(tx, {
        tenantId, ...(kind ? { kind } : {}), ...(pid !== undefined ? { profileId: (pid as string).toLowerCase() } : {}), ...(isActive === undefined ? {} : { isActive }),
        ...(p ? { after: { kind: p[0] as string, id: p[1] as string } } : {}), limit: limit + 1,
      });
      return page(rows, limit, toImage, (r) => [r['profile_kind'], r['profile_id']]);
    },

    async setImage(ctx: ContentCtx, input: { kind: unknown; profileId: unknown; body: unknown }) {
      const { tx, tenantId, userId } = scope(ctx);
      const kind = parseKind(input.kind, PROFILE_KINDS, '/profile_kind');
      if (kind === undefined) return invalid('/profile_kind');
      if (!isUuid(input.profileId)) return invalid('/profile_id');
      const b = input.body;
      if (!isObj(b)) return invalid('/');
      for (const k of Object.keys(b)) if (k !== 'image_attachment_id') invalid(`/${k.slice(0, 64)}`, 'common.unknown_field', 'Unknown field');
      if (!isUuid(b['image_attachment_id'])) return invalid('/image_attachment_id');
      const imageId = b['image_attachment_id'].toLowerCase();
      await checkAsset(repo, tx, tenantId, imageId);
      return toImage(await repo.upsertProfileImage(tx, { tenantId, userId, kind, profileId: input.profileId.toLowerCase(), imageId }));
    },

    async clearImage(ctx: ContentCtx, input: { kind: unknown; profileId: unknown }) {
      const { tx, tenantId, userId } = scope(ctx);
      const kind = parseKind(input.kind, PROFILE_KINDS, '/profile_kind');
      if (kind === undefined) return invalid('/profile_kind');
      if (!isUuid(input.profileId)) return invalid('/profile_id');
      if (!(await repo.clearProfileImage(tx, { tenantId, userId, kind, profileId: input.profileId.toLowerCase() }))) throw new LimsError('common.not_found');
    },
  };
}
export type ContentService = ReturnType<typeof createContentService>;
