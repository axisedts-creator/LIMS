// Credit parties / affiliations #67–#70 (02-TRD §5 rows 67–70, §5.0, §5.1 CreditParty, §6.2, §9.1; PRD AC-12.1–12.4; 05-SCHEMA credit_parties / code_counters);
// 07-SECURITY S-1, S-5, S-11, AB-20, AB-22, REQ-SEC-081/082. Validates its own input (import commits call it directly).
// Every write bumps the catalog revision (entity `credit_party`) in the caller's transaction. Lock order: counter row, party row, catalog_state.
// pan / contact_phone_e164 / contact_email / billing_address leave ONLY for holders of catalog.price_list.manage, decided by IdentityPort.getActor (fail closed) —
// applied to list, get, create AND update responses. No credit limit / days / balance exists in C3 (AC-12.3); price_list_id is T-17's.
// [CONV] auto code CP{seq:5} from code_counters (key party_code; `next_value` = next to hand out); a blank party_code is an absent one.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';   // [CONV] relative import (same as masters.service.ts)
import { LimsError, type FieldError } from '../../../core/errors.js';
import { decodeCursor, encodeCursor } from '../mappers/masters.mapper.js';
import * as repo from '../repo/masters.repo.js';
import {
  UUID, checkUpdate, fail, invalid, isObj, kindOf, lockAt, mapPg, required, unknown,
  type Ctx, type Deps, type Tx,
} from './masters.service.js';
import { createRevisionService } from './revision.service.js';

const MANAGE = 'catalog.price_list.manage';
const COLS = ['id', 'party_code', 'name', 'kind', 'allows_credit', 'pan', 'contact_phone_e164', 'contact_email', 'billing_address', 'is_active', 'version'];
const SENSITIVE = ['pan', 'contact_phone_e164', 'contact_email', 'billing_address'];
const KINDS = ['hospital', 'company', 'clinic', 'partner_lab', 'insurer', 'other'];
const CODE_IN = /^[A-Za-z0-9_-]{1,20}$/;          // checked BEFORE upper-casing: no Unicode case-fold forgeries (ı -> I)
const PHONE = /^\+[1-9][0-9]{7,14}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const str = (v: unknown, max: number): boolean => typeof v === 'string' && v.length <= max;
const OK: Record<string, (v: unknown) => boolean> = {
  party_code: (v) => typeof v === 'string' && (v.trim() === '' || CODE_IN.test(v.trim())),
  name: (v) => str(v, 160) && (v as string).trim().length >= 1,
  kind: (v) => typeof v === 'string' && KINDS.includes(v),
  allows_credit: (v) => typeof v === 'boolean',
  is_active: (v) => typeof v === 'boolean',
  pan: (v) => str(v, 20),
  contact_phone_e164: (v) => typeof v === 'string' && PHONE.test(v),
  contact_email: (v) => str(v, 254) && EMAIL.test(v as string),
  billing_address: (v) => str(v, 500),
};
const CREATE_KEYS = ['party_code', 'name', 'kind', 'allows_credit', ...SENSITIVE];
const UPDATE_KEYS = ['name', 'kind', 'allows_credit', 'is_active', 'unset', ...SENSITIVE];
const likeEscape = (s: string) => s.replace(/[\\%_]/g, '\\$&');

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
    else if (!OK[k]!(v)) errors.push(invalid(`/${k}`));
    else out[k] = v;
  }
  if (errors.length) fail(errors);
  return out;
}

type R = Record<string, any>;
const partyDto = (r: R, sensitive: boolean) => {
  const out: R = { id: r.id, party_code: r.party_code, name: r.name, kind: r.kind, allows_credit: r.allows_credit === true };
  if (sensitive) for (const k of SENSITIVE) if (r[k] != null) out[k] = r[k];
  out['is_active'] = r.is_active === true; out['version'] = Number(r.version);
  return out;
};

const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : undefined);
interface ListQuery { is_active: 'true' | 'false' | 'all'; kind?: string; allows_credit?: boolean; q?: string; cursor?: string; limit: number }
function checkQuery(query: unknown): ListQuery {
  const q = query === undefined ? {} : query;
  if (!isObj(q)) return fail([invalid('')]);
  const errors: FieldError[] = [];
  const out: ListQuery = { is_active: 'true', limit: 50 };
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined) continue;
    if (k === 'is_active') { if (v === 'true' || v === 'false' || v === 'all') out.is_active = v; else errors.push(invalid('/is_active')); }
    else if (k === 'kind') { if (typeof v === 'string' && KINDS.includes(v)) out.kind = v; else errors.push(invalid('/kind')); }
    else if (k === 'allows_credit') { const b = bool(v); if (b === undefined) errors.push(invalid('/allows_credit')); else out.allows_credit = b; }
    else if (k === 'q') { if (typeof v === 'string' && v.length <= 20) { if (v.trim() !== '') out.q = v.trim(); } else errors.push(invalid('/q')); }
    else if (k === 'cursor') { if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(v)) throw new LimsError('common.invalid_cursor'); out.cursor = v; }
    else if (k === 'limit') {
      const n = typeof v === 'string' && /^[0-9]{1,3}$/.test(v) ? Number(v) : v;
      if (Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 200) out.limit = n as number; else errors.push(invalid('/limit'));
    } else errors.push(unknown(''));
  }
  if (errors.length) fail(errors);
  return out;
}

export interface CreditPartiesDeps extends Deps {
  /** IdentityPort subset (03-IC §4): the actor's permissions decide whether pan / contacts / address are returned. */
  identity: { getActor(ctx: unknown): Promise<{ permissions: readonly string[] }> };
}

export function createCreditPartiesService(deps: CreditPartiesDeps) {
  const revision = createRevisionService(deps);
  const nowOf = (ctx: Ctx) => ctx.now?.() ?? new Date().toISOString();
  const bump = (ctx: Ctx, id: string, changeKind: string, at: string) =>
    revision.bumpRevision(ctx, { entityType: 'credit_party', entityId: id, changeKind, effectiveFrom: at });
  const q = (ctx: Ctx, text: string, values: unknown[]) => (ctx.tx as Tx).query(text, values);
  /** Fail closed: a failing lookup fails the call (REQ-SEC-081). */
  const canSeeSensitive = async (ctx: Ctx) => {
    const actor = await deps.identity.getActor(ctx);
    return Array.isArray(actor?.permissions) && actor.permissions.includes(MANAGE);
  };

  /** Next CP{seq:5}: upsert of the (tenant, party_code) counter row; the row lock serialises concurrent creates until COMMIT. */
  async function nextCode(ctx: Ctx): Promise<string> {
    const { rows } = await q(ctx,
      'INSERT INTO catalog.code_counters (tenant_id, counter_key, next_value, created_by) VALUES ($1, $2, 2, $3) ' +
      'ON CONFLICT (tenant_id, counter_key) DO UPDATE SET next_value = next_value + 1, updated_at = now() RETURNING next_value',
      [ctx.tenantId, 'party_code', ctx.actor.id]);
    return `CP${String(Number(rows[0].next_value) - 1).padStart(5, '0')}`;
  }

  return {
    async listCreditParties(ctx: Ctx, query?: unknown) {
      const f = checkQuery(query);
      const sensitive = await canSeeSensitive(ctx);
      const values: unknown[] = [ctx.tenantId];
      const bind = (v: unknown) => { values.push(v); return `$${values.length}`; };
      const where = ['tenant_id = $1'];
      if (f.is_active !== 'all') where.push(`is_active = ${bind(f.is_active === 'true')}`);
      if (f.kind !== undefined) where.push(`kind = ${bind(f.kind)}`);
      if (f.allows_credit !== undefined) where.push(`allows_credit = ${bind(f.allows_credit)}`);
      if (f.q !== undefined) where.push(`party_code LIKE ${bind(`${likeEscape(f.q.toUpperCase())}%`)} ESCAPE '\\'`);
      if (f.cursor !== undefined) { const [v, id] = decodeCursor(f.cursor, 'party_code'); where.push(`(party_code, id) > (${bind(v)}, ${bind(id)})`); }
      const { rows } = await q(ctx,
        `SELECT ${COLS.join(', ')} FROM catalog.credit_parties WHERE ${where.join(' AND ')} ORDER BY party_code ASC, id ASC LIMIT ${bind(f.limit + 1)}`, values);
      const data = rows.slice(0, f.limit);
      const last = data[data.length - 1];
      const page: { limit: number; next_cursor?: string } = { limit: f.limit };
      if (rows.length > f.limit && last) page.next_cursor = encodeCursor('party_code', last.party_code, last.id);
      return { data: data.map((r) => partyDto(r, sensitive)), page };
    },

    async createCreditParty(ctx: Ctx, body?: unknown) {
      const b = checkBody(body, CREATE_KEYS);
      if (b['name'] === undefined) fail([required('/name')]);
      if (b['kind'] === undefined) fail([required('/kind')]);
      const sensitive = await canSeeSensitive(ctx);
      const code = typeof b['party_code'] === 'string' ? b['party_code'].trim().toUpperCase() : '';
      const at = nowOf(ctx);
      const partyCode = code !== '' ? code : await nextCode(ctx);
      const row: R = {
        id: uuidv7(), tenant_id: ctx.tenantId, party_code: partyCode, name: (b['name'] as string).trim(), kind: b['kind'],
        created_by: ctx.actor.id, updated_by: ctx.actor.id,
      };
      for (const k of ['allows_credit', ...SENSITIVE]) if (b[k] !== undefined) row[k] = b[k];
      const created = await repo.insertRow(ctx.tx as Tx, 'credit_parties', COLS, row).catch(mapPg);
      await bump(ctx, created.id, 'created', at);
      return partyDto(created, sensitive);
    },

    async getCreditParty(ctx: Ctx, input: { id?: unknown } = {}) {
      if (typeof input.id !== 'string' || !UUID.test(input.id)) fail([invalid('/id')]);
      const sensitive = await canSeeSensitive(ctx);
      const [row] = await repo.selectRows(ctx.tx as Tx, 'credit_parties', COLS, { tenant_id: ctx.tenantId, id: input.id }, 'id');
      if (!row) throw new LimsError('common.not_found');
      return partyDto(row, sensitive);
    },

    async updateCreditParty(ctx: Ctx, input: { id?: unknown; expectedVersion?: unknown; patch?: unknown } = {}) {
      const { id, ev } = checkUpdate(input);
      const b = checkBody(input.patch, UPDATE_KEYS);
      const patch: R = {};
      for (const k of Object.keys(b)) if (k !== 'unset') patch[k] = k === 'name' ? (b[k] as string).trim() : b[k];
      const unset = b['unset'];
      if (unset !== undefined) {
        if (!Array.isArray(unset) || unset.length > SENSITIVE.length || new Set(unset).size !== unset.length
          || unset.some((k) => typeof k !== 'string' || !SENSITIVE.includes(k) || b[k] !== undefined)) fail([invalid('/unset')]);
        for (const k of unset as string[]) patch[k] = null;
      }
      if (Object.keys(patch).length === 0) fail([invalid('')]);          // an empty PATCH would bump version / revision for no change
      const sensitive = await canSeeSensitive(ctx);
      const at = nowOf(ctx);
      const before = await lockAt(ctx, 'credit_parties', COLS, id, ev);
      const after = await repo.updateRow(ctx.tx as Tx, 'credit_parties', COLS, { tenantId: ctx.tenantId, id, expectedVersion: ev, actorId: ctx.actor.id }, patch).catch(mapPg);
      if (!after) throw new LimsError('common.version_conflict');
      await bump(ctx, id, kindOf(before, after), at);
      return partyDto(after, sensitive);
    },
  };
}
