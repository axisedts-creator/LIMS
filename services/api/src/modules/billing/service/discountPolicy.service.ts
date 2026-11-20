// T0B-FINCTRL-1 (LD-321, founder blanket authority LD-310) accounting controls of contracts/openapi/billing.yaml (T0C-FINCTRL-1): discount reasons,
// party discount slabs and their resolution, per user discount limits, discount authorities, the caller's own policy.
// Tenant and actor come from ctx only. Every user value is validated here first (handlers are also called without the core pipeline): 400 with a JSON pointer,
// no value echoed. Money is integer paisa (never a string, never a float), basis points 0..10000. Nothing here logs (done_when 7);
// every write is recorded by the row audit trigger of its table.
// done_when 2: a slab overlap is refused HERE (400 + path) under the per party advisory lock of the DB trigger, so the trigger (23505) is only the backstop:
// the loser of two racing creates waits for the winner's commit, then sees its row and gets the same domain answer.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../core/errors.js';
import { toPaisa } from '../domain/money/paisa.js';
import * as repo from '../repository/discountPolicy.repo.js';
import { Checker, decode, encode, fail, isUniqueViolation, notFound, pathId, scope } from './accounts.service.js';
import type { BalanceCtx } from './balance.service.js';
import { DEFAULT_TZ, localDate } from './ledgerDto.js';
import { iso, isRec, limitOf, present, UUID } from './invoiceRead.service.js';

type Row = Record<string, any>;
const MAX = Number.MAX_SAFE_INTEGER;                              // 9007199254740991, the contract maximum of every *_paisa
const SLAB_KINDS = ['credit_party', 'partner', 'doctor', 'franchise'] as const;
const CODE = /^[A-Z0-9_]{1,32}$/;
const REASON_KEY = /^[0-9]{4}:[A-Z0-9_]{1,32}$/;

/** integer in [min, max]; a JSON number only. */
function int(c: Checker, k: string, min: number, max: number, required = false): number | undefined {
  if (!c.has(k, required)) return undefined;
  const v = c.src[k];
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max) return v;
  c.flag(k);
  return undefined;
}
const body = (raw: unknown): Checker => { const c = new Checker(isRec(raw) ? raw : {}); if (!isRec(raw)) c.flag(''); return c; };
const idCursor = (q: Row, sort: string): string | undefined => (q['cursor'] === undefined ? undefined : decode<string>(q['cursor'], sort, (k) => typeof k === 'string' && UUID.test(k)));
const page = <T>(rows: Row[], limit: number, map: (r: Row) => T, sort: string, key: (r: Row) => string) => {
  const data = rows.slice(0, limit);
  return { data: data.map(map), page: { limit, ...(rows.length > limit ? { next_cursor: encode(sort, key(data[data.length - 1]!)) } : {}) } };
};
/** Optimistic concurrency: 428 without If-Match, 400 malformed. */
function version(v: number | undefined): number {
  if (v === undefined) throw new LimsError('common.precondition_required');
  if (!Number.isSafeInteger(v) || v < 1) throw fail(['/If-Match']);
  return v;
}

// ---------------------------------------------------------------- DTOs
const reasonDto = (r: Row) => ({
  id: r['id'], code: r['code'], name: r['name'], is_active: r['is_active'] === true, display_order: Number(r['display_order']), version: Number(r['version']),
  created_at: iso(r['created_at']), updated_at: iso(r['updated_at']),
});
const slabDto = (r: Row) => present({
  id: r['id'], party_kind: r['party_kind'], party_id: r['party_id'], amount_from_paisa: toPaisa(r['amount_from_paisa']), amount_to_paisa: toPaisa(r['amount_to_paisa']),
  discount_bp: Number(r['discount_bp']), effective_from: r['effective_from'], effective_to: r['effective_to'], is_active: r['is_active'] === true, version: Number(r['version']),
  created_at: iso(r['created_at']), updated_at: iso(r['updated_at']),
});
const ceilingDto = (r: Row) => ({
  id: r['id'], user_id: r['user_id'], max_discount_bp: Number(r['max_discount_bp']), max_discount_paisa: toPaisa(r['max_discount_paisa']), is_active: r['is_active'] === true,
  version: Number(r['version']), created_at: iso(r['created_at']), updated_at: iso(r['updated_at']),
});
const ceiling = (r: Row | undefined) => (r ? { max_discount_bp: Number(r['max_discount_bp']), max_discount_paisa: toPaisa(r['max_discount_paisa']) } : undefined);

async function today(ctx: BalanceCtx): Promise<string> {
  const idp = ctx.ports?.IdentityPort;
  const s = idp ? await idp.getTenantSettings(ctx, { keys: ['timezone'] }) : undefined;
  const tz = typeof s?.timezone === 'string' && s.timezone !== '' ? s.timezone : DEFAULT_TZ;
  return localDate(iso((ctx.now as () => unknown)()), tz);
}

/** The slab ranges as one value: amount [from, to) with to > from, dates with effective_to >= effective_from. */
interface SlabRange { from: number; to: number; bp: number; effFrom: string; effTo: string | null }
type LooseRange = { [K in keyof SlabRange]?: SlabRange[K] | undefined };
function checkRange(c: Checker, r: LooseRange): void {
  if (r.from !== undefined && r.to !== undefined && r.to <= r.from && !c.errors.some((e) => e.path === '/amount_to_paisa')) c.flag('amount_to_paisa');
  if (r.effFrom !== undefined && r.effTo != null && r.effTo < r.effFrom && !c.errors.some((e) => e.path === '/effective_to')) c.flag('effective_to');
}
const overlapError = () => fail(['/amount_from_paisa', '/amount_to_paisa']);

export function createDiscountPolicyService() {
  /** The user (core.users.id) of the calling membership ([CONV] the actor is a membership: ctx.actor.membershipId, else ctx.actor.id). */
  async function myUser(ctx: BalanceCtx, tx: Parameters<typeof repo.getReason>[0], tenantId: string): Promise<string | undefined> {
    const m = (ctx.actor as { membershipId?: unknown }).membershipId ?? ctx.actor.id;
    return typeof m === 'string' && UUID.test(m) ? repo.userOfMembership(tx, tenantId, m) : undefined;
  }
  async function userOrNotFound(tx: Parameters<typeof repo.getReason>[0], tenantId: string, raw: unknown, path: string): Promise<string> {
    const id = pathId(raw, path);
    if (!(await repo.userExists(tx, tenantId, id))) throw notFound();                       // unknown and another tenant's user look the same
    return id;
  }

  return {
    // ------------------------------------------------ discount reasons
    async listReasons(ctx: BalanceCtx, rawQuery: unknown) {
      const { tx, tenantId, actorId } = scope(ctx);
      const q = isRec(rawQuery) ? rawQuery : {};
      const limit = limitOf(q['limit']);
      const c = new Checker(q);
      c.only(['is_active', 'limit', 'cursor']);
      const isActive = c.bool('is_active');
      c.done();
      const after = q['cursor'] === undefined ? undefined : decode<string>(q['cursor'], 'discount_reason', (k) => typeof k === 'string' && REASON_KEY.test(k));
      await repo.ensureSeedReasons(tx, tenantId, actorId);
      const rows = await repo.listReasons(tx, { tenantId, limit: limit + 1, ...(isActive === undefined ? {} : { isActive }), ...(after ? { after } : {}) });
      return page(rows, limit, reasonDto, 'discount_reason', (r) => `${String(r['display_order']).padStart(4, '0')}:${r['code']}`);
    },
    async createReason(ctx: BalanceCtx, raw: unknown) {
      const { tx, tenantId, actorId } = scope(ctx);
      const c = body(raw);
      c.only(['code', 'name', 'display_order']);
      const code = c.text('code', 32, true, CODE);
      const name = c.text('name', 200, true);
      const order = int(c, 'display_order', 0, 9999);
      c.done();
      await repo.ensureSeedReasons(tx, tenantId, actorId);                                    // a custom code never collides later with a seeded one
      try {
        return reasonDto(await repo.insertReason(tx, { id: uuidv7(), tenantId, code: code!, name: name!, displayOrder: order ?? 0, actorId }));
      } catch (e) {
        if (isUniqueViolation(e, 'discount_reason__tenant_id_code__uq')) throw fail(['/code']);    // contract: duplicate -> common.validation_failed
        throw e;
      }
    },
    async updateReason(ctx: BalanceCtx, i: { id: unknown; expectedVersion: number | undefined; body: unknown }) {
      const { tx, tenantId, actorId } = scope(ctx);
      const id = pathId(i.id, 'discount_reason_id');
      if (!(await repo.getReason(tx, tenantId, id))) throw notFound();
      const v = version(i.expectedVersion);
      const c = body(i.body);
      c.only(['name', 'display_order', 'is_active']);
      const name = c.text('name', 200);
      const order = int(c, 'display_order', 0, 9999);
      const isActive = c.bool('is_active');
      if (name === undefined && order === undefined && isActive === undefined && c.errors.length === 0) c.flag('');    // minProperties 1
      c.done();
      const row = await repo.updateReason(tx, { tenantId, id, version: v, actorId, ...(name === undefined ? {} : { name }), ...(order === undefined ? {} : { displayOrder: order }), ...(isActive === undefined ? {} : { isActive }) });
      if (!row) throw new LimsError('common.version_conflict');
      return reasonDto(row);
    },

    // ------------------------------------------------ party discount slabs
    async listSlabs(ctx: BalanceCtx, rawQuery: unknown) {
      const { tx, tenantId } = scope(ctx);
      const q = isRec(rawQuery) ? rawQuery : {};
      const limit = limitOf(q['limit']);
      const c = new Checker(q);
      c.only(['party_kind', 'party_id', 'is_active', 'limit', 'cursor']);
      const partyKind = c.oneOf('party_kind', SLAB_KINDS);
      const partyId = c.uuid('party_id');
      const isActive = c.bool('is_active');
      c.done();
      const beforeId = idCursor(q, 'party_discount_slab');
      const rows = await repo.listSlabs(tx, { tenantId, limit: limit + 1, ...(partyKind ? { partyKind } : {}), ...(partyId ? { partyId } : {}), ...(isActive === undefined ? {} : { isActive }), ...(beforeId ? { beforeId } : {}) });
      return page(rows, limit, slabDto, 'party_discount_slab', (r) => String(r['id']));
    },
    async createSlab(ctx: BalanceCtx, raw: unknown) {
      const { tx, tenantId, actorId } = scope(ctx);
      const c = body(raw);
      c.only(['party_kind', 'party_id', 'amount_from_paisa', 'amount_to_paisa', 'discount_bp', 'effective_from', 'effective_to']);
      const partyKind = c.oneOf('party_kind', SLAB_KINDS, true);
      const partyId = c.uuid('party_id', true);
      const r: LooseRange = {
        from: int(c, 'amount_from_paisa', 0, MAX, true), to: int(c, 'amount_to_paisa', 1, MAX, true), bp: int(c, 'discount_bp', 0, 10_000, true),
        effFrom: c.date('effective_from', true), effTo: c.date('effective_to') ?? null,
      };
      checkRange(c, r);
      c.done();
      if (!(await repo.partyExists(tx, tenantId, partyKind!, partyId!))) throw notFound();
      const p = { tenantId, partyKind: partyKind!, partyId: partyId! };
      const s = r as SlabRange;
      await repo.lockParty(tx, p);
      if (await repo.findOverlap(tx, { ...p, ...s })) throw overlapError();
      try {
        return slabDto(await repo.insertSlab(tx, { id: uuidv7(), ...p, ...s, actorId }));
      } catch (e) {
        if (isUniqueViolation(e, 'party_discount_slab__no_overlap')) throw overlapError();          // backstop only: the lock above makes it unreachable
        throw e;
      }
    },
    async updateSlab(ctx: BalanceCtx, i: { id: unknown; expectedVersion: number | undefined; body: unknown; deactivate?: boolean }) {
      const { tx, tenantId, actorId } = scope(ctx);
      const id = pathId(i.id, 'party_discount_slab_id');
      const first = await repo.getSlab(tx, tenantId, id);
      if (!first) throw notFound();
      const v = version(i.expectedVersion);
      const c = body(i.deactivate ? {} : i.body);
      const patch: Partial<SlabRange> = {};
      if (!i.deactivate) {
        c.only(['amount_from_paisa', 'amount_to_paisa', 'discount_bp', 'effective_from', 'effective_to']);
        const from = int(c, 'amount_from_paisa', 0, MAX), to = int(c, 'amount_to_paisa', 1, MAX), bp = int(c, 'discount_bp', 0, 10_000);
        const effFrom = c.date('effective_from'), effTo = c.date('effective_to');
        if (Object.keys(c.src).length === 0 && c.errors.length === 0) c.flag('');                   // minProperties 1
        Object.assign(patch, from === undefined ? {} : { from }, to === undefined ? {} : { to }, bp === undefined ? {} : { bp }, effFrom === undefined ? {} : { effFrom }, effTo === undefined ? {} : { effTo });
      }
      c.done();
      const p = { tenantId, partyKind: String(first['party_kind']), partyId: String(first['party_id']) };
      await repo.lockParty(tx, p);
      const cur = (await repo.getSlab(tx, tenantId, id))!;                                       // re-read under the lock
      if (Number(cur['version']) !== v) throw new LimsError('common.version_conflict');
      if (i.deactivate && cur['is_active'] !== true) return slabDto(cur);                          // contract: idempotent on an inactive slab
      const next: SlabRange = {
        from: patch.from ?? toPaisa(cur['amount_from_paisa']), to: patch.to ?? toPaisa(cur['amount_to_paisa']), bp: patch.bp ?? Number(cur['discount_bp']),
        effFrom: patch.effFrom ?? String(cur['effective_from']), effTo: patch.effTo ?? (cur['effective_to'] ?? null),
      };
      const rc = new Checker(isRec(i.body) ? i.body : {});
      checkRange(rc, next);
      rc.done();
      const isActive = i.deactivate ? false : cur['is_active'] === true;
      if (isActive && (await repo.findOverlap(tx, { ...p, ...next, exceptId: id }))) throw overlapError();
      try {
        const row = await repo.updateSlab(tx, { tenantId, id, version: v, ...next, isActive, actorId });
        if (!row) throw new LimsError('common.version_conflict');
        return slabDto(row);
      } catch (e) {
        if (isUniqueViolation(e, 'party_discount_slab__no_overlap')) throw overlapError();
        throw e;
      }
    },
    /** done_when 2: the ONE active slab of the party holding the bill amount on the day (default today in the tenant time zone). */
    async resolve(ctx: BalanceCtx, rawQuery: unknown) {
      const { tx, tenantId } = scope(ctx);
      const q = isRec(rawQuery) ? rawQuery : {};
      const c = new Checker(q);
      c.only(['party_kind', 'party_id', 'amount_paisa', 'on_date']);
      const partyKind = c.oneOf('party_kind', SLAB_KINDS, true);
      const partyId = c.uuid('party_id', true);
      let amount: number | undefined;
      if (c.has('amount_paisa', true)) {
        const v = q['amount_paisa'];
        const n = typeof v === 'string' && /^[0-9]{1,16}$/.test(v) ? Number(v) : v;                // a query string arrives as text; a float, a sign or words never parse
        if (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0) amount = n; else c.flag('amount_paisa');
      }
      const onDate = c.date('on_date');
      c.done();
      if (!(await repo.partyExists(tx, tenantId, partyKind!, partyId!))) throw notFound();
      const row = await repo.resolveSlab(tx, { tenantId, partyKind: partyKind!, partyId: partyId!, amount: amount!, day: onDate ?? (await today(ctx)) });
      return row ? { matched: true, slab: slabDto(row), discount_bp: Number(row['discount_bp']) } : { matched: false };
    },

    // ------------------------------------------------ per user limits
    async listLimits(ctx: BalanceCtx, rawQuery: unknown) { return listCeil(ctx, rawQuery, 'user_discount_limit'); },
    /** PUT: creates the user's limit or replaces it in place (version + 1); If-Match optional (contract), a stale one -> 409. */
    async setLimit(ctx: BalanceCtx, i: { userId: unknown; expectedVersion: number | undefined; body: unknown }) {
      const { tx, tenantId, actorId } = scope(ctx);
      const userId = pathId(i.userId, 'user_id');
      if (i.expectedVersion !== undefined && (!Number.isSafeInteger(i.expectedVersion) || i.expectedVersion < 1)) throw fail(['/If-Match']);
      const c = body(i.body);
      c.only(['max_discount_bp', 'max_discount_paisa', 'is_active']);
      const bp = int(c, 'max_discount_bp', 0, 10_000, true);
      const paisa = int(c, 'max_discount_paisa', 0, MAX, true);
      const isActive = c.bool('is_active');
      c.done();
      if (!(await repo.userExists(tx, tenantId, userId))) throw notFound();
      await repo.lockUser(tx, tenantId, userId);
      const cur = await repo.currentLimit(tx, tenantId, userId);
      if (!cur) {
        if (i.expectedVersion !== undefined) throw new LimsError('common.version_conflict');      // nothing to match
        return ceilingDto(await repo.insertLimit(tx, { id: uuidv7(), tenantId, userId, bp: bp!, paisa: paisa!, isActive: isActive ?? true, actorId }));
      }
      const v = i.expectedVersion ?? Number(cur['version']);
      if (Number(cur['version']) !== v) throw new LimsError('common.version_conflict');
      const row = await repo.updateLimit(tx, { tenantId, id: String(cur['id']), version: v, bp: bp!, paisa: paisa!, isActive: isActive ?? true, actorId });
      if (!row) throw new LimsError('common.version_conflict');
      return ceilingDto(row);
    },

    // ------------------------------------------------ discount authorities
    async listAuthorities(ctx: BalanceCtx, rawQuery: unknown) { return listCeil(ctx, rawQuery, 'discount_authority'); },
    async createAuthority(ctx: BalanceCtx, raw: unknown) {
      const { tx, tenantId, actorId } = scope(ctx);
      const c = body(raw);
      c.only(['user_id', 'max_discount_bp', 'max_discount_paisa']);
      const userId = c.uuid('user_id', true);
      const bp = int(c, 'max_discount_bp', 0, 10_000, true);
      const paisa = int(c, 'max_discount_paisa', 0, MAX, true);
      c.done();
      await userOrNotFound(tx, tenantId, userId, 'user_id');
      return ceilingDto(await repo.insertAuthority(tx, { id: uuidv7(), tenantId, userId: userId!, bp: bp!, paisa: paisa!, actorId }));
    },
    async deactivateAuthority(ctx: BalanceCtx, i: { id: unknown; expectedVersion: number | undefined }) {
      const { tx, tenantId, actorId } = scope(ctx);
      const id = pathId(i.id, 'discount_authority_id');
      const cur = await repo.getAuthority(tx, tenantId, id);
      if (!cur) throw notFound();
      const v = version(i.expectedVersion);
      if (Number(cur['version']) === v && cur['is_active'] !== true) return ceilingDto(cur);
      const row = await repo.deactivateAuthority(tx, { tenantId, id, version: v, actorId });
      if (!row) throw new LimsError('common.version_conflict');
      return ceilingDto(row);
    },

    // ------------------------------------------------ the caller's own policy (never another user's numbers)
    async myPolicy(ctx: BalanceCtx) {
      const { tx, tenantId, actorId } = scope(ctx);
      await repo.ensureSeedReasons(tx, tenantId, actorId);
      const userId = await myUser(ctx, tx, tenantId);
      const [limit, authority] = userId ? [await repo.activeLimit(tx, tenantId, userId), await repo.activeAuthority(tx, tenantId, userId)] : [undefined, undefined];
      const reasons = await repo.listReasons(tx, { tenantId, isActive: true, limit: 200 });
      return present({
        own_limit: ceiling(limit), authority: ceiling(authority),
        reasons: reasons.map((r) => ({ code: r['code'], name: r['name'], display_order: Number(r['display_order']) })),
      });
    },
  };

  async function listCeil(ctx: BalanceCtx, rawQuery: unknown, table: 'user_discount_limit' | 'discount_authority') {
    const { tx, tenantId } = scope(ctx);
    const q = isRec(rawQuery) ? rawQuery : {};
    const limit = limitOf(q['limit']);
    const c = new Checker(q);
    c.only(['user_id', 'is_active', 'limit', 'cursor']);
    const userId = c.uuid('user_id');
    const isActive = c.bool('is_active');
    c.done();
    const beforeId = idCursor(q, table);
    const rows = await repo.listCeilings(tx, table, { tenantId, limit: limit + 1, ...(userId ? { userId } : {}), ...(isActive === undefined ? {} : { isActive }), ...(beforeId ? { beforeId } : {}) });
    return page(rows, limit, ceilingDto, table, (r) => String(r['id']));
  }
}
export type DiscountPolicyService = ReturnType<typeof createDiscountPolicyService>;
