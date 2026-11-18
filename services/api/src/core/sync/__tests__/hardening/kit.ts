// T0B-SYNC-5 kit (not a test). Offline sync hardening: load, chaos, retention, observability (LD-322, LD-325, founder 2026-11-17 09:19 NPT).
// Builds on ../helpers2.ts (REAL pushSyncBatch engine + real PG17 + RLS, one request tx per batch, SAVEPOINT per operation). The eight catalogue op types are
// registered here as SYNTHETIC adapters writing to sync2_test.s5_* tables, so what is measured is the ENGINE + LEDGER + counters, not a domain service.
// A "receipt" takes its number from a gap free per tenant counter held until the end of the request tx (same device as ../adapters/doubles.ts nextNo):
// a rolled back operation gives its number back, so a lost or doubled operation shows up as a gap or a duplicate.
// PINNED SURFACE of the production code (writer may dispute with a CR; every item may be overruled by the lead/arbiter, then the tests follow):
//   services/api/src/core/sync/retention.ts  exports DEFAULT_SYNC_RETENTION_DAYS (= 180) and
//     purgeSyncLedger(db: { tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> }, o: { tenantId: string; now: string | Date; retentionDays?: number; batchSize?: number; maxBatches?: number;
//       metrics?: { inc(name, labels?, by?): void } }): Promise<{ conflicts: number; operations: number; batches: number; capped: boolean }>
//     EVERY batch runs in its OWN db.tx call (own commit, row locks only, never a table lock), at most batchSize rows per DELETE statement (default 500), at most maxBatches batches
//     per run (default 200; capped = more was left). Rules: a conflict is purged when status = 'resolved' AND resolved_at < now - retentionDays; an operation when
//     server_received_at < now - retentionDays (strict) AND status IN ('accepted','duplicate','rejected','conflict') AND it has no remaining conflict row (an open conflict keeps its operation)
//     AND it has no print marker in state pending or recall_required; its satellites (core.sync_signoff_outcome, core.sync_alert, a confirmed core.sync_print_marker) go with it.
//     Fail closed: retentionDays must be a positive integer, else it throws before any delete. It never touches audit.* (the table triggers add audit rows, none is removed).
//     Metrics: lims_core_retention_purged_total{table:'sync_operation'|'sync_conflict'} by rows deleted, lims_core_retention_purge_capped_total{table} when capped.
//     Privileges: runs as lims_worker with system claims of the tenant; lims_api keeps NO DELETE on any of these tables (a migration or DEFINER function is the writer's choice).
//   services/api/src/core/sync/metrics.ts  exports refreshSyncGauges(tx: Tx, metrics: { set(name, value, labels?): void }, o: { tenantId: string; now: string | Date }): Promise<void>
//     lims_core_sync_conflicts_open{tenant_id}            = open conflicts of the tenant (the conflict inbox size), set also when 0
//     lims_core_sync_print_recalls{tenant_id}             = print markers of the tenant in state recall_required
//     lims_core_sync_device_backlog_age_seconds{tenant_id,device_id} = for every ACTIVE device: now - COALESCE(last_sync_at, first_seen_at) in whole seconds when the device was seen
//                                                          after its last sync (last_seen_at > COALESCE(last_sync_at, first_seen_at)); else 0. Revoked devices are not reported.
//     accepted / duplicate / rejected / conflict counts = the existing lims_core_sync_operations_total{status} (T0B-SYNC-2), exposed unchanged.
//   services/worker/src: a per tenant cron task `core.sync_retention` (calls purgeSyncLedger) and a per tenant cron task `core.sync_metrics` (calls refreshSyncGauges), both registered in the worker.
//   docs/ops/OFFLINE-SYNC.md: the runbook (checked by runbook.static.test.ts).
import { LimsError } from '../../../errors.js';
import { provisionalNumber, SyncConflictError } from '../../engine.js';
import { ensureCounter, nextNo } from '../adapters/doubles.js';
import { A1, devicePush, engine, iso, NOW, newDevice, okBody, ownerRows, superTx, uid, type Op } from '../helpers2.js';

export { ensureCounter, nextNo, provisionalNumber };
export * from '../helpers2.js';

/** p95 bound of one batch of 50 operations under the load test (written in the notes: T0B-SYNC-5-tests.md). A single throwaway PG17 container on a developer machine, 40 batches in
 *  flight, every batch with receipts serialised on the gap free counter row: the bound is generous on purpose, a regression to per row commits or table locks goes far above it. */
export const P95_BATCH_MS_BOUND = 30_000;
export const LOAD = { devices: 200, opsPerDevice: 100, batchSize: 50, concurrency: 40 } as const;

// ---------------------------------------------------------------- synthetic tables
let ready = false;
export async function ensureS5(): Promise<void> {
  if (ready) return;
  await ensureCounter();
  await superTx(async (tx) => {
    await tx.query(`CREATE TABLE IF NOT EXISTS sync2_test.s5_patient (tenant_id uuid NOT NULL, patient_key text NOT NULL, PRIMARY KEY (tenant_id, patient_key))`);
    await tx.query(`CREATE TABLE IF NOT EXISTS sync2_test.s5_order (tenant_id uuid NOT NULL, order_key text NOT NULL, op_id uuid NOT NULL, PRIMARY KEY (tenant_id, order_key))`);
    await tx.query(`CREATE TABLE IF NOT EXISTS sync2_test.s5_receipt (tenant_id uuid NOT NULL, series text NOT NULL, no bigint NOT NULL, op_id uuid NOT NULL, PRIMARY KEY (tenant_id, series, no), UNIQUE (tenant_id, op_id))`);
    await tx.query(`CREATE TABLE IF NOT EXISTS sync2_test.s5_state (tenant_id uuid NOT NULL, entity_id uuid NOT NULL, state text NOT NULL, op_id uuid NOT NULL, PRIMARY KEY (tenant_id, entity_id, state))`);
    // one row per APPLIED operation: the primary key makes a double application fail loudly (23505) instead of passing silently
    await tx.query(`CREATE TABLE IF NOT EXISTS sync2_test.s5_event (tenant_id uuid NOT NULL, op_id uuid NOT NULL, kind text NOT NULL, PRIMARY KEY (tenant_id, op_id))`);
    await tx.query('GRANT ALL ON ALL TABLES IN SCHEMA sync2_test TO PUBLIC');
  });
  ready = true;
}

// ---------------------------------------------------------------- deterministic data
export function prng(seed: number): () => number {   // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** A stable UUID (version 8 shape) for a key: the same order / specimen / centre-day gets the same entity id on every device. */
export function uuidFor(key: string): string {
  const h = [...key].reduce((acc, ch) => (Math.imul(acc ^ ch.charCodeAt(0), 16777619) >>> 0), 2166136261).toString(16).padStart(8, '0');
  const k2 = [...key].reduce((acc, ch) => (Math.imul(acc + ch.charCodeAt(0), 2654435761) >>> 0), 7).toString(16).padStart(8, '0');
  return `${h}-${k2.slice(0, 4)}-8${k2.slice(4, 7)}-8${h.slice(0, 3)}-${(h + k2).slice(0, 12).padEnd(12, '0')}`;
}
const pad = (n: number): string => String(n).padStart(7, '0');

// ---------------------------------------------------------------- synthetic adapters for the eight catalogue types
export const chaos = { kill: false };
export function mixedAdapters(series: string): any[] {
  const event = (ctx: any, op: any, kind: string) => ctx.tx.query('INSERT INTO sync2_test.s5_event (tenant_id, op_id, kind) VALUES ($1, $2, $3)', [ctx.tenantId, op.opId, kind]);
  const once = async (ctx: any, op: any, state: string): Promise<boolean> =>
    (await ctx.tx.query('INSERT INTO sync2_test.s5_state (tenant_id, entity_id, state, op_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING 1', [ctx.tenantId, op.entityId, state, op.opId])).rows.length === 1;
  const make = (opType: string, permission: string, execute: (ctx: any, op: any) => Promise<any>): any => ({
    opType, permission,
    validate(p: any) { if (p?.invalid === true) throw new LimsError('common.validation_failed'); },
    execute,
  });
  return [
    make('registration.create_order', 'frontdesk.registration.create', async (ctx, op) => {
      const p = op.payload as { patient_key: string; order_key: string };
      await ctx.tx.query('INSERT INTO sync2_test.s5_patient (tenant_id, patient_key) VALUES ($1, $2) ON CONFLICT DO NOTHING', [ctx.tenantId, p.patient_key]);   // the same patient on two devices = ONE patient
      const o = await ctx.tx.query('INSERT INTO sync2_test.s5_order (tenant_id, order_key, op_id) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, order_key) DO NOTHING RETURNING 1', [ctx.tenantId, p.order_key, op.opId]);
      if (o.rows.length === 0) throw new SyncConflictError({ entityType: 'order', serverPayload: { order_key: p.order_key }, errorCode: 'frontdesk.patient_duplicate_suspected' });
      await event(ctx, op, 'registration');
      return { entityId: uuidFor(p.order_key) };
    }),
    make('billing.record_receipt', 'billing.payment.record', async (ctx, op) => {
      const no = await nextNo(ctx, series);
      await ctx.tx.query('INSERT INTO sync2_test.s5_receipt (tenant_id, series, no, op_id) VALUES ($1, $2, $3, $4)', [ctx.tenantId, series, no, op.opId]);
      await event(ctx, op, 'receipt');
      return { entityId: op.entityId, numberMappings: [{ document_type: 'receipt', provisional_number: provisionalNumber(op.deviceId, op.opId, 'receipt'), final_number: `RCP-${pad(no)}` }] };
    }),
    make('collection.mark_collected', 'lab.specimen.collect', async (ctx, op) => {
      if (!(await once(ctx, op, 'collected'))) return { entityId: op.entityId, outcome: 'duplicate' };   // already in that state (another device got there first)
      await event(ctx, op, 'collected'); return { entityId: op.entityId };
    }),
    make('accession.receive', 'lab.specimen.receive', async (ctx, op) => {
      if (!(await once(ctx, op, 'received'))) return { entityId: op.entityId, outcome: 'duplicate' };
      await event(ctx, op, 'received'); return { entityId: op.entityId };
    }),
    make('result.enter', 'lab.result.enter', async (ctx, op) => {
      // chaos: the request transaction dies in the middle of the batch (armed per test: a device re-sends the SAME payload after the crash, so the op itself can not change)
      if ((op.payload as any).kill === true && chaos.kill) await ctx.tx.query('SELECT pg_terminate_backend(pg_backend_pid())');
      await event(ctx, op, 'result.enter'); return {};
    }),
    make('result.verify', 'lab.result.verify', async (ctx, op) => { await event(ctx, op, 'result.verify'); return { entityId: op.entityId }; }),
    make('report.print_marker', 'reporting.report.print', async (ctx, op) => { await event(ctx, op, 'print_marker'); return { entityId: op.entityId }; }),
    make('daily_cash.close', 'billing.cash.close', async (ctx, op) => {
      if (!(await once(ctx, op, 'closed'))) return { entityId: op.entityId, outcome: 'duplicate' };   // a close already made: idempotent per centre and day
      await event(ctx, op, 'cash_close'); return { entityId: op.entityId };
    }),
  ];
}
export const syncEngine = (series: string, settings: Record<string, unknown> = {}) => engine(settings, mixedAdapters(series));

// ---------------------------------------------------------------- operation plans
export interface PlannedOp { op: Op; kind: string }
export interface DevicePlan { index: number; deviceId: string; ops: PlannedOp[] }
export interface Overlap { sharedOrders: number; sharedSpecimens: number; sharedCashDays: number }

/** `run` makes every key unique to this run (the throwaway database keeps rows between runs). Each device gets `n` operations in time order, 1 .. 20 hours before NOW (inside the 24 hour skew limit).
 *  Realistic overlap: patients repeat across devices (pool of 300), pairs of devices (i, i + devices/2) register the SAME order, collect / receive the SAME specimen and close the SAME centre day:
 *  one of the two wins, the other is a conflict (order) or a duplicate (specimen, cash). */
export async function buildPlans(run: string, devices: number, n: number, seed = 7): Promise<{ plans: DevicePlan[]; overlap: Overlap }> {
  const rnd = prng(seed);
  const plans: DevicePlan[] = [];
  const half = Math.floor(devices / 2);
  const overlap: Overlap = { sharedOrders: 0, sharedSpecimens: 0, sharedCashDays: 0 };
  for (let d = 0; d < devices; d++) {
    const deviceId = await newDevice(A1);
    const ops: PlannedOp[] = [];
    const myOrders: string[] = [];
    const base = NOW.getTime() - 20 * 3_600_000;
    const step = Math.floor((19 * 3_600_000) / n);
    for (let i = 0; i < n; i++) {
      const at = new Date(base + i * step);
      const r = rnd();
      const pair = d % half;                                   // devices d and d + half form a pair
      let op: Op; let kind: string;
      if (i === 0) {                                            // first op: the shared order of the pair (only for the first `half/4` pairs, so most orders are not shared)
        const shared = pair < Math.floor(half / 4);
        const orderKey = shared ? `${run}-shared-order-${pair}` : `${run}-o-${d}-0`;
        if (shared && d < half) overlap.sharedOrders += 1;
        myOrders.push(orderKey);
        op = { op_id: uid(), op_type: 'registration.create_order', payload: { patient_key: `${run}-p-${Math.floor(rnd() * 300)}`, order_key: orderKey }, device_created_at: iso(at) };
        kind = 'registration';
      } else if (i === 1 && pair < Math.floor(half / 4)) {      // the shared specimen
        if (d < half) overlap.sharedSpecimens += 1;
        op = { op_id: uid(), op_type: 'collection.mark_collected', entity_id: uuidFor(`${run}-spec-${pair}`), base_version: 2, payload: { tag: 'x' }, device_created_at: iso(at) };
        kind = 'collection';
      } else if (i === n - 1 && pair < Math.floor(half / 4)) {  // the shared cash day, last operation of the device
        if (d < half) overlap.sharedCashDays += 1;
        op = { op_id: uid(), op_type: 'daily_cash.close', entity_id: uuidFor(`${run}-cash-${pair}`), base_version: 1, payload: { day: '2026-11-16' }, device_created_at: iso(at) };
        kind = 'cash';
      } else if (r < 0.18) {
        const orderKey = `${run}-o-${d}-${i}`; myOrders.push(orderKey);
        op = { op_id: uid(), op_type: 'registration.create_order', payload: { patient_key: `${run}-p-${Math.floor(rnd() * 300)}`, order_key: orderKey }, device_created_at: iso(at) };
        kind = 'registration';
      } else if (r < 0.42) {
        op = { op_id: uid(), op_type: 'billing.record_receipt', entity_id: uuidFor(myOrders[Math.floor(rnd() * myOrders.length)] ?? `${run}-o-${d}-0`), payload: { amount_received_paisa: 1000 + Math.floor(rnd() * 9000) }, device_created_at: iso(at) };
        kind = 'receipt';
      } else if (r < 0.52) {
        op = { op_id: uid(), op_type: 'collection.mark_collected', entity_id: uuidFor(`${run}-spec-d${d}-${i}`), base_version: 2, payload: { tag: 'x' }, device_created_at: iso(at) };
        kind = 'collection';
      } else if (r < 0.62) {
        op = { op_id: uid(), op_type: 'accession.receive', entity_id: uuidFor(`${run}-spec-d${d}-${i}`), base_version: 3, payload: { tag: 'x' }, device_created_at: iso(at) };
        kind = 'accession';
      } else if (r < 0.82) {
        op = { op_id: uid(), op_type: 'result.enter', payload: { value: Math.floor(rnd() * 1000) }, device_created_at: iso(at) };
        kind = 'enter';
      } else if (r < 0.94) {
        op = { op_id: uid(), op_type: 'result.verify', entity_id: uuidFor(`${run}-res-${d}-${i}`), base_version: 3, payload: { level: 1 }, device_created_at: iso(at) };
        kind = 'verify';
      } else {
        op = { op_id: uid(), op_type: 'report.print_marker', entity_id: uuidFor(`${run}-rep-${d}-${i}`), payload: { printed: true }, device_created_at: iso(at) };
        kind = 'print';
      }
      ops.push({ op, kind });
    }
    plans.push({ index: d, deviceId, ops });
  }
  return { plans, overlap };
}
export const chunk = <T,>(xs: readonly T[], n: number): T[][] => { const out: T[][] = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };

/** Runs `fn` over `items` with at most `limit` in flight. */
export async function pool<T>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { for (;;) { const i = next++; if (i >= items.length) return; await fn(items[i]!, i); } }));
}
export const percentile = (xs: readonly number[], p: number): number => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] ?? 0; };

// ---------------------------------------------------------------- owner side truth
export const ledgerOf = (opIds: string[]) => ownerRows(`SELECT op_id, status, error_code, result FROM core.sync_operation WHERE op_id = ANY($1::uuid[])`, [opIds]);
export const eventsOf = (opIds: string[]) => ownerRows(`SELECT op_id, kind FROM sync2_test.s5_event WHERE op_id = ANY($1::uuid[])`, [opIds]);
export const receiptNos = async (series: string): Promise<number[]> => (await ownerRows('SELECT no FROM sync2_test.s5_receipt WHERE series = $1 ORDER BY no', [series])).map((r) => Number(r.no));

/** The closed list of core.yaml SyncErrorCode (same source the engine reads). */
export async function closedCodes(): Promise<ReadonlySet<string>> {
  const { loadSpec, REPO_ROOT } = await import('../../../module.js');
  const { join } = await import('node:path');
  return new Set((loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'core.yaml')) as any).components.schemas.SyncErrorCode.enum as string[]);
}
