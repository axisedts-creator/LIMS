// Price lists, assignments, versions, items #71–#81 (02-TRD §5 rows 71–81, §5.0, §5.1 PriceList / PriceListVersion, §9.1; PRD AC-13.3–13.8; 03-APP-FLOW §2.1 V1–V5, E1/E2/E11/E22/E25;
// 05-SCHEMA price_lists / price_list_assignments / price_list_versions / price_list_items + §5 triggers); 07-SECURITY S-1, S-3, S-5, AB-1, AB-2, AB-3, AB-10, AB-20.
// Validates its own input (import commits call it directly). Every statement is single-table and tenant-scoped (RLS is the backstop). The quote engine #82 is T-19's.
// Revision: create -> `price_list`/created, PATCH / assignments -> updated|deactivated, publish -> versioned (entity_id = LIST id, effective_from = the version's). Draft edits, copies and discards
// bump nothing (drafts are invisible to consumers). Lock order: price_lists row, price_list_versions row, items, then catalog_state (bumpRevision).
// [CONV] a published version is frozen by trigger; the service checks status first (409 catalog.version_in_use) and maps a P0001 to the same code.
// [CONV] bulk-remove outcomes: removed -> `updated`, valid orderable without an item -> `unchanged`, unknown / foreign orderable -> `error` common.not_found.
// [CONV] a bulk-upsert with ANY invalid row (shape, price, duplicate orderable) is refused whole with 400; only unknown / foreign orderable ids are per-row errors (AB-2).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';   // [CONV] relative import (same as masters.service.ts)
import { LimsError, type FieldError } from '../../../core/errors.js';
import { decodeCursor, encodeCursor } from '../mappers/masters.mapper.js';
import * as repo from '../repo/masters.repo.js';
import {
  UUID, checkUpdate, fail, invalid, isObj, kindOf, lockAt, mapPg, required, unknown,
  type Ctx, type Deps, type Tx,
} from './masters.service.js';
import { createRevisionService } from './revision.service.js';
import * as stateRepo from '../repo/catalogState.repo.js';
import { windowsOverlap } from '../domain/surcharge.js';
import { isTaxTypeUsable } from '../domain/tax.js';

const LIST_COLS = ['id', 'code', 'name', 'owner_kind', 'falls_through', 'version', 'is_active'];
const VER_COLS = ['id', 'price_list_id', 'version_no', 'status', 'effective_from', 'effective_to', 'item_count', 'source_import_id', 'change_reason', 'version'];
const CODE_IN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;     // checked BEFORE upper-casing: no Unicode case-fold forgeries (ı -> I)
const KINDS = ['default', 'credit_party', 'referrer', 'centre'];
/** owner_kind -> [owner table, assignment column]; fixed strings only (never user input). */
const OWNER: Record<string, readonly [string, string]> = {
  credit_party: ['catalog.credit_parties', 'credit_party_id'], referrer: ['catalog.doctors', 'doctor_id'], centre: ['core.collection_centres', 'centre_id'],
};
const MAX_OWNERS = 500;
const MAX_BATCH = 200;
const MAX_PRICE = 999_999_999;
const SKEW_MS = 300_000;                                 // V4: effective_from >= now - 300 s
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)$/;

type R = Record<string, any>;
const ts = (v: unknown): string | undefined => (v == null ? undefined : new Date(v as string).toISOString());
const ms = (v: unknown): number => new Date(v as string).getTime();

/** Declared keys only (S-5). Errors never echo a submitted key or value (AB-20): unknown keys are reported at the root. */
function exact(input: unknown, allowed: readonly string[]): R {
  if (!isObj(input)) return fail([invalid('')]);
  const out: R = {};
  let bad = false;
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    if (allowed.includes(k)) out[k] = v; else bad = true;
  }
  if (bad) fail([unknown('')]);
  return out;
}
const uuidArg = (v: unknown, path: string): string => (typeof v === 'string' && UUID.test(v) ? v : fail([invalid(path)]));
/** A de-duplicated uuid array of at most `max` members, or a 400 at `path`. */
function uuidList(v: unknown, path: string, max: number, min = 0): string[] {
  if (!Array.isArray(v) || v.length < min || v.length > max || v.some((x) => typeof x !== 'string' || !UUID.test(x)) || new Set(v).size !== v.length) return fail([invalid(path)]);
  return v as string[];
}
/** PriceMoney: exactly {amount_paisa: integer 0..999,999,999, currency: 'NPR'} (AC-13.8). */
function paisa(v: unknown): number | undefined {
  if (!isObj(v) || Object.keys(v).length !== 2 || v['currency'] !== 'NPR') return undefined;
  const n = v['amount_paisa'];
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX_PRICE ? n : undefined;
}

const versionDto = (v: R) => {
  const out: R = { id: v.id, price_list_id: v.price_list_id, version_no: Number(v.version_no), status: v.status };
  if (v.effective_from != null) out['effective_from'] = ts(v.effective_from);
  if (v.effective_to != null) out['effective_to'] = ts(v.effective_to);
  out['item_count'] = Number(v.item_count);
  if (v.source_import_id != null) out['source_import_id'] = v.source_import_id;
  if (v.change_reason != null) out['change_reason'] = v.change_reason;
  out['version'] = Number(v.version);
  return out;
};
const versionRef = (v: R) => ({ id: v.id, version_no: Number(v.version_no), effective_from: ts(v.effective_from) });

/** PriceList DTO; current / scheduled are derived from the published|superseded windows at `now` (a superseded window still counts while it contains now). */
function listDto(r: R, owners: string[], versions: R[], now: number): R {
  const out: R = {
    id: r.id, code: r.code, name: r.name, owner_kind: r.owner_kind, falls_through: r.falls_through === true,
    assignments: [...owners].sort().map((owner_id) => ({ owner_id })),
  };
  const live = versions.filter((v) => v.status === 'published' || v.status === 'superseded');
  const current = live.filter((v) => ms(v.effective_from) <= now && (v.effective_to == null || now < ms(v.effective_to))).sort((a, b) => ms(b.effective_from) - ms(a.effective_from))[0];
  const scheduled = live.filter((v) => ms(v.effective_from) > now).sort((a, b) => ms(a.effective_from) - ms(b.effective_from))[0];
  const draft = versions.find((v) => v.status === 'draft');
  if (current) out['current_version'] = versionRef(current);
  if (scheduled) out['scheduled_version'] = versionRef(scheduled);
  if (draft) out['draft_version_id'] = draft.id;
  out['is_active'] = r.is_active === true; out['version'] = Number(r.version);
  return out;
}

/** 23505 on a version insert = the one-draft index or version_no (V1: 409 version_conflict); P0001 = the immutability triggers. */
function mapVersionPg(e: unknown): never {
  const c = (e as { code?: unknown })?.code;
  if (c === '23505') throw new LimsError('common.version_conflict');
  if (c === 'P0001') throw new LimsError('catalog.version_in_use');
  return mapPg(e);
}
function mapItemPg(e: unknown): never {
  if ((e as { code?: unknown })?.code === 'P0001') throw new LimsError('catalog.version_in_use');
  return mapPg(e);
}

// ---- T-18: surcharge rules #83–#85, tax types #86–#88, tax rules #89–#91 (02-TRD §5.1, §7.5, §7.6; PRD AC-14.5, AC-15.2, AC-15.5; 08 R18).
// Every write: validate -> tenant-scoped existence checks -> lock catalog_state (serialises the overlap check, §7.5/§7.6) -> row lock -> write -> bumpRevision.
// [CONV] events: surcharge rules entity_type `surcharge_rule`; tax types AND tax rules entity_type `tax_rule`; /end -> `deactivated` with effective_from = effective_to (02-TRD §8); a rate change -> `updated` with the new version's id + effective_from.
const S_COLS = ['id', 'scope', 'department_id', 'orderable_id', 'price_list_id', 'amount_kind', 'amount_paisa', 'percent_bp', 'effective_from', 'effective_to', 'is_active', 'version'];
const R_COLS = ['id', 'scope', 'department_id', 'orderable_id', 'vat_treatment', 'other_tax_code', 'hs_code', 'effective_from', 'effective_to', 'is_active', 'version'];
const Y_COLS = ['id', 'code', 'display', 'rate_bp', 'effective_from', 'effective_to', 'sort_order', 'is_active', 'version'];
const TAX_CODE = /^[A-Z0-9_]{1,16}$/;
const TAX_CODE_IN = /^[A-Za-z0-9_]{1,16}$/;              // checked BEFORE upper-casing (no Unicode case-fold forgeries)
const HS = /^[0-9]{4,8}$/;
const S_SCOPES = ['all', 'department', 'orderable'];
const R_SCOPES = ['tenant_default', 'department', 'orderable'];

const isoArg = (v: unknown): string | undefined => (typeof v === 'string' && ISO.test(v) && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : undefined);
const nullOr = (v: unknown) => (v == null ? undefined : v);
const omitEmpty = (o: R): R => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const inForce = (r: R, at: number) => r.is_active !== false && ms(r.effective_from) <= at && (r.effective_to == null || at < ms(r.effective_to));

const surchargeDto = (r: R): R => omitEmpty({
  id: r.id, scope: r.scope, department_id: nullOr(r.department_id), orderable_id: nullOr(r.orderable_id), price_list_id: nullOr(r.price_list_id), amount_kind: r.amount_kind,
  amount: r.amount_paisa == null ? undefined : { amount_paisa: Number(r.amount_paisa), currency: 'NPR' }, percent_bp: r.percent_bp == null ? undefined : Number(r.percent_bp),
  effective_from: ts(r.effective_from), effective_to: ts(r.effective_to), version: Number(r.version),
});
const taxRuleDto = (r: R): R => omitEmpty({
  id: r.id, scope: r.scope, department_id: nullOr(r.department_id), orderable_id: nullOr(r.orderable_id), vat_treatment: r.vat_treatment,
  other_tax_code: nullOr(r.other_tax_code), hs_code: nullOr(r.hs_code), effective_from: ts(r.effective_from), effective_to: ts(r.effective_to), version: Number(r.version),
});
const taxTypeDto = (r: R): R => omitEmpty({
  id: r.id, code: r.code, display: r.display, rate_bp: r.rate_bp == null ? undefined : Number(r.rate_bp),
  effective_from: ts(r.effective_from), effective_to: ts(r.effective_to), scope: 'tenant', is_active: r.is_active === true, version: Number(r.version),
});
// CR pending: .orchestra/cr/T-18.md — g_tax_types has no effective_from / version; the VAT row reports created_at and version 1 until ruled (08 A4.1 forbids created_at).
const globalTypeDto = (r: R): R => omitEmpty({
  id: r.id, code: r.code, display: r.display, rate_bp: r.rate_bp == null ? undefined : Number(r.rate_bp), effective_from: ts(r.created_at) ?? new Date(0).toISOString(), scope: 'global', is_active: r.is_active === true, version: 1,
});

/** `{ scope?, active_at? }` list query; unknown keys -> 400. */
function ruleQuery(raw: unknown, scopes: readonly string[]): { scope?: string; at?: number } {
  const q = raw === undefined ? {} : raw;
  if (!isObj(q)) return fail([invalid('')]);
  const errors: FieldError[] = [];
  const f: { scope?: string; at?: number } = {};
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined) continue;
    if (k === 'scope') { if (typeof v === 'string' && scopes.includes(v)) f.scope = v; else errors.push(invalid('/scope')); }
    else if (k === 'active_at') { const a = isoArg(v); if (a) f.at = ms(a); else errors.push(invalid('/active_at')); }
    else errors.push(unknown(''));
  }
  if (errors.length) fail(errors);
  return f;
}
/** scope -> key columns: exactly the scope's key present (a uuid), every other key absent. */
function scopeKey(b: R, scope: unknown, scopes: readonly string[], errors: FieldError[]): { department_id?: string; orderable_id?: string } {
  if (scope === undefined) { errors.push(required('/scope')); return {}; }
  if (typeof scope !== 'string' || !scopes.includes(scope)) { errors.push(invalid('/scope')); return {}; }
  const out: { department_id?: string; orderable_id?: string } = {};
  for (const k of ['department_id', 'orderable_id'] as const) {
    const want = scope === k.slice(0, -3);
    if (b[k] === undefined) { if (want) errors.push(required(`/${k}`)); }
    else if (!want) errors.push(invalid(`/${k}`));
    else if (typeof b[k] === 'string' && UUID.test(b[k])) out[k] = b[k];
    else errors.push(invalid(`/${k}`));
  }
  return out;
}
/** effective_from required, effective_to optional and strictly after it. */
function windowOf(b: R, errors: FieldError[]): { from: string; to: string | undefined } {
  let from = '';
  if (b['effective_from'] === undefined) errors.push(required('/effective_from'));
  else { const f = isoArg(b['effective_from']); if (f) from = f; else errors.push(invalid('/effective_from')); }
  let to: string | undefined;
  if (b['effective_to'] !== undefined) {
    to = isoArg(b['effective_to']);
    if (!to) errors.push(invalid('/effective_to'));
    else if (from && ms(to) <= ms(from)) errors.push(invalid('/effective_to'));
  }
  return { from, to };
}
const sameWin = (from: string, to: string | undefined) => ({ effective_from: from, effective_to: to ?? null });

export interface PricingDeps extends Deps {
  /** IdentityPort subset, passed for symmetry with the other catalog services; no price-list field is role-restricted. */
  identity?: { getActor(ctx: unknown): Promise<{ permissions: readonly string[] }> };
}

export function createPricingService(deps: PricingDeps) {
  const revision = createRevisionService(deps);
  const nowOf = (ctx: Ctx) => ctx.now?.() ?? new Date().toISOString();
  const bump = (ctx: Ctx, id: string, changeKind: string, at: string) =>
    revision.bumpRevision(ctx, { entityType: 'price_list', entityId: id, changeKind, effectiveFrom: at });
  const q = (ctx: Ctx, text: string, values: unknown[]) => (ctx.tx as Tx).query(text, values);
  const tx = (ctx: Ctx) => ctx.tx as Tx;

  /** assignments + versions of the given lists, folded into PriceList DTOs (+ the raw version rows, newest first, for the detail view). */
  async function assemble(ctx: Ctx, rows: R[]): Promise<Array<{ dto: R; versions: R[] }>> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const asg = (await q(ctx, 'SELECT price_list_id, credit_party_id, doctor_id, centre_id FROM catalog.price_list_assignments WHERE tenant_id = $1 AND price_list_id = ANY($2)', [ctx.tenantId, ids])).rows;
    const vers = (await q(ctx, `SELECT ${VER_COLS.join(', ')} FROM catalog.price_list_versions WHERE tenant_id = $1 AND price_list_id = ANY($2) ORDER BY version_no DESC`, [ctx.tenantId, ids])).rows;
    const now = ms(nowOf(ctx));
    return rows.map((r) => {
      const versions = vers.filter((v) => v.price_list_id === r.id);
      const owners = asg.filter((a) => a.price_list_id === r.id).map((a) => (a.credit_party_id ?? a.doctor_id ?? a.centre_id) as string);
      return { dto: listDto(r, owners, versions, now), versions };
    });
  }

  /** Every owner id must exist in THIS tenant (S-3 / AB-3: unknown and foreign ids look the same: 404). The composite FK is only the backstop. */
  async function ownersExist(ctx: Ctx, kind: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const [table] = OWNER[kind]!;
    const { rows } = await q(ctx, `SELECT id FROM ${table} WHERE tenant_id = $1 AND id = ANY($2)`, [ctx.tenantId, ids]);
    if (rows.length !== ids.length) throw new LimsError('common.not_found');
  }
  const insertAssignment = (ctx: Ctx, listId: string, kind: string, ownerId: string) =>
    q(ctx, `INSERT INTO catalog.price_list_assignments (id, tenant_id, price_list_id, owner_kind, ${OWNER[kind]![1]}, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [uuidv7(), ctx.tenantId, listId, kind, ownerId, ctx.actor.id]).catch(mapPg);

  /** The version row locked, tenant-scoped (a foreign or unknown id is 404), and required to be a draft (anything else is frozen: 409 catalog.version_in_use). */
  async function lockDraft(ctx: Ctx, id: string): Promise<R> {
    const v = await repo.lockRow(tx(ctx), 'price_list_versions', VER_COLS, ctx.tenantId, id);
    if (!v) throw new LimsError('common.not_found');
    if (v.status !== 'draft') throw new LimsError('catalog.version_in_use');
    return v;
  }
  /** Orderable ids of this tenant among `ids` (RLS + explicit tenant filter). */
  async function knownOrderables(ctx: Ctx, ids: string[]): Promise<Set<string>> {
    const { rows } = await q(ctx, 'SELECT id FROM catalog.orderables WHERE tenant_id = $1 AND id = ANY($2)', [ctx.tenantId, ids]);
    return new Set(rows.map((r) => r.id as string));
  }
  /** Keeps item_count equal to the rows; no `version` bump (an item edit must not invalidate the publisher's If-Match). */
  async function recount(ctx: Ctx, ver: R): Promise<void> {
    const { rows } = await q(ctx, 'SELECT count(*) FROM catalog.price_list_items WHERE tenant_id = $1 AND price_list_version_id = $2', [ctx.tenantId, ver.id]);
    const n = Number(rows[0]?.count ?? 0);
    if (n !== Number(ver.item_count)) {
      await q(ctx, 'UPDATE catalog.price_list_versions SET item_count = $3, updated_at = now(), updated_by = $4 WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, ver.id, n, ctx.actor.id]);
    }
  }

  /** Row-locks the tenant's catalog_state row (created lazily); held to COMMIT. Taken before any read of the rule tables on a T-18 write path. */
  async function lockState(ctx: Ctx): Promise<void> {
    await stateRepo.ensureState(tx(ctx), ctx.tenantId, uuidv7(), ctx.actor.id);
    await q(ctx, 'SELECT catalog_revision FROM catalog.catalog_state WHERE tenant_id = $1 FOR UPDATE', [ctx.tenantId]);
  }
  /** Unknown and foreign ids look the same (AB-3): 404. */
  async function mustExist(ctx: Ctx, table: 'departments' | 'orderables' | 'price_lists', id: string | undefined): Promise<void> {
    if (id === undefined) return;
    const rows = await repo.selectRows(tx(ctx), table, ['id'], { tenant_id: ctx.tenantId, id }, 'id');
    if (rows.length === 0) throw new LimsError('common.not_found');
  }
  /** Shared /end (#85, #91): If-Match, effective_to (default = transaction clock) >= effective_from, open rules only; only effective_to + bookkeeping move. */
  async function endRule(ctx: Ctx, table: 'surcharge_rules' | 'tax_rules', cols: readonly string[], entityType: string,
    input: { id?: unknown; expectedVersion?: unknown; body?: unknown }, guard: (r: R) => void): Promise<R> {
    const { id, ev } = checkUpdate(input);
    const b = input.body === undefined || input.body === null ? {} : exact(input.body, ['effective_to']);
    const at = nowOf(ctx);
    let to = new Date(at).toISOString();
    if (b['effective_to'] !== undefined) { const t = isoArg(b['effective_to']); if (!t) fail([invalid('/effective_to')]); to = t as string; }
    await lockState(ctx);
    const row = await lockAt(ctx, table, cols, id, ev);
    guard(row);
    if (row.effective_to != null) fail([invalid('/effective_to')]);                       // already ended: the history is not rewritten
    if (ms(to) < ms(row.effective_from)) fail([invalid('/effective_to')]);
    const after = await repo.updateRow(tx(ctx), table, cols, { tenantId: ctx.tenantId, id, expectedVersion: ev, actorId: ctx.actor.id }, { effective_to: to }).catch(mapPg);
    if (!after) throw new LimsError('common.version_conflict');
    await revision.bumpRevision(ctx, { entityType, entityId: id, changeKind: 'deactivated', effectiveFrom: to });
    return after;
  }
  /** Rows of one scope of a rule table, filtered in memory (single-table SQL, a few hundred rows per tenant). */
  const scopeRows = async (ctx: Ctx, table: 'surcharge_rules' | 'tax_rules', cols: readonly string[], scope: string) =>
    (await q(ctx, `SELECT ${cols.join(', ')} FROM catalog.${table} WHERE tenant_id = $1 AND scope = $2 ORDER BY effective_from ASC, id ASC`, [ctx.tenantId, scope])).rows;
  async function listRules(ctx: Ctx, table: 'surcharge_rules' | 'tax_rules', cols: readonly string[], scopes: readonly string[], query: unknown, dto: (r: R) => R) {
    const f = ruleQuery(query, scopes);
    const values: unknown[] = [ctx.tenantId];
    let where = 'tenant_id = $1';
    if (f.scope !== undefined) { values.push(f.scope); where += ' AND scope = $2'; }
    const { rows } = await q(ctx, `SELECT ${cols.join(', ')} FROM catalog.${table} WHERE ${where} ORDER BY effective_from ASC, id ASC`, values);
    return { data: rows.filter((r) => f.at === undefined || inForce(r, f.at)).map(dto) };
  }

  return {
    async listPriceLists(ctx: Ctx, query?: unknown) {
      const raw = query === undefined ? {} : query;
      if (!isObj(raw)) fail([invalid('')]);
      const errors: FieldError[] = [];
      const f: { is_active: string; owner_kind?: string; owner_id?: string; cursor?: string; limit: number } = { is_active: 'true', limit: 50 };
      for (const [k, v] of Object.entries(raw as R)) {
        if (v === undefined) continue;
        if (k === 'is_active') { if (v === 'true' || v === 'false' || v === 'all') f.is_active = v; else errors.push(invalid('/is_active')); }
        else if (k === 'owner_kind') { if (typeof v === 'string' && KINDS.includes(v)) f.owner_kind = v; else errors.push(invalid('/owner_kind')); }
        else if (k === 'owner_id') { if (typeof v === 'string' && UUID.test(v)) f.owner_id = v; else errors.push(invalid('/owner_id')); }
        else if (k === 'cursor') { if (typeof v === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(v)) f.cursor = v; else errors.push(invalid('/cursor')); }
        else if (k === 'limit') { const n = typeof v === 'string' && /^[0-9]{1,3}$/.test(v) ? Number(v) : v; if (Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 200) f.limit = n as number; else errors.push(invalid('/limit')); }
        else errors.push(unknown(''));
      }
      if (errors.length) fail(errors);
      const values: unknown[] = [ctx.tenantId];
      const bind = (v: unknown) => { values.push(v); return `$${values.length}`; };
      const where = ['tenant_id = $1'];
      if (f.is_active !== 'all') where.push(`is_active = ${bind(f.is_active === 'true')}`);
      if (f.owner_kind !== undefined) where.push(`owner_kind = ${bind(f.owner_kind)}`);
      if (f.owner_id !== undefined) {
        const hit = await q(ctx, 'SELECT price_list_id FROM catalog.price_list_assignments WHERE tenant_id = $1 AND (credit_party_id = $2 OR doctor_id = $2 OR centre_id = $2)', [ctx.tenantId, f.owner_id]);
        if (hit.rows.length === 0) return { data: [], page: { limit: f.limit } };
        where.push(`id = ANY(${bind(hit.rows.map((r) => r.price_list_id))})`);
      }
      if (f.cursor !== undefined) { const [v, id] = decodeCursor(f.cursor, 'code'); where.push(`(code, id) > (${bind(v)}, ${bind(id)})`); }
      const { rows } = await q(ctx, `SELECT ${LIST_COLS.join(', ')} FROM catalog.price_lists WHERE ${where.join(' AND ')} ORDER BY code ASC, id ASC LIMIT ${bind(f.limit + 1)}`, values);
      const data = rows.slice(0, f.limit);
      const last = data[data.length - 1];
      const page: { limit: number; next_cursor?: string } = { limit: f.limit };
      if (rows.length > f.limit && last) page.next_cursor = encodeCursor('code', last.code, last.id);
      return { data: (await assemble(ctx, data)).map((x) => x.dto), page };
    },

    async createPriceList(ctx: Ctx, body?: unknown) {
      const b = exact(body, ['code', 'name', 'owner_kind', 'falls_through', 'assignments']);
      const errors: FieldError[] = [];
      let code = '';
      if (b['code'] === undefined) errors.push(required('/code'));
      else if (typeof b['code'] === 'string' && CODE_IN.test(b['code'].trim())) code = b['code'].trim().toUpperCase();
      else errors.push(invalid('/code'));
      const name = typeof b['name'] === 'string' ? b['name'].trim() : '';
      if (b['name'] === undefined) errors.push(required('/name'));
      else if (name.length < 1 || name.length > 120) errors.push(invalid('/name'));
      const kind = b['owner_kind'];
      if (kind === undefined) errors.push(required('/owner_kind'));
      else if (typeof kind !== 'string' || !KINDS.includes(kind)) errors.push(invalid('/owner_kind'));
      if (b['falls_through'] !== undefined && typeof b['falls_through'] !== 'boolean') errors.push(invalid('/falls_through'));
      let owners: string[] = [];
      if (b['assignments'] === undefined) errors.push(required('/assignments'));
      else {
        const a = b['assignments'];
        if (!Array.isArray(a) || a.length > MAX_OWNERS || a.some((x) => !isObj(x) || Object.keys(x).length !== 1 || typeof x['owner_id'] !== 'string' || !UUID.test(x['owner_id']))) errors.push(invalid('/assignments'));
        else {
          owners = a.map((x) => x['owner_id'] as string);
          if (new Set(owners).size !== owners.length || (kind === 'default' && owners.length > 0)) errors.push(invalid('/assignments'));
        }
      }
      if (errors.length) fail(errors);
      const at = nowOf(ctx);
      await ownersExist(ctx, kind as string, owners);
      const list = await repo.insertRow(tx(ctx), 'price_lists', LIST_COLS, {
        id: uuidv7(), tenant_id: ctx.tenantId, code, name, owner_kind: kind, falls_through: b['falls_through'] ?? true, is_active: true, created_by: ctx.actor.id, updated_by: ctx.actor.id,
      }).catch(mapPg);
      await repo.insertRow(tx(ctx), 'price_list_versions', VER_COLS, {
        id: uuidv7(), tenant_id: ctx.tenantId, price_list_id: list.id, version_no: 1, status: 'draft', item_count: 0, created_by: ctx.actor.id, updated_by: ctx.actor.id,
      }).catch(mapVersionPg);
      for (const o of owners) await insertAssignment(ctx, list.id, kind as string, o);
      await bump(ctx, list.id, 'created', at);
      return (await assemble(ctx, [list]))[0]!.dto;
    },

    async getPriceListDetail(ctx: Ctx, input: { id?: unknown } = {}) {
      const id = uuidArg(input.id, '/id');
      const [row] = await repo.selectRows(tx(ctx), 'price_lists', LIST_COLS, { tenant_id: ctx.tenantId, id }, 'id');
      if (!row) throw new LimsError('common.not_found');
      const [{ dto, versions }] = (await assemble(ctx, [row])) as [{ dto: R; versions: R[] }];
      return { ...dto, versions: versions.slice(0, 50).map(versionDto) };
    },

    async updatePriceList(ctx: Ctx, input: { id?: unknown; expectedVersion?: unknown; patch?: unknown } = {}) {
      const { id, ev } = checkUpdate(input);
      const b = exact(input.patch, ['name', 'falls_through', 'is_active']);
      const patch: R = {};
      if (b['name'] !== undefined) { const n = typeof b['name'] === 'string' ? b['name'].trim() : ''; if (n.length < 1 || n.length > 120) fail([invalid('/name')]); patch['name'] = n; }
      for (const k of ['falls_through', 'is_active']) if (b[k] !== undefined) { if (typeof b[k] !== 'boolean') fail([invalid(`/${k}`)]); patch[k] = b[k]; }
      if (Object.keys(patch).length === 0) fail([invalid('')]);            // an empty PATCH would bump version / revision for no change
      const at = nowOf(ctx);
      const before = await lockAt(ctx, 'price_lists', LIST_COLS, id, ev);
      if (before.owner_kind === 'default' && patch['is_active'] === false) fail([invalid('/is_active')]);   // E22: the tenant always keeps a default list
      const after = await repo.updateRow(tx(ctx), 'price_lists', LIST_COLS, { tenantId: ctx.tenantId, id, expectedVersion: ev, actorId: ctx.actor.id }, patch).catch(mapPg);
      if (!after) throw new LimsError('common.version_conflict');
      await bump(ctx, id, kindOf(before, after), at);
      return (await assemble(ctx, [after]))[0]!.dto;
    },

    /** Replaces the owner set: removed owners are deleted first, then added ones inserted, so a move inside one list never clashes. An owner of ANOTHER list -> 23505 -> 409. */
    async replacePriceListAssignments(ctx: Ctx, input: { id?: unknown; expectedVersion?: unknown; body?: unknown } = {}) {
      const { id, ev } = checkUpdate(input);
      const b = exact(input.body, ['owner_ids']);
      if (b['owner_ids'] === undefined) fail([required('/owner_ids')]);
      const owners = uuidList(b['owner_ids'], '/owner_ids', MAX_OWNERS);
      const at = nowOf(ctx);
      const list = await lockAt(ctx, 'price_lists', LIST_COLS, id, ev);
      if (list.owner_kind === 'default' && owners.length > 0) fail([invalid('/owner_ids')]);
      if (list.owner_kind !== 'default') await ownersExist(ctx, list.owner_kind, owners);
      const col = OWNER[list.owner_kind]?.[1];
      const cur = (await q(ctx, 'SELECT id, credit_party_id, doctor_id, centre_id FROM catalog.price_list_assignments WHERE tenant_id = $1 AND price_list_id = $2', [ctx.tenantId, id])).rows;
      const ownerOf = (a: R) => (col ? a[col] : undefined) as string;
      const drop = cur.filter((a) => !owners.includes(ownerOf(a)));
      const add = owners.filter((o) => !cur.some((a) => ownerOf(a) === o));
      if (drop.length) await q(ctx, 'DELETE FROM catalog.price_list_assignments WHERE tenant_id = $1 AND id = ANY($2)', [ctx.tenantId, drop.map((a) => a.id)]);
      for (const o of add) await insertAssignment(ctx, id, list.owner_kind, o);
      const after = await repo.updateRow(tx(ctx), 'price_lists', LIST_COLS, { tenantId: ctx.tenantId, id, expectedVersion: ev, actorId: ctx.actor.id }, {}).catch(mapPg);
      if (!after) throw new LimsError('common.version_conflict');
      await bump(ctx, id, 'updated', at);
      return (await assemble(ctx, [after]))[0]!.dto;
    },

    /** V1: one draft per list (409 common.version_conflict); version_no = max + 1; content copied from `copy_from_version_no` (default: the latest published). */
    async createPriceListVersionDraft(ctx: Ctx, input: { id?: unknown; body?: unknown; sourceImportId?: string } = {}) {   // sourceImportId: internal (import commit), never from HTTP
      const id = uuidArg(input.id, '/id');
      const b = input.body === undefined ? {} : exact(input.body, ['copy_from_version_no']);
      const copy = b['copy_from_version_no'];
      if (copy !== undefined && (!Number.isInteger(copy) || (copy as number) < 1 || (copy as number) > 2147483647)) fail([invalid('/copy_from_version_no')]);
      const list = await repo.lockRow(tx(ctx), 'price_lists', LIST_COLS, ctx.tenantId, id);      // serialises concurrent draft creates of one list
      if (!list) throw new LimsError('common.not_found');
      const vers = (await q(ctx, `SELECT ${VER_COLS.join(', ')} FROM catalog.price_list_versions WHERE tenant_id = $1 AND price_list_id = $2 ORDER BY version_no DESC`, [ctx.tenantId, id])).rows;
      if (vers.some((v) => v.status === 'draft')) throw new LimsError('common.version_conflict');
      const src = copy !== undefined ? vers.find((v) => Number(v.version_no) === copy) : vers.find((v) => v.status === 'published');
      if (copy !== undefined && !src) throw new LimsError('common.not_found');
      const items = src ? (await q(ctx, 'SELECT orderable_id, unit_price_paisa FROM catalog.price_list_items WHERE tenant_id = $1 AND price_list_version_id = $2', [ctx.tenantId, src.id])).rows : [];
      const created = await repo.insertRow(tx(ctx), 'price_list_versions', VER_COLS, {
        id: uuidv7(), tenant_id: ctx.tenantId, price_list_id: id, version_no: Number(vers[0]?.version_no ?? 0) + 1, status: 'draft', item_count: items.length, ...(input.sourceImportId ? { source_import_id: input.sourceImportId } : {}),
        created_by: ctx.actor.id, updated_by: ctx.actor.id,
      }).catch(mapVersionPg);
      // ponytail: one INSERT per copied item (single-table SQL); fine for typical lists, switch to INSERT ... SELECT near the 100,000-item ceiling.
      for (const it of items) {
        await repo.insertRow(tx(ctx), 'price_list_items', ['id'], {
          id: uuidv7(), tenant_id: ctx.tenantId, price_list_version_id: created.id, orderable_id: it.orderable_id, unit_price_paisa: Number(it.unit_price_paisa),
          created_by: ctx.actor.id, updated_by: ctx.actor.id,
        }).catch(mapItemPg);
      }
      return versionDto(created);
    },

    async listPriceListItems(ctx: Ctx, input: { versionId?: unknown; query?: unknown } = {}) {
      const vid = uuidArg(input.versionId, '/id');
      const raw = input.query === undefined ? {} : input.query;
      if (!isObj(raw)) fail([invalid('')]);
      const errors: FieldError[] = [];
      const f: { kind?: string; dept?: string; sort: string; cursor?: string; limit: number } = { sort: 'orderable_code', limit: 50 };
      for (const [k, v] of Object.entries(raw as R)) {
        if (v === undefined) continue;
        if (k === 'orderable_kind') { if (v === 'test' || v === 'panel') f.kind = v; else errors.push(invalid('/orderable_kind')); }
        else if (k === 'department_id') { if (typeof v === 'string' && UUID.test(v)) f.dept = v; else errors.push(invalid('/department_id')); }
        else if (k === 'sort') { if (v === 'orderable_code' || v === '-orderable_code') f.sort = v; else errors.push(invalid('/sort')); }
        else if (k === 'cursor') { if (typeof v === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(v)) f.cursor = v; else errors.push(invalid('/cursor')); }
        else if (k === 'limit') { const n = typeof v === 'string' && /^[0-9]{1,3}$/.test(v) ? Number(v) : v; if (Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 200) f.limit = n as number; else errors.push(invalid('/limit')); }
        else errors.push(unknown(''));
      }
      if (errors.length) fail(errors);
      const [ver] = await repo.selectRows(tx(ctx), 'price_list_versions', ['id'], { tenant_id: ctx.tenantId, id: vid }, 'id');
      if (!ver) throw new LimsError('common.not_found');
      const after = f.cursor === undefined ? undefined : decodeCursor(f.cursor, f.sort);
      const items = (await q(ctx, 'SELECT orderable_id, unit_price_paisa FROM catalog.price_list_items WHERE tenant_id = $1 AND price_list_version_id = $2', [ctx.tenantId, vid])).rows;
      const ovals: unknown[] = [ctx.tenantId];
      const ow = ['tenant_id = $1'];
      if (f.kind !== undefined) { ovals.push(f.kind); ow.push(`kind = $${ovals.length}`); }
      if (f.dept !== undefined) { ovals.push(f.dept); ow.push(`department_id = $${ovals.length}`); }
      // ponytail: join + sort + page in memory (an orderable list is a few thousand rows per tenant); push into SQL if that ever shows in profiles.
      const ords = new Map((await q(ctx, `SELECT id, kind, code FROM catalog.orderables WHERE ${ow.join(' AND ')}`, ovals)).rows.map((o) => [o.id as string, o]));
      const sign = f.sort.startsWith('-') ? -1 : 1;
      const cmp = (a: R, b: R) => sign * ((a.code < b.code ? -1 : a.code > b.code ? 1 : 0) || (a.orderable_id < b.orderable_id ? -1 : a.orderable_id > b.orderable_id ? 1 : 0));
      let rows: R[] = items.filter((i) => ords.has(i.orderable_id)).map((i) => ({ ...i, code: ords.get(i.orderable_id)!.code, kind: ords.get(i.orderable_id)!.kind })).sort(cmp);
      if (after) rows = rows.filter((r) => cmp(r, { code: after[0], orderable_id: after[1] }) > 0);
      const data = rows.slice(0, f.limit);
      const last = data[data.length - 1];
      const page: { limit: number; next_cursor?: string } = { limit: f.limit };
      if (rows.length > f.limit && last) page.next_cursor = encodeCursor(f.sort, last.code, last.orderable_id);
      return {
        data: data.map((r) => ({ orderable_id: r.orderable_id, orderable_code: r.code, orderable_kind: r.kind, unit_price: { amount_paisa: Number(r.unit_price_paisa), currency: 'NPR' } })),
        page,
      };
    },

    /** Draft only (AC-13.4). Created / updated / unchanged per row; unknown or foreign orderable ids are per-row `common.not_found` (AB-2), the rest is applied. */
    async upsertPriceListItems(ctx: Ctx, input: { versionId?: unknown; body?: unknown } = {}) {
      const vid = uuidArg(input.versionId, '/id');
      const b = exact(input.body, ['items']);
      const raw = b['items'];
      if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_BATCH) fail([invalid('/items')]);
      const errors: FieldError[] = [];
      const seen = new Set<string>();
      const rows: Array<{ orderable_id: string; price: number }> = [];
      (raw as unknown[]).forEach((it, i) => {
        const p = paisa(isObj(it) ? it['unit_price'] : undefined);
        if (!isObj(it) || Object.keys(it).some((k) => k !== 'orderable_id' && k !== 'unit_price')) errors.push(invalid(`/items/${i}`));
        else if (typeof it['orderable_id'] !== 'string' || !UUID.test(it['orderable_id']) || seen.has(it['orderable_id'])) errors.push(invalid(`/items/${i}/orderable_id`));
        else if (p === undefined) errors.push(invalid(`/items/${i}/unit_price`));
        else { seen.add(it['orderable_id']); rows.push({ orderable_id: it['orderable_id'], price: p }); }
      });
      if (errors.length) fail(errors);
      const ver = await lockDraft(ctx, vid);
      const known = await knownOrderables(ctx, rows.map((r) => r.orderable_id));
      const have = new Map((await q(ctx, 'SELECT id, orderable_id, unit_price_paisa, version FROM catalog.price_list_items WHERE tenant_id = $1 AND price_list_version_id = $2 AND orderable_id = ANY($3)',
        [ctx.tenantId, vid, rows.map((r) => r.orderable_id)])).rows.map((r) => [r.orderable_id as string, r]));
      const results: R[] = [];
      for (const r of rows) {
        if (!known.has(r.orderable_id)) { results.push({ orderable_id: r.orderable_id, outcome: 'error', error_code: 'common.not_found' }); continue; }
        const ex = have.get(r.orderable_id);
        if (!ex) {
          await repo.insertRow(tx(ctx), 'price_list_items', ['id'], {
            id: uuidv7(), tenant_id: ctx.tenantId, price_list_version_id: vid, orderable_id: r.orderable_id, unit_price_paisa: r.price, created_by: ctx.actor.id, updated_by: ctx.actor.id,
          }).catch(mapItemPg);
          results.push({ orderable_id: r.orderable_id, outcome: 'created' });
        } else if (Number(ex.unit_price_paisa) === r.price) results.push({ orderable_id: r.orderable_id, outcome: 'unchanged' });
        else {
          const up = await repo.updateRow(tx(ctx), 'price_list_items', ['id'], { tenantId: ctx.tenantId, id: ex.id, expectedVersion: Number(ex.version), actorId: ctx.actor.id }, { unit_price_paisa: r.price }).catch(mapItemPg);
          if (!up) throw new LimsError('common.version_conflict');
          results.push({ orderable_id: r.orderable_id, outcome: 'updated' });
        }
      }
      await recount(ctx, ver);
      return { results };
    },

    /** ids are ORDERABLE ids (02-TRD #79). Draft only; a published / superseded / discarded version -> 409 catalog.version_in_use. */
    async removePriceListItems(ctx: Ctx, input: { versionId?: unknown; body?: unknown } = {}) {
      const vid = uuidArg(input.versionId, '/id');
      const b = exact(input.body, ['ids']);
      const ids = uuidList(b['ids'], '/ids', MAX_BATCH, 1);
      const ver = await lockDraft(ctx, vid);
      const known = await knownOrderables(ctx, ids);
      const gone = new Set((await q(ctx, 'DELETE FROM catalog.price_list_items WHERE tenant_id = $1 AND price_list_version_id = $2 AND orderable_id = ANY($3) RETURNING orderable_id',
        [ctx.tenantId, vid, ids]).catch(mapItemPg)).rows.map((r) => r.orderable_id as string));
      await recount(ctx, ver);
      return {
        results: ids.map((id) => (!known.has(id) ? { orderable_id: id, outcome: 'error', error_code: 'common.not_found' } : { orderable_id: id, outcome: gone.has(id) ? 'updated' : 'unchanged' })),
      };
    },

    /** V4/V5: draft -> published; the open-ended published predecessor becomes superseded with effective_to = this effective_from, in the same transaction. */
    async publishPriceListVersion(ctx: Ctx, input: { versionId?: unknown; expectedVersion?: unknown; body?: unknown } = {}) {
      const { id, ev } = checkUpdate({ id: input.versionId, expectedVersion: input.expectedVersion });
      const b = exact(input.body, ['effective_from', 'change_reason']);
      const at = nowOf(ctx);
      const errors: FieldError[] = [];
      const reason = typeof b['change_reason'] === 'string' ? b['change_reason'].trim() : '';
      if (b['change_reason'] === undefined) errors.push(required('/change_reason'));
      else if (reason.length < 1 || reason.length > 500) errors.push(invalid('/change_reason'));
      let from = at;
      if (b['effective_from'] !== undefined) {
        const e = b['effective_from'];
        if (typeof e !== 'string' || !ISO.test(e) || Number.isNaN(Date.parse(e))) errors.push(invalid('/effective_from'));
        else from = new Date(e).toISOString();
      }
      if (errors.length === 0 && ms(from) < ms(at) - SKEW_MS) errors.push(invalid('/effective_from'));
      if (errors.length) fail(errors);
      const [pre] = await repo.selectRows(tx(ctx), 'price_list_versions', ['id', 'price_list_id'], { tenant_id: ctx.tenantId, id }, 'id');
      if (!pre) throw new LimsError('common.not_found');
      const list = await repo.lockRow(tx(ctx), 'price_lists', LIST_COLS, ctx.tenantId, pre.price_list_id);   // lock order: list, then version
      if (!list) throw new LimsError('common.not_found');
      const ver = await lockAt(ctx, 'price_list_versions', VER_COLS, id, ev);
      if (ver.status !== 'draft') throw new LimsError('catalog.version_in_use');
      const sibs = (await q(ctx, `SELECT ${VER_COLS.join(', ')} FROM catalog.price_list_versions WHERE tenant_id = $1 AND price_list_id = $2 ORDER BY version_no DESC`, [ctx.tenantId, list.id])).rows;
      const live = sibs.filter((v) => v.status === 'published' || v.status === 'superseded');
      if (live.some((v) => ms(from) <= ms(v.effective_from))) fail([invalid('/effective_from')]);        // V4: strictly later than every earlier window start
      for (const p of live.filter((v) => v.status === 'published' && v.effective_to == null)) {
        const s = await repo.updateRow(tx(ctx), 'price_list_versions', ['id'], { tenantId: ctx.tenantId, id: p.id, expectedVersion: Number(p.version), actorId: ctx.actor.id },
          { status: 'superseded', effective_to: from }).catch(mapVersionPg);
        if (!s) throw new LimsError('common.version_conflict');
      }
      const count = Number((await q(ctx, 'SELECT count(*) FROM catalog.price_list_items WHERE tenant_id = $1 AND price_list_version_id = $2', [ctx.tenantId, id])).rows[0]?.count ?? 0);
      const after = await repo.updateRow(tx(ctx), 'price_list_versions', VER_COLS, { tenantId: ctx.tenantId, id, expectedVersion: ev, actorId: ctx.actor.id },
        { status: 'published', effective_from: from, change_reason: reason, published_at: at, published_by: ctx.actor.id, item_count: count }).catch(mapVersionPg);
      if (!after) throw new LimsError('common.version_conflict');
      await bump(ctx, list.id, 'versioned', from);
      return versionDto(after);
    },

    /** V3: draft -> discarded (status only; the items stay as history). No event, no revision bump. */
    async discardPriceListVersionDraft(ctx: Ctx, input: { versionId?: unknown; expectedVersion?: unknown } = {}) {
      const { id, ev } = checkUpdate({ id: input.versionId, expectedVersion: input.expectedVersion });
      const ver = await lockAt(ctx, 'price_list_versions', VER_COLS, id, ev);
      if (ver.status !== 'draft') throw new LimsError('catalog.version_in_use');
      const after = await repo.updateRow(tx(ctx), 'price_list_versions', VER_COLS, { tenantId: ctx.tenantId, id, expectedVersion: ev, actorId: ctx.actor.id }, { status: 'discarded' }).catch(mapVersionPg);
      if (!after) throw new LimsError('common.version_conflict');
      return versionDto(after);
    },

    // ---------------------------------------------------------------------------------------------------- T-18 surcharge rules #83–#85
    async listSurchargeRules(ctx: Ctx, query?: unknown) {
      return listRules(ctx, 'surcharge_rules', S_COLS, S_SCOPES, query, surchargeDto);
    },

    /** AC-14.5: an active rule of the same (scope, key, price list) whose window overlaps -> 400 /effective_from, checked after the catalog_state lock. */
    async createSurchargeRule(ctx: Ctx, body?: unknown) {
      const b = exact(body, ['scope', 'department_id', 'orderable_id', 'price_list_id', 'amount_kind', 'amount', 'percent_bp', 'effective_from', 'effective_to']);
      const errors: FieldError[] = [];
      const key = scopeKey(b, b['scope'], S_SCOPES, errors);
      let list: string | undefined;
      if (b['price_list_id'] !== undefined) { if (typeof b['price_list_id'] === 'string' && UUID.test(b['price_list_id'])) list = b['price_list_id']; else errors.push(invalid('/price_list_id')); }
      const kind = b['amount_kind'];
      let amount: number | undefined; let bp: number | undefined;
      if (kind === undefined) errors.push(required('/amount_kind'));
      else if (kind !== 'flat' && kind !== 'percent') errors.push(invalid('/amount_kind'));
      else if (kind === 'flat') {
        if (b['percent_bp'] !== undefined) errors.push(invalid('/percent_bp'));
        if (b['amount'] === undefined) errors.push(required('/amount'));
        else { amount = paisa(b['amount']); if (amount === undefined || amount < 1) errors.push(invalid('/amount')); }
      } else {
        if (b['amount'] !== undefined) errors.push(invalid('/amount'));
        const p = b['percent_bp'];
        if (p === undefined) errors.push(required('/percent_bp'));
        else if (Number.isInteger(p) && (p as number) >= 1 && (p as number) <= 100_000) bp = p as number;
        else errors.push(invalid('/percent_bp'));
      }
      const { from, to } = windowOf(b, errors);
      if (errors.length) fail(errors);
      const scope = b['scope'] as string;
      await mustExist(ctx, 'departments', key.department_id);
      await mustExist(ctx, 'orderables', key.orderable_id);
      await mustExist(ctx, 'price_lists', list);
      await lockState(ctx);
      const mine = sameWin(from, to);
      const clash = (await scopeRows(ctx, 'surcharge_rules', S_COLS, scope)).some((r) => r.is_active !== false
        && (r.department_id ?? undefined) === key.department_id && (r.orderable_id ?? undefined) === key.orderable_id && (r.price_list_id ?? undefined) === list && windowsOverlap(r, mine));
      if (clash) fail([invalid('/effective_from')]);
      const row = await repo.insertRow(tx(ctx), 'surcharge_rules', S_COLS, omitEmpty({
        id: uuidv7(), tenant_id: ctx.tenantId, scope, ...key, price_list_id: list, amount_kind: kind, amount_paisa: amount, percent_bp: bp,
        effective_from: from, effective_to: to, is_active: true, created_by: ctx.actor.id, updated_by: ctx.actor.id,
      })).catch(mapPg);
      await revision.bumpRevision(ctx, { entityType: 'surcharge_rule', entityId: row.id, changeKind: 'created', effectiveFrom: from });
      return surchargeDto(row);
    },

    async endSurchargeRule(ctx: Ctx, input: { id?: unknown; expectedVersion?: unknown; body?: unknown } = {}) {
      return surchargeDto(await endRule(ctx, 'surcharge_rules', S_COLS, 'surcharge_rule', input, () => undefined));
    },

    // ---------------------------------------------------------------------------------------------------- T-18 tax types #86–#88
    /** The global VAT row + the tenant versions in force at `active_at` (default now); `all_versions` = the whole rate history. */
    async listTaxTypes(ctx: Ctx, query?: unknown) {
      const raw = query === undefined ? {} : query;
      if (!isObj(raw)) fail([invalid('')]);
      const errors: FieldError[] = [];
      let at = ms(nowOf(ctx)); let all = false;
      for (const [k, v] of Object.entries(raw as R)) {
        if (v === undefined) continue;
        if (k === 'active_at') { const a = isoArg(v); if (a) at = ms(a); else errors.push(invalid('/active_at')); }
        else if (k === 'all_versions') { if (v === true || v === 'true') all = true; else if (v === false || v === 'false') all = false; else errors.push(invalid('/all_versions')); }
        else errors.push(unknown(''));
      }
      if (errors.length) fail(errors);
      const globals = (await repo.selectRows(tx(ctx), 'g_tax_types', ['id', 'code', 'display', 'rate_bp', 'is_active', 'created_at'], {}, 'code')).filter((r) => r.is_active === true);
      const mine = (await q(ctx, `SELECT ${Y_COLS.join(', ')} FROM catalog.cs_tax_types WHERE tenant_id = $1 ORDER BY code ASC, effective_from ASC`, [ctx.tenantId])).rows;
      const shown = all ? mine : mine.filter((r) => ms(r.effective_from) <= at && (r.effective_to == null || at < ms(r.effective_to)));
      return { data: [...globals.map(globalTypeDto), ...shown.map(taxTypeDto)] };
    },

    async createTaxType(ctx: Ctx, body?: unknown) {
      const b = exact(body, ['code', 'display', 'rate_bp', 'effective_from']);
      const errors: FieldError[] = [];
      let code = '';
      if (b['code'] === undefined) errors.push(required('/code'));
      else if (typeof b['code'] === 'string' && TAX_CODE_IN.test(b['code'].trim())) code = b['code'].trim().toUpperCase();
      else errors.push(invalid('/code'));
      if (code === 'VAT') errors.push(invalid('/code'));                                   // VAT is the global system type (read-only)
      const display = typeof b['display'] === 'string' ? b['display'].trim() : '';
      if (b['display'] === undefined) errors.push(required('/display'));
      else if (display.length < 1 || display.length > 60) errors.push(invalid('/display'));
      const rate = b['rate_bp'];
      if (rate !== undefined && !(Number.isInteger(rate) && (rate as number) >= 0 && (rate as number) <= 10_000)) errors.push(invalid('/rate_bp'));
      let from = new Date(nowOf(ctx)).toISOString();
      if (b['effective_from'] !== undefined) { const f = isoArg(b['effective_from']); if (f) from = f; else errors.push(invalid('/effective_from')); }
      if (errors.length) fail(errors);
      await lockState(ctx);
      const have = await repo.selectRows(tx(ctx), 'cs_tax_types', ['id'], { tenant_id: ctx.tenantId, code }, 'id');
      if (have.length) throw new LimsError('catalog.code_duplicate');
      const row = await repo.insertRow(tx(ctx), 'cs_tax_types', Y_COLS, omitEmpty({
        id: uuidv7(), tenant_id: ctx.tenantId, code, display, rate_bp: rate, effective_from: from, is_active: true, created_by: ctx.actor.id, updated_by: ctx.actor.id,
      })).catch(mapPg);
      await revision.bumpRevision(ctx, { entityType: 'tax_rule', entityId: row.id, changeKind: 'created', effectiveFrom: from });
      return taxTypeDto(row);
    },

    /** display / is_active edit the row in place; a rate change (needs effective_from >= now, after the version's start) ends this open version and inserts a new one (08 R18). */
    async updateTaxType(ctx: Ctx, input: { id?: unknown; expectedVersion?: unknown; patch?: unknown } = {}) {
      const { id, ev } = checkUpdate(input);
      const b = exact(input.patch, ['display', 'rate_bp', 'effective_from', 'is_active']);
      const errors: FieldError[] = [];
      const patch: R = {};
      if (b['display'] !== undefined) { const d = typeof b['display'] === 'string' ? b['display'].trim() : ''; if (d.length < 1 || d.length > 60) errors.push(invalid('/display')); else patch['display'] = d; }
      if (b['is_active'] !== undefined) { if (typeof b['is_active'] === 'boolean') patch['is_active'] = b['is_active']; else errors.push(invalid('/is_active')); }
      const rate = b['rate_bp'];
      const rateChange = rate !== undefined;
      if (rateChange && !(Number.isInteger(rate) && (rate as number) >= 0 && (rate as number) <= 10_000)) errors.push(invalid('/rate_bp'));
      const at = nowOf(ctx);
      let from: string | undefined;
      if (b['effective_from'] !== undefined) { from = isoArg(b['effective_from']); if (!from) errors.push(invalid('/effective_from')); }
      if (rateChange && b['effective_from'] === undefined) errors.push(required('/effective_from'));
      if (!rateChange && b['effective_from'] !== undefined) errors.push(invalid('/effective_from'));   // a window is only ever opened by a new rate version
      if (from && rateChange && ms(from) < ms(at) - SKEW_MS) errors.push(invalid('/effective_from'));
      if (Object.keys(b).length === 0) errors.push(invalid(''));
      if (errors.length) fail(errors);
      await lockState(ctx);
      const row = await lockAt(ctx, 'cs_tax_types', Y_COLS, id, ev);
      if (!rateChange) {
        const after = await repo.updateRow(tx(ctx), 'cs_tax_types', Y_COLS, { tenantId: ctx.tenantId, id, expectedVersion: ev, actorId: ctx.actor.id }, patch).catch(mapPg);
        if (!after) throw new LimsError('common.version_conflict');
        await revision.bumpRevision(ctx, { entityType: 'tax_rule', entityId: id, changeKind: kindOf(row, after), effectiveFrom: new Date(at).toISOString() });
        return taxTypeDto(after);
      }
      if (row.effective_to != null || ms(from as string) <= ms(row.effective_from)) fail([invalid('/effective_from')]);   // only the open version gets a successor, strictly later
      const ended = await repo.updateRow(tx(ctx), 'cs_tax_types', ['id'], { tenantId: ctx.tenantId, id, expectedVersion: ev, actorId: ctx.actor.id }, { effective_to: from }).catch(mapPg);
      if (!ended) throw new LimsError('common.version_conflict');
      const next = await repo.insertRow(tx(ctx), 'cs_tax_types', Y_COLS, {
        id: uuidv7(), tenant_id: ctx.tenantId, code: row.code, display: patch['display'] ?? row.display, rate_bp: rate, effective_from: from, sort_order: Number(row.sort_order ?? 100),
        is_active: patch['is_active'] ?? row.is_active, created_by: ctx.actor.id, updated_by: ctx.actor.id,
      }).catch(mapPg);
      await revision.bumpRevision(ctx, { entityType: 'tax_rule', entityId: next.id, changeKind: 'updated', effectiveFrom: from as string });
      return taxTypeDto(next);
    },

    // ---------------------------------------------------------------------------------------------------- T-18 tax rules #89–#91
    async listTaxRules(ctx: Ctx, query?: unknown) {
      return listRules(ctx, 'tax_rules', R_COLS, R_SCOPES, query, taxRuleDto);
    },

    /** AC-15.5: a tenant-default successor ends the open default at its effective_from; any other overlap of the same key -> 400 /effective_from (after the catalog_state lock). */
    async createTaxRule(ctx: Ctx, body?: unknown) {
      const b = exact(body, ['scope', 'department_id', 'orderable_id', 'vat_treatment', 'other_tax_code', 'hs_code', 'effective_from', 'effective_to']);
      const errors: FieldError[] = [];
      const key = scopeKey(b, b['scope'], R_SCOPES, errors);
      const vat = b['vat_treatment'];
      if (vat === undefined) errors.push(required('/vat_treatment'));
      else if (vat !== 'exempt' && vat !== 'taxable') errors.push(invalid('/vat_treatment'));
      const other = b['other_tax_code'];
      if (other !== undefined && (typeof other !== 'string' || !TAX_CODE.test(other) || other === 'VAT')) errors.push(invalid('/other_tax_code'));
      const hs = b['hs_code'];
      if (hs !== undefined && (typeof hs !== 'string' || !HS.test(hs))) errors.push(invalid('/hs_code'));
      const { from, to } = windowOf(b, errors);
      if (errors.length) fail(errors);
      const scope = b['scope'] as string;
      const mine = sameWin(from, to);
      await mustExist(ctx, 'departments', key.department_id);
      await mustExist(ctx, 'orderables', key.orderable_id);
      if (other !== undefined) {
        // AC-15.2 [CONV]: usable = an active version of this tenant's code WITH a rate (0 counts) whose window overlaps the rule's.
        const vers = await repo.selectRows(tx(ctx), 'cs_tax_types', Y_COLS, { tenant_id: ctx.tenantId, code: other }, 'effective_from');
        if (!vers.some((v) => isTaxTypeUsable(v) && windowsOverlap(v, mine))) fail([invalid('/other_tax_code')]);
      }
      await lockState(ctx);
      const same = (await scopeRows(ctx, 'tax_rules', R_COLS, scope)).filter((r) => (r.department_id ?? undefined) === key.department_id && (r.orderable_id ?? undefined) === key.orderable_id);
      const pred = scope === 'tenant_default' ? same.find((r) => r.is_active !== false && r.effective_to == null && ms(r.effective_from) < ms(from)) : undefined;
      const clash = same.some((r) => r.is_active !== false && windowsOverlap(r === pred ? { effective_from: r.effective_from, effective_to: from } : r, mine));
      if (clash) fail([invalid('/effective_from')]);
      const close = async (r: R, end: string) => {
        const ok = await repo.updateRow(tx(ctx), 'tax_rules', ['id'], { tenantId: ctx.tenantId, id: r.id, expectedVersion: Number(r.version), actorId: ctx.actor.id }, { effective_to: end }).catch(mapPg);
        if (!ok) throw new LimsError('common.version_conflict');
      };
      if (pred) await close(pred, from);
      // An inactive rule left open would hold the open-rule unique index; close it at its own start or the new start, whichever is later (it applied to nothing anyway).
      if (to === undefined) for (const r of same.filter((x) => x.is_active === false && x.effective_to == null)) await close(r, ms(r.effective_from) > ms(from) ? ts(r.effective_from)! : from);
      const row = await repo.insertRow(tx(ctx), 'tax_rules', R_COLS, omitEmpty({
        id: uuidv7(), tenant_id: ctx.tenantId, scope, ...key, vat_treatment: vat, other_tax_code: other, hs_code: hs, effective_from: from, effective_to: to,
        is_active: true, created_by: ctx.actor.id, updated_by: ctx.actor.id,
      })).catch((e: unknown) => {
        const pe = e as { code?: string; constraint?: string; message?: string };
        if (pe?.code === '23503' && /other_type/.test(`${pe.constraint ?? ''} ${pe.message ?? ''}`)) fail([invalid('/other_tax_code')]);
        if (pe?.code === '23505') fail([invalid('/effective_from')]);                        // open-rule unique index backstop
        return mapPg(e);
      });
      await revision.bumpRevision(ctx, { entityType: 'tax_rule', entityId: row.id, changeKind: 'created', effectiveFrom: from });
      return taxRuleDto(row);
    },

    /** The tenant default is only ever ended by its successor (AC-15.5): 400. */
    async endTaxRule(ctx: Ctx, input: { id?: unknown; expectedVersion?: unknown; body?: unknown } = {}) {
      return taxRuleDto(await endRule(ctx, 'tax_rules', R_COLS, 'tax_rule', input, (r) => { if (r.scope === 'tenant_default') fail([invalid('/scope')]); }));
    },
  };
}
