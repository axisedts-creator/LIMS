// API-T14 — instruments.export_agent_state_metrics (02-TRD §10, §13; AC-13.6; 03-IC X6 / CR-C1-003: names and labels verbatim).
// Platform-scope task: no tenant claims, only the DEFINER app.instruments_agent_state_snapshot() is called.
import { describe, expect, it } from 'vitest';
import { manifest } from '../index.js';
import { AGENT, CENTRE_1, CENTRE_2, T_A, T_B, ago, makeWorld, type World } from './helpers.js';

const ID = 'instruments.export_agent_state_metrics';
const STATES = ['online', 'offline', 'backlog', 'degraded'];
const snap = (n: number, over: Record<string, unknown> = {}) => ({
  tenant_id: T_A, centre_id: CENTRE_1, agent_id: AGENT(n), health_state: 'online', last_heartbeat_at: ago(20), queue_depth: 7, clock_offset_ms: 2500,
  agent_version: '1.4.0', silent_instrument_count: 2, ...over,
});
async function run(w: World) { const ctx = w.makeCtx({ tenantId: undefined }); await manifest.tasks![ID]!({}, ctx); return ctx; }
const val = (w: World, name: string, labels: Record<string, unknown>) => w.metrics.last('set', name, labels)?.value;
const base = (n: number, t = T_A, c = CENTRE_1) => ({ tenant_id: t, centre_id: c, agent_id: AGENT(n) });

describe('AC-13.6 agent gauges', () => {
  it.each(STATES)('lims_instruments_agent_state: current state %s = 1, the other three = 0, all four series present', async (state) => {
    const w = makeWorld(); w.snapshot = [snap(1, { health_state: state })];
    await run(w);
    for (const s of STATES) expect(val(w, 'lims_instruments_agent_state', { ...base(1), state: s }), s).toBe(s === state ? 1 : 0);
    const series = w.metrics.calls.filter((c) => c.kind === 'set' && c.name === 'lims_instruments_agent_state');
    expect(series).toHaveLength(4);
    for (const c of series) expect(Object.keys(c.labels).sort()).toEqual(['agent_id', 'centre_id', 'state', 'tenant_id']);
  });

  it('exports heartbeat timestamp (unix seconds), queue depth, clock offset (ms / 1000), silent instruments and agent_info = 1 with agent_version', async () => {
    const w = makeWorld(); const hb = ago(20); w.snapshot = [snap(1, { last_heartbeat_at: hb })];
    await run(w);
    expect(val(w, 'lims_instruments_agent_last_heartbeat_timestamp_seconds', base(1))).toBeCloseTo(hb.getTime() / 1000, 0);
    expect(val(w, 'lims_instruments_agent_queue_depth', base(1))).toBe(7);
    expect(val(w, 'lims_instruments_agent_clock_offset_seconds', base(1))).toBe(2.5);
    expect(val(w, 'lims_instruments_agent_silent_instruments', base(1))).toBe(2);
    expect(val(w, 'lims_instruments_agent_info', { ...base(1), agent_version: '1.4.0' })).toBe(1);
    const info = w.metrics.calls.find((c) => c.name === 'lims_instruments_agent_info')!;
    expect(Object.keys(info.labels).sort()).toEqual(['agent_id', 'agent_version', 'centre_id', 'tenant_id']);
  });

  it('heartbeat timestamp is ABSENT while the agent never heartbeated (state series still present)', async () => {
    const w = makeWorld(); w.snapshot = [snap(1, { last_heartbeat_at: null, health_state: 'offline' })];
    await run(w);
    expect(w.metrics.calls.some((c) => c.name === 'lims_instruments_agent_last_heartbeat_timestamp_seconds')).toBe(false);
    expect(val(w, 'lims_instruments_agent_state', { ...base(1), state: 'offline' })).toBe(1);
  });

  it('every agent of every tenant gets its own labelled series (two tenants, two centres)', async () => {
    const w = makeWorld(); w.snapshot = [snap(1), snap(2, { tenant_id: T_B, centre_id: CENTRE_2, health_state: 'backlog' })];
    await run(w);
    expect(val(w, 'lims_instruments_agent_state', { ...base(1), state: 'online' })).toBe(1);
    expect(val(w, 'lims_instruments_agent_state', { ...base(2, T_B, CENTRE_2), state: 'backlog' })).toBe(1);
    expect(val(w, 'lims_instruments_agent_state', { ...base(2, T_B, CENTRE_2), state: 'online' })).toBe(0);
  });

  it('metric names are exactly the C1 names (no invented lims_instruments_agent_* series)', async () => {
    const w = makeWorld(); w.snapshot = [snap(1)];
    await run(w);
    const allowed = new Set(['lims_instruments_agent_state', 'lims_instruments_agent_last_heartbeat_timestamp_seconds', 'lims_instruments_agent_queue_depth',
      'lims_instruments_agent_clock_offset_seconds', 'lims_instruments_agent_silent_instruments', 'lims_instruments_agent_info']);
    for (const c of w.metrics.calls) expect(allowed.has(c.name), c.name).toBe(true);
    expect(w.metrics.calls.some((c) => c.name === 'lims_instruments_agent_last_heartbeat_age_seconds')).toBe(false);   // removed by CR-C1-003
  });
});

describe('platform scope', () => {
  it('runs without tenant claims and issues exactly one statement: the inventoried DEFINER (no table reads, no writes)', async () => {
    const w = makeWorld(); w.snapshot = [snap(1)];
    await run(w);
    expect(w.stmts).toHaveLength(1);
    expect(w.stmts[0]!.text).toMatch(/app\.instruments_agent_state_snapshot\s*\(/);
    expect(w.stmts[0]!.claims).toBeUndefined();
    expect(w.writes()).toHaveLength(0);
  });
  it('an empty snapshot is fine', async () => {
    const w = makeWorld(); await expect(run(w)).resolves.toBeDefined();
  });
});
