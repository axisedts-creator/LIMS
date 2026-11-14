// C7 API-T06 test helpers (not a test file). Synthetic data only. SEAMS the spec leaves open — the writer must match them or raise a dispute:
//
//   ../repo/device.repo.ts            exports `DeviceRepo` (interface below) + `createDeviceRepo(): DeviceRepo` (SQL on the request tx, explicit tenant predicate on every statement,
//                                     never selects `secret_sha256`). Tests inject the FakeRepo below.
//   ../service/enrolment.service.ts   `createEnrolmentService(deps?: { repo?, now?: () => Date })`   -> enrolAgent(ctx, { hostFingerprintSha256, agentVersion, launcherVersion, osVersion })
//   ../service/releases.service.ts    `createReleasesService(deps?: { repo?, releasesDir?: string, now? })` -> getAgentConfig(ctx) [E02] · downloadAgentRelease(ctx, { releaseId }) [E08]
//   ../service/heartbeat.service.ts   `createHeartbeatService(deps?: { repo?, now? })`               -> submitAgentHeartbeat(ctx, { body }) [E03] · submitAgentLogBundle(ctx, { body }) [E07]
//                                     `body` = the SNAKE_CASE request body exactly as in contracts/openapi/instruments.yaml. Every method returns `{ status, body, headers? }`.
//   ../handlers/<one file or several> replace the 5 device stubs of handlers/index.ts (enrolAgent, getAgentConfig, submitAgentHeartbeat, submitAgentLogBundle, downloadAgentRelease).
//
//   ctx (device ops) = { tenantId, actor:{type:'device', id:<agent_id>}, claims:{credential_kind:'enrolment_code'|'device_token', credential_id}, clientIp, requestId, tx, now?, audit:{access} }.
//   `claims` are the allow-listed extraClaims set by auth/deviceTokenResolver (core/auth/claims.ts); services enforce the credential kind (E01 enrolment_code, all others device_token) and fail
//   closed with 401 auth.device_token_invalid when it is missing or wrong. Device permissions (x-permission) are checked by the core, not by IdentityPort.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalJson, signConfigDocument } from '../service/signing.js';
import { CENTRE_A1, CENTRE_A2, NOW, REQ_ID, TENANT_A, TENANT_B, USER, agentRow, commandRow, credRow, idN, makeCtx as baseCtx, releaseRow, statusRow, type Row } from './agents.helpers.js';

export { idN, CENTRE_A1, CENTRE_A2, NOW, TENANT_A, TENANT_B, USER, REQ_ID, agentRow, commandRow, credRow, releaseRow, statusRow };
export type { Row };
export { rejection } from './agents.helpers.js';

export const AGENT_X = idN(0x1000);          // centre A1
export const AGENT_Y = idN(0x1001);          // centre A1, same tenant (AC-01.7)
export const AGENT_Z = idN(0x1002);          // centre A2, same tenant (S-02)
export const AGENT_B = idN(0x1b00);          // tenant B
export const CODE_ID = idN(0x6001), OLD_TOKEN_ID = idN(0x6002), Y_TOKEN_ID = idN(0x6003);
export const FINGERPRINT = 'c'.repeat(64);
export const CLIENT_IP = '203.0.113.9';
export const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest();

// ---------------------------------------------------------------------------------------------------- signed config fixtures (real Ed25519 via service/signing.ts, test key under __tests__/fixtures/config)
const fx = (f: string) => readFileSync(new URL(`./fixtures/config/${f}`, import.meta.url), 'utf8');
export const TEST_PKCS8 = fx('test-key.pkcs8.pem');
export const TEST_SPKI = fx('test-key.spki.pem');
export const TEST_KEY_ID = 'cfg-test-1';
export const configDoc = (agentId: string, centreId: string, version: number, targetReleaseId: string | null = null): Row => ({
  schema: 'lims.bridge.config.v1', agent_id: agentId, centre_id: centreId, config_version: version, issued_at: '2026-11-06T04:00:00.000Z', heartbeat_interval_seconds: 60,
  upload: { max_batch_messages: 100, max_batch_bytes: 3145728, flush_interval_seconds: 2, uploaded_retention_hours: 24 },
  rate_budget: { requests_per_minute: 60, reserved_host_query_per_minute: 20, reserved_heartbeat_per_minute: 2 }, tls: { spki_pins_sha256: [] }, log_level: 'info',
  update: { channel: 'stable', target: targetReleaseId ? { release_id: targetReleaseId, version: '1.2.3', package_sha256: 'a'.repeat(64), package_size: 1024, signature: 'c2lnbmF0dXJl', key_id: 'rel-test-1', authenticode_publisher: 'Synthetic Publisher Ltd' } : null, allow_downgrade: false, window: null }, instruments: [], // LD-78: full Target (TRD 5.10); null target/window legal in the opaque document
});
export function configRow(agentId: string, centreId: string, version: number, o: { tenant?: string; targetReleaseId?: string | null; document?: Row } = {}): Row {
  const document = o.document ?? configDoc(agentId, centreId, version, o.targetReleaseId ?? null);
  const env = signConfigDocument(document, { privateKey: TEST_PKCS8, keyId: TEST_KEY_ID });
  return { id: idN(0xc000 + version), tenant_id: o.tenant ?? TENANT_A, centre_id: centreId, agent_id: agentId, config_version: version, document, canonical_sha256: sha(canonicalJson(document)).toString('hex'),
    signature: env.signature, key_id: env.key_id, issued_at: '2026-11-06T04:00:00.000Z', reason: 'agent_created', created_at: NOW, created_by: USER };
}
/** true iff `signature` verifies over canonical(document) with the public test key. */
export const signatureVerifies = (document: unknown, signature: string): boolean =>
  verify(null, Buffer.from(canonicalJson(document), 'utf8'), createPublicKey(TEST_SPKI), Buffer.from(signature, 'base64url'));

// ---------------------------------------------------------------------------------------------------- request fixtures
export const enrolInput = (o: Row = {}) => ({ hostFingerprintSha256: FINGERPRINT, agentVersion: '1.2.3', launcherVersion: '1.0.0', osVersion: 'Windows 11 24H2', ...o });
export const heartbeatBody = (o: Row = {}): Row => ({
  sent_at_agent: '2026-11-07T11:59:58.000Z', agent_version: '1.2.4', launcher_version: '1.0.1', os_version: 'Windows 11 24H2',
  queue: { pending: 3, uploading: 1, rejected: 2, oversize: 1, uploaded_retained: 40, oldest_pending_age_seconds: 12 },
  disk_free_mb: 40960, clock_offset_ms: 1500, clock_offset_uncertainty_ms: 50, config: { applied_version: 1, state: 'ok' }, update: { state: 'idle' }, auth_state: 'ok', instruments: [],
  counters: { astm_naks_sent: 0, astm_naks_received: 0, astm_incomplete_sessions: 0, mllp_discarded_bytes: 0, mllp_oversize: 0, host_query_unavailable: 0 }, command_results: [], ...o,
});
export const bundleBody = (commandId: string, o: Row = {}): Row => ({ command_id: commandId, lines: ['synthetic log line one', 'synthetic log line two'], from_at_agent: '2026-11-06T12:00:00.000Z', to_at_agent: '2026-11-07T11:00:00.000Z', ...o });

// ---------------------------------------------------------------------------------------------------- the repo seam
export interface DeviceRepo {
  /** SELECT … FOR UPDATE of the agents row (serialises concurrent enrolments); RLS-invisible / other tenant -> undefined. Cols of 05-SCHEMA §2.1 + `health` (agent_status row|null). */
  lockAgent(tx: any, tenantId: string, agentId: string): Promise<Row | undefined>;
  /** plain read, same shape as lockAgent. */
  findAgent(tx: any, tenantId: string, agentId: string): Promise<Row | undefined>;
  /** agent_credentials row WITHOUT secret_sha256: id, agent_id, kind, status, expires_at, … */
  findCredential(tx: any, tenantId: string, credentialId: string): Promise<Row | undefined>;
  listActiveCredentials(tx: any, tenantId: string, agentId: string, kind: 'device_token' | 'enrolment_code'): Promise<Row[]>;
  /** compare-and-set active -> used (used_at = now); false when it was no longer `active` (lost a race). */
  markCredentialUsed(tx: any, tenantId: string, credentialId: string, usedAtIso: string): Promise<boolean>;
  insertCredential(tx: any, tenantId: string, row: Row): Promise<void>;     // { id, centre_id, agent_id, kind, secret_sha256, expires_at?, issued_by }
  revokeCredential(tx: any, tenantId: string, credentialId: string, o: { reasonCode: string; actorId: string; replacedByCredentialId?: string }): Promise<void>;
  /** agent -> active (enrolled_at only when still null), host_fingerprint_sha256, agent_status versions. Does NOT touch latest_config_version. */
  completeEnrolment(tx: any, tenantId: string, agentId: string, o: { hostFingerprintSha256: string; enrolledAt: string; agentVersion: string; launcherVersion: string; osVersion: string; actorId: string }): Promise<void>;
  /** newest agent_config_versions row of the agent. */
  getLatestConfig(tx: any, tenantId: string, agentId: string): Promise<Row | undefined>;
  /** UPSERT of the heartbeat-owned agent_status columns ONLY (never health_state / health_version / state_changed_at — single writer = evaluator). */
  recordHeartbeat(tx: any, tenantId: string, agentId: string, row: Row): Promise<void>;
  /** atomically queued -> delivered (delivered_at) for unexpired commands, returns every unexpired queued|delivered command of the agent, oldest requested_at first. */
  claimCommands(tx: any, tenantId: string, agentId: string, nowIso: string): Promise<Row[]>;
  /** delivered -> completed|failed (completed_at, result_code); false when the command is unknown / not this agent's / not `delivered`. */
  completeCommand(tx: any, tenantId: string, agentId: string, commandId: string, o: { state: 'completed' | 'failed'; resultCode?: string; nowIso: string }): Promise<boolean>;
  findCommand(tx: any, tenantId: string, agentId: string, commandId: string): Promise<Row | undefined>;
  insertLogBundle(tx: any, tenantId: string, row: Row): Promise<{ id: string }>;   // { id, centre_id, agent_id, command_id, lines, from_at_agent, to_at_agent, size_bytes, created_by }
  /** global g_agent_releases row incl. package_file_name, package_sha256, package_size, is_active. */
  findRelease(tx: any, releaseId: string): Promise<Row | undefined>;
}

export interface FakeSeed { agents?: Row[]; configs?: Row[]; commands?: Row[]; releases?: Row[] }
export function makeRepo(seed: FakeSeed = {}) {
  const agents = (seed.agents ?? [
    agentRow({ id: AGENT_X, status: 'pending_enrolment', health: null, credentials: [credRow({ id: CODE_ID, kind: 'enrolment_code', expires_at: '2026-11-08T08:00:00.000Z', agent_id: AGENT_X })], enrolled_at: null }),
  ]).map((r) => structuredClone(r));
  const configs = seed.configs ?? [];
  const commands = (seed.commands ?? []).map((r) => ({ ...r }));
  const releases = seed.releases ?? [];
  const bundles: Row[] = [];
  const calls: Array<{ op: string; tenantId?: string; args: unknown[] }> = [];
  let seq = 0;
  const rec = async <T>(op: string, tenantId: string | undefined, args: unknown[], fn: () => T): Promise<T> => { calls.push({ op, tenantId, args }); await Promise.resolve(); return fn(); };
  const mine = (t: string) => agents.filter((a) => a.tenant_id === t);
  const agentOf = (t: string, id: string) => mine(t).find((a) => a.id === id);
  const allCreds = () => agents.flatMap((a) => (a.credentials as Row[]).map((c) => ({ ...c, agent_id: c.agent_id ?? a.id, tenant_id: c.tenant_id ?? a.tenant_id })));
  const credOf = (t: string, id: string) => agents.filter((a) => a.tenant_id === t).flatMap((a) => a.credentials as Row[]).find((c) => c.id === id);
  const view = (r: Row | undefined) => (r ? structuredClone(r) : undefined);
  const repo: DeviceRepo = {
    lockAgent: (_tx, t, id) => rec('lockAgent', t, [id], () => view(agentOf(t, id))),
    findAgent: (_tx, t, id) => rec('findAgent', t, [id], () => view(agentOf(t, id))),
    findCredential: (_tx, t, id) => rec('findCredential', t, [id], () => {
      const c = credOf(t, id); const a = agents.find((x) => (x.credentials as Row[]).includes(c as Row));
      if (!c || !a) return undefined; const { secret_sha256: _s, ...rest } = c; return structuredClone({ ...rest, agent_id: c['agent_id'] ?? a.id, tenant_id: a.tenant_id });
    }),
    listActiveCredentials: (_tx, t, id, kind) => rec('listActiveCredentials', t, [id, kind], () => structuredClone(((agentOf(t, id)?.credentials ?? []) as Row[]).filter((c) => c.status === 'active' && c.kind === kind).map(({ secret_sha256: _s, ...r }) => r))),
    markCredentialUsed: (_tx, t, id, at) => rec('markCredentialUsed', t, [id, at], () => { const c = credOf(t, id); if (!c || c.status !== 'active') return false; Object.assign(c, { status: 'used', used_at: at }); return true; }),
    insertCredential: (_tx, t, row) => rec('insertCredential', t, [row], () => {
      const a = agentOf(t, row['agent_id']); if (!a) throw new Error('fk'); a.credentials.push({ status: 'active', issued_at: NOW, ...row });
    }),
    revokeCredential: (_tx, t, id, o) => rec('revokeCredential', t, [id, o], () => {
      const c = credOf(t, id); if (c) Object.assign(c, { status: 'revoked', revoked_at: NOW, revoked_by: o.actorId, revoke_reason_code: o.reasonCode, replaced_by_credential_id: o.replacedByCredentialId ?? null });
    }),
    completeEnrolment: (_tx, t, id, o) => rec('completeEnrolment', t, [id, o], () => {
      const a = agentOf(t, id); if (!a) throw new Error('missing agent');
      Object.assign(a, { status: 'active', enrolled_at: a.enrolled_at ?? o.enrolledAt, host_fingerprint_sha256: o.hostFingerprintSha256, version: a.version + 1 });
      a.health = { ...(a.health ?? statusRow({ health_state: 'offline', last_heartbeat_at: null })), agent_version: o.agentVersion, launcher_version: o.launcherVersion, os_version: o.osVersion };
    }),
    getLatestConfig: (_tx, t, id) => rec('getLatestConfig', t, [id], () => view([...configs].filter((c) => c.tenant_id === t && c.agent_id === id).sort((a, b) => b.config_version - a.config_version)[0])),
    recordHeartbeat: (_tx, t, id, row) => rec('recordHeartbeat', t, [id, row], () => {
      const a = agentOf(t, id); if (!a) throw new Error('missing agent');
      a.health = { ...(a.health ?? statusRow({ health_state: 'offline', health_version: 1, last_heartbeat_at: null })), ...structuredClone(row) };
    }),
    claimCommands: (_tx, t, id, nowIso) => rec('claimCommands', t, [id, nowIso], () => {
      const live = commands.filter((c) => c.tenant_id === t && c.agent_id === id && (c.state === 'queued' || c.state === 'delivered') && Date.parse(c.expires_at) > Date.parse(nowIso));
      for (const c of live) if (c.state === 'queued') Object.assign(c, { state: 'delivered', delivered_at: nowIso, version: c.version + 1 });
      return structuredClone(live.sort((a, b) => a.requested_at.localeCompare(b.requested_at)));
    }),
    completeCommand: (_tx, t, id, cid, o) => rec('completeCommand', t, [id, cid, o], () => {
      const c = commands.find((x) => x.tenant_id === t && x.agent_id === id && x.id === cid); if (!c || c.state !== 'delivered') return false;
      Object.assign(c, { state: o.state, completed_at: o.nowIso, result_code: o.resultCode ?? null, version: c.version + 1 }); return true;
    }),
    findCommand: (_tx, t, id, cid) => rec('findCommand', t, [id, cid], () => view(commands.find((x) => x.tenant_id === t && x.agent_id === id && x.id === cid))),
    insertLogBundle: (_tx, t, row) => rec('insertLogBundle', t, [row], () => { const r = { ...structuredClone(row), tenant_id: t, id: row['id'] ?? idN(0xb100 + ++seq) }; bundles.push(r); return { id: r.id }; }),
    findRelease: (_tx, id) => rec('findRelease', undefined, [id], () => view(releases.find((r) => r.id === id))),
  };
  return {
    repo, agents, commands, bundles, calls, allCreds,
    callsOf: (op: string) => calls.filter((c) => c.op === op),
    mutations: () => calls.filter((c) => /^(insert|mark|revoke|complete|record|claim)/.test(c.op)),
    agent: (id: string) => agents.find((a) => a.id === id) as Row,
    cred: (id: string) => allCreds().find((c) => c.id === id) as Row,
  };
}
export type FakeRepo = ReturnType<typeof makeRepo>;

// ---------------------------------------------------------------------------------------------------- ctx
export function makeDeviceCtx(o: { tenantId?: string; agentId?: string; kind?: string | null; credentialId?: string; clientIp?: string } = {}) {
  const base = baseCtx({ tenantId: o.tenantId ?? TENANT_A, actor: { type: 'device', id: o.agentId ?? AGENT_X } });
  const ctx: any = { ...base.ctx, clientIp: o.clientIp ?? CLIENT_IP, claims: o.kind === null ? undefined : { credential_kind: o.kind ?? 'device_token', credential_id: o.credentialId ?? OLD_TOKEN_ID } };
  delete ctx.ports;   // device operations are authorised by the core pipeline (x-permission), the services must not need IdentityPort
  return { ...base, ctx };
}
export const enrolCtx = (o: Parameters<typeof makeDeviceCtx>[0] = {}) => makeDeviceCtx({ kind: 'enrolment_code', credentialId: CODE_ID, ...o });

// ---------------------------------------------------------------------------------------------------- common seeds
export const activeAgent = (o: Row = {}) => agentRow({ id: AGENT_X, status: 'active', centre_id: CENTRE_A1, latest_config_version: 1,
  health: statusRow({ health_state: 'offline', health_version: 3 }), credentials: [credRow({ id: OLD_TOKEN_ID, kind: 'device_token', agent_id: AGENT_X })], ...o });
export const cmd = (n: number, o: Row = {}) => commandRow({ id: idN(0x8000 + n), agent_id: AGENT_X, requested_at: `2026-11-07T0${n}:00:00.000Z`, expires_at: '2026-11-08T12:00:00.000Z', ...o });
