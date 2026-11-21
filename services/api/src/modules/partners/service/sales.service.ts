// T0B-SALES-1 (LD-321, LD-325 b; founder 2026-11-17 09:18 NPT priority; contract T0C-SALES-1): the 15 sales hierarchy operations of partners.yaml.
// Order in every operation: staff actor -> IdentityPort.assertRole (auth.forbidden; partners.sales.manage is privileged -> auth.mfa_required at aal1) -> If-Match
// -> request rules (domain/sales.rules.ts, no SQL) -> tenant-bound row lookup (foreign / unknown = the same common.not_found) -> version -> rules that need
// the database (level free, manager same tenant + active + no loop, party exists, no overlap, no active clients) -> ONE write. The DB CHECKs / triggers of
// migration 20261117210000 are only the concurrent backstop and map to the same common.validation_failed. Every write is audited by app.tg_row_audit
// (phone / email of a representative are excluded there); nothing of a request body is logged (no personal data in logs).
// Visibility (done_when (3)): a holder of partners.sales.manage sees the whole tenant; any other reader only the subtree under the active representative
// rows linked to the user (sales_representative.user_id = actor id); outside it = common.not_found (no existence leak).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../core/errors.js';
import type { HandlerContext, HandlerResult } from '../../../core/module.js';
import {
  MAX_TREE_DEPTH, bodyOf, email, ifMatch, invalid, isObj, isUuid, isoDate, level, optDate, partyKind, phone, qBool, qInt, qText, qUuid, text, unsetList, uuid, windowOrdered, type Obj,
} from '../domain/sales.rules.js';
import { toAssignmentDto, toClientDto, toDesignationDto, toRepresentativeDto, toServiceAreaDto, toTreeNodeDto } from '../mappers/sales.dto.js';
import * as repo from '../repository/sales.repo.js';

const READ = 'partners.sales.read';
const MANAGE = 'partners.sales.manage';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_TZ = 'Asia/Kathmandu';

type Req = { params?: unknown; query?: unknown; headers?: unknown; body?: unknown };
type Who = { tenantId: string; actorId: string };
const tx = (ctx: HandlerContext): repo.Q => ctx.tx as repo.Q;
const notFound = (): never => { throw new LimsError('common.not_found'); };

async function authorize(ctx: HandlerContext, permission: string): Promise<Who> {
  if (ctx.actor?.type !== 'user' || !ctx.tenantId) throw new LimsError('auth.forbidden');   // staff operation: patient / partner / device / system actors never reach SQL
  await ctx.ports.IdentityPort.assertRole(ctx, { permission });
  return { tenantId: ctx.tenantId, actorId: ctx.actor.id };
}
/** a manage holder sees the whole tenant; anybody else only the own subtree */
async function seesAll(ctx: HandlerContext): Promise<boolean> {
  try {
    const a = await (ctx.ports.IdentityPort as unknown as { getActor(c: unknown): Promise<{ permissions?: readonly string[] }> }).getActor(ctx);
    return Array.isArray(a?.permissions) && a.permissions.includes(MANAGE);
  } catch { return false; }   // fail closed: the own subtree only
}
/** the calendar date of ctx.now() in the tenant time zone (default Asia/Kathmandu) */
async function tenantZone(ctx: HandlerContext): Promise<string> {
  try {
    const t = (await (ctx.ports.IdentityPort as unknown as { getTenantSettings(c: unknown, i: { keys: string[] }): Promise<Obj | undefined> }).getTenantSettings(ctx, { keys: ['timezone'] }))?.['timezone'];
    if (typeof t === 'string' && t !== '') { new Intl.DateTimeFormat('en-CA', { timeZone: t }); return t; }
  } catch { /* fall back to the default zone */ }
  return DEFAULT_TZ;
}
const dateIn = (tz: string, at: Date): string => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
const nowOf = (ctx: HandlerContext): Date => new Date((ctx as unknown as { now(): Date | number | string }).now());

const param = (req: Req, k: string): string => { const v = isObj(req.params) ? req.params[k] : undefined; return isUuid(v) ? v : notFound(); };
const queryOf = (req: Req): Obj => (isObj(req.query) ? req.query : {});
const limitOf = (q: Obj): number => qInt(q, 'limit', 1, MAX_LIMIT) ?? DEFAULT_LIMIT;

// ---- cursor: base64url(JSON {v:1, s:<list>, k:<key>}); carries no authority (02-CV §4.3) ----
const encodeCursor = (s: string, k: unknown): string => Buffer.from(JSON.stringify({ v: 1, s, k })).toString('base64url');
function decodeCursor<T>(raw: unknown, s: string, check: (k: unknown) => k is T): T | undefined {
  if (raw === undefined) return undefined;
  const bad = (): never => { throw new LimsError('common.invalid_cursor'); };
  if (typeof raw !== 'string' || raw.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(raw)) return bad();
  let o: unknown;
  try { o = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { return bad(); }
  if (!isObj(o) || o['v'] !== 1 || o['s'] !== s || !check(o['k'])) return bad();
  return o['k'] as T;
}
const isNameKey = (k: unknown): k is { name: string; id: string } => isObj(k) && typeof k['name'] === 'string' && k['name'].length <= 200 && isUuid(k['id']);
function page<T>(rows: repo.Row[], limit: number, map: (r: repo.Row) => T, key: (r: repo.Row) => unknown, s: string) {
  const data = rows.slice(0, limit);
  const last = rows.length > limit ? data[data.length - 1] : undefined;
  return { status: 200, body: { data: data.map(map), page: { limit, ...(last ? { next_cursor: encodeCursor(s, key(last)) } : {}) } } };
}

/** DB backstop -> the same validation error the domain check gives (a concurrent request won between our check and our write) */
function backstop(e: unknown): never {
  const x = e as { code?: string; constraint?: string; message?: string };
  if (x?.code === '23505' && /level/.test(x.constraint ?? '')) throw invalid('/level');
  if (x?.code === '23514' && /manager|own_manager/.test(`${x.message ?? ''} ${x.constraint ?? ''}`)) throw invalid('/manager_id');
  if (x?.code === '23P01') throw invalid('/effective_from');
  throw e;
}

// ================================================================ designations
export async function listDesignations(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const { tenantId } = await authorize(ctx, READ);
  const q = queryOf(req);
  const f = { level: qInt(q, 'level', 1, 8), isActive: qBool(q, 'is_active'), q: qText(q, 'q', 64), limit: limitOf(q) };
  const after = decodeCursor(q['cursor'], 'designations', (k): k is number => Number.isInteger(k) && (k as number) >= 1 && (k as number) <= 8);
  const rows = await repo.listDesignations(tx(ctx), tenantId, { ...strip(f), ...(after !== undefined ? { after: { level: after } } : {}) });
  return page(rows, f.limit, toDesignationDto, (r) => Number(r['level']), 'designations');
}

export async function createDesignation(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const { tenantId, actorId } = await authorize(ctx, MANAGE);
  const b = bodyOf(req.body, ['name', 'level']);
  const name = text(b, 'name', 120, true)!; const lvl = level(b['level']);
  if (await repo.levelTaken(tx(ctx), tenantId, lvl)) throw invalid('/level');
  const id = uuidv7();
  await repo.insertDesignation(tx(ctx), tenantId, { id, name, level: lvl, actorId }).catch(backstop);
  return { status: 201, body: toDesignationDto((await repo.getDesignation(tx(ctx), tenantId, id))!) };
}

export async function updateDesignation(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const { tenantId, actorId } = await authorize(ctx, MANAGE);
  const expected = ifMatch(req.headers);
  const id = param(req, 'designation_id');
  const b = bodyOf(req.body, ['name', 'level', 'is_active']);
  const patch: Obj = {};
  const name = text(b, 'name', 120, false); if (name !== undefined) patch['name'] = name;
  if (b['level'] !== undefined) patch['level'] = level(b['level']);
  if (b['is_active'] !== undefined) { if (typeof b['is_active'] !== 'boolean') throw invalid('/is_active'); patch['is_active'] = b['is_active']; }
  if (Object.keys(patch).length === 0) throw invalid('');
  const cur = (await repo.getDesignation(tx(ctx), tenantId, id, true)) ?? notFound();
  if (Number(cur['version']) !== expected) throw new LimsError('common.version_conflict');
  if (patch['level'] !== undefined && await repo.levelTaken(tx(ctx), tenantId, patch['level'] as number, id)) throw invalid('/level');
  if (!await repo.bump(tx(ctx), 'sales_designation', tenantId, id, expected, patch, actorId).catch(backstop)) throw new LimsError('common.version_conflict');
  return { status: 200, body: toDesignationDto((await repo.getDesignation(tx(ctx), tenantId, id))!) };
}

// ================================================================ representatives
const REP_FIELDS = ['name', 'phone', 'email', 'user_id', 'designation_id', 'manager_id', 'joining_date'] as const;
const REP_OPTIONAL = ['phone', 'email', 'user_id', 'manager_id', 'joining_date'] as const;

/** the request values of a representative, checked without SQL */
function repValues(b: Obj, create: boolean): Obj {
  const v: Obj = {};
  const put = (k: string, x: unknown): void => { if (x !== undefined) v[k] = x; };
  put('name', text(b, 'name', 200, create)); put('phone', phone(b)); put('email', email(b)); put('user_id', uuid(b, 'user_id', false));
  put('designation_id', uuid(b, 'designation_id', create)); put('manager_id', uuid(b, 'manager_id', false)); put('joining_date', optDate(b, 'joining_date'));
  return v;
}
/** designation: an ACTIVE designation of this tenant */
async function checkDesignation(ctx: HandlerContext, tenantId: string, id: string): Promise<void> {
  const d = await repo.getDesignation(tx(ctx), tenantId, id);
  if (!d || d['is_active'] !== true) throw invalid('/designation_id');
}
/** manager: not itself, an ACTIVE representative of this tenant (row locked FOR SHARE so it cannot be deactivated under us), and no loop */
async function checkManager(ctx: HandlerContext, tenantId: string, repId: string, managerId: string): Promise<void> {
  if (managerId === repId) throw invalid('/manager_id');
  const m = await repo.getRepresentative(tx(ctx), tenantId, managerId, 'FOR SHARE');
  if (!m || m['is_active'] !== true) throw invalid('/manager_id');
  if (await repo.wouldLoop(tx(ctx), tenantId, repId, managerId)) throw invalid('/manager_id');
}

export async function listRepresentatives(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const { tenantId, actorId } = await authorize(ctx, READ);
  const q = queryOf(req);
  const f = { q: qText(q, 'q', 64), designationId: qUuid(q, 'designation_id'), managerId: qUuid(q, 'manager_id'), isActive: qBool(q, 'is_active'), limit: limitOf(q) };
  const after = decodeCursor(q['cursor'], 'representatives', isNameKey);
  const all = await seesAll(ctx);
  const rows = await repo.listRepresentatives(tx(ctx), tenantId, { ...strip(f), ...(all ? {} : { scopeUserId: actorId }), ...(after ? { after } : {}) });
  return page(rows, f.limit, toRepresentativeDto, (r) => ({ name: r['name'], id: r['id'] }), 'representatives');
}

export async function createRepresentative(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const { tenantId, actorId } = await authorize(ctx, MANAGE);
  const v = repValues(bodyOf(req.body, REP_FIELDS), true);
  const id = uuidv7();
  await checkDesignation(ctx, tenantId, v['designation_id'] as string);
  if (v['manager_id'] !== undefined) {
    await repo.lockManagerChanges(tx(ctx), tenantId);   // same lock as the loop trigger: manager changes of a tenant run one at a time (taken before any row lock)
    await checkManager(ctx, tenantId, id, v['manager_id'] as string);
  }
  await repo.insertRepresentative(tx(ctx), tenantId, { ...v, id, actorId }).catch(backstop);
  return { status: 201, body: toRepresentativeDto((await repo.getRepresentative(tx(ctx), tenantId, id))!) };
}

export async function updateRepresentative(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const { tenantId, actorId } = await authorize(ctx, MANAGE);
  const expected = ifMatch(req.headers);
  const id = param(req, 'representative_id');
  const b = bodyOf(req.body, [...REP_FIELDS, 'unset']);
  const patch = repValues(b, false);
  for (const k of unsetList(b, REP_OPTIONAL)) patch[k] = null;
  if (Object.keys(patch).length === 0) throw invalid('');
  if (patch['manager_id'] === id) throw invalid('/manager_id');   // no self manager: refused before any SQL
  if (typeof patch['manager_id'] === 'string') await repo.lockManagerChanges(tx(ctx), tenantId);   // lock order: tenant manager lock, then rows (no deadlock between movers)
  const cur = (await repo.getRepresentative(tx(ctx), tenantId, id, 'FOR NO KEY UPDATE')) ?? notFound();
  if (Number(cur['version']) !== expected) throw new LimsError('common.version_conflict');
  if (typeof patch['designation_id'] === 'string') await checkDesignation(ctx, tenantId, patch['designation_id']);
  if (typeof patch['manager_id'] === 'string' && patch['manager_id'] !== cur['manager_id']) await checkManager(ctx, tenantId, id, patch['manager_id']);
  // moving a representative moves its whole team: the reports keep their manager_id
  if (!await repo.bump(tx(ctx), 'sales_representative', tenantId, id, expected, patch, actorId).catch(backstop)) throw new LimsError('common.version_conflict');
  return { status: 200, body: toRepresentativeDto((await repo.getRepresentative(tx(ctx), tenantId, id))!) };
}

/**
 * Refused (validation, path /representative_id) while the representative has an assignment that is open or ends today or later (tenant date):
 * unassign or reassign the clients first. [CONV] the contract has no body here, so the "reassign in the same request" of the brief is not offered (CR gap, tests note).
 * Direct reports keep manager_id (a deactivated manager stays in the tree as a node); nothing is deleted.
 */
export async function deactivateRepresentative(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const { tenantId, actorId } = await authorize(ctx, MANAGE);
  const expected = ifMatch(req.headers);
  const id = param(req, 'representative_id');
  const cur = (await repo.getRepresentative(tx(ctx), tenantId, id, 'FOR NO KEY UPDATE')) ?? notFound();   // an assignment in flight holds FOR SHARE: we wait for it
  if (Number(cur['version']) !== expected) throw new LimsError('common.version_conflict');
  if (cur['is_active'] !== true) return { status: 200, body: toRepresentativeDto(cur) };   // already off: nothing to write
  if (await repo.hasActiveClients(tx(ctx), tenantId, id, dateIn(await tenantZone(ctx), nowOf(ctx)))) throw invalid('/representative_id');
  if (!await repo.bump(tx(ctx), 'sales_representative', tenantId, id, expected, { is_active: false }, actorId)) throw new LimsError('common.version_conflict');
  return { status: 200, body: toRepresentativeDto((await repo.getRepresentative(tx(ctx), tenantId, id))!) };
}

// ================================================================ tree
const isPath = (k: unknown): k is string[] => Array.isArray(k) && k.length >= 1 && k.length <= MAX_TREE_DEPTH && k.every(isUuid);
export async function getTree(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const { tenantId, actorId } = await authorize(ctx, READ);
  const q = queryOf(req);
  const rootId = qUuid(q, 'root_id');
  const maxDepth = qInt(q, 'max_depth', 1, MAX_TREE_DEPTH) ?? MAX_TREE_DEPTH;
  const includeInactive = qBool(q, 'include_inactive') ?? false;
  const limit = limitOf(q);
  const after = decodeCursor(q['cursor'], 'tree', isPath);
  const all = await seesAll(ctx);
  if (!all && rootId !== undefined && !await repo.inOwnSubtree(tx(ctx), tenantId, actorId, rootId)) notFound();
  const rows = await repo.salesTree(tx(ctx), tenantId, {
    ...(rootId !== undefined ? { rootId } : all ? {} : { ownUserId: actorId }), maxDepth, includeInactive, ...(after ? { after } : {}), limit,
  });
  if (rootId !== undefined && after === undefined && rows.length === 0) notFound();   // the root is always listed: empty = unknown / other tenant
  return page(rows, limit, toTreeNodeDto, (r) => r['path'], 'tree');
}

// ================================================================ party assignments
export async function assignParty(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const { tenantId, actorId } = await authorize(ctx, MANAGE);
  const b = bodyOf(req.body, ['party_kind', 'party_id', 'representative_id', 'effective_from', 'effective_to']);
  const kind = partyKind(b['party_kind']);
  const partyId = uuid(b, 'party_id', true)!; const repId = uuid(b, 'representative_id', true)!;
  const from = isoDate(b['effective_from'], '/effective_from'); const to = optDate(b, 'effective_to') ?? null;
  if (!windowOrdered(from, to)) throw invalid('/effective_to');   // dates ordered (inclusive: the same day is fine)
  if (!await repo.partyExists(tx(ctx), tenantId, kind, partyId)) throw invalid('/party_id');
  const rep = await repo.getRepresentative(tx(ctx), tenantId, repId, 'FOR SHARE');   // a deactivation of this representative waits for us (and we for it)
  if (!rep || rep['is_active'] !== true) throw invalid('/representative_id');
  if (await repo.overlaps(tx(ctx), tenantId, { kind, partyId, repId, from, to })) throw invalid('/effective_from');
  const id = uuidv7();
  await repo.insertAssignment(tx(ctx), tenantId, { id, kind, partyId, repId, from, to, actorId }).catch(backstop);   // trigger: overlap under a per party+representative lock
  return { status: 201, body: toAssignmentDto((await repo.getAssignment(tx(ctx), tenantId, id))!) };
}

/** ends the assignment on effective_to (default: today in the tenant time zone); the row is kept for history */
export async function unassignParty(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const { tenantId, actorId } = await authorize(ctx, MANAGE);
  const expected = ifMatch(req.headers);
  const id = param(req, 'assignment_id');
  const b = bodyOf(req.body, ['effective_to'], { optional: true });
  const explicit = optDate(b, 'effective_to');
  const cur = (await repo.getAssignment(tx(ctx), tenantId, id, true)) ?? notFound();
  if (Number(cur['version']) !== expected) throw new LimsError('common.version_conflict');
  const to = explicit ?? dateIn(await tenantZone(ctx), nowOf(ctx));
  if (!windowOrdered(String(cur['effective_from']), to)) throw invalid('/effective_to');   // a future start cannot be ended before it begins
  if (!await repo.bump(tx(ctx), 'party_sales_assignment', tenantId, id, expected, { effective_to: to }, actorId).catch(backstop)) throw new LimsError('common.version_conflict');
  return { status: 200, body: toAssignmentDto((await repo.getAssignment(tx(ctx), tenantId, id))!) };
}

export async function listClients(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const { tenantId, actorId } = await authorize(ctx, READ);
  const repId = param(req, 'representative_id');
  const q = queryOf(req);
  const kind = q['party_kind'] === undefined ? undefined : partyKind(q['party_kind'], '/party_kind');
  const asOfRaw = q['as_of'] === undefined ? undefined : isoDate(q['as_of'], '/as_of');
  const limit = limitOf(q);
  const after = decodeCursor(q['cursor'], 'clients', isUuid);
  const visible = (await seesAll(ctx)) ? (await repo.getRepresentative(tx(ctx), tenantId, repId)) !== undefined : await repo.inOwnSubtree(tx(ctx), tenantId, actorId, repId);
  if (!visible) notFound();
  const tz = await tenantZone(ctx);
  const rows = await repo.listClients(tx(ctx), tenantId, { repId, asOf: asOfRaw ?? dateIn(tz, nowOf(ctx)), tz, ...(kind ? { kind } : {}), ...(after ? { after } : {}), limit });
  return page(rows, limit, toClientDto, (r) => r['assignment_id'], 'clients');
}

// ================================================================ service areas
export async function listServiceAreas(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const { tenantId } = await authorize(ctx, READ);
  const q = queryOf(req);
  const f = { district: qText(q, 'district', 100), centreId: qUuid(q, 'centre_id'), isActive: qBool(q, 'is_active'), q: qText(q, 'q', 64), limit: limitOf(q) };
  const after = decodeCursor(q['cursor'], 'service_areas', isNameKey);
  const rows = await repo.listServiceAreas(tx(ctx), tenantId, { ...strip(f), ...(after ? { after } : {}) });
  return page(rows, f.limit, toServiceAreaDto, (r) => ({ name: r['name'], id: r['id'] }), 'service_areas');
}

export async function createServiceArea(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const { tenantId, actorId } = await authorize(ctx, MANAGE);
  const b = bodyOf(req.body, ['name', 'district', 'area_text', 'centre_id']);
  const name = text(b, 'name', 200, true)!; const district = text(b, 'district', 100, true)!;
  const areaText = text(b, 'area_text', 500, false) ?? null; const centreId = uuid(b, 'centre_id', false) ?? null;
  if (centreId !== null && !await repo.centreExists(tx(ctx), tenantId, centreId)) throw invalid('/centre_id');
  const id = uuidv7();
  await repo.insertServiceArea(tx(ctx), tenantId, { id, name, district, areaText, centreId, actorId });
  return { status: 201, body: toServiceAreaDto((await repo.getServiceArea(tx(ctx), tenantId, id))!) };
}

export async function updateServiceArea(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const { tenantId, actorId } = await authorize(ctx, MANAGE);
  const expected = ifMatch(req.headers);
  const id = param(req, 'service_area_id');
  const b = bodyOf(req.body, ['name', 'district', 'area_text', 'centre_id', 'unset']);
  const patch: Obj = {};
  const put = (k: string, x: unknown): void => { if (x !== undefined) patch[k] = x; };
  put('name', text(b, 'name', 200, false)); put('district', text(b, 'district', 100, false)); put('area_text', text(b, 'area_text', 500, false)); put('centre_id', uuid(b, 'centre_id', false));
  for (const k of unsetList(b, ['area_text', 'centre_id'])) patch[k] = null;
  if (Object.keys(patch).length === 0) throw invalid('');
  const cur = (await repo.getServiceArea(tx(ctx), tenantId, id, true)) ?? notFound();
  if (Number(cur['version']) !== expected) throw new LimsError('common.version_conflict');
  if (typeof patch['centre_id'] === 'string' && !await repo.centreExists(tx(ctx), tenantId, patch['centre_id'])) throw invalid('/centre_id');
  if (!await repo.bump(tx(ctx), 'service_area', tenantId, id, expected, patch, actorId)) throw new LimsError('common.version_conflict');
  return { status: 200, body: toServiceAreaDto((await repo.getServiceArea(tx(ctx), tenantId, id))!) };
}

export async function deactivateServiceArea(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const { tenantId, actorId } = await authorize(ctx, MANAGE);
  const expected = ifMatch(req.headers);
  const id = param(req, 'service_area_id');
  const cur = (await repo.getServiceArea(tx(ctx), tenantId, id, true)) ?? notFound();
  if (Number(cur['version']) !== expected) throw new LimsError('common.version_conflict');
  if (cur['is_active'] !== true) return { status: 200, body: toServiceAreaDto(cur) };   // already off: nothing to write
  if (!await repo.bump(tx(ctx), 'service_area', tenantId, id, expected, { is_active: false }, actorId)) throw new LimsError('common.version_conflict');
  return { status: 200, body: toServiceAreaDto((await repo.getServiceArea(tx(ctx), tenantId, id))!) };
}

/** drop undefined keys (exactOptionalPropertyTypes) */
function strip<T extends Obj>(o: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as never;
}
