// T0D-18 unit-test rig (LD-133): 02-TRD §6.2 stages 5-11 behind ONE factory, with every collaborator faked at its existing seam.
//
// INTERFACE THE TESTS EXPECT (the spec fixes behaviour, not names; the writer may dispute a name in .orchestra/notes/T0D-18-dispute-*.md):
//   core/pipeline/index.ts   export function createPipeline(deps: PipelineDeps): { run(call: PipelineCall): Promise<PipelineResult> }
//   PipelineDeps = {
//     env: 'dev' | 'ci' | 'staging' | 'production';
//     db: Db;                                    // createDb() of core/db/tx.ts (here over createFakePgBouncer)
//     idempotency: Idempotency;                  // begin / finish / release of core/idempotency.ts
//     rateLimiter: RateLimiter;                  // consume(tier, key) of core/ratelimit
//     authz: ReturnType<typeof createAuthzGuard>;// core/ports/authz-guard.ts (forRequest / check)
//     ports: { portsFor(module: string): PortRegistry };   // core/ports/registry.ts resolvePorts() result
//     services?: Readonly<Record<string, unknown>>;        // module name -> createServices(deps) result  (ctx.services)
//     shared: { core; events; uploads; files; storage; download };   // opaque, handed to ctx unchanged (06 §6.3 members)
//     log: PortLog; metrics: PortMetrics;
//   }
//   PipelineCall = {
//     op: { module; operationId; method; routeTemplate; public: boolean; identityAuth?: boolean; context?: string;
//           idempotency?: 'none'|'optional'|'required'; rateLimitTier?: RateLimitTier };
//     claims?: DbClaims;            // undefined for a public operation (stage 4 gave an anonymous actor)
//     requestId; clientIp; userAgent?; idempotencyKey?;
//     req: { params; query; headers; body };
//     handler: Handler;             // module handler (HandlerContext as second argument)
//     log: logger of the request (becomes ctx.log)
//   }
//   PipelineResult = { status: number; body?: unknown; headers?: Record<string, string> }
//   Errors: a LimsError thrown by a stage or by the handler is rethrown AFTER the transaction rolled back (unless commitOnError)
//   and the idempotency key was released; a handler RESULT with status >= 400 is returned, not thrown.
import { LimsError } from '../../errors.js';
import { createAuthzGuard } from '../../ports/authz-guard.js';
import { createDb } from '../../db/tx.js';
import { createFakePgBouncer, pgError, recorder, SUB, TENANT_A } from '../../db/__tests__/helpers.js';
import { createPipeline } from '../index.js';

export { pgError, SUB, TENANT_A };
export const TENANT_B = '0190a000-0000-7000-8000-00000000bbbb';
export const MEMBERSHIP = '0190a000-0000-7000-8000-00000000a0aa';
export const DEVICE = '0190a000-0000-7000-8000-00000000d001';
export const REQ_ID = '0190a000-0000-7000-8000-0000000000f1';

export const claimsA = { sub: SUB, tenant_id: TENANT_A, membership_id: MEMBERSHIP, actor_type: 'user', aal: 'aal1' } as const;
export const claimsB = { sub: '0190a000-0000-7000-8000-00000000b001', tenant_id: TENANT_B, actor_type: 'user' } as const;
export const claimsDevice = { sub: DEVICE, tenant_id: TENANT_A, actor_type: 'device' } as const;

export const op = (over: Record<string, unknown> = {}) => ({
  module: 'frontdesk', operationId: 'createThing', method: 'POST', routeTemplate: '/v1/frontdesk/things',
  public: false, context: 'tenant', idempotency: 'none', rateLimitTier: 'general', ...over,
}) as any;

export type Handler = (req: any, ctx: any) => Promise<{ status: number; body?: unknown; headers?: Record<string, string> }>;
/** handler that records that it ran, asserts a role (so stage 9 passes) and returns `result`. */
export const okHandler = (result: { status: number; body?: unknown } = { status: 201, body: { id: 't1' } }): Handler =>
  async (_req, ctx) => { await ctx.ports.IdentityPort.assertRole(ctx, { permission: 'catalog.view' }); return result; };

export interface Rig {
  fake: ReturnType<typeof createFakePgBouncer>;
  order: string[];
  rl: { calls: Array<[string, string]>; deny?: LimsError };
  idem: { begin: any[]; finish: any[]; release: any[]; beginResult: any; beginError?: Error; finishError?: Error };
  rec: ReturnType<typeof recorder>;
  assertRoleCalls: any[];
  incs: Array<[string, Record<string, string> | undefined]>;
  shared: Record<'core' | 'events' | 'uploads' | 'files' | 'storage' | 'download', object>;
  services: Record<string, unknown>;
  pipeline: ReturnType<typeof createPipeline>;
  run(over?: Record<string, unknown>): Promise<any>;
  /** statement texts (trimmed) issued so far on the fake server connections */
  sql(): string[];
  inTx(): boolean;
}

export function makeRig(o: { env?: string; servers?: number; handler?: Handler } = {}): Rig {
  const fake = createFakePgBouncer(o.servers ?? 2);
  const rec = recorder();
  const order: string[] = [];
  const rl: Rig['rl'] = { calls: [] };
  const idem: Rig['idem'] = { begin: [], finish: [], release: [], beginResult: { action: 'skip' } };
  const assertRoleCalls: any[] = [];
  const shared = { core: { k: 'core' }, events: { k: 'events' }, uploads: { k: 'uploads' }, files: { k: 'files' }, storage: { k: 'storage' }, download: { k: 'download' } };
  const services = { frontdesk: { k: 'frontdesk-services' } };
  const env = o.env ?? 'ci';
  const db = createDb({ pool: fake.pool, log: rec.log as any, metrics: rec.metrics as any, sleep: async () => undefined, random: () => 0 } as any);
  const rateLimiter = {
    async consume(tier: string, key: string) { order.push(`rate:${tier}:${key}`); rl.calls.push([tier, key]); if (rl.deny) throw rl.deny; },
  };
  const idempotency = {
    async begin(r: any) { order.push('idem.begin'); idem.begin.push(r); if (idem.beginError) throw idem.beginError; return idem.beginResult; },
    async finish(tx: any, h: any, out: any) { order.push(`idem.finish:inTx=${fake.servers.some((s) => s.inTx)}`); idem.finish.push({ tx, handle: h, out }); if (idem.finishError) throw idem.finishError; },
    async release(h: any) { order.push('idem.release'); idem.release.push(h); },
  };
  const identityPort = { async assertRole(...a: unknown[]) { assertRoleCalls.push(a); }, async getActor() { return {}; } };
  const ports = { portsFor: () => ({ IdentityPort: identityPort, CatalogPort: { k: 'catalog-fake' } }) };
  const incs: Rig['incs'] = [];
  const metrics = { setGauge() {}, inc: (n: string, l?: Record<string, string>) => { incs.push([n, l]); } };
  const authz = createAuthzGuard({ env, log: rec.log as any, metrics: metrics as any });
  const pipeline = createPipeline({
    env, db, idempotency, rateLimiter, authz, ports, services, shared, log: rec.log, metrics,
  } as any);
  const handler = o.handler ?? okHandler();
  const rig: Rig = {
    fake, order, rl, idem, rec, assertRoleCalls, incs, shared: shared as any, services, pipeline,
    run: (over = {}) => pipeline.run({
      op: op(), claims: claimsA, requestId: REQ_ID, clientIp: '203.0.113.9', userAgent: 'vitest',
      req: { params: {}, query: {}, headers: {}, body: { name: 'x' } },
      handler: (async (req: any, ctx: any) => { order.push(`handler:inTx=${fake.servers.some((s) => s.inTx)}`); return handler(req, ctx); }) as any,
      log: rec.log,
      ...over,
    } as any),
    sql: () => fake.texts(),
    inTx: () => fake.servers.some((s) => s.inTx),
  };
  return rig;
}

export const lastTxEnd = (rig: Rig): 'COMMIT' | 'ROLLBACK' | undefined =>
  [...rig.sql()].reverse().find((t) => /^(COMMIT|ROLLBACK)$/i.test(t))?.toUpperCase() as any;
export const count = (rig: Rig, re: RegExp): number => rig.sql().filter((t) => re.test(t)).length;
export const logged = (rig: Rig, event: string) => rig.rec.calls.filter((c) => c.obj?.event === event);
export async function rejects(p: Promise<unknown>): Promise<any> {
  try { await p; } catch (e) { return e; }
  throw new Error('expected a rejection, but it resolved');
}
export { LimsError };
