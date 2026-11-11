// Staff agent operations E10-E21 (02-TRD §7.3/§7.5; 01-PRD AC-01.1-01.3, AC-02.1-02.4, AC-16.1-16.3, AC-24.3; 07-SECURITY S-02/S-04/S-06).
// Object-level rule (02-CV §10.1): load through the repo (RLS + tenant predicate) -> 404 if invisible -> assertRole(permission, object centre).
// Tenant and actor come from ctx only. Secrets: the enrolment code exists only in the E14 response; the DB gets its sha256.
import { LimsError, type FieldError } from '../../../core/errors.js';
// [CONV] relative import until @lims/shared-ts is a services/api dependency (same as credentials.service.ts).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { agentNext, type AgentStatus } from '../domain/agent.state.js';
import {
  toAgent, toAgentCommand, toAgentRelease, toAgentSummary, toHealthTransition, toLogBundle,
} from '../mappers/agents.mapper.js';
import { createAgentsRepo, type AgentsRepo, type Row, type Tx } from '../repo/agents.repo.js';
import { generateEnrolmentCode } from './credentials.service.js';

export interface AgentsCtx {
  readonly tenantId: string;
  readonly actor: { readonly type: string; readonly id: string; readonly membershipId?: string };
  readonly requestId?: string;
  readonly tx: unknown;
  readonly now?: () => string | Date;
  readonly ports?: { readonly IdentityPort?: { assertRole(ctx: unknown, r: { permission: string; centreId?: string }): Promise<unknown> } };
  readonly audit?: { access(entry: Record<string, unknown>): Promise<unknown> };
}
export interface Result { status: number; body: any; version?: number }
export type Scope = ReturnType<typeof scope>;

const READ = 'instruments.agent.read';
const MANAGE = 'instruments.agent.manage';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const AGENT_CODE = /^[A-Z0-9-]{2,32}$/;
const CHANNELS = ['stable', 'beta'];
const STATUSES = ['pending_enrolment', 'active', 'revoked', 'retired'];
const HEALTH_STATES = ['online', 'offline', 'backlog', 'degraded'];
const SORTS = ['agent_code', '-last_heartbeat_at'];
const COMMAND_KINDS = ['upload_logs', 'refresh_config', 'restart_service', 'reupload_since'];
const ALL_KINDS = ['device_token', 'enrolment_code'];
const DAY_MS = 24 * 3600 * 1000;
const REUPLOAD_MAX_MS = 72 * 3600 * 1000;               // 02-TRD E17: since >= now - 72 h
const SUPERSEDED_REASON = 'other';                       // [CONV] earlier unused codes revoked on E14 re-issue (seeded g_cs_revoke_reasons)

export const fail = (path: string, code = 'common.field_invalid', message = 'Field invalid'): never => {
  throw new LimsError('common.validation_failed', undefined, [{ path, code, message } satisfies FieldError]);
};
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
export const isInt = (v: unknown, min: number, max: number) => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
export function version(v: unknown): number {
  if (v === undefined || v === null) throw new LimsError('common.precondition_required');
  if (!isInt(v, 1, 2147483647)) fail('/If-Match');
  return v as number;
}
export function limitOf(v: unknown): number {
  const n = v === undefined ? 50 : v;
  if (!isInt(n, 1, 200)) fail('/limit');
  return n as number;
}
export function enumList(v: unknown, allowed: string[], path: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > allowed.length || !v.every((x) => allowed.includes(x))) fail(path);
  return [...new Set(v as string[])];
}
export function cursorOf(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length === 0 || v.length > 512) throw new LimsError('common.invalid_cursor');
  return v;
}
export function scope(ctx: AgentsCtx) {
  if (typeof ctx?.tenantId !== 'string' || !UUID.test(ctx.tenantId) || typeof ctx.actor?.id !== 'string' || typeof ctx.actor?.type !== 'string' || !ctx.tx) {
    throw new LimsError('auth.unauthenticated');
  }
  const assertRole = ctx.ports?.IdentityPort?.assertRole;
  if (typeof assertRole !== 'function') throw new LimsError('common.internal');   // fail closed: no authorisation port
  return {
    tx: ctx.tx as Tx, tenantId: ctx.tenantId, actorId: ctx.actor.id,
    assert: (permission: string, centreId?: string) => assertRole.call(ctx.ports!.IdentityPort, ctx, centreId === undefined ? { permission } : { permission, centreId }),
  };
}
export function page(limit: number, nextCursor?: string) {
  return nextCursor ? { limit, next_cursor: nextCursor } : { limit };
}

export function createAgentsService(deps: { repo?: AgentsRepo; now?: () => Date } = {}) {
  const repo = deps.repo ?? createAgentsRepo();
  const nowMs = (ctx: AgentsCtx): number => new Date(deps.now?.() ?? ctx.now?.() ?? new Date()).getTime();

  /** BOLA: RLS-visible row of the caller's tenant, else 404; then assertRole at the agent's centre. */
  async function loadAgent(s: Scope, agentId: unknown, permission: string): Promise<Row> {
    if (!isUuid(agentId)) throw new LimsError('common.not_found');
    const row = await repo.findAgent(s.tx, s.tenantId, agentId);
    if (!row || row.tenant_id !== s.tenantId) throw new LimsError('common.not_found');
    await s.assert(permission, row.centre_id);
    return row;
  }
  async function reason(s: Scope, code: unknown, text: unknown) {
    if (typeof code !== 'string' || code.length < 1 || code.length > 64 || !(await repo.isRevokeReason(s.tx, code))) fail('/reason_code');
    if (text !== undefined && (typeof text !== 'string' || text.length > 300)) fail('/reason_text');
    return { reasonCode: code as string, ...(typeof text === 'string' ? { reasonText: text } : {}) };
  }
  /** E15/E16 shared tail: status change (version-guarded) THEN credential revocation, one access row per revoked credential. */
  async function transition(ctx: AgentsCtx, s: Scope, agent: Row, v: number, to: AgentStatus, r: { reasonCode: string; reasonText?: string }): Promise<Result> {
    const moved = await repo.transitionAgent(s.tx, s.tenantId, agent.id, v, { status: to, ...r, actorId: s.actorId });
    if (!moved) throw new LimsError('common.version_conflict');
    const revoked = await repo.revokeCredentials(s.tx, s.tenantId, agent.id, { kinds: ALL_KINDS, reasonCode: r.reasonCode, actorId: s.actorId });
    for (const id of revoked) {
      await ctx.audit!.access({ action: 'device_credential.revoke', entityType: 'agent_credential', entityId: id, centreId: agent.centre_id, outcome: 'allowed' });
    }
    const out = (await repo.findAgent(s.tx, s.tenantId, agent.id)) ?? moved;
    return { status: 200, body: toAgent(out), version: out.version };
  }
  function requireAudit(ctx: AgentsCtx) {
    if (typeof ctx.audit?.access !== 'function') throw new LimsError('common.internal');
  }

  return {
    /** E10 — AC-16.1. RLS limits the rows to the caller's centres; a centre filter is asserted at that centre. */
    async listAgents(ctx: AgentsCtx, q: { centreId?: unknown; status?: unknown; healthState?: unknown; sort?: unknown; cursor?: unknown; limit?: unknown }): Promise<Result> {
      const s = scope(ctx);
      if (q?.centreId !== undefined && !isUuid(q.centreId)) fail('/centre_id');
      const status = enumList(q?.status, STATUSES, '/status');
      const healthState = enumList(q?.healthState, HEALTH_STATES, '/health_state');
      if (q?.sort !== undefined && !SORTS.includes(q.sort as string)) fail('/sort');
      const limit = limitOf(q?.limit);
      const cursor = cursorOf(q?.cursor);
      await s.assert(READ, q?.centreId as string | undefined);
      const res = await repo.listAgents(s.tx, s.tenantId, { centreId: q?.centreId, status, healthState, sort: q?.sort ?? 'agent_code', cursor, limit });
      return { status: 200, body: { data: res.rows.filter((r) => r.tenant_id === s.tenantId).map(toAgentSummary), page: page(limit, res.nextCursor) } };
    },

    /** E11 — AC-01.1 / AC-01.2. Asserted at the target centre BEFORE the centre lookup (no existence probe through 400 vs 403). */
    async createAgent(ctx: AgentsCtx, input: { agentCode?: unknown; displayName?: unknown; centreId?: unknown; updateChannel?: unknown; backlogThreshold?: unknown }): Promise<Result> {
      const s = scope(ctx);
      if (typeof input?.agentCode !== 'string' || !AGENT_CODE.test(input.agentCode)) fail('/agent_code');
      if (typeof input.displayName !== 'string' || input.displayName.length < 1 || input.displayName.length > 80) fail('/display_name');
      if (!isUuid(input.centreId)) fail('/centre_id');
      if (input.updateChannel !== undefined && !CHANNELS.includes(input.updateChannel as string)) fail('/update_channel');
      if (input.backlogThreshold !== undefined && !isInt(input.backlogThreshold, 10, 100000)) fail('/backlog_threshold');
      const centreId = input.centreId as string;
      await s.assert(MANAGE, centreId);
      const centre = await repo.getCentre(s.tx, s.tenantId, centreId);
      if (!centre || !centre.is_active || centre.centre_kind === 'home_collection') fail('/centre_id');   // 08 A13 P-1
      const row: Row = {
        id: uuidv7(), centre_id: centreId, agent_code: input.agentCode, display_name: input.displayName,
        update_channel: input.updateChannel ?? 'stable', created_by: s.actorId, updated_by: s.actorId,
        ...(input.backlogThreshold === undefined ? {} : { backlog_threshold: input.backlogThreshold }),
      };
      let created: Row;
      try {
        created = await repo.insertAgent(s.tx, s.tenantId, row);
      } catch (e) {
        if ((e as { code?: unknown })?.code === '23505') throw new LimsError('instruments.code_duplicate');
        throw e;
      }
      return { status: 201, body: toAgent(created), version: created.version };
    },

    /** E12 — AC-16.2 / AC-16.3. */
    async getAgent(ctx: AgentsCtx, input: { agentId?: unknown }): Promise<Result> {
      const s = scope(ctx);
      const row = await loadAgent(s, input?.agentId, READ);
      return { status: 200, body: toAgent(row), version: row.version };
    },

    /** E13. Only the four whitelisted columns ever reach the repo. */
    async updateAgent(ctx: AgentsCtx, input: { agentId?: unknown; expectedVersion?: unknown; patch?: Record<string, unknown> }): Promise<Result> {
      const s = scope(ctx);
      const v = version(input?.expectedVersion);
      const p = input.patch ?? {};
      const cols: Row = {};
      if (p['display_name'] !== undefined) {
        if (typeof p['display_name'] !== 'string' || p['display_name'].length < 1 || p['display_name'].length > 80) fail('/display_name');
        cols['display_name'] = p['display_name'];
      }
      if (p['update_channel'] !== undefined) {
        if (!CHANNELS.includes(p['update_channel'] as string)) fail('/update_channel');
        cols['update_channel'] = p['update_channel'];
      }
      if (p['backlog_threshold'] !== undefined) {
        if (!isInt(p['backlog_threshold'], 10, 100000)) fail('/backlog_threshold');
        cols['backlog_threshold'] = p['backlog_threshold'];
      }
      const unset = p['unset'];
      if (unset !== undefined && (!Array.isArray(unset) || unset.length > 1 || unset.some((x) => x !== 'pinned_release_id'))) fail('/unset');
      const clearPin = Array.isArray(unset) && unset.includes('pinned_release_id');
      if (p['pinned_release_id'] !== undefined) {
        if (clearPin) fail('/unset');
        if (!isUuid(p['pinned_release_id'])) fail('/pinned_release_id');
      }
      if (clearPin) cols['pinned_release_id'] = null;
      if (Object.keys(cols).length === 0 && p['pinned_release_id'] === undefined) fail('/');
      const agent = await loadAgent(s, input.agentId, MANAGE);
      if (agent.status === 'retired') throw new LimsError('instruments.agent_not_active');
      if (agent.version !== v) throw new LimsError('common.version_conflict');
      if (p['pinned_release_id'] !== undefined) {
        const rel = await repo.findRelease(s.tx, p['pinned_release_id'] as string);
        if (!rel || !rel.is_active) throw new LimsError('common.not_found');
        cols['pinned_release_id'] = rel.id;
      }
      const out = await repo.updateAgent(s.tx, s.tenantId, agent.id, v, cols, s.actorId);
      if (!out) throw new LimsError('common.version_conflict');
      return { status: 200, body: toAgent(out), version: out.version };
    },

    /** E14 — AC-01.3 / AC-02.3. Earlier unused codes are revoked; the live device token stays until redemption (A3). */
    async issueEnrolmentCode(ctx: AgentsCtx, input: { agentId?: unknown }): Promise<Result> {
      const s = scope(ctx);
      requireAudit(ctx);
      const agent = await loadAgent(s, input?.agentId, MANAGE);
      if (agent.status === 'retired') throw new LimsError('instruments.agent_not_active');
      // Row lock: two concurrent E14 calls must not both see zero active codes and each insert one.
      const locked = await repo.lockAgent(s.tx, s.tenantId, agent.id);
      if (!locked) throw new LimsError('common.not_found');
      if (locked.status === 'retired') throw new LimsError('instruments.agent_not_active');
      await repo.revokeCredentials(s.tx, s.tenantId, agent.id, { kinds: ['enrolment_code'], reasonCode: SUPERSEDED_REASON, actorId: s.actorId });
      const { token, secretSha256 } = generateEnrolmentCode();
      const credentialId = uuidv7();
      const expiresAt = new Date(nowMs(ctx) + DAY_MS).toISOString();
      await repo.insertCredential(s.tx, s.tenantId, {
        id: credentialId, centre_id: agent.centre_id, agent_id: agent.id, kind: 'enrolment_code', secret_sha256: secretSha256, expires_at: expiresAt, issued_by: s.actorId,
      });
      await ctx.audit!.access({ action: 'device_credential.issue', entityType: 'agent_credential', entityId: credentialId, centreId: agent.centre_id, outcome: 'allowed' });
      return { status: 201, body: { enrolment_code: token, expires_at: expiresAt, credential_id: credentialId } };
    },

    /** E15 — AC-02.1 (A4). */
    async revokeAgent(ctx: AgentsCtx, input: { agentId?: unknown; expectedVersion?: unknown; reasonCode?: unknown; reasonText?: unknown }): Promise<Result> {
      const s = scope(ctx);
      requireAudit(ctx);
      const v = version(input?.expectedVersion);
      const r = await reason(s, input.reasonCode, input.reasonText);
      const agent = await loadAgent(s, input.agentId, MANAGE);
      const to = agentNext(agent.status, 'revoke');
      if (agent.version !== v) throw new LimsError('common.version_conflict');
      return transition(ctx, s, agent, v, to, r);
    },

    /** E16 — AC-02.4 (A6). */
    async retireAgent(ctx: AgentsCtx, input: { agentId?: unknown; expectedVersion?: unknown; reasonCode?: unknown; reasonText?: unknown }): Promise<Result> {
      const s = scope(ctx);
      requireAudit(ctx);
      const v = version(input?.expectedVersion);
      const r = await reason(s, input.reasonCode, input.reasonText);
      const agent = await loadAgent(s, input.agentId, MANAGE);
      agentNext(agent.status, 'retire');                  // table first: retired -> invalid_transition
      if (agent.version !== v) throw new LimsError('common.version_conflict');
      const busy = (await repo.countNonRetiredInstruments(s.tx, s.tenantId, agent.id)) > 0;
      const to = agentNext(agent.status, 'retire', { hasNonRetiredInstruments: busy });
      return transition(ctx, s, agent, v, to, r);
    },

    /** E17 — AC-24.3: expires_at = requested_at + 24 h (the expiry job is API-T14). Only `since` of reupload_since is ever stored. */
    async requestAgentCommand(ctx: AgentsCtx, input: { agentId?: unknown; kind?: unknown; params?: unknown }): Promise<Result> {
      const s = scope(ctx);
      const kind = input?.kind;
      if (typeof kind !== 'string' || !COMMAND_KINDS.includes(kind)) fail('/kind');
      const now = nowMs(ctx);
      let params: Row = {};
      if (kind === 'reupload_since') {
        const since = (input.params as Row | undefined)?.['since'];
        const t = typeof since === 'string' && ISO_UTC.test(since) ? Date.parse(since) : NaN;
        if (!Number.isFinite(t) || t < now - REUPLOAD_MAX_MS || t > now) fail('/params/since');
        params = { since };
      }
      const agent = await loadAgent(s, input.agentId, MANAGE);
      if (agent.status === 'retired') throw new LimsError('instruments.agent_not_active');
      const row = await repo.insertCommand(s.tx, s.tenantId, {
        id: uuidv7(), centre_id: agent.centre_id, agent_id: agent.id, kind, params, requested_by: s.actorId,
        requested_at: new Date(now).toISOString(), expires_at: new Date(now + DAY_MS).toISOString(),
      });
      return { status: 202, body: toAgentCommand(row) };
    },

    /** E18 */
    async listAgentCommands(ctx: AgentsCtx, input: { agentId?: unknown; cursor?: unknown; limit?: unknown }): Promise<Result> {
      const s = scope(ctx);
      const limit = limitOf(input?.limit);
      const cursor = cursorOf(input?.cursor);
      const agent = await loadAgent(s, input?.agentId, READ);
      const res = await repo.listCommands(s.tx, s.tenantId, agent.id, { cursor, limit });
      return { status: 200, body: { data: res.rows.map(toAgentCommand), page: page(limit, res.nextCursor) } };
    },

    /** E19 — AC-16.3 timeline. */
    async listAgentHealthTransitions(ctx: AgentsCtx, input: { agentId?: unknown; changedAtFrom?: unknown; changedAtTo?: unknown; cursor?: unknown; limit?: unknown }): Promise<Result> {
      const s = scope(ctx);
      for (const [k, path] of [['changedAtFrom', '/changed_at_from'], ['changedAtTo', '/changed_at_to']] as const) {
        const val = input?.[k];
        if (val !== undefined && (typeof val !== 'string' || !ISO_UTC.test(val) || Number.isNaN(Date.parse(val)))) fail(path);
      }
      const limit = limitOf(input?.limit);
      const cursor = cursorOf(input?.cursor);
      const agent = await loadAgent(s, input?.agentId, READ);
      const res = await repo.listTransitions(s.tx, s.tenantId, agent.id, { changedAtFrom: input.changedAtFrom, changedAtTo: input.changedAtTo, cursor, limit });
      return { status: 200, body: { data: res.rows.map(toHealthTransition), page: page(limit, res.nextCursor) } };
    },

    /** E20 */
    async getAgentLogBundle(ctx: AgentsCtx, input: { agentId?: unknown; bundleId?: unknown }): Promise<Result> {
      const s = scope(ctx);
      const agent = await loadAgent(s, input?.agentId, MANAGE);
      if (!isUuid(input.bundleId)) throw new LimsError('common.not_found');
      const b = await repo.findLogBundle(s.tx, s.tenantId, agent.id, input.bundleId);
      if (!b || b.agent_id !== agent.id) throw new LimsError('common.not_found');
      return { status: 200, body: toLogBundle(b) };
    },

    /** E21: global reference rows, tenant-wide read permission. */
    async listAgentReleases(ctx: AgentsCtx, input: { channel?: unknown }): Promise<Result> {
      const s = scope(ctx);
      if (input?.channel !== undefined && !CHANNELS.includes(input.channel as string)) fail('/channel');
      await s.assert(READ);
      const rows = await repo.listReleases(s.tx, input?.channel === undefined ? {} : { channel: input.channel as string });
      return { status: 200, body: { data: rows.map(toAgentRelease) } };
    },
  };
}
export type AgentsService = ReturnType<typeof createAgentsService>;
