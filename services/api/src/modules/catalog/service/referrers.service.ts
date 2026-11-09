// Doctors (referrers) #60–#66 (02-TRD §5 rows 60–66, §5.0, §5.1 Doctor, §6.2, §9.1; PRD AC-11.1–11.5; 03-APP-FLOW F-09; 05-SCHEMA doctors / code_counters);
// 07-SECURITY S-1, S-5, S-11, AB-15, AB-20, REQ-SEC-081/082. Validates its own input (import commits call it directly).
// Every write bumps the catalog revision (entity `doctor`) in the caller's transaction. Lock order: counter row, doctor rows (id order), catalog_state.
// Contacts (phone_e164, email) leave only for holders of catalog.referrer.manage, decided by IdentityPort.getActor (fail closed) — summaries never carry them.
// Merge: source -> target, merged_into_id stays ONE hop (doctors already pointing at the source are re-pointed). The source's price-list assignment moves to the target (or is dropped if the target has one) in the same transaction (T-17).
// [CONV] auto code DR{seq:5} from code_counters (`next_value` = next to hand out); a merged doctor can be neither verified nor reactivated (409 catalog.version_in_use).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';   // [CONV] relative import (same as masters.service.ts)
import { LimsError, type FieldError } from '../../../core/errors.js';
import { decodeCursor, encodeCursor } from '../mappers/masters.mapper.js';
import * as repo from '../repo/masters.repo.js';
import {
  UUID, checkUpdate, fail, invalid, isObj, kindOf, lockAt, mapPg, required, unknown,
  type Ctx, type Deps, type Tx,
} from './masters.service.js';
import { createRevisionService } from './revision.service.js';

const MANAGE = 'catalog.referrer.manage';
const COLS = ['id', 'doctor_code', 'display_name', 'name_normalised', 'qualification', 'registration_council', 'registration_no', 'phone_e164', 'email', 'notes',
  'is_verified', 'source', 'merged_into_id', 'is_active', 'version', 'created_at'];
const CONTACTS = ['phone_e164', 'email'];
const OPTIONAL = ['qualification', 'registration_council', 'registration_no', 'phone_e164', 'email', 'notes'];
const CODE_IN = /^[A-Za-z0-9_-]{1,20}$/;          // checked BEFORE upper-casing: no Unicode case-fold forgeries (ı -> I)
const PHONE = /^\+[1-9][0-9]{7,14}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_HINTS = 10;

type Kind = 'name' | 'text' | 'phone' | 'email' | 'bool';
const FIELDS: Record<string, { k: Kind; max?: number }> = {
  display_name: { k: 'name', max: 120 }, qualification: { k: 'text', max: 120 }, registration_council: { k: 'text', max: 20 }, registration_no: { k: 'text', max: 30 },
  phone_e164: { k: 'phone' }, email: { k: 'email' }, notes: { k: 'text', max: 500 }, is_active: { k: 'bool' }, quick_add: { k: 'bool' }, doctor_code: { k: 'text' },
};
const CREATE_KEYS = ['doctor_code', 'display_name', 'qualification', 'registration_council', 'registration_no', 'phone_e164', 'email', 'notes', 'quick_add'];
const UPDATE_KEYS = ['display_name', 'qualification', 'registration_council', 'registration_no', 'phone_e164', 'email', 'notes', 'is_active', 'unset'];

/** Lower-case, NFC, trimmed, single spaces (05-SCHEMA name_normalised; APP-FLOW F-09). */
export const normaliseName = (s: string): string => s.normalize('NFC').toLowerCase().trim().replace(/\s+/g, ' ');
const likeEscape = (s: string) => s.replace(/[\\%_]/g, '\\$&');

function okValue(key: string, v: unknown): boolean {
  const f = FIELDS[key]!;
  if (f.k === 'bool') return typeof v === 'boolean';
  if (typeof v !== 'string') return false;
  switch (f.k) {
    case 'name': return v.length <= f.max! && v.trim().length >= 1;
    case 'text': return key === 'doctor_code' ? CODE_IN.test(v.trim()) : v.length <= f.max!;
    case 'phone': return PHONE.test(v);
    case 'email': return v.length <= 254 && EMAIL.test(v);
    default: return false;
  }
}

/** Declared keys only (S-5). Errors never echo a submitted key or value (AB-20): unknown keys are reported at the root. */
function checkBody(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isObj(input)) return fail([invalid('')]);
  const errors: FieldError[] = [];
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(input)) {
    const v = input[k];
    if (v === undefined) continue;
    if (!allowed.includes(k)) errors.push(unknown(''));
    else if (k === 'unset') out[k] = v;
    else if (!okValue(k, v)) errors.push(invalid(`/${k}`));
    else out[k] = v;
  }
  if (errors.length) fail(errors);
  return out;
}

type R = Record<string, any>;
const summary = (r: R) => ({
  id: r.id as string, doctor_code: r.doctor_code as string, display_name: r.display_name as string, ...(r.qualification == null ? {} : { qualification: r.qualification as string }),
  is_verified: r.is_verified === true, is_active: r.is_active === true, canonical_doctor_id: (r.merged_into_id ?? r.id) as string,
});
/** Doctor DTO: NULL optionals omitted; phone/email only when `contacts`. */
const doctorDto = (r: R, contacts: boolean) => {
  const out: R = { id: r.id, doctor_code: r.doctor_code, display_name: r.display_name };
  for (const k of OPTIONAL) if (r[k] != null && (contacts || !CONTACTS.includes(k))) out[k] = r[k];
  out['is_verified'] = r.is_verified === true; out['source'] = r.source;
  if (r.merged_into_id != null) out['merged_into_id'] = r.merged_into_id;
  out['is_active'] = r.is_active === true; out['version'] = Number(r.version);
  return out;
};

const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : undefined);
interface ListQuery { is_active: 'true' | 'false' | 'all'; is_verified?: boolean; source?: string; sort: string; cursor?: string; limit: number }
function checkQuery(query: unknown): ListQuery {
  const q = query === undefined ? {} : query;
  if (!isObj(q)) return fail([invalid('')]);
  const errors: FieldError[] = [];
  const out: ListQuery = { is_active: 'true', sort: 'doctor_code', limit: 50 };
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined) continue;
    if (k === 'is_active') { if (v === 'true' || v === 'false' || v === 'all') out.is_active = v; else errors.push(invalid('/is_active')); }
    else if (k === 'is_verified') { const b = bool(v); if (b === undefined) errors.push(invalid('/is_verified')); else out.is_verified = b; }
    else if (k === 'source') { if (v === 'back_office' || v === 'quick_add' || v === 'import') out.source = v; else errors.push(invalid('/source')); }
    else if (k === 'sort') { if (v === 'doctor_code' || v === '-doctor_code' || v === 'created_at' || v === '-created_at') out.sort = v; else errors.push(invalid('/sort')); }
    else if (k === 'cursor') { if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(v)) throw new LimsError('common.invalid_cursor'); out.cursor = v; }
    else if (k === 'limit') {
      const n = typeof v === 'string' && /^[0-9]{1,3}$/.test(v) ? Number(v) : v;
      if (Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 200) out.limit = n as number; else errors.push(invalid('/limit'));
    } else errors.push(unknown(''));
  }
  if (errors.length) fail(errors);
  return out;
}

interface SearchIn { q: string; includeUnverified: boolean; includeInactive: boolean; limit: number }
function checkSearch(body: unknown): SearchIn {
  if (!isObj(body)) return fail([invalid('')]);
  const errors: FieldError[] = [];
  let q = ''; let includeUnverified = true; let includeInactive = false; let limit = 50;
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    if (k === 'q') { if (typeof v === 'string' && v.length >= 1 && v.length <= 64 && v.trim() !== '') q = v; else errors.push(invalid('/q')); }
    else if (k === 'include_unverified') { if (typeof v === 'boolean') includeUnverified = v; else errors.push(invalid('/include_unverified')); }
    else if (k === 'include_inactive') { if (typeof v === 'boolean') includeInactive = v; else errors.push(invalid('/include_inactive')); }
    else if (k === 'limit') { if (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 50) limit = v as number; else errors.push(invalid('/limit')); }
    else errors.push(unknown(''));
  }
  if (q === '' && !errors.some((e) => e.path === '/q')) errors.push(required('/q'));
  if (errors.length) fail(errors);
  return { q, includeUnverified, includeInactive, limit };
}

export interface ReferrersDeps extends Deps {
  /** IdentityPort subset (03-IC §4): the actor's permissions decide whether contacts are returned. */
  identity: { getActor(ctx: unknown): Promise<{ permissions: readonly string[] }> };
}

export function createReferrersService(deps: ReferrersDeps) {
  const revision = createRevisionService(deps);
  const nowOf = (ctx: Ctx) => ctx.now?.() ?? new Date().toISOString();
  const bump = (ctx: Ctx, id: string, changeKind: string, at: string) =>
    revision.bumpRevision(ctx, { entityType: 'doctor', entityId: id, changeKind, effectiveFrom: at });
  const q = (ctx: Ctx, text: string, values: unknown[]) => (ctx.tx as Tx).query(text, values);

  /** Next DR{seq:5}: upsert of the (tenant, doctor_code) counter row; the row lock serialises concurrent quick-adds until COMMIT. */
  async function nextCode(ctx: Ctx): Promise<string> {
    const { rows } = await q(ctx,
      'INSERT INTO catalog.code_counters (tenant_id, counter_key, next_value, created_by) VALUES ($1, $2, 2, $3) ' +
      'ON CONFLICT (tenant_id, counter_key) DO UPDATE SET next_value = next_value + 1, updated_at = now() RETURNING next_value',
      [ctx.tenantId, 'doctor_code', ctx.actor.id]);
    return `DR${String(Number(rows[0].next_value) - 1).padStart(5, '0')}`;
  }

  return {
    /** Match: doctor_code prefix of upper-cased q OR name_normalised contains normalised q (escaped LIKE); rank in code (≤ 5,000 doctors/tenant). */
    async searchDoctors(ctx: Ctx, body?: unknown) {
      const s = checkSearch(body);
      const nq = normaliseName(s.q);
      const values: unknown[] = [ctx.tenantId];
      const bind = (v: unknown) => { values.push(v); return `$${values.length}`; };
      const where = ['tenant_id = $1'];
      if (!s.includeInactive) where.push(`is_active = ${bind(true)}`);
      if (!s.includeUnverified) where.push(`is_verified = ${bind(true)}`);
      where.push(`(doctor_code LIKE ${bind(`${likeEscape(nq).toUpperCase()}%`)} ESCAPE '\\' OR name_normalised LIKE ${bind(`%${likeEscape(nq)}%`)} ESCAPE '\\')`);
      const { rows } = await q(ctx,
        `SELECT ${COLS.join(', ')} FROM catalog.doctors WHERE ${where.join(' AND ')} ORDER BY doctor_code ASC, id ASC LIMIT 5000`, values);
      const code = nq.toUpperCase();
      const rank = (r: R) => (r.doctor_code === code ? 0 : String(r.doctor_code).startsWith(code) ? 1 : String(r.name_normalised).startsWith(nq) ? 2 : 3);
      rows.sort((a, b) => rank(a) - rank(b) || (a.doctor_code < b.doctor_code ? -1 : a.doctor_code > b.doctor_code ? 1 : 0));
      return { data: rows.slice(0, s.limit).map(summary) };
    },

    async listDoctors(ctx: Ctx, query?: unknown) {
      const f = checkQuery(query);
      const values: unknown[] = [ctx.tenantId];
      const bind = (v: unknown) => { values.push(v); return `$${values.length}`; };
      const where = ['tenant_id = $1'];
      if (f.is_active !== 'all') where.push(`is_active = ${bind(f.is_active === 'true')}`);
      if (f.is_verified !== undefined) where.push(`is_verified = ${bind(f.is_verified)}`);
      if (f.source !== undefined) where.push(`source = ${bind(f.source)}`);
      const desc = f.sort.startsWith('-');
      const col = f.sort.replace(/^-/, '');
      if (f.cursor !== undefined) { const [v, id] = decodeCursor(f.cursor, f.sort); where.push(`(${col}, id) ${desc ? '<' : '>'} (${bind(v)}, ${bind(id)})`); }
      const dir = desc ? 'DESC' : 'ASC';
      const { rows } = await q(ctx,
        `SELECT ${COLS.join(', ')} FROM catalog.doctors WHERE ${where.join(' AND ')} ORDER BY ${col} ${dir}, id ${dir} LIMIT ${bind(f.limit + 1)}`, values);
      const data = rows.slice(0, f.limit);
      const last = data[data.length - 1];
      const page: { limit: number; next_cursor?: string } = { limit: f.limit };
      // ponytail: created_at cursor carries ms precision (node-pg Date); sub-ms ties could repeat a row. Switch to a (created_at::text) cursor if that bites.
      if (rows.length > f.limit && last) page.next_cursor = encodeCursor(f.sort, col === 'created_at' ? new Date(last.created_at).toISOString() : last[col], last.id);
      return { data: data.map(summary), page };
    },

    async createDoctor(ctx: Ctx, body?: unknown) {
      const b = checkBody(body, CREATE_KEYS);
      if (b['display_name'] === undefined) fail([required('/display_name')]);
      const name = (b['display_name'] as string).trim();
      const explicit = typeof b['doctor_code'] === 'string' ? b['doctor_code'].trim().toUpperCase() : undefined;
      const at = nowOf(ctx);
      const nameNorm = normaliseName(name);
      // Hints first, so the new row is never its own twin: same normalised name AND phone, ACTIVE doctors of this tenant, ≤ 10.
      const hints = typeof b['phone_e164'] !== 'string' ? [] : (await q(ctx,
        `SELECT ${COLS.join(', ')} FROM catalog.doctors WHERE tenant_id = $1 AND name_normalised = $2 AND phone_e164 = $3 AND is_active = $4 ORDER BY doctor_code ASC, id ASC LIMIT $5`,
        [ctx.tenantId, nameNorm, b['phone_e164'], true, MAX_HINTS])).rows;
      const doctorCode = explicit ?? await nextCode(ctx);
      const row: R = {
        id: uuidv7(), tenant_id: ctx.tenantId, doctor_code: doctorCode,
        display_name: name, name_normalised: nameNorm, is_verified: false, source: b['quick_add'] === true ? 'quick_add' : 'back_office', is_active: true,
        created_by: ctx.actor.id, updated_by: ctx.actor.id,
      };
      for (const k of OPTIONAL) if (b[k] !== undefined) row[k] = b[k];
      const created = await repo.insertRow(ctx.tx as Tx, 'doctors', COLS, row).catch(mapPg);
      await bump(ctx, created.id, 'created', at);
      return { ...doctorDto(created, true), possible_duplicate_of: hints.map(summary) };
    },

    async getDoctor(ctx: Ctx, input: { id?: unknown } = {}) {
      if (typeof input.id !== 'string' || !UUID.test(input.id)) fail([invalid('/id')]);
      const actor = await deps.identity.getActor(ctx);            // fail closed: a failing lookup fails the read (REQ-SEC-081)
      const contacts = Array.isArray(actor?.permissions) && actor.permissions.includes(MANAGE);
      const [row] = await repo.selectRows(ctx.tx as Tx, 'doctors', COLS, { tenant_id: ctx.tenantId, id: input.id }, 'id');
      if (!row) throw new LimsError('common.not_found');
      return doctorDto(row, contacts);
    },

    async updateDoctor(ctx: Ctx, input: { id?: unknown; expectedVersion?: unknown; patch?: unknown } = {}) {
      const { id, ev } = checkUpdate(input);
      const b = checkBody(input.patch, UPDATE_KEYS);
      const unset = b['unset'];
      const patch: R = {};
      for (const k of Object.keys(b)) if (k !== 'unset') patch[k] = k === 'display_name' ? (b[k] as string).trim() : b[k];
      if (unset !== undefined) {
        if (!Array.isArray(unset) || unset.length > OPTIONAL.length || new Set(unset).size !== unset.length
          || unset.some((k) => typeof k !== 'string' || !OPTIONAL.includes(k) || b[k] !== undefined)) fail([invalid('/unset')]);
        for (const k of unset as string[]) patch[k] = null;
      }
      if (patch['display_name'] !== undefined) patch['name_normalised'] = normaliseName(patch['display_name']);
      const at = nowOf(ctx);
      const before = await lockAt(ctx, 'doctors', COLS, id, ev);
      if (patch['is_active'] === true && before.merged_into_id != null) throw new LimsError('catalog.version_in_use');
      const after = await repo.updateRow(ctx.tx as Tx, 'doctors', COLS, { tenantId: ctx.tenantId, id, expectedVersion: ev, actorId: ctx.actor.id }, patch).catch(mapPg);
      if (!after) throw new LimsError('common.version_conflict');
      await bump(ctx, id, kindOf(before, after), at);
      return doctorDto(after, true);
    },

    async verifyDoctor(ctx: Ctx, input: { id?: unknown; expectedVersion?: unknown } = {}) {
      const { id, ev } = checkUpdate(input);
      const at = nowOf(ctx);
      const before = await lockAt(ctx, 'doctors', COLS, id, ev);
      if (before.merged_into_id != null) throw new LimsError('catalog.version_in_use');
      const after = await repo.updateRow(ctx.tx as Tx, 'doctors', COLS, { tenantId: ctx.tenantId, id, expectedVersion: ev, actorId: ctx.actor.id },
        { is_verified: true, verified_at: at, verified_by: ctx.actor.id });
      if (!after) throw new LimsError('common.version_conflict');
      await bump(ctx, id, 'updated', at);
      return doctorDto(after, true);
    },

    async mergeDoctor(ctx: Ctx, input: { id?: unknown; expectedVersion?: unknown; body?: unknown } = {}) {
      const { id, ev } = checkUpdate(input);
      if (!isObj(input.body)) fail([invalid('')]);
      const extra = Object.keys(input.body as R).filter((k) => k !== 'into_doctor_id' && (input.body as R)[k] !== undefined);
      const into = (input.body as R)['into_doctor_id'];
      if (extra.length) fail([unknown('')]);
      if (into === undefined) fail([required('/into_doctor_id')]);
      if (typeof into !== 'string' || !UUID.test(into) || into === id) fail([invalid('/into_doctor_id')]);
      const at = nowOf(ctx);
      // Both rows locked in id order (no deadlock between X->Y and Y->X); the target is re-read under the lock.
      const { rows } = await q(ctx, `SELECT ${COLS.join(', ')} FROM catalog.doctors WHERE tenant_id = $1 AND id = ANY($2) ORDER BY id ASC FOR UPDATE`, [ctx.tenantId, [id, into]]);
      const src = rows.find((r) => r.id === id);
      const target = rows.find((r) => r.id === into);
      if (!src) throw new LimsError('common.not_found');
      if (Number(src.version) !== ev) throw new LimsError('common.version_conflict');
      if (src.merged_into_id != null) throw new LimsError('catalog.version_in_use');
      if (!target || target.is_active !== true || target.merged_into_id != null) fail([invalid('/into_doctor_id')]);   // unknown and foreign targets look the same
      const after = await repo.updateRow(ctx.tx as Tx, 'doctors', COLS, { tenantId: ctx.tenantId, id, expectedVersion: ev, actorId: ctx.actor.id },
        { is_active: false, merged_into_id: into }).catch(mapPg);
      if (!after) throw new LimsError('common.version_conflict');
      await q(ctx, // chain flattening: whoever pointed at the source now points at the survivor
        'UPDATE catalog.doctors SET merged_into_id = $3, version = version + 1, updated_at = now(), updated_by = $4 WHERE tenant_id = $1 AND merged_into_id = $2',
        [ctx.tenantId, id, into, ctx.actor.id]);
      // 03-APP-FLOW §2.4 [CONV]: the merged doctor's price-list assignment is removed; if the survivor has none, the same list is re-assigned to it.
      // DELETE + INSERT (associations carry no UPDATE contract). Both doctor rows are locked above, so concurrent merges into one survivor serialise.
      const asg = (await q(ctx, 'SELECT id, price_list_id, doctor_id FROM catalog.price_list_assignments WHERE tenant_id = $1 AND doctor_id = ANY($2) FOR UPDATE', [ctx.tenantId, [id, into]])).rows;
      const moved = asg.find((a) => a.doctor_id === id);
      if (moved) {
        await q(ctx, 'DELETE FROM catalog.price_list_assignments WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, moved.id]);
        if (!asg.some((a) => a.doctor_id === into)) {
          await q(ctx, 'INSERT INTO catalog.price_list_assignments (id, tenant_id, price_list_id, owner_kind, doctor_id, created_by) VALUES ($1, $2, $3, $4, $5, $6)',
            [uuidv7(), ctx.tenantId, moved.price_list_id, 'referrer', into, ctx.actor.id]);
        }
      }
      await bump(ctx, id, 'deactivated', at);
      return doctorDto(after, true);
    },
  };
}
