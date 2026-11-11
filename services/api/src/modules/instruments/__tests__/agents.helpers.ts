// C7 API-T04 test helpers (not a test file). Synthetic data only. Fixes the SEAMS the spec leaves open (writer must match, or raise a dispute):
//
//   ../repo/agents.repo.ts            exports `AgentsRepo` (interface below) + `createAgentsRepo(): AgentsRepo` (SQL on the request tx; explicit tenant predicate on
//                                     every statement; never selects/returns `secret_sha256` — column grant CR-C7-006). Tests inject FakeRepo instead.
//   ../service/agents.service.ts      exports `createAgentsService(deps?: { repo?: AgentsRepo; now?: () => Date })` -> one async method per operationId E10-E21
//                                     `listAgents|createAgent|getAgent|updateAgent|issueEnrolmentCode|revokeAgent|retireAgent|requestAgentCommand|listAgentCommands|
//                                      listAgentHealthTransitions|getAgentLogBundle|listAgentReleases` taking `(ctx, input)`; each returns `{ status, body, version? }`.
//                                     ctx = { tenantId, actor{type,id,membershipId?}, requestId, tx, ports:{ IdentityPort:{ assertRole(ctx,{permission,centreId?}) } },
//                                             audit:{ access(entry) }, now?: () => string|Date }.
//   ../mappers/agents.mapper.ts       exports toAgent, toAgentSummary, toAgentCredential, toAgentCommand, toHealthTransition, toAgentRelease, toLogBundle (pure, row -> DTO).
//   ../handlers/<operationId>.ts      (or one file) replace the 12 stubs in handlers/index.ts; handlers call `createAgentsService()` and map req -> input, ETag = `"<version>"`.
//
// Service inputs (camelCase; ids are validated uuid strings): listAgents{centreId?,status?:string[],healthState?:string[],sort?,cursor?,limit?} · createAgent{agentCode,displayName,
// centreId,updateChannel?,backlogThreshold?} · getAgent{agentId} · updateAgent{agentId,expectedVersion:number|undefined,patch:{display_name?,update_channel?,pinned_release_id?,
// backlog_threshold?,unset?:string[]}} · issueEnrolmentCode{agentId} · revokeAgent/retireAgent{agentId,expectedVersion,reasonCode,reasonText?} · requestAgentCommand{agentId,kind,params?} ·
// listAgentCommands{agentId,cursor?,limit?} · listAgentHealthTransitions{agentId,changedAtFrom?,changedAtTo?,cursor?,limit?} · getAgentLogBundle{agentId,bundleId} · listAgentReleases{channel?}.
// expectedVersion undefined -> 428 common.precondition_required; mismatch -> 409 common.version_conflict.
import { createHash } from 'node:crypto';
import { LimsError } from '../../../core/errors.js';
import { access } from '../../../core/audit/access.js';

export const idN = (n: number) => `0190a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
export const TENANT_A = idN(0xa1), TENANT_B = idN(0xb1);
export const CENTRE_A1 = idN(0xc1), CENTRE_A2 = idN(0xc2), CENTRE_HOME = idN(0xc3), CENTRE_INACTIVE = idN(0xc4), CENTRE_FRANCHISE = idN(0xc5);
export const USER = idN(0xd1), MEM = idN(0xd2), REQ_ID = idN(0xe1);
export const NOW = '2026-11-07T12:00:00.000Z';
export const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest();
export const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
export const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, got success'); };
export const forbidden = () => new LimsError('auth.forbidden');

export type Row = Record<string, any>;
export interface AgentsRepo {
  getCentre(tx: any, tenantId: string, centreId: string): Promise<{ id: string; centre_kind: string; is_active: boolean } | undefined>;
  insertAgent(tx: any, tenantId: string, row: Row): Promise<Row>;                       // duplicate (tenant_id, agent_code) -> throws { code: '23505' }
  findAgent(tx: any, tenantId: string, agentId: string): Promise<Row | undefined>;       // agents cols + `health` (agent_status row|null) + `credentials` (credential rows) ; RLS-invisible -> undefined
  listAgents(tx: any, tenantId: string, q: Row): Promise<{ rows: Row[]; nextCursor?: string }>;
  findRelease(tx: any, releaseId: string): Promise<{ id: string; channel: string; is_active: boolean } | undefined>;
  listReleases(tx: any, q: { channel?: string }): Promise<Row[]>;
  isRevokeReason(tx: any, code: string): Promise<boolean>;
  updateAgent(tx: any, tenantId: string, agentId: string, expectedVersion: number, patch: Row): Promise<Row | undefined>;   // undefined = version mismatch
  transitionAgent(tx: any, tenantId: string, agentId: string, expectedVersion: number, o: { status: string; reasonCode?: string; reasonText?: string; actorId: string }): Promise<Row | undefined>;
  revokeCredentials(tx: any, tenantId: string, agentId: string, o: { kinds: string[]; reasonCode: string; actorId: string }): Promise<string[]>;   // revoked credential ids
  insertCredential(tx: any, tenantId: string, row: Row): Promise<void>;                  // { id, centre_id, agent_id, kind, secret_sha256, expires_at, issued_by }
  countNonRetiredInstruments(tx: any, tenantId: string, agentId: string): Promise<number>;
  insertCommand(tx: any, tenantId: string, row: Row): Promise<Row>;
  listCommands(tx: any, tenantId: string, agentId: string, q: Row): Promise<{ rows: Row[]; nextCursor?: string }>;
  listTransitions(tx: any, tenantId: string, agentId: string, q: Row): Promise<{ rows: Row[]; nextCursor?: string }>;
  findLogBundle(tx: any, tenantId: string, agentId: string, bundleId: string): Promise<Row | undefined>;
}

// ---------------------------------------------------------------------------------------------------- fixtures
export const SECRET_HEX = 'deadbeef'.repeat(8);          // planted: must never appear in any DTO
export const credRow = (o: Row = {}): Row => ({
  id: idN(0x5000 + Math.floor(Math.random() * 0xfff)), tenant_id: TENANT_A, centre_id: CENTRE_A1, kind: 'device_token', status: 'active',
  secret_sha256: Buffer.from(SECRET_HEX, 'hex'), issued_at: '2026-11-01T08:00:00.000Z', issued_by: USER, issued_by_display: 'Synthetic Manager',
  last_used_at: '2026-11-07T11:59:00.000Z', ...o,
});
export const statusRow = (o: Row = {}): Row => ({
  health_state: 'online', health_version: 3, last_heartbeat_at: '2026-11-07T11:59:30.000Z', agent_version: '1.2.3', launcher_version: '1.0.0', os_version: 'Windows 11 24H2',
  queue_depth: 4, oldest_pending_age_seconds: 12, queue_rejected: 0, queue_oversize: 0, disk_free_mb: 51200, clock_offset_ms: 1500, clock_offset_uncertainty_ms: 50,
  config_version_applied: 1, config_state: 'ok', update_state: 'idle', update_target_version: null, auth_state: 'ok', last_ip: '203.0.113.7', last_ip_changed_at: '2026-11-02T00:00:00.000Z', ...o,
});
export const agentRow = (o: Row = {}): Row => ({
  id: idN(0x1000), tenant_id: TENANT_A, centre_id: CENTRE_A1, agent_code: 'HUB-PC-01', display_name: 'Hub PC 1', status: 'active', update_channel: 'stable',
  pinned_release_id: null, backlog_threshold: 100, enrolled_at: '2026-11-01T09:00:00.000Z', host_fingerprint_sha256: 'a'.repeat(64), revoked_at: null, revoked_by: null,
  revoke_reason_code: null, revoke_reason_text: null, retired_at: null, retired_by: null, latest_config_version: 1, version: 1, is_active: true,
  created_at: '2026-11-01T08:00:00.000Z', updated_at: '2026-11-01T09:00:00.000Z', created_by: USER, updated_by: USER,
  health: statusRow(), credentials: [credRow({ id: idN(0x5001) })], ...o,
});
export const releaseRow = (o: Row = {}): Row => ({
  id: idN(0x7001), version: '1.2.3', channel: 'stable', package_file_name: 'bridge-agent-1.2.3.msi', package_sha256: 'b'.repeat(64), package_size: 12345678,
  signature: 'SIGNATURE-PLANTED-BASE64==', key_id: 'k1', authenticode_publisher: 'CN=Synthetic Publisher', min_windows_build: 19045, released_at: '2026-10-01T00:00:00.000Z',
  is_active: true, notes: 'Synthetic notes', created_at: '2026-10-01T00:00:00.000Z', ...o,
});
export const commandRow = (o: Row = {}): Row => ({
  id: idN(0x8001), tenant_id: TENANT_A, centre_id: CENTRE_A1, agent_id: idN(0x1000), kind: 'upload_logs', params: {}, state: 'queued', requested_by: USER,
  requested_by_display: 'Synthetic Manager', requested_at: NOW, delivered_at: null, completed_at: null, result_code: null, expires_at: '2026-11-08T12:00:00.000Z',
  log_bundle_id: null, version: 1, ...o,
});
export const transitionRow = (o: Row = {}): Row => ({
  id: idN(0x9001), tenant_id: TENANT_A, centre_id: CENTRE_A1, agent_id: idN(0x1000), health_version: 2, from_state: 'offline', to_state: 'online',
  changed_at: '2026-11-07T10:00:00.000Z', last_heartbeat_at: '2026-11-07T10:00:00.000Z', queue_depth: 0, clock_offset_seconds: 1, silent_instrument_ids: [], event_id: idN(0x9f01),
  created_at: NOW, created_by: USER, ...o,
});
export const bundleRow = (o: Row = {}): Row => ({
  id: idN(0xb001), tenant_id: TENANT_A, centre_id: CENTRE_A1, agent_id: idN(0x1000), command_id: idN(0x8001), lines: ['line one', 'line two'], from_at_agent: '2026-11-07T10:00:00.000Z',
  to_at_agent: '2026-11-07T11:00:00.000Z', size_bytes: 17, created_at: NOW, created_by: USER, ...o,
});

// ---------------------------------------------------------------------------------------------------- fake repo (in-memory, tenant-aware like RLS + explicit predicate)
export interface FakeSeed { agents?: Row[]; centres?: Row[]; releases?: Row[]; commands?: Row[]; transitions?: Row[]; bundles?: Row[]; instruments?: Array<{ tenant_id: string; agent_id: string; state: string }>; revokeReasons?: string[] }
export function makeRepo(seed: FakeSeed = {}) {
  const agents = (seed.agents ?? []).map((r) => ({ ...r }));
  const centres: Row[] = seed.centres ?? [
    { id: CENTRE_A1, centre_kind: 'own', is_active: true }, { id: CENTRE_A2, centre_kind: 'own', is_active: true }, { id: CENTRE_FRANCHISE, centre_kind: 'franchise', is_active: true },
    { id: CENTRE_HOME, centre_kind: 'home_collection', is_active: true }, { id: CENTRE_INACTIVE, centre_kind: 'own', is_active: false },
  ];
  const releases = seed.releases ?? [releaseRow(), releaseRow({ id: idN(0x7002), version: '1.3.0', channel: 'beta' }), releaseRow({ id: idN(0x7003), version: '1.0.0', is_active: false })];
  const commands = (seed.commands ?? []).map((r) => ({ ...r }));
  const transitions = seed.transitions ?? [];
  const bundles = seed.bundles ?? [];
  const instruments = seed.instruments ?? [];
  const reasons = seed.revokeReasons ?? ['device_replaced', 'device_lost_or_stolen', 'suspected_compromise', 'decommissioned', 'staff_error', 'other'];
  const credentials = () => agents.flatMap((a) => a.credentials as Row[]);
  const calls: Array<{ op: string; tenantId?: string; args: unknown[] }> = [];
  const rec = <T>(op: string, tenantId: string | undefined, args: unknown[], fn: () => T): T => { calls.push({ op, tenantId, args }); return fn(); };
  const mine = (t: string) => agents.filter((a) => a.tenant_id === t);
  const dto = (r: Row | undefined) => (r ? structuredClone(r) : undefined);
  let seq = 0;
  const repo: AgentsRepo = {
    async getCentre(_tx, t, id) { return rec('getCentre', t, [id], () => dto(centres.find((c) => c.id === id)) as any); },
    async insertAgent(_tx, t, row) {
      return rec('insertAgent', t, [row], () => {
        if (mine(t).some((a) => a.agent_code === row['agent_code'])) throw Object.assign(new Error('duplicate key'), { code: '23505' });
        const r = agentRow({ ...row, tenant_id: t, status: 'pending_enrolment', enrolled_at: null, health: null, credentials: [], version: 1, latest_config_version: 1 }); agents.push(r); return structuredClone(r);
      });
    },
    async findAgent(_tx, t, id) { return rec('findAgent', t, [id], () => dto(mine(t).find((a) => a.id === id))); },
    /** SELECT … FOR UPDATE on the agent row (serialises concurrent E14); returns the locked row so the service can re-check status. */
    async lockAgent(_tx, t, id) { return rec('lockAgent', t, [id], () => dto(mine(t).find((a) => a.id === id))); },
    async listAgents(_tx, t, q) {
      return rec('listAgents', t, [q], () => {
        let rows = mine(t);
        if (q['centreId']) rows = rows.filter((a) => a.centre_id === q['centreId']);
        if (q['status']?.length) rows = rows.filter((a) => q['status'].includes(a.status));
        if (q['healthState']?.length) rows = rows.filter((a) => q['healthState'].includes(a.health?.health_state));
        return { rows: structuredClone(rows) };
      });
    },
    async findRelease(_tx, id) { return rec('findRelease', undefined, [id], () => dto(releases.find((r) => r.id === id)) as any); },
    async listReleases(_tx, q) { return rec('listReleases', undefined, [q], () => structuredClone(releases.filter((r) => !q.channel || r.channel === q.channel))); },
    async isRevokeReason(_tx, code) { return rec('isRevokeReason', undefined, [code], () => reasons.includes(code)); },
    async updateAgent(_tx, t, id, v, patch) {
      return rec('updateAgent', t, [id, v, patch], () => {
        const a = mine(t).find((x) => x.id === id); if (!a || a.version !== v) return undefined;
        Object.assign(a, patch, { version: a.version + 1 }); return structuredClone(a);
      });
    },
    async transitionAgent(_tx, t, id, v, o) {
      return rec('transitionAgent', t, [id, v, o], () => {
        const a = mine(t).find((x) => x.id === id); if (!a || a.version !== v) return undefined;
        a.status = o.status; a.version += 1;
        if (o.status === 'revoked') Object.assign(a, { revoked_at: NOW, revoked_by: o.actorId, revoke_reason_code: o.reasonCode, revoke_reason_text: o.reasonText ?? null });
        if (o.status === 'retired') Object.assign(a, { retired_at: NOW, retired_by: o.actorId, revoke_reason_code: o.reasonCode ?? a.revoke_reason_code });
        return structuredClone(a);
      });
    },
    async revokeCredentials(_tx, t, id, o) {
      return rec('revokeCredentials', t, [id, o], () => {
        const a = mine(t).find((x) => x.id === id); if (!a) return [];
        const hit = (a.credentials as Row[]).filter((c) => c.status === 'active' && o.kinds.includes(c.kind));
        for (const c of hit) Object.assign(c, { status: 'revoked', revoked_at: NOW, revoked_by: o.actorId, revoke_reason_code: o.reasonCode });
        return hit.map((c) => c.id);
      });
    },
    async insertCredential(_tx, t, row) {
      return rec('insertCredential', t, [row], () => {
        const a = mine(t).find((x) => x.id === row['agent_id']); if (!a) throw new Error('fk');
        a.credentials.push({ status: 'active', issued_at: NOW, issued_by_display: 'Synthetic Manager', ...row });
      });
    },
    async countNonRetiredInstruments(_tx, t, id) { return rec('countNonRetiredInstruments', t, [id], () => instruments.filter((i) => i.tenant_id === t && i.agent_id === id && i.state !== 'retired').length); },
    async insertCommand(_tx, t, row) {
      return rec('insertCommand', t, [row], () => { const r = commandRow({ requested_at: 'MISSING', expires_at: 'MISSING', requested_by_display: 'Synthetic Manager', ...row, tenant_id: t, id: row['id'] ?? idN(0x8100 + ++seq) }); commands.push(r); return structuredClone(r); });   // service must stamp requested_at/expires_at (else 'MISSING' fails the tests)
    },
    async listCommands(_tx, t, id, q) { return rec('listCommands', t, [id, q], () => ({ rows: structuredClone(commands.filter((c) => c.tenant_id === t && c.agent_id === id)) })); },
    async listTransitions(_tx, t, id, q) { return rec('listTransitions', t, [id, q], () => ({ rows: structuredClone(transitions.filter((c) => c.tenant_id === t && c.agent_id === id)) })); },
    async findLogBundle(_tx, t, id, b) { return rec('findLogBundle', t, [id, b], () => dto(bundles.find((x) => x.tenant_id === t && x.agent_id === id && x.id === b))); },
  };
  return { repo, agents, commands, calls, credentials, callsOf: (op: string) => calls.filter((c) => c.op === op), mutations: () => calls.filter((c) => /^(insert|update|transition|revoke)/.test(c.op)) };
}
export type FakeRepo = ReturnType<typeof makeRepo>;

// ---------------------------------------------------------------------------------------------------- ctx (asserts via the REAL core access() so entry validity is checked)
export function makeCtx(over: { tenantId?: string; roles?: (c: { permission: string; centreId?: string }) => void; actor?: Row } = {}) {
  const tenantId = over.tenantId ?? TENANT_A;
  const asserted: Array<{ permission: string; centreId?: string }> = [];
  const inserts: Array<{ text: string; values: unknown[] }> = [];
  const tx = { async query(text: string, values: unknown[] = []) { inserts.push({ text, values }); return { rows: [] }; } };
  const actor = over.actor ?? { type: 'user', id: USER, membershipId: MEM };
  const ctx: any = {
    tenantId, actor, requestId: REQ_ID, tx, now: () => NOW,
    ports: { IdentityPort: { assertRole: async (_c: unknown, r: { permission: string; centreId?: string }) => { asserted.push(r); over.roles?.(r); } } },
    audit: { access: async (e: any) => { await access({ tenantId, requestId: REQ_ID, actor, tx }, e); } },
    log: { info() {}, warn() {}, error() {} },
  };
  /** access_log rows as written through the real core access(): [id, tenant, centre, actor, type, membership, support, action, entity_type, entity_id, purpose, outcome, detail, request_id]. */
  const accessRows = () => inserts.filter((i) => /audit\.access_log/.test(i.text)).map((i) => ({
    tenantId: i.values[1], centreId: i.values[2], actorId: i.values[3], action: i.values[7], entityType: i.values[8], entityId: i.values[9], outcome: i.values[11], detail: i.values[12],
  }));
  return { ctx, asserted, accessRows, inserts };
}
/** Principal that only holds `instruments.agent.read` (or nothing): assertRole throws auth.forbidden for manage. */
export const readerOnly = (r: { permission: string }) => { if (r.permission !== 'instruments.agent.read') throw forbidden(); };
/** Principal scoped to centre A1 only: assertRole for another centre throws auth.forbidden. */
export const onlyCentre = (c: string) => (r: { centreId?: string }) => { if (r.centreId !== undefined && r.centreId !== c) throw forbidden(); };
