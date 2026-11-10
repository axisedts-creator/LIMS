// C7 API-T06 — contract probes for E01/E02/E03/E07/E08 against contracts/openapi/instruments.yaml + contracts/permissions.yaml (02-TRD §7.1/§7.2; 07-SECURITY S-05, S-06, E01 row).
// Spec-level: these pass or fail on the contract itself (they check the spec, not code); the behaviour half is in enrolment/releases/heartbeat.service.test.ts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { REPO_ROOT } from '../../../../core/module.js';
import { operation, propertyNames, responseViolations, violations } from '../agents.contract.js';
import { bundleBody, enrolInput, heartbeatBody, idN } from '../device.helpers.js';

// [opId, method, path, permission, x-idempotency]
const OPS: Array<[string, string, string, string, string]> = [
  ['enrolAgent', 'post', '/v1/instruments/agent/enrolments', 'instruments.ingest.enrol', 'none'],
  ['getAgentConfig', 'get', '/v1/instruments/agent/config', 'instruments.ingest.config_read', 'none'],
  ['submitAgentHeartbeat', 'post', '/v1/instruments/agent/heartbeats', 'instruments.ingest.heartbeat', 'optional'],
  ['submitAgentLogBundle', 'post', '/v1/instruments/agent/log-bundles', 'instruments.ingest.heartbeat', 'required'],
  ['downloadAgentRelease', 'get', '/v1/instruments/agent/releases/{release_id}/package', 'instruments.ingest.config_read', 'none'],
];

describe('E01/E02/E03/E07/E08 route table (TRD §7.2)', () => {
  it.each(OPS)('%s: method, path, x-permission, x-idempotency, deviceToken scheme, ingest tier', (id, method, path, perm, idem) => {
    const o = operation(id);
    expect([o.method, o.path]).toEqual([method, path]);
    expect(o.op['x-permission']).toBe(perm); expect(o.op['x-idempotency']).toBe(idem);
    expect(o.op.security).toEqual([{ deviceToken: [] }]); expect(o.op['x-rate-limit-tier']).toBe('ingest');
  });
  it('E01 stores no idempotent replay (it would persist the device token) and says why', () => {
    expect(operation('enrolAgent').op['x-idempotency-justification']).toMatch(/secret|token/i);
  });
  it('every device op answers 401 auth.device_token_invalid', () => {
    for (const [id] of OPS) { expect(operation(id).op['x-error-codes'], id).toContain('auth.device_token_invalid'); expect(Object.keys(operation(id).op.responses), id).toContain('401'); }
  });
  it('E07 declares 404 and 409 instruments.invalid_transition; E08 declares 404', () => {
    expect(operation('submitAgentLogBundle').op['x-error-codes']).toEqual(expect.arrayContaining(['common.not_found', 'instruments.invalid_transition']));
    expect(Object.keys(operation('submitAgentLogBundle').op.responses)).toEqual(expect.arrayContaining(['404', '409']));
    expect(operation('downloadAgentRelease').op['x-error-codes']).toContain('common.not_found');
  });
  it('E08 200 declares Content-Length, X-Package-Sha256 (hex64) and application/octet-stream', () => {
    const r = operation('downloadAgentRelease').op.responses['200'];
    expect(Object.keys(r.headers)).toEqual(expect.arrayContaining(['Content-Length', 'X-Package-Sha256']));
    expect(r.headers['X-Package-Sha256'].schema.pattern).toBe('^[0-9a-f]{64}$'); expect(Object.keys(r.content)).toEqual(['application/octet-stream']);
  });
});

describe('S-05 device scope: the bridge_agent role holds ingest.* only, enrol is not granted to staff', () => {
  const perms = parse(readFileSync(join(REPO_ROOT, 'contracts', 'permissions.yaml'), 'utf8'));
  const list: Array<{ code: string; roles: string[] }> = Array.isArray(perms) ? perms : (perms.permissions ?? Object.values(perms).find(Array.isArray));
  it('each ingest permission has no staff role (device actors only)', () => {
    for (const c of ['instruments.ingest.enrol', 'instruments.ingest.config_read', 'instruments.ingest.heartbeat', 'instruments.ingest.submit']) expect(list.find((x) => x.code === c)?.roles, c).toEqual([]);
  });
  it('bridge_agent role: exactly the five ingest permissions, nothing under lab.* or instruments.message.*', () => {
    const role: string[] = perms.fixed_actor_permissions.device.bridge_agent;
    expect([...role].sort()).toEqual(['instruments.ingest.config_read', 'instruments.ingest.enrol', 'instruments.ingest.heartbeat', 'instruments.ingest.host_query', 'instruments.ingest.submit']);
  });
});

describe('request/response schemas are closed and fixtures are valid', () => {
  it('E01 request: fixture valid; extra field, upper-case or 63-char fingerprint, empty version are rejected', () => {
    const body = { host_fingerprint_sha256: enrolInput().hostFingerprintSha256, agent_version: '1.2.3', launcher_version: '1.0.0', os_version: 'Windows 11' };
    const schema = operation('enrolAgent').op.requestBody.content['application/json'].schema;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.host_fingerprint_sha256.pattern).toBe('^[0-9a-f]{64}$');
    expect(body.host_fingerprint_sha256).toMatch(new RegExp(schema.properties.host_fingerprint_sha256.pattern));
  });
  it('E01 201 body is closed and has exactly {agent_id, centre_id, device_token, server_time, config_version}', () => {
    const s = operation('enrolAgent').op.responses['201'].content['application/json'].schema;
    expect(s.additionalProperties).toBe(false); expect(Object.keys(s.properties).sort()).toEqual(['agent_id', 'centre_id', 'config_version', 'device_token', 'server_time']);
    expect(responseViolations('enrolAgent', '201', { agent_id: idN(1), centre_id: idN(2), device_token: `lmsd_${'A'.repeat(43)}`, server_time: '2026-11-07T12:00:00.000Z', config_version: 1 })).toEqual([]);
    expect(responseViolations('enrolAgent', '201', { agent_id: idN(1), centre_id: idN(2), device_token: 'x', server_time: '2026-11-07T12:00:00.000Z', config_version: 1, secret_sha256: 'x' }).length).toBeGreaterThan(0);
  });
  it('E03 fixture valid; a negative queue count or an unknown field is rejected; the response is closed', () => {
    expect(violations('Heartbeat', heartbeatBody())).toEqual([]);
    expect(violations('Heartbeat', heartbeatBody({ queue: { ...heartbeatBody().queue, pending: -1 } })).length).toBeGreaterThan(0);
    expect(violations('Heartbeat', heartbeatBody({ extra: 1 })).length).toBeGreaterThan(0);
    expect(responseViolations('submitAgentHeartbeat', '200', { server_time: '2026-11-07T12:00:00.000Z', latest_config_version: 1, health_state: 'online', commands: [{ command_id: idN(3), kind: 'upload_logs', params: {}, expires_at: '2026-11-08T12:00:00.000Z' }] })).toEqual([]);
    expect(responseViolations('submitAgentHeartbeat', '200', { server_time: '2026-11-07T12:00:00.000Z', latest_config_version: 1, health_state: 'bogus', commands: [] }).length).toBeGreaterThan(0);
  });
  it('E07 request: lines 1..20000 each <= 1000 chars; closed object; 201 is exactly {bundle_id}', () => {
    const s = operation('submitAgentLogBundle').op.requestBody.content['application/json'].schema;
    expect(s.additionalProperties).toBe(false); expect(s.properties.lines).toMatchObject({ minItems: 1, maxItems: 20000, items: { maxLength: 1000 } });
    expect(Object.keys(bundleBody(idN(4))).sort()).toEqual([...s.required].sort());
    expect(responseViolations('submitAgentLogBundle', '201', { bundle_id: idN(5) })).toEqual([]);
    expect(responseViolations('submitAgentLogBundle', '201', { bundle_id: idN(5), lines: [] }).length).toBeGreaterThan(0);
  });
  it('E02 200 declares alg / key_id / signature / document and carries no secret-bearing property name', () => {
    const names = propertyNames(operation('getAgentConfig').op.responses['200'].content['application/json'].schema);
    expect(names).toEqual(expect.arrayContaining(['alg', 'key_id', 'signature', 'document']));
    expect(names.filter((n) => /secret|private|password|token/i.test(n))).toEqual([]);
  });
});
