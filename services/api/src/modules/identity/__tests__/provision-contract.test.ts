// PLATFORM-PROVISION-1 (LD-275, LD-29): the REAL request validation of the identity provisionTenant operation (contracts/openapi/identity.yaml,
// requestBody schema, the SAME ajv options as core/openapi.ts BODY_AJV_OPTIONS = { ...AJV_OPTIONS, coerceTypes: false }) accepts the EXACT body the
// Provision tenant form builds (fixture shared with the web test: apps/web/src/features/platform/__tests__/provision1.payload.json) and refuses it
// without contract_acceptance or without the acceptor title, naming the field path. Limits equal the service validator accInput (tenant.service.ts:302).
// Also: the generated copies of the contract (packages/api-client-ts) carry the new field. Synthetic data only.
// Expected now: the fixture is refused (additionalProperties: contract_acceptance), the limit cases fail the same way, the generated copies lack the field.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AjvCompiler } from '@fastify/ajv-compiler';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../core/module.js';
import { AJV_OPTIONS } from '../../../core/openapi.js';

const spec: any = loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'identity.yaml'));
const FIXTURE = join(REPO_ROOT, 'apps', 'web', 'src', 'features', 'platform', '__tests__', 'provision1.payload.json');
const payload = (): any => JSON.parse(readFileSync(FIXTURE, 'utf8'));

const factory = AjvCompiler() as unknown as (ext: object, o: { customOptions: object }) => (c: { schema: object; httpPart?: string }) => ((v: unknown) => boolean) & { errors?: any[] };
const compile = factory({}, { customOptions: { ...AJV_OPTIONS, coerceTypes: false, keywords: [...AJV_OPTIONS.keywords, 'components'] } });
function requestSchema(operationId: string): object {
  for (const item of Object.values<any>(spec.paths)) {
    for (const m of ['get', 'put', 'post', 'delete', 'patch']) {
      if (item?.[m]?.operationId === operationId) {
        const s = item[m].requestBody?.content?.['application/json']?.schema;
        if (!s) throw new Error(`${operationId} has no json request schema`);
        return { components: spec.components, ...s };
      }
    }
  }
  throw new Error(`no operation ${operationId}`);
}
const validate = compile({ schema: requestSchema('provisionTenant'), httpPart: 'body' });
/** field paths of the refusals, e.g. "/contract_acceptance/tos/accepted_by_title" ([] when valid) */
function refused(body: unknown): string[] {
  if (validate(body)) return [];
  return (validate.errors ?? []).map((e: any) => {
    const base: string = e.instancePath ?? e.dataPath ?? '';
    const extra = e.params?.missingProperty ?? e.params?.additionalProperty;
    return extra ? `${base}/${extra}` : base;
  });
}
const withAcc = (patch: (ca: any) => void) => { const p = payload(); patch(p.contract_acceptance); return p; };

describe('the validator is the real one (guards against a vacuous pass)', () => {
  it('refuses an unknown top-level key and a bad tenant code, so a pass below means something', () => {
    expect(refused({ ...payload(), surprise: 1 })).toContain('/surprise');
    expect(refused({ ...payload(), code: 'Bad Code' }).length).toBeGreaterThan(0);
  });
});

describe('provisionTenant request validation (LD-29: contract_acceptance)', () => {
  it('accepts the exact payload the form builds', () => {
    expect(refused(payload())).toEqual([]);
  });

  it('refuses the payload without contract_acceptance, naming the field', () => {
    const p = payload(); delete p.contract_acceptance;
    expect(refused(p)).toContain('/contract_acceptance');
  });

  it.each(['tos', 'dpa'])('refuses the payload without the acceptor title of %s, naming the field path', (doc) => {
    expect(refused(withAcc((ca) => { delete ca[doc].accepted_by_title; }))).toContain(`/contract_acceptance/${doc}/accepted_by_title`);
  });

  it.each(['tos', 'dpa'])('refuses a missing %s object', (doc) => {
    expect(refused(withAcc((ca) => { delete ca[doc]; }))).toContain(`/contract_acceptance/${doc}`);
  });

  it.each(['tos', 'dpa'])('refuses each missing field of %s', (doc) => {
    for (const f of ['version', 'accepted_by_name', 'accepted_by_title', 'accepted_at']) {
      expect(refused(withAcc((ca) => { delete ca[doc][f]; })), `${doc}.${f}`).toContain(`/contract_acceptance/${doc}/${f}`);
    }
  });

  // limits equal the service validator accInput: version 1..32, accepted_by_name 1..120, accepted_by_title 1..80, accepted_at UTC date-time
  it.each([
    ['version', 32, 33], ['accepted_by_name', 120, 121], ['accepted_by_title', 80, 81],
  ] as const)('%s: %i characters pass, %i characters and the empty string are refused', (f, max, over) => {
    for (const doc of ['tos', 'dpa']) {
      expect(refused(withAcc((ca) => { ca[doc][f] = 'x'.repeat(max); })), `${doc}.${f} at max`).toEqual([]);
      expect(refused(withAcc((ca) => { ca[doc][f] = 'x'.repeat(over); })), `${doc}.${f} over`).toContain(`/contract_acceptance/${doc}/${f}`);
      expect(refused(withAcc((ca) => { ca[doc][f] = ''; })), `${doc}.${f} empty`).toContain(`/contract_acceptance/${doc}/${f}`);
    }
  });

  it('accepted_at must be a UTC date-time: an offset time, a date only and free text are refused; a millisecond UTC instant passes', () => {
    for (const bad of ['2026-11-16T17:08:00+05:45', '2026-11-16', 'yesterday', 12345, null]) {
      expect(refused(withAcc((ca) => { ca.tos.accepted_at = bad; })), String(bad)).toContain('/contract_acceptance/tos/accepted_at');
    }
    expect(refused(withAcc((ca) => { ca.dpa.accepted_at = '2026-11-16T11:23:00.000Z'; }))).toEqual([]);
  });

  it('additionalProperties is false on contract_acceptance and on both documents; wrong types are refused, not coerced', () => {
    expect(refused(withAcc((ca) => { ca.privacy = ca.tos; }))).toContain('/contract_acceptance/privacy');
    expect(refused(withAcc((ca) => { ca.tos.signed_by_ip = '203.0.113.5'; }))).toContain('/contract_acceptance/tos/signed_by_ip');
    expect(refused(withAcc((ca) => { ca.dpa.version = 3; }))).toContain('/contract_acceptance/dpa/version');
    expect(refused({ ...payload(), contract_acceptance: [] }).length).toBeGreaterThan(0);
  });

  it('the rest of the request is unchanged: still no tenant_id, still no extra keys', () => {
    expect(refused({ ...payload(), tenant_id: '0190a000-0000-7000-8000-00000000b001' })).toContain('/tenant_id');
  });
});

describe('the generated copies of the identity contract carry contract_acceptance (LD-275: regenerate with pnpm codegen)', () => {
  const block = (file: string) => {
    const text = readFileSync(join(REPO_ROOT, file), 'utf8').replace(/\r\n/g, '\n');
    const i = text.indexOf('\n  provisionTenant: {');
    if (i < 0) throw new Error(`no provisionTenant in ${file}`);
    return text.slice(i, text.indexOf('responses:', i));
  };
  it.each(['packages/api-client-ts/src/server/operations.ts', 'packages/api-client-ts/src/identity.ts'])('%s: provisionTenant body has the required acceptance fields', (f) => {
    const b = block(f);
    expect(b).toContain('contract_acceptance: {');
    for (const k of ['tos: {', 'dpa: {', 'version: string;', 'accepted_by_name: string;', 'accepted_by_title: string;', 'accepted_at: string;']) expect(b, k).toContain(k);
  });
});
