// C7 API-T04 — contract probes for E10-E21 against contracts/openapi/instruments.yaml + contracts/permissions.yaml (02-TRD §7.3; 07-SECURITY S-04, S-06, REQ-SEC-080/081).
// Spec-level: these pass or fail on the contract itself; the DTO/mapper half is in agents.mapper.test.ts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { REPO_ROOT } from '../../../../core/module.js';
import { operation, propertyNames, spec } from '../agents.contract.js';

// [opId, method, path, permission, x-idempotency]
const OPS: Array<[string, string, string, string, string]> = [
  ['listAgents', 'get', '/v1/instruments/agents', 'instruments.agent.read', 'none'],
  ['createAgent', 'post', '/v1/instruments/agents', 'instruments.agent.manage', 'required'],
  ['getAgent', 'get', '/v1/instruments/agents/{agent_id}', 'instruments.agent.read', 'none'],
  ['updateAgent', 'patch', '/v1/instruments/agents/{agent_id}', 'instruments.agent.manage', 'none'],
  ['issueEnrolmentCode', 'post', '/v1/instruments/agents/{agent_id}/enrolment-codes', 'instruments.agent.manage', 'none'],
  ['revokeAgent', 'post', '/v1/instruments/agents/{agent_id}/revoke', 'instruments.agent.manage', 'optional'],
  ['retireAgent', 'post', '/v1/instruments/agents/{agent_id}/retire', 'instruments.agent.manage', 'optional'],
  ['requestAgentCommand', 'post', '/v1/instruments/agents/{agent_id}/commands', 'instruments.agent.manage', 'required'],
  ['listAgentCommands', 'get', '/v1/instruments/agents/{agent_id}/commands', 'instruments.agent.read', 'none'],
  ['listAgentHealthTransitions', 'get', '/v1/instruments/agents/{agent_id}/health-transitions', 'instruments.agent.read', 'none'],
  ['getAgentLogBundle', 'get', '/v1/instruments/agents/{agent_id}/log-bundles/{bundle_id}', 'instruments.agent.manage', 'none'],
  ['listAgentReleases', 'get', '/v1/instruments/agent-releases', 'instruments.agent.read', 'none'],
];
const FORBIDDEN_FIELDS = ['secret_sha256', 'secret', 'token', 'device_token', 'raw_bytes', 'package_sha256', 'signature', 'key_id', 'authenticode_publisher', 'package_file_name', 'host_fingerprint_sha256'];

describe('E10-E21 route table (TRD §7.3)', () => {
  it.each(OPS)('%s: method, path, x-permission, x-idempotency match the TRD', (id, method, path, perm, idem) => {
    const o = operation(id);
    expect([o.method, o.path]).toEqual([method, path]);
    expect(o.op['x-permission']).toBe(perm);
    expect(o.op['x-idempotency']).toBe(idem);
    expect(o.op.security).toEqual([{ bearerJwt: [] }]);
  });
  it('E14 is the only non-idempotent secret carrier and says why (secret shown once)', () => {
    expect(operation('issueEnrolmentCode').op['x-idempotency-justification']).toMatch(/secret|once/i);
  });
  it('every staff op can answer 404 for an invisible object and 403 (BOLA: load under RLS, then assertRole)', () => {
    for (const id of ['getAgent', 'updateAgent', 'issueEnrolmentCode', 'revokeAgent', 'retireAgent', 'requestAgentCommand', 'listAgentCommands', 'listAgentHealthTransitions', 'getAgentLogBundle']) {
      const r = operation(id).op.responses;
      expect(Object.keys(r), id).toEqual(expect.arrayContaining(['403', '404']));
    }
  });
});

describe('S-04 privilege: agent.manage is privileged (aal2 enforced by the core from permissions.yaml), agent.read is not', () => {
  const perms = parse(readFileSync(join(REPO_ROOT, 'contracts', 'permissions.yaml'), 'utf8'));
  const list: Array<{ code: string; privileged: boolean; roles: string[] }> = Array.isArray(perms) ? perms : (perms.permissions ?? Object.values(perms).find(Array.isArray));
  const p = (c: string) => list.find((x) => x.code === c);
  it('instruments.agent.manage privileged:true, lab_manager + tenant_admin only (no technologist)', () => {
    expect(p('instruments.agent.manage')).toMatchObject({ privileged: true });
    expect(p('instruments.agent.manage')!.roles.sort()).toEqual(['lab_manager', 'tenant_admin']);
  });
  it('instruments.agent.read privileged:false, lab_manager', () => {
    expect(p('instruments.agent.read')).toMatchObject({ privileged: false, roles: ['lab_manager'] });
  });
});

describe('S-06 / REQ-SEC-081: no secret-bearing property in any E10-E21 response schema', () => {
  it.each(OPS)('%s response schemas carry no forbidden field name', (id) => {
    const names = new Set<string>();
    for (const [status, r] of Object.entries<any>(operation(id).op.responses ?? {})) {
      if (!/^2/.test(status)) continue;
      for (const n of propertyNames(r?.content?.['application/json']?.schema)) names.add(n);
    }
    expect([...names].filter((n) => FORBIDDEN_FIELDS.includes(n))).toEqual([]);
  });
  it('the enrolment code appears in exactly one response: E14 201 { enrolment_code, expires_at, credential_id }', () => {
    for (const [id] of OPS) {
      const n = propertyNames(operation(id).op.responses?.['201']?.content?.['application/json']?.schema ?? operation(id).op.responses?.['200']?.content?.['application/json']?.schema);
      expect(n.includes('enrolment_code'), id).toBe(id === 'issueEnrolmentCode');
    }
  });
  it('response objects are closed (additionalProperties:false) so a leaked column fails response validation', () => {
    for (const name of ['Agent', 'AgentSummary', 'AgentCredential', 'AgentCommand', 'HealthTransition', 'AgentRelease']) {
      expect(spec.components.schemas[name]?.additionalProperties, name).toBe(false);
    }
  });
});
