// HC-T15 harness: H16 listPhleboDevices (GET /v1/homecollection/devices) and H17 requestDeviceWipe (POST /v1/homecollection/devices/{device_id}/wipe), both `homecollection.device.manage`
// (privileged, CR-C17-008: IdentityPort.assertRole answers auth.mfa_required at aal1). H17 needs If-Match "<version>" (428 / 409 / 400) and an Idempotency-Key (core pipeline, NOT re-tested here).
// Same convention as ../devices/helpers.ts (HC-T10): handler taken from the module manifest, driven with a request-shaped object + a HandlerContext over a REAL PG17 tx (lims_api, RLS on;
// `bypassRls` = superuser tx so only the repo's own tenant_id filter keeps tenants apart). Unlike ../visits/helpers.ts `op`, the IdentityPort fake here models aal1/aal2 (as ../settings/helpers.ts).
// ASSUMED ctx (as HC-T10): tenantId, tx, now(), actor{type,id,membershipId}, log, db.tx(fn), ports.IdentityPort.assertRole, core.memberships.list (display_name). Synthetic data only.
// Env: LIMS_TEST_APP_URL / LIMS_TEST_SUPER_URL, exported by tests/homecollection/HC-T15.pg.sh.
import { LimsError } from '../../../../core/errors.js';
import { manifest } from '../../index.js';
import { HC_CENTRE, TENANT_A, TENANT_B, SYS_ACTOR, MEMBER, MEMBER2, appTx, ownerRows, superTx, uid } from '../../repository/__tests__/helpers.js';
import { req, rejection, responseErrors, schemaErrors, spec, opOf, seedReasons } from '../settings/helpers.js';
import { v7, seedDevice, deviceRow, deviceRows, frozen, hdr, signOff, register, regBody, staffName } from '../devices/helpers.js';

export { TENANT_A, TENANT_B, SYS_ACTOR, MEMBER, MEMBER2, ownerRows, superTx, uid, req, rejection, responseErrors, schemaErrors, spec, opOf, seedReasons, v7, seedDevice, deviceRow, deviceRows, frozen, hdr, signOff, register, regBody, staffName };
export const T = 120_000;
export const NOW = new Date('2026-11-10T06:00:00.000Z');
export const PERM = 'homecollection.device.manage';
export const P = { device: PERM, read: 'homecollection.visit.read', assign: 'homecollection.visit.assign', sync: 'homecollection.sync.upload', settings: 'homecollection.settings.manage' } as const;
const PRIVILEGED: ReadonlySet<string> = new Set([PERM, P.settings]);

export interface Who { tenant: string; membershipId: string; grants: readonly string[]; mfa: 'aal1' | 'aal2' }
const mid = (side: 'a' | 'b', n: number) => `01a1a98a-ac40-7000-8000-00000000${side}${n}`;
/** lab_manager / tenant_admin at aal2: device.manage (privileged). */
export const ADMIN: Who = { tenant: TENANT_A, membershipId: mid('a', 900), grants: [P.device, P.read], mfa: 'aal2' };
export const ADMIN_B: Who = { tenant: TENANT_B, membershipId: mid('b', 900), grants: [P.device, P.read], mfa: 'aal2' };
/** dispatcher: visit.read + visit.assign, no device.manage. */
export const DISPATCHER: Who = { tenant: TENANT_A, membershipId: mid('a', 901), grants: [P.read, P.assign], mfa: 'aal2' };
/** phlebotomist: sync.upload (+ visit.read) only; the owner of seeded devices (membership MEMBER.a). */
export const PHLEBO: Who = { tenant: TENANT_A, membershipId: MEMBER.a, grants: [P.read, P.sync], mfa: 'aal2' };
export const as = (w: Who, o: Partial<Who>): Who => ({ ...w, ...o });

export interface Probe { logs: string[]; requestId: string; identity: Array<{ permission: string }>; memberships: Array<Record<string, unknown>> }
export interface Reply { status: number; body: any; headers?: Record<string, string>; probe: Probe }
export interface OpOpts { bypassRls?: boolean; coreFails?: boolean }
const H = manifest.handlers as unknown as Record<string, (r: any, ctx: any) => Promise<{ status: number; body?: any; headers?: Record<string, string> }>>;

/** One request = one committed tx with `who.tenant`'s claims (RLS on unless `bypassRls`); a thrown error rolls the tx back and carries `.probe`. */
export async function op(operationId: string, r: ReturnType<typeof req>, who: Who, o: OpOpts = {}): Promise<Reply> {
  const side = who.tenant === TENANT_B ? 'b' : 'a';
  const probe: Probe = { logs: [], requestId: uid(), identity: [], memberships: [] };
  const run = async (tx: any) => {
    const log = (lvl: string) => (obj: object, msg?: string) => { probe.logs.push(`${lvl} ${JSON.stringify(obj)} ${msg ?? ''}`); };
    const ctx: any = {
      operationId, clientIp: '203.0.113.9', log: { info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') }, metrics: { inc: () => undefined },
      tenantId: who.tenant, tx, requestId: probe.requestId, now: () => NOW, centreId: HC_CENTRE[side],
      actor: { type: 'user', id: SYS_ACTOR, membershipId: who.membershipId },
      db: { tx: async (fn: (c: any) => Promise<unknown>) => fn(ctx) },
      ports: {
        IdentityPort: {
          async assertRole(_c: unknown, a: { permission: string }) {
            probe.identity.push({ permission: a?.permission });
            if (!who.grants.includes(a?.permission)) throw new LimsError('auth.forbidden');
            if (PRIVILEGED.has(a.permission) && who.mfa !== 'aal2') throw new LimsError('auth.mfa_required');   // as packages/fakes IdentityPort.fake.ts
          },
          async getActor() {
            return { actor: { type: 'user', id: SYS_ACTOR, membershipId: who.membershipId }, displayName: 'Synthetic Admin', roles: [], permissions: [...who.grants],
              centreScope: { all: true, centreIds: [] }, branchIds: [], mfa: { enrolled: who.mfa === 'aal2', level: who.mfa }, isLocked: false };
          },
          async getTenantSettings() { return { timezone: 'Asia/Kathmandu' }; },
        },
      },
      core: {
        memberships: {
          async list(_c: unknown, a: { membershipIds?: readonly string[]; activeOnly?: boolean } = {}) {
            probe.memberships.push({ ...a, ...(a.membershipIds ? { membershipIds: [...a.membershipIds] } : {}) });
            if (o.coreFails) throw new LimsError('common.internal');
            return (a.membershipIds ?? []).map((id) => ({ membershipId: id, displayName: staffName(id), roleCodes: ['phlebotomist'], allCentres: true, isActive: true }));
          },
        },
      },
      commitOnError: () => undefined,
    };
    return H[operationId]!(r, ctx);
  };
  try {
    const out = await (o.bypassRls ? superTx(run, who.tenant) : appTx(who.tenant, run));
    return { ...(out as any), probe };
  } catch (e) { if (e && typeof e === 'object') (e as any).probe = probe; throw e; }
}

export const listDevices = (query: object, who: Who = ADMIN, o: OpOpts = {}) => op('listPhleboDevices', req({ query }), who, o);
export const listFails = (query: object, who: Who = ADMIN, o: OpOpts = {}) => rejection(listDevices(query, who, o));
/** If-Match is sent as `"<version>"` (settings convention); pass `undefined` for "header absent", or a raw string. */
export const wipe = (deviceId: string, body: unknown, ifMatch: string | number | undefined, who: Who = ADMIN, o: OpOpts = {}) =>
  op('requestDeviceWipe', req({ params: { device_id: deviceId }, body, headers: ifMatch === undefined ? {} : { 'if-match': typeof ifMatch === 'number' ? `"${ifMatch}"` : ifMatch } }), who, o);
export const wipeFails = (deviceId: string, body: unknown, ifMatch: string | number | undefined, who: Who = ADMIN, o: OpOpts = {}) => rejection(wipe(deviceId, body, ifMatch, who, o));

/** Every page of H16 for one filter, following next_cursor (committed rows of the whole tenant, other test files' devices included). */
export async function allPages(query: object, who: Who = ADMIN, limit = 2): Promise<{ ids: string[]; pages: any[] }> {
  const pages: any[] = []; const ids: string[] = []; let cursor: string | undefined;
  for (let i = 0; i < 500; i++) {
    const r = await listDevices({ ...query, limit, ...(cursor ? { cursor } : {}) }, who);
    pages.push(r.body); ids.push(...r.body.data.map((d: any) => d.id));
    cursor = r.body.page.next_cursor;
    if (!cursor) return { ids, pages };
  }
  throw new Error('pagination did not terminate');
}
