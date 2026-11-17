// C8 AN-T11 — getInterfacesReport (GET /v1/analytics/reports/interfaces). PRD US-14.1–2, M90 (messages per instrument), M91 (agents by state, live);
// 02-TRD §5 #15 / §5.1 InterfacesReport / §6.8 (labels from instruments.v_pub_instrument_directory, 08 R12d; agents from instruments.v_pub_agent_status);
// 07-SECURITY P1, P4. Repos are in-memory emulators (./helpers.t11.ts).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  A1, A2, ADMIN, AGENT, INSTR, NO_PERM, OWNER_A1, OWNER_MULTI, SENTINEL, WINDOW, call11, contractErrors11, db, expectLims, makeCtx11, ok11, seedT11, t11,
} from './helpers.t11.js';

vi.mock('../../repository/rollups.repo.js', async () => (await import('./helpers.t11.js')).rollupsMockT11);
vi.mock('../../repository/labels.repo.js', async () => (await import('./helpers.t11.js')).labelsRepoMockT11);
vi.mock('../../repository/sourceViews.repo.js', async () => (await import('./helpers.t11.js')).sourceViewsMockT11);

const OP = 'getInterfacesReport' as const;
const MK = ['messages', 'patient_records', 'qc_records', 'unmatched', 'quarantined', 'duplicates'];
const m = (r: any) => Object.fromEntries(MK.map((k) => [k, r[k]]));
const byId = (body: any) => Object.fromEntries(body.instruments.map((r: any) => [r.instrument_id, r]));
const states = (body: any) => Object.fromEntries(body.agents.by_state.map((s: any) => [s.state, s.count]));

beforeEach(() => { seedT11(); vi.clearAllMocks(); });

describe('US-14.1 — messages, patient records, QC, unmatched, quarantined, duplicates per instrument', () => {
  it('one row per instrument summed over the window (CHEM-01 over two days); out-of-window days and tenant B never leak', async () => {
    const body = await ok11(OP, (await makeCtx11(ADMIN)).ctx, WINDOW);
    expect(body.report_code).toBe('interfaces');
    const r = byId(body);
    expect(Object.keys(r).sort()).toEqual([INSTR.CHEM, INSTR.HAE, INSTR.BARE].sort());
    expect(m(r[INSTR.CHEM])).toEqual({ messages: 200, patient_records: 170, qc_records: 23, unmatched: 3, quarantined: 1, duplicates: 3 });
    expect(m(r[INSTR.HAE])).toEqual({ messages: 50, patient_records: 40, qc_records: 10, unmatched: 0, quarantined: 0, duplicates: 0 });
    expect(m(r[INSTR.BARE])).toEqual({ messages: 10, patient_records: 8, qc_records: 2, unmatched: 0, quarantined: 0, duplicates: 0 });
    expect(r[INSTR.CHEM].centre_id).toBe(A1);
    expect(r[INSTR.HAE].centre_id).toBe(A2);
    expect(JSON.stringify(body)).not.toContain(String(SENTINEL));
  });

  it('instrument labels come from the directory view: label contains display_name, instrument_code and is_active are set; inactive instrument flagged', async () => {
    const r = byId(await ok11(OP, (await makeCtx11(ADMIN)).ctx, WINDOW));
    expect(r[INSTR.CHEM].label).toContain('Analyser One');
    expect(r[INSTR.CHEM].instrument_code).toBe('CHEM-01');
    expect(r[INSTR.CHEM].is_active).toBe(true);
    expect(r[INSTR.HAE].label).toContain('Analyser Two');
    expect(r[INSTR.HAE].is_active).toBe(false);
  });

  it('an instrument with no directory row: instrument_code and is_active are omitted; the label is omitted or the short id only (no crash, no tenant B name)', async () => {
    const r = byId(await ok11(OP, (await makeCtx11(ADMIN)).ctx, WINDOW))[INSTR.BARE];
    expect('instrument_code' in r).toBe(false);
    expect('is_active' in r).toBe(false);
    if (r.label !== undefined) expect(r.label).toContain(INSTR.BARE.slice(-8));
    expect(m(r).messages).toBe(10);
  });

  it('empty window → instruments [] but agents (live, not period-bound) are still listed', async () => {
    const body = await ok11(OP, (await makeCtx11(ADMIN)).ctx, { business_date_from: '2030-01-01', business_date_to: '2030-01-08' });
    expect(body.instruments).toEqual([]);
    expect(body.agents.agents).toHaveLength(3);
    expect(contractErrors11(OP, body)).toEqual([]);
  });
});

describe('US-14.2 — agents by state, live from instruments.v_pub_agent_status', () => {
  it('by_state counts and the agent rows (id, centre, state, heartbeat, version, queue depth); tenant B agent absent', async () => {
    const body = await ok11(OP, (await makeCtx11(ADMIN)).ctx, WINDOW);
    expect(states(body)).toEqual({ online: 1, offline: 1, degraded: 1 });
    const a = Object.fromEntries(body.agents.agents.map((x: any) => [x.agent_id, x]));
    expect(Object.keys(a).sort()).toEqual([AGENT.ONLINE, AGENT.OFFLINE, AGENT.DEGRADED].sort());
    expect(a[AGENT.OFFLINE]).toEqual({ agent_id: AGENT.OFFLINE, centre_id: A2, state: 'offline', last_heartbeat_at: '2026-11-05T23:10:00.000Z', agent_version: '1.4.1', queue_depth: 12 });
    expect(a[AGENT.ONLINE]).toMatchObject({ centre_id: A1, state: 'online', queue_depth: 0 });
    expect(JSON.stringify(body)).not.toContain('9.9.9');
  });

  it('by_state counts sum to the number of agent rows', async () => {
    const body = await ok11(OP, (await makeCtx11(ADMIN)).ctx, WINDOW);
    expect(body.agents.by_state.reduce((s: number, x: any) => s + x.count, 0)).toBe(body.agents.agents.length);
  });
});

describe('centre scoping on instruments and agents (07 P4)', () => {
  it('A1-only user: instruments and agents of A1 only; scope echo has empty tenant_wide_sections_hidden', async () => {
    const body = await ok11(OP, (await makeCtx11(OWNER_A1)).ctx, WINDOW);
    expect(Object.keys(byId(body)).sort()).toEqual([INSTR.CHEM, INSTR.BARE].sort());
    expect(body.instruments.every((r: any) => r.centre_id === A1)).toBe(true);
    expect(states(body)).toEqual({ online: 1, degraded: 1 });
    expect(body.agents.agents.every((x: any) => x.centre_id === A1)).toBe(true);
    expect(body.scope).toEqual({ all_centres: false, centre_ids: [A1], tenant_wide_sections_hidden: [] });
    expect(contractErrors11(OP, body)).toEqual([]);
  });

  it('two-centre user sees both centres; admin sees all', async () => {
    expect((await ok11(OP, (await makeCtx11(OWNER_MULTI)).ctx, WINDOW)).instruments).toHaveLength(3);
    expect((await ok11(OP, (await makeCtx11(ADMIN)).ctx, WINDOW)).agents.agents).toHaveLength(3);
  });

  it('centre_id filter: inside scope narrows both sections; outside scope → 404 common.not_found with nothing read', async () => {
    const body = await ok11(OP, (await makeCtx11(ADMIN)).ctx, { ...WINDOW, centre_id: [A2] });
    expect(body.instruments.map((r: any) => r.instrument_id)).toEqual([INSTR.HAE]);
    expect(body.agents.agents.map((x: any) => x.agent_id)).toEqual([AGENT.OFFLINE]);
    db.calls.length = 0;
    await expectLims(call11(OP, (await makeCtx11(OWNER_A1)).ctx, { ...WINDOW, centre_id: [A2] }), 'common.not_found', 404);
    expect(db.calls).toEqual([]);
  });

  it('every repo call (messages and agent status) carries the ctx tenant and the effective scope', async () => {
    const { ctx } = await makeCtx11(OWNER_A1);
    await ok11(OP, ctx, WINDOW);
    expect(db.calls.map((c) => c.fn).sort()).toEqual(['interfaceMessageRows', 'listAgentStatus']);
    for (const c of db.calls) { expect(c.args.tenantId).toBe(ctx.tenantId); expect(c.args.scope).toEqual({ all: false, centreIds: [A1] }); }
  });

  it('agents with a NULL-like/unknown centre cannot appear for a restricted user (agents of tenant B or other centres never leak)', async () => {
    t11.agents.push({ tenantId: t11.agents[0]!.tenantId, agentId: '00000000-0000-4000-8000-0000000000aa', centreId: A2, state: 'online', heartbeat: '2026-11-06T05:00:00.000Z', version: '2.0.0', queue: 1 });
    const text = JSON.stringify(await ok11(OP, (await makeCtx11(OWNER_A1)).ctx, WINDOW));
    expect(text).not.toContain('2.0.0');
  });
});

describe('contract + errors', () => {
  it('200 body validates against InterfacesReport (additionalProperties:false = response allow-list)', async () => {
    expect(contractErrors11(OP, await ok11(OP, (await makeCtx11(ADMIN)).ctx, WINDOW))).toEqual([]);
  });

  it('no analytics.dashboard.read → 403 before any read', async () => {
    const { ctx, touched } = await makeCtx11(NO_PERM);
    await expectLims(call11(OP, ctx, WINDOW), 'auth.forbidden', 403);
    expect(touched).toEqual([]);
    expect(db.calls).toEqual([]);
  });
});
