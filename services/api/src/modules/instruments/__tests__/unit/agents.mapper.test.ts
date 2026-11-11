// C7 API-T04 — mapper test: "secrets never in DTOs" (done_when; 07-SECURITY S-06, REQ-SEC-080/081; AC-16.3 "credentials ... never secrets").
// Expected API of ../../mappers/agents.mapper.ts (pure functions, DB row -> DTO, allowlist of fields; rows are the snake_case rows of agents.helpers.ts):
//   toAgent(row)            row = agents columns + `health` (agent_status row | null) + `credentials` (credential rows incl. secret_sha256 and issued_by_display) -> openapi `Agent`
//   toAgentSummary(row)     -> `AgentSummary`          toAgentCredential(credRow) -> `AgentCredential`
//   toAgentCommand(row)     row has `requested_by_display`, optional `log_bundle_id` -> `AgentCommand` (key `command_id`, not `id`)
//   toHealthTransition(row) -> `HealthTransition`      toAgentRelease(row) -> `AgentRelease` (no signature / hash / key / publisher / file name)
//   toLogBundle(row)        -> E20 body { bundle_id, lines, from_at_agent, to_at_agent, created_at }
// health: clock_offset_seconds = round(clock_offset_ms / 1000); a row with no agent_status (pending_enrolment) -> state 'offline', queue_depth 0, oldest_pending_age_seconds 0.
import { describe, expect, it } from 'vitest';
import { responseViolations, violations } from '../agents.contract.js';
import {
  SECRET_HEX, agentRow, bundleRow, commandRow, credRow, idN, releaseRow, statusRow, transitionRow,
} from '../agents.helpers.js';
import {
  toAgent, toAgentCommand, toAgentCredential, toAgentRelease, toAgentSummary, toHealthTransition, toLogBundle,
} from '../../mappers/agents.mapper.js';

const B64_SECRET = Buffer.from(SECRET_HEX, 'hex').toString('base64');
const LEAK_NEEDLES = [SECRET_HEX, B64_SECRET, 'secret_sha256', 'SIGNATURE-PLANTED', 'package_sha256', 'authenticode', 'bridge-agent-1.2.3.msi', 'host_fingerprint', 'a'.repeat(64), 'b'.repeat(64)];
const noLeak = (dto: unknown) => { const s = JSON.stringify(dto, (_k, v) => (v instanceof Uint8Array || (v && v.type === 'Buffer') ? `BYTES:${Buffer.from(v.data ?? v).toString('hex')}` : v)); for (const n of LEAK_NEEDLES) expect(s, n).not.toContain(n); };

describe('toAgent (E12/E11/E13/E15/E16 body)', () => {
  const row = agentRow({
    credentials: [
      credRow({ id: idN(0x5001), kind: 'device_token', status: 'active' }),
      credRow({ id: idN(0x5002), kind: 'enrolment_code', status: 'used', used_at: '2026-11-01T09:00:00.000Z', expires_at: '2026-11-02T08:00:00.000Z' }),
      credRow({ id: idN(0x5003), kind: 'device_token', status: 'revoked', revoked_at: '2026-10-30T00:00:00.000Z', replaced_by_credential_id: idN(0x5001) }),
    ],
  });
  it('validates against the closed openapi Agent schema (a leaked column fails additionalProperties:false)', () => {
    expect(violations('Agent', toAgent(row))).toEqual([]);
  });
  it('never carries secret_sha256, the planted hash bytes (hex/base64/Buffer JSON), host fingerprint, or internal columns', () => {
    const dto: any = toAgent(row); noLeak(dto);
    for (const c of dto.credentials) expect(Object.keys(c)).not.toEqual(expect.arrayContaining(['secret_sha256']));
    for (const k of ['tenant_id', 'created_by', 'updated_by', 'is_active', 'host_fingerprint_sha256', 'revoked_by', 'retired_by', 'revoke_reason_text']) expect(dto, k).not.toHaveProperty(k);
  });
  it('credential summary = id/kind/status/issued_at/issued_by_display + optional expires/used/last_used/revoked (AC-16.3)', () => {
    const dto: any = toAgent(row);
    expect(dto.credentials).toHaveLength(3);
    expect(dto.credentials[0]).toMatchObject({ credential_id: idN(0x5001), kind: 'device_token', status: 'active', issued_by_display: 'Synthetic Manager' });
    expect(dto.credentials[1]).toMatchObject({ kind: 'enrolment_code', status: 'used', used_at: '2026-11-01T09:00:00.000Z', expires_at: '2026-11-02T08:00:00.000Z' });
    expect(dto.credentials[2]).toMatchObject({ status: 'revoked', revoked_at: '2026-10-30T00:00:00.000Z' });
    expect(dto.credentials[0]).not.toHaveProperty('id');
  });
  it('health block: ms -> seconds, ids of last_ip kept, absent optionals omitted (not null)', () => {
    const dto: any = toAgent(agentRow({ health: statusRow({ clock_offset_ms: 2600, config_state: null, update_state: null }) }));
    expect(dto.health).toMatchObject({ state: 'online', queue_depth: 4, clock_offset_seconds: 3, last_ip: '203.0.113.7' });
    expect(dto.health).not.toHaveProperty('config_state');
    expect(violations('Agent', dto)).toEqual([]);
  });
  it('pending_enrolment agent without agent_status row and without credentials still maps and validates', () => {
    const dto: any = toAgent(agentRow({ status: 'pending_enrolment', enrolled_at: null, health: null, credentials: [] }));
    expect(dto.health).toMatchObject({ state: 'offline', queue_depth: 0, oldest_pending_age_seconds: 0 });
    expect(dto.credentials).toEqual([]);
    expect(dto).not.toHaveProperty('enrolled_at');
    expect(violations('Agent', dto)).toEqual([]);
  });
  it('a hostile extra column on the row (even named like a secret) is dropped, not copied', () => {
    const dto = toAgent({ ...row, secret: 'SECRET-PLANTED', device_token: 'lmsd_PLANTED', token: 'x', raw_bytes: 'x' } as any);
    expect(JSON.stringify(dto)).not.toMatch(/SECRET-PLANTED|lmsd_PLANTED|raw_bytes/);
    expect(violations('Agent', dto)).toEqual([]);
  });
  it('revoked agent maps reason code but not free text or the revoker id', () => {
    const dto: any = toAgent(agentRow({ status: 'revoked', revoked_at: '2026-11-05T00:00:00.000Z', revoked_by: idN(0xd1), revoke_reason_code: 'lost_device', revoke_reason_text: 'free text' }));
    expect(dto).toMatchObject({ status: 'revoked', revoke_reason_code: 'lost_device' });
    expect(dto).not.toHaveProperty('revoke_reason_text'); expect(dto).not.toHaveProperty('revoked_by');
  });
  it('does not mutate its input', () => {
    const before = JSON.stringify(row); toAgent(row); expect(JSON.stringify(row)).toBe(before);
  });
});

describe('toAgentSummary (E10 item)', () => {
  it('validates against AgentSummary, carries no credentials / secrets / fingerprint', () => {
    const dto: any = toAgentSummary(agentRow());
    expect(violations('AgentSummary', dto)).toEqual([]);
    expect(dto).not.toHaveProperty('credentials'); expect(dto).not.toHaveProperty('backlog_threshold'); noLeak(dto);
    expect(dto.health).toMatchObject({ state: 'online', queue_depth: 4, oldest_pending_age_seconds: 12, clock_offset_seconds: 2 });
  });
});

describe('toAgentCredential', () => {
  it('drops secret_sha256 in every shape it can arrive in (Buffer, Uint8Array, hex string)', () => {
    for (const secret of [Buffer.from(SECRET_HEX, 'hex'), new Uint8Array(Buffer.from(SECRET_HEX, 'hex')), SECRET_HEX]) {
      const dto = toAgentCredential(credRow({ secret_sha256: secret }));
      noLeak(dto); expect(violations('AgentCredential', dto)).toEqual([]);
    }
  });
});

describe('toAgentCommand (E17/E18)', () => {
  it('validates; id -> command_id; display name only (no requested_by uuid, tenant, version)', () => {
    const dto: any = toAgentCommand(commandRow({ kind: 'reupload_since', params: { since: '2026-11-06T12:00:00.000Z' } }));
    expect(violations('AgentCommand', dto)).toEqual([]);
    expect(dto).toMatchObject({ command_id: idN(0x8001), agent_id: idN(0x1000), params: { since: '2026-11-06T12:00:00.000Z' }, requested_by_display: 'Synthetic Manager' });
    for (const k of ['id', 'tenant_id', 'requested_by', 'version', 'centre_id']) expect(dto, k).not.toHaveProperty(k);
  });
  it('log_bundle_id is exposed for a completed upload_logs command and omitted otherwise', () => {
    expect(toAgentCommand(commandRow({ state: 'completed', completed_at: '2026-11-07T12:05:00.000Z', result_code: 'ok', log_bundle_id: idN(0xb001) }))).toMatchObject({ log_bundle_id: idN(0xb001) });
    expect(toAgentCommand(commandRow())).not.toHaveProperty('log_bundle_id');
  });
});

describe('toHealthTransition (E19)', () => {
  it('validates; first transition has no from_state; silent list capped at 50; event_id / tenant not exposed', () => {
    const first: any = toHealthTransition(transitionRow({ from_state: null }));
    expect(violations('HealthTransition', first)).toEqual([]); expect(first).not.toHaveProperty('from_state');
    const many: any = toHealthTransition(transitionRow({ silent_instrument_ids: Array.from({ length: 80 }, (_, i) => idN(0xf000 + i)) }));
    expect(many.silent_instrument_ids).toHaveLength(50); expect(violations('HealthTransition', many)).toEqual([]);
    for (const k of ['event_id', 'tenant_id', 'id', 'created_by']) expect(first, k).not.toHaveProperty(k);
  });
});

describe('toAgentRelease (E21): no signature or hash fields (they travel only in the signed config)', () => {
  it('validates and omits signature, package_sha256, key_id, authenticode_publisher, package_file_name', () => {
    const dto: any = toAgentRelease(releaseRow());
    expect(violations('AgentRelease', dto)).toEqual([]); noLeak(dto);
    for (const k of ['signature', 'package_sha256', 'key_id', 'authenticode_publisher', 'package_file_name', 'created_at']) expect(dto, k).not.toHaveProperty(k);
    expect(dto).toMatchObject({ id: idN(0x7001), version: '1.2.3', channel: 'stable', package_size: 12345678, is_active: true });
  });
  it('package_size arriving as a pg bigint string is a number in the DTO', () => {
    expect((toAgentRelease(releaseRow({ package_size: '12345678' })) as any).package_size).toBe(12345678);
  });
});

describe('toLogBundle (E20)', () => {
  it('validates against the E20 200 response schema; exposes bundle_id, not row ids, command or size', () => {
    const dto: any = toLogBundle(bundleRow());
    expect(responseViolations('getAgentLogBundle', '200', dto)).toEqual([]);
    expect(dto).toMatchObject({ bundle_id: idN(0xb001), lines: ['line one', 'line two'] });
    for (const k of ['id', 'tenant_id', 'command_id', 'size_bytes', 'created_by', 'agent_id']) expect(dto, k).not.toHaveProperty(k);
  });
});
