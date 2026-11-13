// HC-T11 harness: A2 getSyncSnapshot (GET /v1/homecollection/sync/snapshot) and A4 ackSync (POST /v1/homecollection/sync/ack), 02-TRD §5.2 / §5.3.1 / §6.2 / §6.4, 01-PRD US-06 + US-13-5.
// Same convention as ../visits/helpers.ts (HC-T08) and ../devices/helpers.ts (HC-T10): the handler under test is taken from the module manifest and driven with a request-shaped object + a HandlerContext
// over a REAL PG17 tx (lims_api, RLS on; `bypassRls` = superuser tx). The core pipeline (schema validation, auth, x-permission) is NOT re-tested; the pipeline hands headers over lower-cased.
// Own `op` (not visits/helpers `op`) because A2 also needs: ports.LabPort.lookupSpecimens fake, `ctx.now()` per test (route dates are per test: "today" = local date in the tenant tz), and port latencies.
// ASSUMED ctx (02-TRD §6.4, as HC-T08/HC-T10): tenantId, tx, requestId, now(), centreId, actor{type,id,membershipId}, log, metrics, db.tx(fn) (pass-through here; the real one is a savepoint, 08 A19 P-44),
//   ports.IdentityPort { assertRole, getActor, getTenantSettings(ctx,{keys}) -> { timezone } }, ports.FrontdeskPort { getPatientDemographicsBatch }, ports.BillingPort { getOrderBalance },
//   ports.LabPort { lookupSpecimens(ctx,{orderId,statuses}) -> SpecimenRef[] }  (all FAKES below: they record every call and can fail / be slow), core.memberships.list, audit.access = the REAL core writer.
// Synthetic data only. Env: LIMS_TEST_APP_URL / LIMS_TEST_SUPER_URL, exported by tests/homecollection/HC-T11.pg.sh.
import { LimsError } from '../../../../core/errors.js';
import { access } from '../../../../core/audit/access.js';
import { rows as fdRows } from '../../../frontdesk/__tests__/integration/helpers.js';
import { manifest } from '../../index.js';
import { HC_CENTRE, appTx, hc, seed } from '../../repository/__tests__/helpers.js';
import { DISPATCHER, MEMBER, MEMBER2, NOBODY, P, PHLEBO, PHLEBO2, SYS_ACTOR, T, TENANT_A, TENANT_B, as, nameOf, ownerRows, phoneOf, regOf, rejection, req, responseErrors, schemaErrors, spec, staffName, superTx, uid,
  type Who } from '../visits/helpers.js';
import { APP, hdr, v7 } from '../devices/helpers.js';

export { DISPATCHER, MEMBER, MEMBER2, NOBODY, P, PHLEBO, PHLEBO2, SYS_ACTOR, T, TENANT_A, TENANT_B, HC_CENTRE, APP, as, hdr, hc, nameOf, ownerRows, phoneOf, regOf, rejection, req, responseErrors, schemaErrors, seed, spec, staffName,
  superTx, uid, v7 };
export type { Who };
/** tenant B's phlebotomist (visit.read + sync.upload): the settings-mutating tests run in tenant B so they cannot disturb tenant A's parallel files. */
export const PHLEBO_B: Who = { tenant: TENANT_B, membershipId: MEMBER.b, grants: [P.read, P.sync] };

/** What the fakes serve (03-IC latencies: demographics batch <= 50 ms (TRD §13 assumption), getOrderBalance <= 10 ms, lookupSpecimens <= 20 ms). */
export interface Fx {
  batchFails?: boolean;
  /** patient ids the Frontdesk port cannot see (omitted from the batch) */
  omit?: readonly string[];
  noPhone?: readonly string[];
  balanceFails?: boolean;
  /** order ids whose balance read fails */
  balanceFailsFor?: readonly string[];
  labFails?: boolean;
  /** order ids whose lookupSpecimens call fails */
  labFailsFor?: readonly string[];
  /** fail with a plain Error instead of a LimsError (an unexpected port failure) */
  labPlain?: boolean;
  /** number of SpecimenRefs per order (default 2) */
  specimens?: number;
  delay?: { demographics?: number; balance?: number; lab?: number };
  /** centres where IdentityPort.assertRole(..., {centreId}) fails with auth.forbidden (a phlebotomist whose membership lacks the centre) */
  deniedCentres?: readonly string[];
}
export interface Probe {
  logs: string[]; requestId: string;
  identity: Array<{ permission: string; centreId?: string }>;
  tenantSettings: unknown[];
  batch: Array<{ patientIds: string[]; purpose: unknown }>;
  lab: Array<Record<string, unknown>>;
  balance: string[];
}
export interface Reply { status: number; body: any; headers?: Record<string, string>; probe: Probe; handlerMs: number }
export interface OpOpts { bypassRls?: boolean; fx?: Fx; now?: Date; headers?: object }

// LD-156 (2026-11-13): fake port latency is an async non-blocking delay (a timer), never a busy-spin, so concurrent port calls overlap as in production.
const sleep = async (ms?: number) => {
  if (ms) await new Promise<void>((r) => setTimeout(r, ms));
};
const H = manifest.handlers as unknown as Record<string, (r: any, ctx: any) => Promise<{ status: number; body?: any; headers?: Record<string, string> }>>;

// ---- deterministic fake data (tests compare against these) ----
export const birthOf = (patientId: string): string => `19${String(70 + (parseInt(patientId.slice(-2), 16) % 30))}-0${1 + (parseInt(patientId.slice(-3, -2), 16) % 9)}-1${parseInt(patientId.slice(-4, -3), 16) % 9}`;
export const barcodeOf = (orderId: string, i: number): string => `SN${orderId.replace(/-/g, '').slice(-10).toUpperCase()}${i}`;
export const specimenIdOf = (orderId: string, i: number): string => `${orderId.slice(0, 24)}${orderId.slice(24, 35)}${i}`;
export const TYPES = ['SST', 'EDTA'] as const;
export const BALANCE_PAISA = 180000;

export async function op(operationId: string, r: ReturnType<typeof req>, who: Who, o: OpOpts = {}): Promise<Reply> {
  const side = who.tenant === TENANT_B ? 'b' : 'a';
  const fx = o.fx ?? {};
  const now = o.now ?? new Date('2027-04-01T06:00:00.000Z');
  const probe: Probe = { logs: [], requestId: uid(), identity: [], tenantSettings: [], batch: [], lab: [], balance: [] };
  let handlerMs = 0;
  const run = async (tx: any) => {
    const log =(lvl: string) => (obj: object, msg?: string) => { probe.logs.push(`${lvl} ${JSON.stringify(obj)} ${msg ?? ''}`); };
    const ctx: any = {
      operationId, clientIp: '203.0.113.9', log: { info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') }, metrics: { inc: () => undefined },
      tenantId: who.tenant, tx, requestId: probe.requestId, now: () => now, centreId: HC_CENTRE[side],
      actor: { type: 'user', id: SYS_ACTOR, membershipId: who.membershipId },
      db: { tx: async (fn: (c: any) => Promise<unknown>) => fn(ctx) },
      ports: {
        IdentityPort: {
          async assertRole(_c: unknown, a: { permission: string; centreId?: string }) {
            probe.identity.push({ permission: a?.permission, ...(a?.centreId ? { centreId: a.centreId } : {}) });
            if (!who.grants.includes(a?.permission)) throw new LimsError('auth.forbidden');
            if (a?.centreId && fx.deniedCentres?.includes(a.centreId)) throw new LimsError('auth.forbidden');
          },
          async getActor() {
            return { actor: { type: 'user', id: SYS_ACTOR, membershipId: who.membershipId }, displayName: 'Synthetic Caller', roles: [], permissions: [...who.grants],
              centreScope: { all: true, centreIds: [] }, branchIds: [], mfa: { enrolled: false, level: 'aal1' }, isLocked: false };
          },
          async getTenantSettings(_c: unknown, a: unknown) { probe.tenantSettings.push(a); return { timezone: 'Asia/Kathmandu' }; },
        },
        FrontdeskPort: {
          async getPatientDemographicsBatch(_c: unknown, a: { patientIds: readonly string[]; purpose: unknown }) {
            probe.batch.push({ patientIds: [...a.patientIds], purpose: a.purpose });
            await sleep(fx.delay?.demographics);
            if (fx.batchFails) throw new LimsError('common.internal');
            if (a.purpose !== 'home_visit' || a.patientIds.length > 200) throw new LimsError('auth.forbidden');
            return a.patientIds.filter((id) => !fx.omit?.includes(id)).map((id) => ({ patientId: id, fullName: nameOf(id), ...(fx.noPhone?.includes(id) ? {} : { phoneE164: phoneOf(id) }), birthOn: birthOf(id), sex: 'female', status: 'active' }));
          },
        },
        BillingPort: {
          async getOrderBalance(_c: unknown, a: { orderId: string }) {
            probe.balance.push(a.orderId);
            await sleep(fx.delay?.balance);
            if (fx.balanceFails || fx.balanceFailsFor?.includes(a.orderId)) throw new LimsError('common.internal');
            const m = (amount: number) => ({ amountPaisa: amount, currency: 'NPR' });
            return { orderId: a.orderId, invoiced: m(BALANCE_PAISA), paid: m(0), credited: m(0), balanceDue: m(BALANCE_PAISA), balanceVersion: 1, asOf: now.toISOString() };
          },
        },
        LabPort: {
          async lookupSpecimens(_c: unknown, a: { orderId: string; statuses?: string[] }) {
            probe.lab.push({ ...a });
            await sleep(fx.delay?.lab);
            if (fx.labFails || fx.labFailsFor?.includes(a.orderId)) throw fx.labPlain ? new Error('synthetic lab outage') : new LimsError('common.internal');
            return Array.from({ length: fx.specimens ?? 2 }, (_x, i) => ({ specimenId: specimenIdOf(a.orderId, i), barcode: barcodeOf(a.orderId, i), orderId: a.orderId, patientId: uid(), centreId: HC_CENTRE[side],
              specimenTypeCode: TYPES[i % 2], ...(i === 0 ? { containerCode: 'TUBE_A' } : {}), status: 'ordered', isActive: true, version: 1 }));
          },
        },
      },
      core: {
        memberships: { async list() { return []; } },
        async user(_c: unknown, a: { userId: string }) { return { id: a.userId, displayName: 'Synthetic User', isActive: true }; },
      },
      audit: { access: (e: any) => access(ctx, e) },
      commitOnError: () => undefined,
    };
    const t0 = performance.now();   // LD-156: handler time only, excluding appTx connect/BEGIN/COMMIT
    const res = await H[operationId]!(r, ctx);
    handlerMs = performance.now() - t0;
    return res;
  };
  try {
    const out = await (o.bypassRls ? superTx(run, who.tenant) : appTx(who.tenant, run));
    return { ...(out as any), probe, handlerMs };
  } catch (e) { if (e && typeof e === 'object') (e as any).probe = probe; throw e; }
}

export const pull = (deviceId: string, o: OpOpts & { cursor?: string; who?: Who; query?: object } = {}) =>
  op('getSyncSnapshot', req({ query: { device_id: deviceId, ...(o.cursor ? { cursor: o.cursor } : {}), ...(o.query ?? {}) }, headers: o.headers ?? hdr(deviceId) }), o.who ?? PHLEBO, o);
export const pullFails = (deviceId: string, o: Parameters<typeof pull>[1] = {}) => rejection(pull(deviceId, o));
export const ackBody = (deviceId: string, cursor: string, o: Record<string, unknown> = {}) => ({ device_id: deviceId, cursor, applied_at_device: '2027-04-01T06:00:05.000Z', max_device_seq_acked: 0, ...o });
export const ack = (body: unknown, o: OpOpts & { who?: Who; id?: string } = {}) => {
  const b: any = body;
  return op('ackSync', req({ body, headers: o.headers ?? hdr(o.id ?? b?.device_id ?? v7()) }), o.who ?? PHLEBO, o);
};
export const ackFails = (body: unknown, o: Parameters<typeof ack>[1] = {}) => rejection(ack(body, o));

export const cursorOf = (c: string): any => JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
export const isoDay = (d: Date) => d.toISOString().slice(0, 10);

// ---- scenario seeding (committed; synthetic). One scenario per test: routes are unique per (centre, member, date) and every test file runs in parallel on one DB. ----
const BASE_DAY = Date.UTC(2027, 3, 1);   // after every fixed date other HC suites use (<= 2027-03-31) and before their hashed ranges (>= 2027-07-20)
let used = 0;
/** A route date reserved for this test file: `file` (0..3) gives it a 70-day range, each scenario takes 3 days (today, "tomorrow" = +1). */
export const nextDay = (file: number): string => isoDay(new Date(BASE_DAY + (file * 70 + 3 * used++) * 86400000));
export const noonOf = (date: string): Date => new Date(`${date}T06:00:00.000Z`);   // 11:45 in Asia/Kathmandu: the same local date
export const addDays = (date: string, n: number): string => isoDay(new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000));

export async function ensureSettings(s: 'a' | 'b', o: Record<string, unknown> = {}): Promise<void> {
  await seed('homecollection.settings', hc.settings(s, o));   // ON CONFLICT DO NOTHING: the committed row (if any) is kept
}
export async function seedDevice(s: 'a' | 'b', o: Record<string, unknown> = {}): Promise<any> {
  const d = hc.device(s, { id: v7(), ...o });
  await seed('homecollection.devices', d);
  return d;
}
export const deviceRow = async (id: string) => (await ownerRows('homecollection.devices', 'id = $1', [id]))[0];
export const routeRow = async (id: string) => (await ownerRows('homecollection.routes', 'id = $1', [id]))[0];
export const bumpRoute = (tenant: string, routeId: string) => superTx(async (tx) => { await tx.query('UPDATE homecollection.routes SET version = version + 1 WHERE id = $1', [routeId]); }, tenant);

export const times = (day: string, seq: number) => {
  const s = seq * 10, e = s + 30; const f = (m: number) => `${day}T${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00Z`;
  return { window_start: f(s), window_end: f(e) };
};
export interface SeededVisit { row: any; patient: any; order: any }
/** A visit with its own patient + order (so per-visit port failures can be targeted by order id). */
export async function seedVisit(s: 'a' | 'b', o: { route?: any; member?: string; seq?: number; date: string; status?: string; extra?: Record<string, unknown>; withWindow?: boolean }): Promise<SeededVisit> {
  const status = o.status ?? 'assigned';
  const patient = fdRows.patient(s, { full_name: 'Synthetic Patient DB', birth_on: '1991-02-03' });
  await seed('frontdesk.patients', patient);
  const order = fdRows.order(s, patient.id, { centre_id: HC_CENTRE[s], collection_mode: 'home' });
  await seed('frontdesk.orders', order);
  await seed('lab.orders', { id: order.id, tenant_id: order.tenant_id, centre_id: HC_CENTRE[s], branch_id: order.branch_id, patient_id: patient.id, registration_no: order.registration_no, visit_type: 'opd', priority: 'routine',
    collection_mode: 'home', source: 'home_collection', registered_at: '2026-11-10T04:00:00Z', patient_sex: 'female', last_order_seq: 1 });
  const seq = o.seq ?? 1;
  const row = hc.visit(s, { patient, order }, {
    status, ...(o.route ? { route_id: o.route.id, route_date: o.date, route_sequence: seq } : {}), ...(o.member ? { assigned_membership_id: o.member, assigned_at: '2027-02-28T10:00:00Z' } : {}),
    ...(o.withWindow === false ? {} : times(o.date, seq)), note_for_phlebotomist: 'Synthetic gate code 0000', ...(status === 'completed' ? { outcome: 'collected', completed_at: `${o.date}T05:00:00Z` } : {}),
    ...(status === 'failed' ? { outcome: 'none', failed_at: `${o.date}T05:00:00Z`, status_reason_code: 'patient_not_home' } : {}), ...(status === 'cancelled' ? { cancelled_at: `${o.date}T03:00:00Z`, status_reason_code: 'patient_request' } : {}),
    ...(o.extra ?? {}) });
  await seed('homecollection.visits', row);
  return { row, patient, order };
}
export const mkRoute = async (s: 'a' | 'b', member: string, date: string): Promise<any> => { const r = hc.route(s, { phlebotomist_membership_id: member, route_date: date }); await seed('homecollection.routes', r); return r; };

export interface Scenario {
  date: string; now: Date; device: any; route: any; routeTomorrow: any;
  /** assigned on today's route, MEMBER.a, sequence 1 and 2 (coordinates on v1, none on v2; v2 has no phone-less patient) */
  v1: SeededVisit; v2: SeededVisit;
  /** assigned to MEMBER.a on tomorrow's route */
  tomorrow: SeededVisit;
  /** PHLEBO2's route + visit today (tenant A), and tenant B's */
  other: SeededVisit; otherRoute: any;
}
/** The US-06-1 world: PHLEBO (MEMBER.a) has 2 visits today, 1 tomorrow; PHLEBO2 has 1 today. `device` is PHLEBO's active registered device. */
export async function scenario(file: number, o: { settings?: Record<string, unknown> } = {}): Promise<Scenario> {
  await ensureSettings('a', o.settings);
  const date = nextDay(file);
  const route = await mkRoute('a', MEMBER.a, date), routeTomorrow = await mkRoute('a', MEMBER.a, addDays(date, 1)), otherRoute = await mkRoute('a', MEMBER2.a, date);
  const v1 = await seedVisit('a', { route, member: MEMBER.a, seq: 1, date, extra: { latitude: 27.7172, longitude: 85.324, landmark: 'Opposite the synthetic bakery', address_text: 'Ward 4, Synthetic Tole 12' } });
  const v2 = await seedVisit('a', { route, member: MEMBER.a, seq: 2, date, extra: { landmark: null } });
  const tomorrow = await seedVisit('a', { route: routeTomorrow, member: MEMBER.a, seq: 1, date: addDays(date, 1) });
  const other = await seedVisit('a', { route: otherRoute, member: MEMBER2.a, seq: 1, date });
  const device = await seedDevice('a');
  return { date, now: noonOf(date), device, route, routeTomorrow, v1, v2, tomorrow, other, otherRoute };
}
/** Pull as PHLEBO on the scenario's device at the scenario's "now". */
export const pullS = (S: Scenario, o: Parameters<typeof pull>[1] = {}) => pull(S.device.id, { now: S.now, ...o });

/** audit.access_log rows of home_visit.view (purpose home_visit_snapshot) written by one request. */
export const snapshotAccessRows = (requestId: string) => ownerRows('audit.access_log', `request_id = $1 AND action = 'home_visit.view' ORDER BY entity_id`, [requestId]);
export const allAccessRows = (requestId: string) => ownerRows('audit.access_log', 'request_id = $1', [requestId]);

/** Every string in a JSON value (keys excluded), for "no registration number / birth date / test name anywhere" scans. */
export function strings(x: unknown, out: string[] = []): string[] {
  if (typeof x === 'string') out.push(x);
  else if (Array.isArray(x)) x.forEach((v) => strings(v, out));
  else if (x && typeof x === 'object') Object.values(x).forEach((v) => strings(v, out));
  return out;
}
export const keysDeep = (x: unknown, out = new Set<string>()): Set<string> => {
  if (Array.isArray(x)) x.forEach((v) => keysDeep(v, out));
  else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { out.add(k); keysDeep(v, out); }
  return out;
};
export const setSettings = (tenant: string, set: string, values: unknown[]) =>
  superTx(async (tx) => { await tx.query(`UPDATE homecollection.settings SET ${set}, version = version + 1 WHERE tenant_id = $1`, [tenant, ...values]); }, tenant);
export const getSettingsRow = async (tenant: string) => (await ownerRows('homecollection.settings', 'tenant_id = $1', [tenant]))[0];
