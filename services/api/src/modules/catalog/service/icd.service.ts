// T0B-PARTYSET-1 (LD-321, LD-325 b): the per tenant ICD master (catalog.icd_code), additive to the catalog module. Separate from the frontdesk registration
// pick list (frontdesk.icd_codes), which stays untouched. Every operation asserts catalog.icd.manage itself (IdentityPort), then the request rules (no SQL),
// then the tenant-bound row (foreign / unknown = common.not_found), then the version, then ONE write (audited by app.tg_row_audit). Deactivate, never delete.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../core/errors.js';
import type { HandlerContext, HandlerResult } from '../../../core/module.js';
import { Checker, ifMatch, invalid, isObj, isUuid, type Obj } from '../../../core/validation/request-rules.js';
import * as repo from '../repo/icd.repo.js';

const MANAGE = 'catalog.icd.manage';
const ICD_CODE = /^[0-9A-Z][0-9A-Z.]{0,15}$/;
type Req = { params?: unknown; query?: unknown; headers?: unknown; body?: unknown };
const tx = (ctx: HandlerContext): repo.Q => ctx.tx as repo.Q;
const notFound = (): never => { throw new LimsError('common.not_found'); };

async function authorize(ctx: HandlerContext): Promise<{ tenantId: string; actorId: string }> {
  if (ctx.actor?.type !== 'user' || !ctx.tenantId || !ctx.ports?.IdentityPort) throw new LimsError('auth.forbidden');
  await ctx.ports.IdentityPort.assertRole(ctx, { permission: MANAGE });
  return { tenantId: ctx.tenantId, actorId: ctx.actor.id };
}
const dto = (r: repo.Row): Obj => ({
  id: r['id'], code: r['code'], title: r['title'], ...(r['chapter'] == null ? {} : { chapter: r['chapter'] }), is_active: r['is_active'] === true,
  version: Number(r['version']), created_at: r['created_at'], updated_at: r['updated_at'],
});
const idParam = (req: Req): string => { const v = isObj(req.params) ? req.params['icd_code_id'] : undefined; return isUuid(v) ? v.toLowerCase() : notFound(); };
function intQ(q: Obj, k: string, min: number, max: number, dflt: number, c: Checker): number {
  const v = q[k];
  if (v === undefined) return dflt;
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,4}$/.test(v) ? Number(v) : Number.NaN;
  if (!Number.isInteger(n) || n < min || n > max) { c.bad(`/${k}`); return dflt; }
  return n;
}
const encode = (k: { code: string; id: string }): string => Buffer.from(JSON.stringify({ v: 1, s: 'icd', k })).toString('base64url');
function decode(raw: unknown): { code: string; id: string } | undefined {
  if (raw === undefined) return undefined;
  const bad = (): never => { throw new LimsError('common.invalid_cursor'); };
  if (typeof raw !== 'string' || raw.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(raw)) return bad();
  let o: unknown;
  try { o = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { return bad(); }
  if (!isObj(o) || o['v'] !== 1 || o['s'] !== 'icd' || !isObj(o['k']) || typeof o['k']['code'] !== 'string' || !ICD_CODE.test(o['k']['code']) || !isUuid(o['k']['id'])) return bad();
  return o['k'] as { code: string; id: string };
}

export async function listIcd(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const { tenantId } = await authorize(ctx);
  const q = isObj(req.query) ? req.query : {};
  const c = new Checker(q);
  const text = c.text('q', 64); const chapter = c.text('chapter', 120); const limit = intQ(q, 'limit', 1, 200, 50, c);
  const ia = q['is_active']; const isActive = ia === undefined ? undefined : ia === true || ia === 'true' ? true : ia === false || ia === 'false' ? false : c.bad('/is_active');
  c.done();
  const after = decode(q['cursor']);
  const rows = await repo.list(tx(ctx), tenantId, { ...(text !== undefined ? { q: text } : {}), ...(chapter !== undefined ? { chapter } : {}), ...(isActive !== undefined ? { isActive } : {}), ...(after ? { after } : {}), limit });
  const data = rows.slice(0, limit);
  const last = rows.length > limit ? data[data.length - 1] : undefined;
  return { status: 200, body: { data: data.map(dto), page: { limit, ...(last ? { next_cursor: encode({ code: last['code'], id: last['id'] }) } : {}) } } };
}

export async function searchIcd(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const { tenantId } = await authorize(ctx);
  const q = isObj(req.query) ? req.query : {};
  const c = new Checker(q);
  const text = c.text('q', 64, true); const limit = intQ(q, 'limit', 1, 50, 20, c);
  c.done();
  return { status: 200, body: { data: (await repo.search(tx(ctx), tenantId, text!, limit)).map(dto) } };
}

export async function createIcd(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const { tenantId, actorId } = await authorize(ctx);
  const c = new Checker(req.body, ['code', 'title', 'chapter']);
  const code = c.text('code', 16, true, ICD_CODE); const title = c.text('title', 500, true); const chapter = c.text('chapter', 120);
  c.done();
  if (await repo.codeTaken(tx(ctx), tenantId, code!)) throw invalid('/code');
  const id = uuidv7();
  await repo.insert(tx(ctx), tenantId, { id, code: code!, title: title!, chapter: chapter ?? null, actorId }).catch((e: { code?: string }) => {
    if (e?.code === '23505') throw invalid('/code');   // a concurrent create of the same code won
    throw e;
  });
  return { status: 201, body: dto((await repo.get(tx(ctx), tenantId, id))!) };
}

export async function updateIcd(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const { tenantId, actorId } = await authorize(ctx);
  const expected = ifMatch(req.headers)!;
  const c = new Checker(req.body, ['title', 'chapter']);
  const patch: Obj = {};
  const title = c.text('title', 500); if (title !== undefined) patch['title'] = title;
  const chapter = c.text('chapter', 120); if (chapter !== undefined) patch['chapter'] = chapter;
  if (Object.keys(patch).length === 0 && c.errors.length === 0) c.bad('/');   // minProperties 1; the code is never renamed (unknown field)
  c.done();
  const id = idParam(req);
  const cur = (await repo.get(tx(ctx), tenantId, id, true)) ?? notFound();
  if (Number(cur['version']) !== expected) throw new LimsError('common.version_conflict');
  if (!await repo.bump(tx(ctx), tenantId, id, expected, patch, actorId)) throw new LimsError('common.version_conflict');
  return { status: 200, body: dto((await repo.get(tx(ctx), tenantId, id))!) };
}

export async function deactivateIcd(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const { tenantId, actorId } = await authorize(ctx);
  const expected = ifMatch(req.headers)!;
  const id = idParam(req);
  const cur = (await repo.get(tx(ctx), tenantId, id, true)) ?? notFound();
  if (Number(cur['version']) !== expected) throw new LimsError('common.version_conflict');
  if (cur['is_active'] !== true) return { status: 200, body: dto(cur) };
  if (!await repo.bump(tx(ctx), tenantId, id, expected, { is_active: false }, actorId)) throw new LimsError('common.version_conflict');
  return { status: 200, body: dto((await repo.get(tx(ctx), tenantId, id))!) };
}
