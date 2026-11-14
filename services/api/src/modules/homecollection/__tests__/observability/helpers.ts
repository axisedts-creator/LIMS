// HC-T17 harness: drives A3 pushSyncMutations exactly like ../sync/helpers.ts `op` (REAL PG17 tx, RLS on, real core createEvents) but with
//   ctx.log     = a RAW recorder (the fields object + message as the module passed them, BEFORE the shared logger's scrubbers: the module itself must not hand PHI to the logger), and
//   ctx.metrics = a recorder that DELEGATES to a real core createMetrics() registry (so an unregistered metric name or a label outside the registered set throws inside the handler,
//                 and the rendered /metrics text can be scanned for planted PHI).
// ASSUMED seam (as lab/analytics precedent): module code emits through ctx.metrics.inc(name, labels?, by?) / .set(name, value, labels?) / .observe(name, value, labels?).
// Synthetic data only. Env: LIMS_TEST_APP_URL / LIMS_TEST_SUPER_URL, exported by tests/homecollection/HC-T17.pg.sh.
import { LimsError } from '../../../../core/errors.js';
import { access } from '../../../../core/audit/access.js';
import { createEvents } from '../../../../core/events/publish.js';
import { createMetrics } from '../../../../core/observability/metrics.js';
import { manifest } from '../../index.js';
import { HC_CENTRE, appTx } from '../../repository/__tests__/helpers.js';
import { SYS_ACTOR, TENANT_B, req, uid } from '../visits/helpers.js';
import { hdr } from '../devices/helpers.js';
import { batchOf, type Mut, type PushWorld } from '../sync/helpers.js';

export { fullFlow, M, pushWorld, ensureTaskRegistry } from '../sync/helpers.js';
export type { Mut, PushWorld };

// planted synthetic PHI (07-SECURITY §5 item 10, TRD §14 "Never"): none of these may reach a log line, a metric name/label or the rendered /metrics text
export const PLANT = {
  name: 'Zorblax Quenthrop',
  phone: '+9779801234567',
  address: 'Plantedtole 77 Quenthrop Marg',
  barcode: 'SNPLANT7Q4X91Z',
  latitude: '27.7123456',
  longitude: '85.3123456',
  paymentRef: 'PAYREF-ZQ9-77231',
} as const;

export interface Recorder {
  logs: Array<{ level: string; fields: unknown; msg: string }>;
  incs: Array<{ name: string; labels: Record<string, unknown> | undefined; by: number }>;
  sets: Array<{ name: string; value: number; labels: Record<string, unknown> | undefined }>;
  observes: Array<{ name: string; value: number; labels: Record<string, unknown> | undefined }>;
  render: () => Promise<string>;
}
export interface ObsOpts { labFailsWith?: Error; now?: Date; deniedCentres?: readonly string[] }

const H = manifest.handlers as unknown as Record<string, (r: any, ctx: any) => Promise<{ status: number; body?: any }>>;
const events = createEvents({ producer: 'homecollection' });

/** Builds the lab fake that serves the world's seeded specimens (what `sync/helpers.ts` keeps in a private map: re-derived from the world). */
const labOf = (w: PushWorld, o: ObsOpts) => ({
  async lookupSpecimens(_c: unknown, a: { orderId: string }) {
    if (o.labFailsWith) throw o.labFailsWith;
    return w.order.id === a.orderId ? w.specimens : [];
  },
});

/** pushSyncMutations for the world with the recorder attached. Returns the handler reply and everything observed. */
export async function pushObserved(w: PushWorld, mutations: Mut[], o: ObsOpts = {}): Promise<{ reply?: { status: number; body: any }; error?: any; rec: Recorder }> {
  const metrics = createMetrics();
  const rec: Recorder = { logs: [], incs: [], sets: [], observes: [], render: () => metrics.render() };
  const now = o.now ?? w.now;
  const body = batchOf(w, mutations);
  const side = w.who.tenant === TENANT_B ? 'b' : 'a';
  const lvl = (level: string) => (a?: unknown, b?: unknown) => {
    if (typeof a === 'string') rec.logs.push({ level, fields: undefined, msg: a });
    else rec.logs.push({ level, fields: a, msg: typeof b === 'string' ? b : '' });
  };
  const run = () => appTx(w.who.tenant, async (tx: any) => {
    tx.startedAt = now;
    const ctx: any = {
      operationId: 'pushSyncMutations', clientIp: '203.0.113.9', log: { info: lvl('info'), warn: lvl('warn'), error: lvl('error'), debug: lvl('debug') },
      metrics: {
        inc: (name: string, labels?: Record<string, unknown>, by = 1) => { metrics.inc(name as never, labels as never, by); rec.incs.push({ name, labels, by }); },
        set: (name: string, value: number, labels?: Record<string, unknown>) => { metrics.set(name as never, value, labels as never); rec.sets.push({ name, value, labels }); },
        observe: (name: string, value: number, labels?: Record<string, unknown>) => { metrics.observe(name as never, value, labels as never); rec.observes.push({ name, value, labels }); },
      },
      tenantId: w.who.tenant, tx, requestId: uid(), now: () => now, centreId: HC_CENTRE[side],
      actor: { type: 'user', id: SYS_ACTOR, membershipId: w.who.membershipId },
      db: { tx: async (fn: (c: any) => Promise<unknown>) => fn(ctx) },
      ports: {
        IdentityPort: {
          async assertRole(_c: unknown, a: { permission: string; centreId?: string }) {
            if (!w.who.grants.includes(a?.permission)) throw new LimsError('auth.forbidden');
            if (a?.centreId && o.deniedCentres?.includes(a.centreId)) throw new LimsError('auth.forbidden');
          },
          async getActor() {
            return { actor: { type: 'user', id: SYS_ACTOR, membershipId: w.who.membershipId }, displayName: PLANT.name, roles: [], permissions: [...w.who.grants], centreScope: { all: true, centreIds: [] },
              branchIds: [], mfa: { enrolled: false, level: 'aal1' }, isLocked: false };
          },
          async getTenantSettings() { return { timezone: 'Asia/Kathmandu' }; },
        },
        LabPort: labOf(w, o),
      },
      events,
      core: { memberships: { async list() { return []; } }, async user(_c: unknown, a: { userId: string }) { return { id: a.userId, displayName: PLANT.name, isActive: true }; } },
      audit: { access: (e: any) => access(ctx, e) },
      commitOnError: () => undefined,
    };
    return H['pushSyncMutations']!(req({ body, headers: hdr(w.device.id) }), ctx);
  });
  // a handler error (e.g. 503 common.dependency_unavailable) is part of the journey: keep what was logged / counted before it
  try { return { reply: (await run()) as { status: number; body: any }, rec }; } catch (error) { return { error, rec }; }
}
