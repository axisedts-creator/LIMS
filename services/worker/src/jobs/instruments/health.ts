// instruments.evaluate_agent_health (03-APP-FLOW §2.4; 02-TRD §9.1, §10; AC-13.2–13.5) and
// instruments.export_agent_state_metrics (02-TRD §10, §13; AC-13.6).
import { uuidv7 } from '../../../../../packages/shared-ts/src/uuidv7/index.js';
import { evaluateHealth, type LiveInstrumentHealthInput } from '../../../../api/src/modules/instruments/domain/health.js';
import { iso, jobTenant, type Ctx } from './shared.js';

const EVENT = 'instruments.agent.health_changed.v1';
const DEFAULT_BACKLOG = 500;                // 02-TRD §11 instruments.settings defaults (no settings row yet)
const DEFAULT_MAX_OLDEST_S = 900;
const MAX_EVENT_SILENT_IDS = 50;            // event schema maxItems

const SETTINGS_SQL = 'SELECT default_backlog_threshold, backlog_max_oldest_pending_seconds FROM instruments.settings WHERE tenant_id = $1';
const AGENTS_SQL = `SELECT s.agent_id, s.centre_id, s.health_state, s.health_version, s.last_heartbeat_at, s.agent_version,
    s.queue_depth, s.oldest_pending_age_seconds, s.clock_offset_ms, a.backlog_threshold
  FROM instruments.agent_status s JOIN instruments.agents a ON a.tenant_id = s.tenant_id AND a.id = s.agent_id
  WHERE s.tenant_id = $1 AND a.status <> 'retired'
  FOR UPDATE OF s`;
const LIVE_SQL = `SELECT i.id AS instrument_id, i.agent_id, i.live_at, i.silence_window_minutes, i.silence_active_from, i.silence_active_to, st.last_message_at
  FROM instruments.instruments i
  LEFT JOIN instruments.instrument_status st ON st.tenant_id = i.tenant_id AND st.instrument_id = i.id
  WHERE i.tenant_id = $1 AND i.state = 'live' AND i.silence_window_minutes IS NOT NULL`;
const TRANSITION_SQL = `INSERT INTO instruments.agent_health_transitions
  (id, tenant_id, centre_id, agent_id, health_version, from_state, to_state, changed_at, last_heartbeat_at, queue_depth,
   clock_offset_seconds, silent_instrument_ids, event_id, created_by)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`;
const STATUS_SQL = `UPDATE instruments.agent_status
  SET health_state = $3, health_version = $4, state_changed_at = $5, silent_instrument_ids = $6, updated_at = $5, updated_by = $7
  WHERE tenant_id = $1 AND agent_id = $2 AND health_version = $8`;

export async function evaluateAgentHealth(payload: { tenant_id?: unknown }, ctx: Ctx): Promise<void> {
  const tenantId = jobTenant(payload, ctx);
  const q = (sql: string, v: unknown[]) => ctx.tx.query(sql, v) as Promise<{ rows: any[]; rowCount?: number }>;
  const agents = (await q(AGENTS_SQL, [tenantId])).rows;
  if (agents.length === 0) return;
  const settings = (await q(SETTINGS_SQL, [tenantId])).rows[0];
  const live = (await q(LIVE_SQL, [tenantId])).rows;
  const { timezone } = await ctx.ports.IdentityPort.getTenantSettings(ctx, { keys: ['timezone'] });
  const byAgent = new Map<string, LiveInstrumentHealthInput[]>();
  for (const i of live) {
    if (i.silence_window_minutes === null || i.silence_window_minutes === undefined) continue;
    const list = byAgent.get(i.agent_id) ?? [];
    list.push({ id: i.instrument_id, liveAt: iso(i.live_at)!, lastMessageAt: iso(i.last_message_at), silenceWindowMinutes: i.silence_window_minutes,
      silenceActiveFrom: i.silence_active_from ?? null, silenceActiveTo: i.silence_active_to ?? null });
    byAgent.set(i.agent_id, list);
  }
  const now = ctx.now();
  let changed = 0;
  for (const a of agents) {
    // never heartbeated: stays offline silently (the event needs last_heartbeat_at; 03-APP-FLOW §2.4)
    if (a.last_heartbeat_at === null || a.last_heartbeat_at === undefined) continue;
    const lastHb = iso(a.last_heartbeat_at)!;
    const { state, silentInstrumentIds } = evaluateHealth({
      lastHeartbeatAt: lastHb, queueDepth: a.queue_depth, oldestPendingAgeSeconds: a.oldest_pending_age_seconds,
      backlogThreshold: a.backlog_threshold ?? settings?.default_backlog_threshold ?? DEFAULT_BACKLOG,
      maxOldestPendingSeconds: settings?.backlog_max_oldest_pending_seconds ?? DEFAULT_MAX_OLDEST_S,
      tenantTimezone: timezone, liveInstruments: byAgent.get(a.agent_id) ?? [],
    }, now);
    if (state === a.health_state) continue;
    const version = a.health_version + 1;
    const clock = a.clock_offset_ms === null || a.clock_offset_ms === undefined ? undefined : Math.round(a.clock_offset_ms / 1000);
    const published = await ctx.events.publish(ctx, EVENT, {
      aggregate: { type: 'agent', id: a.agent_id, seq: version }, idempotencyKey: `${a.agent_id}:health:${version}`,
      payload: {
        agent_id: a.agent_id, centre_id: a.centre_id, from_state: a.health_state, to_state: state, last_heartbeat_at: lastHb,
        agent_version: a.agent_version ?? '', queue_depth: a.queue_depth, ...(clock === undefined ? {} : { clock_offset_seconds: clock }),
        silent_instrument_ids: silentInstrumentIds.slice(0, MAX_EVENT_SILENT_IDS),
      },
    });
    if (published.duplicate) continue;                 // an earlier delivery already applied this transition
    await q(TRANSITION_SQL, [uuidv7(), tenantId, a.centre_id, a.agent_id, version, a.health_state, state, now, lastHb, a.queue_depth,
      clock ?? null, silentInstrumentIds, published.eventId, ctx.actor.id]);
    const upd = await q(STATUS_SQL, [tenantId, a.agent_id, state, version, now, silentInstrumentIds, ctx.actor.id, a.health_version]);
    if (upd.rowCount === 0) throw new Error('evaluate_agent_health: agent_status changed concurrently');
    changed += 1;
  }
  ctx.log.info('instruments.evaluate_agent_health', { agents: agents.length, changed });
}

const STATES = ['online', 'offline', 'backlog', 'degraded'] as const;
const SNAPSHOT_SQL = `SELECT tenant_id, centre_id, agent_id, health_state, last_heartbeat_at, queue_depth, clock_offset_ms, agent_version, silent_instrument_count
  FROM app.instruments_agent_state_snapshot()`;

/** Platform scope: the only statement is the inventoried DEFINER (no tenant claims, no table reads). */
export async function exportAgentStateMetrics(_payload: unknown, ctx: Ctx): Promise<void> {
  const { rows } = await ctx.tx.query(SNAPSHOT_SQL);
  const m = ctx.metrics;
  for (const r of rows) {
    const base = { tenant_id: r.tenant_id, centre_id: r.centre_id, agent_id: r.agent_id };
    for (const s of STATES) m.set('lims_instruments_agent_state', s === r.health_state ? 1 : 0, { ...base, state: s });
    if (r.last_heartbeat_at !== null && r.last_heartbeat_at !== undefined) {
      m.set('lims_instruments_agent_last_heartbeat_timestamp_seconds', new Date(r.last_heartbeat_at).getTime() / 1000, base);
    }
    m.set('lims_instruments_agent_queue_depth', Number(r.queue_depth), base);
    if (r.clock_offset_ms !== null && r.clock_offset_ms !== undefined) m.set('lims_instruments_agent_clock_offset_seconds', r.clock_offset_ms / 1000, base);
    m.set('lims_instruments_agent_silent_instruments', Number(r.silent_instrument_count ?? 0), base);
    if (r.agent_version) m.set('lims_instruments_agent_info', 1, { ...base, agent_version: r.agent_version });
  }
}
