// HC-T14 harness: H13 listHandovers, H14 getHandover, H15 confirmHandover (02-TRD §5.1/§5.4 rule 3, 03-APP-FLOW §1.3, 01-PRD US-12-1/2/3/5, 07-SECURITY REQ-SEC-017, 08 A19 D-125).
// Same convention as ../sync/helpers.ts (HC-T12): the handler under test is taken from the module manifest and driven with a request-shaped object + a HandlerContext over a REAL PG17 tx (lims_api, RLS on).
// DIFFERENCE: the tx carries the claims of a USER actor (actor_type 'user' + membership_id), so app.has_all_centres() / app.current_centre_ids() are the real ones (core.memberships / membership_centres):
// RECEIVER = seeded membership a50a, all_centres = false, centre A-C1 only — NOT a member of the home-collection centre A-HC (the D-125 case).
// ASSUMED ctx (as HC-T09/HC-T12): tenantId, tx (every statement is recorded in probe.sql), requestId, now() (= NOW), actor{type,id,membershipId}, db.tx(fn) = SAVEPOINT, log, metrics,
//   ports.IdentityPort.assertRole(ctx,{permission,centreId?}) (records every call; throws auth.forbidden), core.memberships.list(ctx,{membershipIds,activeOnly}) -> [{membershipId,displayName,...}],
//   core.user(ctx,{userId}), audit.access. Headers lower-cased: `if-match: "<v>"`, `idempotency-key`. Rejections carry `.code/.statusCode/.errors` and `.probe`.
// The core pipeline (OpenAPI validation, auth, x-permission, Idempotency-Key replay) is NOT re-tested here.
import { LimsError } from '../../../../core/errors.js';
import { manifest } from '../../index.js';
import { RECEIVER, NOW, ensureDiscrepancyTask, type HoWorld } from './world.js';
import { req } from '../settings/helpers.js';

export * from './world.js';
export { req };
export const T = 120_000;
export const PERM = 'homecollection.handover.receive';

const pgModule = 'pg'; // variable specifier: no tsc error before the writer adds the dependency
const { default: pg } = (await import(pgModule)) as any;
const pool = new pg.Pool({ connectionString: process.env['LIMS_TEST_APP_URL'], max: 10 });
export const closeHandoverPool = async (): Promise<void> => { await pool.end(); };

export const staffName = (membershipId: string): string => `Synthetic Staff ${membershipId.slice(-6)}`;

export interface Who { tenant: string; membershipId: string; userId: string; grants: readonly string[] }
/** centre staff of A-C1 holding handover.receive (role centre_staff / front_desk / lab_technologist, CR-C17-008) */
export const STAFF_C: Who = { ...RECEIVER, grants: [PERM] };
/** same membership without the permission */
export const NO_PERM: Who = { ...RECEIVER, grants: ['homecollection.visit.read'] };
export const asUser = (membershipId: string, userId: string, grants: readonly string[], tenant: string = RECEIVER.tenant): Who => ({ tenant, membershipId, userId, grants });

export interface Fx { deniedCentres?: string[]; namesFail?: boolean }
export interface Probe { sql: string[]; identity: Array<{ permission: string; centreId?: string }>; logs: string[]; requestId: string; savepoints: number }
export interface Reply { status: number; body: any; headers?: Record<string, string>; probe: Probe }
export interface OpOpts { fx?: Fx; /** throw after the handler returned (the tx rolls back: "same transaction" probe) */ failAfter?: boolean; claimsOverride?: Record<string, unknown> }
const H = manifest.handlers as unknown as Record<string, (r: any, ctx: any) => Promise<{ status: number; body?: any; headers?: Record<string, string> }>>;

let sp = 0;
export async function op(operationId: string, r: ReturnType<typeof req>, who: Who, o: OpOpts = {}): Promise<Reply> {
  await ensureDiscrepancyTask();
  const fx = o.fx ?? {};
  const probe: Probe = { sql: [], identity: [], logs: [], requestId: crypto.randomUUID(), savepoints: 0 };
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ tenant_id: who.tenant, sub: who.userId, actor_type: 'user', membership_id: who.membershipId, ...(o.claimsOverride ?? {}) })]);
    const tx: any = { startedAt: NOW, query: (text: string, values?: unknown[]) => { probe.sql.push(String(text)); return c.query(text, values); } };
    const log = (lvl: string) => (obj: object, msg?: string) => { probe.logs.push(`${lvl} ${JSON.stringify(obj)} ${msg ?? ''}`); };
    const ctx: any = {
      operationId, clientIp: '203.0.113.9', log: { info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') }, metrics: { inc: () => undefined },
      tenantId: who.tenant, tx, requestId: probe.requestId, now: () => NOW, centreId: undefined,
      actor: { type: 'user', id: who.userId, membershipId: who.membershipId },
      db: {
        tx: async (fn: (x: any) => Promise<unknown>) => {
          const name = `hc_t14_sp_${++sp}`; probe.savepoints++;
          await c.query(`SAVEPOINT ${name}`);
          try { const out = await fn(ctx); await c.query(`RELEASE SAVEPOINT ${name}`); return out; } catch (e) { await c.query(`ROLLBACK TO SAVEPOINT ${name}`); throw e; }
        },
      },
      ports: {
        IdentityPort: {
          async assertRole(_c: unknown, a: { permission: string; centreId?: string }) {
            probe.identity.push({ permission: a?.permission, ...(a?.centreId ? { centreId: a.centreId } : {}) });
            if (!who.grants.includes(a?.permission)) throw new LimsError('auth.forbidden');
            if (a?.centreId && fx.deniedCentres?.includes(a.centreId)) throw new LimsError('auth.forbidden');
          },
          async getActor() {
            return { actor: { type: 'user', id: who.userId, membershipId: who.membershipId }, displayName: 'Synthetic Caller', roles: [], permissions: [...who.grants], centreScope: { all: false, centreIds: [] },
              branchIds: [], mfa: { enrolled: false, level: 'aal1' }, isLocked: false };
          },
          async getTenantSettings() { return { timezone: 'Asia/Kathmandu' }; },
        },
      },
      core: {
        memberships: {
          async list(_c: unknown, a: { membershipIds?: readonly string[] } = {}) {
            if (fx.namesFail) throw new LimsError('common.dependency_unavailable');
            return (a.membershipIds ?? []).map((id) => ({ membershipId: id, displayName: staffName(id), roleCodes: [], allCentres: false, isActive: true }));
          },
        },
        async user(_c: unknown, a: { userId: string }) { if (fx.namesFail) throw new LimsError('common.dependency_unavailable'); return { id: a.userId, displayName: staffName(a.userId), isActive: true }; },
      },
      audit: { access: () => undefined },
      commitOnError: () => undefined,
    };
    let out: any;
    try {
      out = await H[operationId]!(r, ctx);
      if (o.failAfter) throw new Error('synthetic failure after the handler');
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); if (e && typeof e === 'object') (e as any).probe = probe; throw e; }
    return { ...(out as any), probe };
  } finally { c.release(); }
}

// ---- request builders ----
export const key = (): string => `t14-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
export const list = (query: object = {}, who: Who = STAFF_C, o: OpOpts = {}) => op('listHandovers', req({ query }), who, o);
export const get = (id: string, who: Who = STAFF_C, o: OpOpts = {}) => op('getHandover', req({ params: { handover_id: id } }), who, o);
export interface Confirm { id: string; items: unknown; version: number | null; note?: unknown; idem?: string | null; who?: Who; fx?: Fx; failAfter?: boolean; headers?: object }
export const confirm = (a: Confirm) => op('confirmHandover', req({
  params: { handover_id: a.id },
  headers: a.headers ?? { ...(a.version === null ? {} : { 'if-match': `"${a.version}"` }), ...(a.idem === null ? {} : { 'idempotency-key': a.idem ?? key() }) },
  body: { items: a.items, ...(a.note === undefined ? {} : { note: a.note }) } }), a.who ?? STAFF_C, { ...(a.fx ? { fx: a.fx } : {}), ...(a.failAfter ? { failAfter: true } : {}) });
/** all items of the world with the same decision, or per-index decisions */
export const decide = (w: HoWorld, received: boolean | boolean[]) => w.items.map((it, i) => ({ specimen_id: it.specimenId, received: Array.isArray(received) ? received[i]! : received }));
export const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected a rejection, got success'); };

// ---- what a statement may touch (D-125: H14/H15 read and write handovers + handover_items only) ----
export const VISIT_SIDE = /homecollection\.(visits|visit_specimens|collections|visit_flags|routes|visit_assignments|visit_transitions|mutations|devices|sync_batches|visit_locations|booking_refs|settings)\b|\blab\.|frontdesk\.|billing\./i;
export const visitSideSql = (p: Probe): string[] => p.sql.filter((s) => VISIT_SIDE.test(s));
/** a probe on the SAME session as a handler call: what the receiver's claims can see */
export async function countAs(who: Who, table: string, where = 'true', values: unknown[] = []): Promise<number> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ tenant_id: who.tenant, sub: who.userId, actor_type: 'user', membership_id: who.membershipId })]);
    const { rows } = await c.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, values);
    await c.query('COMMIT');
    return rows[0].n as number;
  } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
}
export const sameInstant = (a: unknown, b: unknown): boolean => new Date(a as string).getTime() === new Date(b as string).getTime();
