// E03 submitAgentHeartbeat + E07 submitAgentLogBundle (02-TRD §7.2/§7.4; 03-APP-FLOW §2.4/§2.5; 01-PRD AC-13.1, AC-24.1, AC-24.3; 07-SECURITY S-01/S-02/S-05).
// The heartbeat never writes health_state (single writer = evaluator, API-T14); it returns the stored state.
import { LimsError } from '../../../core/errors.js';
// [CONV] relative import until @lims/shared-ts is a services/api dependency (same as agents.service.ts).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { Row } from '../repo/agents.repo.js';
import { createDeviceRepo, type DeviceRepo } from '../repo/device.repo.js';
import { isUuid } from './agents.service.js';
import { activeAgent, clock, deviceScope, iso, type DeviceCtx, type DeviceResult } from './enrolment.service.js';

const obj = (v: unknown): Row => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Row) : {});
const n = (v: unknown) => (Number.isSafeInteger(v) ? (v as number) : null);
const s = (v: unknown) => (typeof v === 'string' ? v : null);

/** Heartbeat body (snake_case, schema-validated by the core) -> heartbeat-owned agent_status columns. */
function statusColumns(b: Row, nowIso: string, clientIp: string | undefined): Row {
  const q = obj(b['queue']), cfg = obj(b['config']), upd = obj(b['update']);
  return {
    last_heartbeat_at: nowIso,                            // server clock: an agent clock cannot fake liveness
    agent_version: s(b['agent_version']), launcher_version: s(b['launcher_version']), os_version: s(b['os_version']),
    queue_depth: (n(q['pending']) ?? 0) + (n(q['uploading']) ?? 0),   // [CONV] depth = not yet uploaded (pending + uploading)
    oldest_pending_age_seconds: n(q['oldest_pending_age_seconds']) ?? 0, queue_rejected: n(q['rejected']) ?? 0, queue_oversize: n(q['oversize']) ?? 0,
    disk_free_mb: n(b['disk_free_mb']), clock_offset_ms: n(b['clock_offset_ms']), clock_offset_uncertainty_ms: n(b['clock_offset_uncertainty_ms']),
    config_version_applied: n(cfg['applied_version']), config_state: s(cfg['state']),
    update_state: s(upd['state']), update_target_version: s(upd['target_version']), update_error_code: s(upd['error_code']),
    auth_state: s(b['auth_state']), last_ip: clientIp ?? null, counters: obj(b['counters']),
  };
}

export function createHeartbeatService(deps: { repo?: DeviceRepo; now?: () => Date } = {}) {
  const repo = deps.repo ?? createDeviceRepo();
  return {
    /** E03 — record, apply command results (idempotent), then deliver every unexpired queued|delivered command. */
    async submitAgentHeartbeat(ctx: DeviceCtx, input: { body?: unknown }): Promise<DeviceResult> {
      const sc = deviceScope(ctx, 'device_token');
      const body = obj(input?.body);
      const agent = await activeAgent(repo, sc);
      const nowIso = new Date(clock(deps, ctx)).toISOString();
      await repo.recordHeartbeat(sc.tx, sc.tenantId, agent.id, statusColumns(body, nowIso, ctx.clientIp));
      for (const r of Array.isArray(body['command_results']) ? body['command_results'] : []) {
        const x = obj(r);
        if (!isUuid(x['command_id']) || (x['state'] !== 'completed' && x['state'] !== 'failed')) continue;
        const resultCode = typeof x['result_code'] === 'string' ? x['result_code'] : undefined;
        // false = unknown / foreign / not delivered / already finished: ignored, the agent retries by command_id
        await repo.completeCommand(sc.tx, sc.tenantId, agent.id, x['command_id'], { state: x['state'], nowIso, ...(resultCode ? { resultCode } : {}) });
      }
      const cmds = await repo.claimCommands(sc.tx, sc.tenantId, agent.id, nowIso);
      return {
        status: 200,
        body: {
          server_time: nowIso, latest_config_version: agent.latest_config_version, health_state: agent.health?.health_state ?? 'offline',
          commands: cmds.filter((c) => c.agent_id === agent.id).map((c) => ({ command_id: c.id, kind: c.kind, params: c.params ?? {}, expires_at: iso(c.expires_at) })),
        },
      };
    },

    /** E07 — answer to a delivered, unexpired upload_logs command of this agent. */
    async submitAgentLogBundle(ctx: DeviceCtx, input: { body?: unknown }): Promise<DeviceResult> {
      const sc = deviceScope(ctx, 'device_token');
      const b = obj(input?.body);
      const agent = await activeAgent(repo, sc);
      const now = clock(deps, ctx);
      if (!isUuid(b['command_id'])) throw new LimsError('common.not_found');
      const cmd = await repo.findCommand(sc.tx, sc.tenantId, agent.id, b['command_id']);
      if (!cmd || cmd.agent_id !== agent.id || (cmd.tenant_id !== undefined && cmd.tenant_id !== sc.tenantId)) throw new LimsError('common.not_found');
      if (cmd.state !== 'delivered' || !(new Date(cmd.expires_at).getTime() > now)) throw new LimsError('instruments.invalid_transition');
      const lines = b['lines'];
      if (!Array.isArray(lines) || !lines.every((l) => typeof l === 'string')) throw new LimsError('common.validation_failed');
      const { id } = await repo.insertLogBundle(sc.tx, sc.tenantId, {
        id: uuidv7(), centre_id: agent.centre_id, agent_id: agent.id, command_id: cmd.id, lines, from_at_agent: b['from_at_agent'], to_at_agent: b['to_at_agent'],
        size_bytes: lines.reduce((t: number, l: string) => t + Buffer.byteLength(l, 'utf8'), 0), created_by: agent.id,
      });
      return { status: 201, body: { bundle_id: id } };
    },
  };
}
export type HeartbeatService = ReturnType<typeof createHeartbeatService>;
