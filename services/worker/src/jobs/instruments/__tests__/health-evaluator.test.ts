// API-T14 — instruments.evaluate_agent_health (03-APP-FLOW §2.4; 02-TRD §9.1, §10). AC-13.2, AC-13.3, AC-13.4, AC-13.5 + event contract of
// instruments.agent.health_changed.v1 (published through the REAL core publisher, so the JSON schema in contracts/events is enforced).
// Helper contract: see helpers.ts header (agent rows / live-instrument rows / settings rows; ctx.ports.IdentityPort for the tenant timezone).
import { describe, expect, it } from 'vitest';
import { manifest } from '../index.js';
import { AGENT, CENTRE_1, INSTR, T_A, T_B, agentRow, ago, liveInstrument, makeWorld, rejects, SENTINEL, type World } from './helpers.js';

const ID = 'instruments.evaluate_agent_health';
async function run(world: World, tenantId: string = T_A) { await manifest.tasks![ID]!({ tenant_id: tenantId }, world.makeCtx({ tenantId })); }
const published = (w: World) => w.events.filter((e) => e.type === 'instruments.agent.health_changed.v1').map((e) => e.envelope);
const stateWrites = (w: World) => w.writes().filter((s) => /instruments\.agent_status/i.test(s.text));
const transitionRows = (w: World) => w.writes().filter((s) => /INSERT\s+INTO\s+instruments\.agent_health_transitions/i.test(s.text));

describe('AC-13.2 offline', () => {
  it('no heartbeat for > 180 s: state offline, health_version + 1, one event with from/to, one agent_health_transitions row', async () => {
    const w = makeWorld();
    w.agents.push(agentRow(1, { health_state: 'online', health_version: 3, last_heartbeat_at: ago(181), queue_depth: 12, clock_offset_ms: 4000, agent_version: '1.4.0' }));
    await run(w);
    const ev = published(w);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      tenant_id: T_A, producer: 'instruments', aggregate: { type: 'agent', id: AGENT(1), seq: 4 }, idempotency_key: `${AGENT(1)}:health:4`,
      actor: { type: 'system' },
      payload: { agent_id: AGENT(1), centre_id: CENTRE_1, from_state: 'online', to_state: 'offline', agent_version: '1.4.0', queue_depth: 12, clock_offset_seconds: 4 },
    });
    expect(Date.parse(ev[0].payload.last_heartbeat_at)).toBe(Date.parse(ago(181).toISOString()));
    const tr = transitionRows(w);
    expect(tr).toHaveLength(1);
    expect(w.touches(tr[0]!, AGENT(1), 'online', 'offline', 4)).toBe(true);
    const upd = stateWrites(w).filter((s) => /UPDATE/i.test(s.text));
    expect(upd).toHaveLength(1);
    expect(w.touches(upd[0]!, 'offline', 4, AGENT(1))).toBe(true);
    expect(upd[0]!.text).toMatch(/health_state/);
    expect(upd[0]!.text).toMatch(/health_version/);
  });

  it('boundary: exactly 180 s since the heartbeat is still online (strictly greater than 3 intervals)', async () => {
    const w = makeWorld();
    w.agents.push(agentRow(1, { last_heartbeat_at: ago(180) }));
    await run(w);
    expect(published(w)).toHaveLength(0);
    expect(w.writes()).toHaveLength(0);
  });

  it('never-heartbeated agent stays offline silently: no event, no transition, no write (event schema needs last_heartbeat_at)', async () => {
    const w = makeWorld();
    w.agents.push(agentRow(1, { health_state: 'offline', health_version: 1, last_heartbeat_at: null }));
    await run(w);
    expect(published(w)).toHaveLength(0);
    expect(w.writes()).toHaveLength(0);
  });

  it('recovery offline -> online is an event with from_state offline', async () => {
    const w = makeWorld();
    w.agents.push(agentRow(1, { health_state: 'offline', health_version: 5, last_heartbeat_at: ago(10) }));
    await run(w);
    expect(published(w)).toHaveLength(1);
    expect(published(w)[0]).toMatchObject({ aggregate: { seq: 6 }, payload: { from_state: 'offline', to_state: 'online' } });
  });

  it('clock offset is reported in whole seconds and omitted when the agent never reported one', async () => {
    const w = makeWorld();
    w.agents.push(agentRow(1, { health_state: 'offline', health_version: 1, clock_offset_ms: null, last_heartbeat_at: ago(5) }));
    await run(w);
    expect(published(w)[0].payload).not.toHaveProperty('clock_offset_seconds');
  });
});

describe('AC-13.3 backlog', () => {
  it.each([
    ['queue depth 501 > default threshold 500', { queue_depth: 501 }, 'backlog'],
    ['queue depth exactly 500 is not a backlog', { queue_depth: 500 }, null],
    ['oldest pending 901 s > 900 s', { oldest_pending_age_seconds: 901 }, 'backlog'],
    ['oldest pending exactly 900 s is not a backlog', { oldest_pending_age_seconds: 900 }, null],
    ['agent-level threshold 10 overrides the tenant default', { backlog_threshold: 10, queue_depth: 11 }, 'backlog'],
    ['agent-level threshold 10000 raises the bar above the default', { backlog_threshold: 10_000, queue_depth: 600 }, null],
  ])('%s', async (_n, over, to) => {
    const w = makeWorld();
    w.agents.push(agentRow(1, over));
    await run(w);
    if (to === null) { expect(published(w)).toHaveLength(0); return; }
    expect(published(w)).toHaveLength(1);
    expect(published(w)[0].payload).toMatchObject({ from_state: 'online', to_state: 'backlog' });
  });

  it('uses the tenant settings row (threshold 20, oldest 120 s) and falls back to 500 / 900 s when the tenant has no settings row', async () => {
    const a = makeWorld(); a.settings = [{ default_backlog_threshold: 20, backlog_max_oldest_pending_seconds: 120 }];
    a.agents.push(agentRow(1, { queue_depth: 21 }), agentRow(2, { oldest_pending_age_seconds: 121 }), agentRow(3, { queue_depth: 20, oldest_pending_age_seconds: 120 }));
    await run(a);
    expect(published(a).map((e) => e.payload.agent_id).sort()).toEqual([AGENT(1), AGENT(2)]);
    const b = makeWorld(); b.settings = [];
    b.agents.push(agentRow(1, { queue_depth: 501 }), agentRow(2, { queue_depth: 500 }));
    await run(b);
    expect(published(b).map((e) => e.payload.agent_id)).toEqual([AGENT(1)]);
  });
});

describe('AC-13.4 degraded (silent live instruments inside their active hours)', () => {
  // Tenant timezone Asia/Kathmandu: the fixed clock is 17:45 local.
  it('a live instrument silent longer than its window is degraded and listed in silent_instrument_ids', async () => {
    const w = makeWorld();
    w.agents.push(agentRow(1));
    w.instruments.push(liveInstrument(1, 1, { last_message_at: ago(61 * 60), silence_window_minutes: 60 }), liveInstrument(2, 1, { last_message_at: ago(5 * 60), silence_window_minutes: 60 }));
    await run(w);
    expect(published(w)).toHaveLength(1);
    expect(published(w)[0].payload).toMatchObject({ from_state: 'online', to_state: 'degraded', silent_instrument_ids: [INSTR(1)] });
    const tr = transitionRows(w);
    expect(tr).toHaveLength(1);
    expect(w.touches(tr[0]!, INSTR(1), 'degraded')).toBe(true);
  });

  it.each([
    ['inside [from, to): 17:00-18:00', '17:00:00', '18:00:00', true],
    ['outside: 08:00-17:45 (to is exclusive and equals local now)', '08:00:00', '17:45:00', false],
    ['inside: from equals local now 17:45-20:00 (from is inclusive)', '17:45:00', '20:00:00', true],
    ['outside: 18:00-20:00', '18:00:00', '20:00:00', false],
    ['overnight window 22:00-06:00 does not cover 17:45', '22:00:00', '06:00:00', false],
    ['unset hours = all day', null, null, true],
  ])('active hours: %s', async (_n, from, to, silent) => {
    const w = makeWorld();
    w.agents.push(agentRow(1));
    w.instruments.push(liveInstrument(1, 1, { last_message_at: ago(3 * 3600), silence_window_minutes: 60, silence_active_from: from, silence_active_to: to }));
    await run(w);
    expect(published(w)).toHaveLength(silent ? 1 : 0);
  });

  it('never-messaged instrument counts silence from live_at', async () => {
    const w = makeWorld();
    w.agents.push(agentRow(1));
    w.instruments.push(liveInstrument(1, 1, { last_message_at: null, live_at: ago(2 * 3600), silence_window_minutes: 60 }), liveInstrument(2, 1, { last_message_at: null, live_at: ago(10 * 60), silence_window_minutes: 60 }));
    await run(w);
    expect(published(w)[0].payload.silent_instrument_ids).toEqual([INSTR(1)]);
  });

  it('instruments without a silence window, and non-live instruments, are never silent', async () => {
    const w = makeWorld();
    w.agents.push(agentRow(1));
    w.instruments.push(liveInstrument(1, 1, { last_message_at: ago(9 * 3600), silence_window_minutes: null }), liveInstrument(2, 1, { state: 'suspended', last_message_at: ago(9 * 3600) }), liveInstrument(3, 1, { state: 'commissioning', last_message_at: ago(9 * 3600) }));
    await run(w);
    expect(published(w)).toHaveLength(0);
  });
});

describe('AC-13.5 precedence and no-change', () => {
  const silent = () => liveInstrument(1, 1, { last_message_at: ago(5 * 3600), silence_window_minutes: 60 });
  it('offline beats backlog and degraded', async () => {
    const w = makeWorld(); w.agents.push(agentRow(1, { last_heartbeat_at: ago(400), queue_depth: 9999 })); w.instruments.push(silent());
    await run(w);
    expect(published(w)[0].payload).toMatchObject({ to_state: 'offline' });
    expect(published(w)[0].payload.silent_instrument_ids ?? []).toEqual([]);
  });
  it('backlog beats degraded', async () => {
    const w = makeWorld(); w.agents.push(agentRow(1, { queue_depth: 9999 })); w.instruments.push(silent());
    await run(w);
    expect(published(w)[0].payload).toMatchObject({ to_state: 'backlog' });
  });
  it('degraded beats online; clearing the silence returns to online with from_state degraded', async () => {
    const a = makeWorld(); a.agents.push(agentRow(1)); a.instruments.push(silent());
    await run(a);
    expect(published(a)[0].payload.to_state).toBe('degraded');
    const b = makeWorld(); b.agents.push(agentRow(1, { health_state: 'degraded', health_version: 8, silent_instrument_ids: [INSTR(1)] })); b.instruments.push(liveInstrument(1, 1, { last_message_at: ago(30) }));
    await run(b);
    expect(published(b)[0]).toMatchObject({ aggregate: { seq: 9 }, payload: { from_state: 'degraded', to_state: 'online' } });
  });
  it.each(['online', 'offline', 'backlog', 'degraded'] as const)('computed state equal to the stored state (%s) writes nothing and emits nothing', async (state) => {
    const w = makeWorld();
    const over: Record<string, unknown> = { health_state: state };
    if (state === 'offline') over.last_heartbeat_at = ago(900);
    if (state === 'backlog') over.queue_depth = 800;
    if (state === 'degraded') { over.silent_instrument_ids = [INSTR(1)]; w.instruments.push(liveInstrument(1, 1, { last_message_at: ago(5 * 3600) })); }
    w.agents.push(agentRow(1, over));
    await run(w);
    expect(published(w)).toHaveLength(0);
    expect(w.writes()).toHaveLength(0);
  });
  it('degraded -> degraded with a different silent set is still no change (state is what is compared)', async () => {
    const w = makeWorld();
    w.agents.push(agentRow(1, { health_state: 'degraded', silent_instrument_ids: [INSTR(9)] }));
    w.instruments.push(liveInstrument(1, 1, { last_message_at: ago(5 * 3600) }));
    await run(w);
    expect(published(w)).toHaveLength(0);
  });
});

describe('many agents, retired agents, duplicate delivery, failure, tenant binding', () => {
  it('only the agents whose state changed get an event, each with its own idempotency key', async () => {
    const w = makeWorld();
    w.agents.push(agentRow(1), agentRow(2, { last_heartbeat_at: ago(500), health_version: 9 }), agentRow(3, { queue_depth: 600, health_version: 2 }), agentRow(4, { health_state: 'offline', health_version: 1, last_heartbeat_at: null }));
    await run(w);
    expect(published(w).map((e) => e.idempotency_key).sort()).toEqual([`${AGENT(2)}:health:10`, `${AGENT(3)}:health:3`].sort());
    expect(transitionRows(w)).toHaveLength(2);
  });

  it('retired agents are not evaluated', async () => {
    const w = makeWorld();
    w.agents.push(agentRow(1, { status: 'retired', retired_at: ago(86_400), last_heartbeat_at: ago(9999) }));
    await run(w);
    expect(published(w)).toHaveLength(0);
    expect(w.writes()).toHaveLength(0);
  });

  it('duplicate delivery is a no-op: the second run sees the same stale row, derives the same key, the event log keeps ONE event and the task still succeeds', async () => {
    const w = makeWorld();
    w.agents.push(agentRow(1, { last_heartbeat_at: ago(400) }));
    const ctxA = w.makeCtx(); const ctxB = w.makeCtx();
    // one event log shared by both ctx (same tenant) -> the second publish reports duplicate:true
    await manifest.tasks![ID]!({ tenant_id: T_A }, ctxA);
    await expect(manifest.tasks![ID]!({ tenant_id: T_A }, ctxB)).resolves.toBeUndefined();
    expect(published(w)).toHaveLength(1);
  });

  it('a failing publish makes the task reject (the transaction, incl. transition + status update, must roll back, never swallowed)', async () => {
    const w = makeWorld();
    w.agents.push(agentRow(1, { last_heartbeat_at: ago(400) }));
    w.publishError = new Error('event_schema_violation');
    await rejects(run(w));
  });

  it('every instruments.* statement binds the job tenant (REQ-SEC-024) and the task passes the tenant timezone source through IdentityPort', async () => {
    const w = makeWorld();
    w.agents.push(agentRow(1, { last_heartbeat_at: ago(400) }));
    w.instruments.push(liveInstrument(1, 1));
    await run(w);
    for (const s of w.stmts.filter((x) => /instruments\./i.test(x.text) && !/core\.event_log/i.test(x.text))) {
      expect(s.text, s.text).toMatch(/tenant_id/);
      expect(s.claims).toMatchObject({ tenant_id: T_A, actor_type: 'system' });
    }
    expect(w.stmts.some((s) => s.values.includes(T_B))).toBe(false);
  });

  it('never logs agent/instrument identifiers payload beyond ids (no sentinel PHI reaches the logs)', async () => {
    const w = makeWorld();
    w.agents.push(agentRow(1, { last_heartbeat_at: ago(400), agent_version: SENTINEL.slice(0, 30) }));
    await run(w);
    expect(w.logs.text()).not.toContain(SENTINEL.slice(0, 30));
  });
});
