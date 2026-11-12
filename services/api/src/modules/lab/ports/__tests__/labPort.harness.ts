// C5 T-24 harness part 2 (not a test file): the ContractHarness over the REAL `labPort`. Seams, seeding and adapters are documented in ./harness.ts.
import { makeCtxFor, type ContractHarness } from '../../../../../../../packages/fakes/src/harness';
import { LimsError } from '../../../../core/errors.js';
import { admin, api, claimsOf, cleanup, dropDash, ensureTaskRegistry, L, MEMBERSHIP, NOW, NS, q, seedFixtures, SYS, TENANT, tenantKey, type World } from './harness.js';

type Obj = Record<string, any>;

/** ports the impl sees (ctx.ports): see the header of ./harness.ts */
function portsFor(w: World) {
  const rangeOf = (analyteId: string) => ({ referenceRangeId: L(0xf8), version: 1, low: analyteId === L(12) ? '4.0' : '10.0', high: analyteId === L(12) ? '10.0' : '20.0', unitCode: 'g/dL' });
  return {
    IdentityPort: {
      async assertRole(ctx: any, r: { permission: string }) {
        if (ctx.actor.type === 'system') return;
        if (!(w.grants[ctx.actor.id] ?? []).includes(r?.permission)) throw new LimsError('auth.forbidden');
      },
      async getTenantSettings() { return { numbering: { barcodePrefix: 'E' }, partialReleaseAllowed: false }; },
    },
    CatalogPort: {
      async mapInstrumentCode(_c: unknown, i: { instrumentId: string; direction: string; instrumentCode?: string; analyteId?: string }) {
        const m = w.mappings.find((x) => x.instrumentId === i.instrumentId && (i.direction === 'outbound' ? x.analyteId === i.analyteId : x.instrumentCode === i.instrumentCode));
        if (!m) throw new LimsError('catalog.instrument_code_unmapped');
        return { mappingId: m.id, instrumentId: m.instrumentId, instrumentCode: m.instrumentCode, analyteId: m.analyteId, testId: m.testId };
      },
      async referenceRangeFor(_c: unknown, i: { analyteId: string }) { return rangeOf(i.analyteId); },
      async criticalLimitsFor(_c: unknown, i: { analyteId: string }) {
        const l = w.criticalLimits.find((x) => x.analyteId === i.analyteId);
        return l ? { criticalLimitId: l.id, version: 1, low: l.low, high: l.high } : undefined;
      },
    },
  };
}

const withSafeDetail = (e: any) => { if (e && typeof e === 'object' && e.detail !== undefined && e.safeDetail === undefined) e.safeDetail = e.detail; return e; };
const mapDeep = (v: any, fn: (k: string, x: string) => string): any => {
  if (Array.isArray(v)) return v.map((x) => mapDeep(x, fn));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'string' ? fn(k, x) : mapDeep(x, fn)]));
  return v;
};

export interface RealHarness extends ContractHarness {
  readonly world: World;
  /** the same ctx, as a device scoped to `centreId` (default: the first centre of the tenant's seeded orders) */
  deviceAt(ctx: any, centreId: string): any;
  /** one port call through the same transaction wrapper (barcode adapters applied; event spy applied unless `{ spy: false }`) */
  call(method: string, ctx: any, input: unknown, o?: { spy?: boolean }): Promise<any>;
  readonly events: ContractHarness['events'] & { all(): readonly any[] };
}

/** () => Promise<RealHarness> over the REAL implementation. Dynamic import: this file loads before the impl exists; the failure is the missing module. */
export function realLabPortHarness(): () => Promise<RealHarness> {
  return async () => {
    await ensureTaskRegistry();
    await cleanup(NS);
    const mod: any = await import('../LabPort.impl.js');
    const real = mod.labPort;
    const w: World = { barcodes: new Map(), mappings: [], criticalLimits: [], grants: {} };
    const ports = portsFor(w);
    const mkCtx = makeCtxFor();
    const watermark: Date = (await admin().query('SELECT clock_timestamp() AS t')).rows[0].t;
    const seen = new Set<string>();
    const spy: Obj[] = [];
    const collect = async () => {
      const rows = await q('SELECT event_id, event_type, envelope FROM core.event_log WHERE created_at >= $1 AND envelope::text LIKE $2 ORDER BY created_at, aggregate_seq', [watermark, `%${NS}%`]);
      for (const r of rows) if (!seen.has(r.event_id)) { seen.add(r.event_id); spy.push({ type: r.event_type, payload: r.envelope?.payload ?? {}, envelope: r.envelope }); }
    };
    const events: any = { ofType: (t: string) => spy.filter((e) => e.type === t), all: () => spy };
    const toDb = (input: any) => (input && typeof input === 'object' && !Array.isArray(input)
      ? Object.fromEntries(Object.entries(input).map(([k, v]) => [k, (k === 'barcode' || k === 'sampleBarcode') && typeof v === 'string' ? dropDash(v) : v])) : input);
    const fromDb = (out: any) => mapDeep(out, (k, x) => (k === 'barcode' ? (w.barcodes.get(x) ?? x) : x));
    const centreCache = new Map<string, string>();
    const firstCentre = async (tenantId: string): Promise<string> => {
      if (!centreCache.has(tenantId)) centreCache.set(tenantId, (await q('SELECT centre_id FROM lab.orders WHERE tenant_id = $1 AND id::text LIKE $2 ORDER BY id LIMIT 1', [tenantId, `${NS}%`]))[0]?.centre_id);
      return centreCache.get(tenantId)!;
    };
    /** one tx under RLS with the actor's claims; commit on success, rollback + rethrow on throw */
    const raw = async (method: string, ctx: any, input: unknown) => {
      if (typeof real[method] !== 'function') throw new Error(`LabPort impl lacks ${method}`);
      const type: string = ctx.actor.type;
      const tk = tenantKey(ctx.tenantId);
      const client = await api().connect();
      try {
        await client.query('BEGIN');
        const extra: Obj = type === 'user' ? { membership_id: MEMBERSHIP[tk] } : type === 'device' ? { centre_id: ctx.__centreId ?? (await firstCentre(ctx.tenantId)) } : {};
        await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claimsOf(ctx.tenantId, type === 'system' ? SYS : ctx.actor.id, type, extra)]);
        (client as any).startedAt = new Date(NOW);   // core events.publish stamps occurred_at from tx.startedAt (the real request tx has it)
        const strict = { tenantId: ctx.tenantId, actor: type === 'user' ? { ...ctx.actor, membershipId: MEMBERSHIP[tk] } : ctx.actor, requestId: ctx.requestId, tx: client, now: () => NOW, ports };
        const out = await real[method](strict, input);
        await client.query('COMMIT');
        return out;
      } catch (e) { await client.query('ROLLBACK').catch(() => undefined); throw withSafeDetail(e); } finally { client.release(); }
    };
    const impl: any = new Proxy({}, {
      get: (_t, m) => {
        if (typeof m !== 'string' || m === 'then') return undefined;
        return async (ctx: any, input: unknown) => { try { return fromDb(await raw(m, ctx, toDb(input))); } finally { await collect(); } };
      },
    });
    const ctxFor: ContractHarness['ctxFor'] = (key, over) => {
      const c: any = mkCtx(key, over);
      c.tenantId = key.startsWith('B') ? TENANT.B : TENANT.A;
      return c;
    };
    return {
      impl, world: w, events, ctxFor,
      async seed(f: object) { await seedFixtures(w, f as Obj); centreCache.clear(); },
      rollback() { /* the shared suite never rolls back */ },
      deviceAt: (ctx: any, centreId: string) => ({ ...ctx, __centreId: centreId }),
      call: async (method: string, ctx: any, input: unknown, o: { spy?: boolean } = {}) => {
        try { return fromDb(await raw(method, ctx, toDb(input))); } finally { if (o.spy !== false) await collect(); }
      },
    } as unknown as RealHarness;
  };
}
