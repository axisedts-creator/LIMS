// C10 T-18 — cron tasks micro.reconcile_chain_status, micro.refresh_metrics, micro.purge_instrument_records, NO database
// (06-IMPLEMENTATION-PLAN row T-18; 02-TRD §9, §11; 05-SCHEMA §8 purge; 01-PRD AC-17.1, AC-08.12; 07-SECURITY P-6, REQ-SEC-024; 08 A13 P-6, A17 D-65).
// The filters themselves (active, older than 24 h, expires_at, NOT EXISTS, tenant RLS) are proven against the real DDL in chainJobs.live.test.ts;
// this file pins wiring, the control flow around the SQL, the LabPort use, batching, metrics and the tenant guard with a recording tx (helpers/chainJobs.ts).
// Fails now: the three task modules do not exist (the manifest handlers are the T-01 fail-closed stubs).
// SEAMS (spec fixes behaviour, not signatures; same convention as T-06/T-12/T-14):
//   tasks/micro.reconcile_chain_status.ts exports `reconcileChainStatus`, tasks/micro.refresh_metrics.ts `refreshMetrics`, tasks/micro.purge_instrument_records.ts
//   `purgeInstrumentRecords` (TRD §8.2 names), each a TaskHandler `(payload, ctx)`, registered in index.ts under the task identifier (replacing the stub). They open NO transaction:
//   ctx.tx is the per-job transaction under the system claims of ctx.tenantId. Tenant comes from ctx.tenantId only; a payload.tenant_id that differs, or a missing ctx.tenantId, rejects before any I/O.
//   LabPort = ctx.ports.LabPort.getOrderResults(ctx, { orderId, scope: 'all_visible' }) (same as the T-06 consumer); one call per distinct order.
//   Counter/gauge API: ctx.metrics.inc(name, labels, n) / ctx.metrics.set(name, value, labels).
//   Reconcile reads the batch size per run from LIMS_MICRO_RECONCILE_BATCH (default 200) and puts it in the cultures SELECT as LIMIT (literal or bound).
//   The C5 line of a culture = the line of its order item whose moduleRef is micro/<culture id>, else the first line (same rule as M2/M18 labLine).
//   "Submitted version" = current_report_version_no > 0 or has_report (the fake SELECT returns both; the live test seeds both).
//   refresh_metrics issues three SELECTs: cultures GROUP BY status; cultures count(*) of overdue reads (no GROUP BY); instrument_records GROUP BY match_status.
// ASSUMED (flagged so a ruling can overrule): gauges are zero-filled over their whole label domain (a status that emptied must read 0, not keep the last value);
//   `lims_micro_instrument_records_open` covers pending_match, needs_mapping, conflict, late_after_final; a LabPort failure rejects the job (retry, TRD §9: 5 attempts).
// Synthetic data only.
import { afterEach, describe, expect, it } from 'vitest';
import { manifest } from '../../index.js';
import { reconcileChainStatus } from '../../tasks/micro.reconcile_chain_status.js';
import { refreshMetrics } from '../../tasks/micro.refresh_metrics.js';
import { purgeInstrumentRecords } from '../../tasks/micro.purge_instrument_records.js';
import { NOW, SYS, TENANT_A, TENANT_B, culture, makeJob, orderWith, u, type Row, type Stmt } from '../helpers/chainJobs.js';

afterEach(() => { delete process.env['LIMS_MICRO_RECONCILE_BATCH']; });

const TASKS = { 'micro.reconcile_chain_status': reconcileChainStatus, 'micro.refresh_metrics': refreshMetrics, 'micro.purge_instrument_records': purgeInstrumentRecords } as const;
const has = (s: Stmt, x: unknown) => s.params.some((p) => p === x) || (typeof x === 'string' && s.text.includes(`'${x}'`));
const limitOf = (s: Stmt): number | undefined => {
  const m = /LIMIT\s+(?:(\d+)|\$(\d+))/i.exec(s.text.replace(/\s+/g, ' '));
  return m ? Number(m[1] ?? s.params[Number(m[2]) - 1]) : undefined;
};
const cultureUpdates = (j: ReturnType<typeof makeJob>) => j.only(/^UPDATE (micro\.)?cultures\b/i);
const setPart = (s: Stmt) => /\bSET\b(.*?)(?:\bWHERE\b|$)/is.exec(s.text.replace(/\s+/g, ' '))?.[1] ?? '';   // the assignments only: a WHERE may read status / chain_cancelled
const statusSets = (j: ReturnType<typeof makeJob>) => cultureUpdates(j).filter((s) => /(^|[\s,])status\s*=/i.test(setPart(s)));
const transitions = (j: ReturnType<typeof makeJob>) => j.only(/^INSERT INTO (micro\.)?culture_transitions\b/i);

describe('T-18 wiring (P-6)', () => {
  it('the manifest registers the three real handlers (not the T-01 fail-closed stubs) and keeps the crons per_tenant', () => {
    for (const [id, h] of Object.entries(TASKS)) {
      expect(typeof h, id).toBe('function');
      expect(manifest.tasks?.[id], id).toBe(h);
    }
    for (const id of Object.keys(TASKS)) expect(manifest.crontab?.find((c) => c.identifier === id)?.tenantScope, id).toBe('per_tenant');
  });
});

describe.each(Object.entries(TASKS))('T-18 tenant guard: %s (P-6, REQ-SEC-024)', (id, handler) => {
  it('no tenant on the context -> rejects before any statement or port call', async () => {
    const j = makeJob({ cultures: [culture(1)] }, { noTenant: true });
    const r = await j.run(handler);
    expect(r.error, id).toBeDefined();
    expect([j.stmts.length, j.labCalls.length]).toEqual([0, 0]);
  });
  it('a payload for another tenant is refused before any statement or port call (the tenant comes from ctx only)', async () => {
    const j = makeJob({ cultures: [culture(1)] });
    const r = await j.run(handler, { tenant_id: TENANT_B });
    expect(r.error, id).toBeDefined();
    expect([j.stmts.length, j.labCalls.length]).toEqual([0, 0]);
  });
  it('a payload without tenant_id runs under ctx.tenantId; every statement binds that tenant and never the other one', async () => {
    const j = makeJob({ cultures: [culture(1)], byStatus: [{ status: 'incubating', n: 1 }], deletes: [0] });
    const r = await j.run(handler, {});
    expect(r.error, id).toBeUndefined();
    expect(j.stmts.length).toBeGreaterThan(0);
    for (const s of j.stmts) {
      expect(s.params, s.text).toContain(TENANT_A);
      expect(s.params, s.text).not.toContain(TENANT_B);
    }
  });
});

describe('T-18 reconcile_chain_status (AC-17.1)', () => {
  const cancelled = (c: Row) => orderWith(c['order_id'], [{ orderItemId: c['order_item_id'], lines: [{ status: 'cancelled', cultureId: c['id'] }] }]);

  it('C5 line cancelled, no submitted version -> the culture is cancelled with reason order_item_cancelled, a transition row records it, written as the system actor', async () => {
    const c = culture(1);
    const j = makeJob({ cultures: [c], orders: { [c.order_id]: cancelled(c) } });
    expect((await j.run(reconcileChainStatus)).error).toBeUndefined();
    expect(j.labCalls).toEqual([{ orderId: c.order_id, scope: 'all_visible' }]);
    const up = statusSets(j);
    expect(up).toHaveLength(1);
    for (const x of ['cancelled', 'order_item_cancelled', c.id, TENANT_A, SYS]) expect(has(up[0]!, x), `UPDATE must carry ${x}`).toBe(true);
    expect(/chain_cancelled/i.test(setPart(up[0]!))).toBe(false);
    const t = transitions(j);
    expect(t).toHaveLength(1);
    for (const x of [c.id, c.centre_id, 'incubating', 'cancelled', 'order_item_cancelled', TENANT_A, SYS]) expect(has(t[0]!, x), `transition must carry ${x}`).toBe(true);
  });

  it('every open pre-submission status is cancelled the same way (awaiting_setup, incubating, growth_detected); the transition keeps the old status', async () => {
    for (const status of ['awaiting_setup', 'incubating', 'growth_detected']) {
      const c = culture(1, { status });
      const j = makeJob({ cultures: [c], orders: { [c.order_id]: cancelled(c) } });
      await j.run(reconcileChainStatus);
      expect(statusSets(j), status).toHaveLength(1);
      expect(has(transitions(j)[0]!, status), status).toBe(true);
    }
  });

  it('C5 line cancelled but a submitted version exists -> only chain_cancelled = true: no status change, no transition, no cancel reason', async () => {
    for (const row of [{ status: 'final_submitted', current_report_version_no: 2, has_report: true }, { status: 'growth_detected', current_report_version_no: 1, has_report: true }, { status: 'amending', current_report_version_no: 3, has_report: true }]) {
      const c = culture(1, row);
      const j = makeJob({ cultures: [c], orders: { [c.order_id]: cancelled(c) } });
      expect((await j.run(reconcileChainStatus)).error, row.status).toBeUndefined();
      const up = cultureUpdates(j);
      expect(up, row.status).toHaveLength(1);
      expect(/chain_cancelled\s*=\s*(true|\$\d+)/i.test(setPart(up[0]!)), row.status).toBe(true);
      expect(has(up[0]!, c.id)).toBe(true);
      expect(statusSets(j), row.status).toEqual([]);
      expect(j.writes().some((s) => has(s, 'order_item_cancelled')), row.status).toBe(false);
      expect(transitions(j), row.status).toEqual([]);
    }
  });

  it('C5 line not cancelled (pending, resulted, approved, amended) or item absent from the C5 answer -> no write at all', async () => {
    for (const lines of [[{ status: 'pending' }], [{ status: 'resulted' }], [{ status: 'approved' }], [{ status: 'amended' }], []]) {
      const c = culture(1);
      const j = makeJob({ cultures: [c], orders: { [c.order_id]: orderWith(c.order_id, [{ orderItemId: c.order_item_id, lines }]) } });
      expect((await j.run(reconcileChainStatus)).error, JSON.stringify(lines)).toBeUndefined();
      expect(j.writes(), JSON.stringify(lines)).toEqual([]);
    }
    const c = culture(1);
    const gone = makeJob({ cultures: [c], orders: { [c.order_id]: orderWith(c.order_id, [{ orderItemId: u(0xdead), lines: [{ status: 'cancelled' }] }]) } });
    expect((await gone.run(reconcileChainStatus)).error).toBeUndefined();
    expect(gone.writes()).toEqual([]);
  });

  it('one getOrderResults per distinct order (all_visible); each culture reads ITS OWN order item line: a cancelled sibling item does not cancel this culture', async () => {
    const c1 = culture(1, { orderN: 1 }), c2 = culture(2, { orderN: 1 }), c3 = culture(3, { orderN: 3 });
    const j = makeJob({ cultures: [c1, c2, c3], orders: {
      [c1.order_id]: orderWith(c1.order_id, [{ orderItemId: c1.order_item_id, lines: [{ status: 'cancelled', cultureId: c1.id }] }, { orderItemId: c2.order_item_id, lines: [{ status: 'approved', cultureId: c2.id }] }]),
      [c3.order_id]: orderWith(c3.order_id, [{ orderItemId: c3.order_item_id, lines: [{ status: 'pending' }] }]),
    } });
    await j.run(reconcileChainStatus);
    expect(j.labCalls.map((c) => c['orderId']).sort()).toEqual([c1.order_id, c3.order_id].sort());
    expect(j.labCalls.every((c) => c['scope'] === 'all_visible')).toBe(true);
    const up = statusSets(j);
    expect(up).toHaveLength(1);
    expect(has(up[0]!, c1.id)).toBe(true);
    expect(j.writes().some((s) => has(s, c2.id) || has(s, c3.id))).toBe(false);
  });

  it('the line whose moduleRef points at this culture wins over another line of the item (same rule as M2/M18)', async () => {
    const c = culture(1);
    const other = makeJob({ cultures: [c], orders: { [c.order_id]: orderWith(c.order_id, [{ orderItemId: c.order_item_id, lines: [{ status: 'cancelled' }, { status: 'approved', cultureId: c.id }] }]) } });
    await other.run(reconcileChainStatus);
    expect(other.writes()).toEqual([]);
    const mine = makeJob({ cultures: [c], orders: { [c.order_id]: orderWith(c.order_id, [{ orderItemId: c.order_item_id, lines: [{ status: 'approved' }, { status: 'cancelled', cultureId: c.id }] }]) } });
    await mine.run(reconcileChainStatus);
    expect(statusSets(mine)).toHaveLength(1);
  });

  it('the culture SELECT is bounded by LIMS_MICRO_RECONCILE_BATCH (read per run, default 200): no more orders are asked than the batch', async () => {
    const rows = [1, 2, 3, 4, 5].map((n) => culture(n));
    const orders = Object.fromEntries(rows.map((c) => [c.order_id, cancelled(c)]));
    const dflt = makeJob({ cultures: rows, orders });
    await dflt.run(reconcileChainStatus);
    const sel = dflt.only(/^SELECT\b.*\bFROM (micro\.)?cultures\b/i);
    expect(sel.length).toBeGreaterThan(0);
    expect(limitOf(sel[0]!)).toBe(200);

    process.env['LIMS_MICRO_RECONCILE_BATCH'] = '3';
    const j = makeJob({ cultures: rows, orders });
    expect((await j.run(reconcileChainStatus)).error).toBeUndefined();
    expect(limitOf(j.only(/^SELECT\b.*\bFROM (micro\.)?cultures\b/i)[0]!)).toBe(3);
    expect(j.labCalls).toHaveLength(3);
    expect(statusSets(j)).toHaveLength(3);
  });

  it('a LabPort failure rejects the job (it retries) and its message is not logged; an empty world resolves quietly', async () => {
    const c = culture(1);
    const j = makeJob({ cultures: [c], labFails: 'SECRET-LAB-DETAIL' });
    const r = await j.run(reconcileChainStatus);
    expect(r.error).toBeDefined();
    expect(JSON.stringify(j.logs)).not.toContain('SECRET-LAB-DETAIL');
    const empty = makeJob({ cultures: [] });
    expect((await empty.run(reconcileChainStatus)).error).toBeUndefined();
    expect([empty.labCalls.length, empty.writes().length]).toEqual([0, 0]);
  });
});

describe('T-18 refresh_metrics (02-TRD §11)', () => {
  const STATUSES = ['awaiting_setup', 'incubating', 'growth_detected', 'final_submitted', 'amending', 'cancelled'];
  const OPEN = ['pending_match', 'needs_mapping', 'conflict', 'late_after_final'];
  const gauge = (j: ReturnType<typeof makeJob>, name: string) => j.sets.filter((s) => s.name === name);

  it('sets the per-tenant gauges: cultures by status (all six statuses, absent = 0), reads overdue, open instrument records by match_status (four open statuses, absent = 0)', async () => {
    const j = makeJob({ byStatus: [{ status: 'incubating', n: 4 }, { status: 'cancelled', n: 1 }, { status: 'final_submitted', n: 9 }], overdue: 2, openRecords: [{ match_status: 'pending_match', n: 3 }, { match_status: 'conflict', n: 1 }] });
    expect((await j.run(refreshMetrics)).error).toBeUndefined();
    const byStatus = gauge(j, 'lims_micro_cultures_by_status');
    expect(byStatus.map((g) => g.labels['status']).sort()).toEqual([...STATUSES].sort());
    expect(Object.fromEntries(byStatus.map((g) => [g.labels['status'], g.value]))).toEqual({ awaiting_setup: 0, incubating: 4, growth_detected: 0, final_submitted: 9, amending: 0, cancelled: 1 });
    expect(gauge(j, 'lims_micro_reads_overdue').map((g) => [g.value, g.labels])).toEqual([[2, { tenant_id: TENANT_A }]]);
    const open = gauge(j, 'lims_micro_instrument_records_open');
    expect(open.map((g) => g.labels['match_status']).sort()).toEqual([...OPEN].sort());
    expect(Object.fromEntries(open.map((g) => [g.labels['match_status'], g.value]))).toEqual({ pending_match: 3, needs_mapping: 0, conflict: 1, late_after_final: 0 });
  });

  it('labels are exactly the TRD set (tenant_id + status / match_status): no culture, centre or user id as a label', async () => {
    const j = makeJob({ byStatus: [{ status: 'incubating', n: 1 }], overdue: 1, openRecords: [{ match_status: 'conflict', n: 1 }] });
    await j.run(refreshMetrics);
    for (const g of gauge(j, 'lims_micro_cultures_by_status')) expect(Object.keys(g.labels).sort()).toEqual(['status', 'tenant_id']);
    for (const g of gauge(j, 'lims_micro_instrument_records_open')) expect(Object.keys(g.labels).sort()).toEqual(['match_status', 'tenant_id']);
    expect(j.sets.every((g) => g.labels['tenant_id'] === TENANT_A)).toBe(true);
    expect(j.sets.every((g) => Number.isFinite(g.value) && g.value >= 0)).toBe(true);
  });

  it('writes nothing, calls no port and opens no counter: a pure read (the next run supersedes)', async () => {
    const j = makeJob({ byStatus: [{ status: 'incubating', n: 1 }], overdue: 1, openRecords: [] });
    await j.run(refreshMetrics);
    expect(j.writes()).toEqual([]);
    expect(j.labCalls).toEqual([]);
    expect(j.incs).toEqual([]);
  });

  it('a DB failure rejects (no half-written gauges are reported as success)', async () => {
    const j = makeJob({});
    j.ctx.tx.query = async () => { throw new Error('boom'); };
    expect((await j.run(refreshMetrics)).error).toBeDefined();
  });
});

describe('T-18 purge_instrument_records (AC-08.12, D-65)', () => {
  const del = (j: ReturnType<typeof makeJob>) => j.only(/^DELETE\b/i);
  const COUNTER = 'lims_micro_instrument_records_purged_total';
  const purged = (j: ReturnType<typeof makeJob>) => j.incs.filter((i) => i.name === COUNTER).reduce((a, i) => a + i.n, 0);

  it('the DELETE hits micro.instrument_records only, with the tenant bound, expires_at < now() (the DB clock) and the AST-reference guard; it is the only statement', async () => {
    const j = makeJob({ deletes: [3, 0] });
    expect((await j.run(purgeInstrumentRecords)).error).toBeUndefined();
    const d = del(j);
    expect(d.length).toBeGreaterThanOrEqual(1);
    for (const s of d) {
      const t = s.text.replace(/\s+/g, ' ');
      expect(/^DELETE FROM (micro\.)?instrument_records\b/i.test(t), t).toBe(true);
      expect(s.params).toContain(TENANT_A);
      expect(/expires_at\s*<\s*now\(\)/i.test(t), 'expires_at < now()').toBe(true);
      expect(/NOT EXISTS\s*\(\s*SELECT[^)]*FROM (micro\.)?ast_results\b[^)]*instrument_record_id/i.test(t), 'NOT EXISTS ast_results.instrument_record_id').toBe(true);
    }
    expect(j.writes().every((s) => /^DELETE FROM (micro\.)?instrument_records\b/i.test(s.text.replace(/\s+/g, ' ').trim()))).toBe(true);
  });

  it('expiry is decided by the database clock, not by ctx.now() or a JS date (the RLS policy checks expires_at < now() too)', async () => {
    const j = makeJob({ deletes: [0] });
    await j.run(purgeInstrumentRecords);
    for (const s of del(j)) expect(s.params.some((p) => p instanceof Date || p === NOW)).toBe(false);
  });

  it('works in batches of 1,000 (TRD §9): repeats while a batch is full, stops on a short batch, counts every deleted row once under tenant_id', async () => {
    const j = makeJob({ deletes: [1000, 1000, 7] });
    expect((await j.run(purgeInstrumentRecords)).error).toBeUndefined();
    const d = del(j);
    expect(d).toHaveLength(3);
    for (const s of d) expect(limitOf(s), s.text).toBe(1000);
    expect(purged(j)).toBe(2007);
    expect(j.incs.filter((i) => i.name === COUNTER).every((i) => i.labels['tenant_id'] === TENANT_A && Object.keys(i.labels).join() === 'tenant_id')).toBe(true);
  });

  it('a full batch followed by an empty one stops there; nothing to purge = one DELETE and no counter movement', async () => {
    const two = makeJob({ deletes: [1000, 0] });
    await two.run(purgeInstrumentRecords);
    expect(del(two)).toHaveLength(2);
    expect(purged(two)).toBe(1000);
    const none = makeJob({ deletes: [0] });
    await none.run(purgeInstrumentRecords);
    expect(del(none)).toHaveLength(1);
    expect(purged(none)).toBe(0);
  });

  it('a DB refusal (RLS 42501, FK 23503) rejects the job: it is not swallowed and nothing is counted as purged', async () => {
    const j = makeJob({ deleteFails: 'permission denied' });
    const r = await j.run(purgeInstrumentRecords);
    expect(r.error).toBeDefined();
    expect(purged(j)).toBe(0);
  });

  it('logs ids and counts only: no barcode / raw value text reaches a log line', async () => {
    const j = makeJob({ deletes: [5, 0] });
    await j.run(purgeInstrumentRecords);
    expect(JSON.stringify(j.logs)).not.toMatch(/barcode|raw_value|sample_barcode/i);
  });
});
