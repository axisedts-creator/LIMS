// T0B-SESSRANGE-1 (LD-304, CR-C0-LOGIN-1; 04-consolidated-decisions A8, REQ-SEC-073): the tenant settings contract must carry the SAME ranges the session checks hold:
// idle_timeout_minutes 15..30, absolute_session_hours 1..12. Today contracts/openapi/identity.yaml says 1..1440 and 1..168 in PlatformTenantSettingsDto, TenantSettingsDto
// and TenantSettingsPatch, so the request validator lets 14, 31 and 13 through to the service (400 common.validation_failed is the expected answer, the field named).
// Synthetic data only. Expected now: every range assertion and every 14/31/13/0/1440/168 rejection fails (schema still wide); the 15/30/1/12 acceptances pass.
import { join } from 'node:path';
import { AjvCompiler } from '@fastify/ajv-compiler';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../core/module.js';
import { AJV_OPTIONS } from '../../../core/openapi.js';

const spec: any = loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'identity.yaml'));
const SCHEMAS = spec.components.schemas as Record<string, any>;
// same recipe as core/openapi.ts BODY_AJV_OPTIONS (JSON bodies are typed: coerceTypes false)
const factory = AjvCompiler() as unknown as (ext: object, o: { customOptions: object }) => (c: { schema: object }) => ((v: unknown) => boolean) & { errors?: any[] };
const compile = factory({}, { customOptions: { ...AJV_OPTIONS, coerceTypes: false, keywords: [...AJV_OPTIONS.keywords, 'components'] } });

const IDLE = { minimum: 15, maximum: 30 } as const;
const ABS = { minimum: 1, maximum: 12 } as const;
const FIELDS = [['idle_timeout_minutes', IDLE], ['absolute_session_hours', ABS]] as const;

/** every schema in the spec that declares either field as a property (walks components and inline schemas) */
function carriers(node: unknown, path: string, out: Array<[string, any]> = []): Array<[string, any]> {
  if (Array.isArray(node)) node.forEach((n, i) => carriers(n, `${path}/${i}`, out));
  else if (node && typeof node === 'object') {
    const o = node as Record<string, any>;
    if (o['properties'] && ('idle_timeout_minutes' in o['properties'] || 'absolute_session_hours' in o['properties'])) out.push([path, o['properties']]);
    for (const [k, v] of Object.entries(o)) carriers(v, `${path}/${k}`, out);
  }
  return out;
}
const CARRIERS = carriers(spec.components, '#/components').concat(carriers(spec.paths, '#/paths'));

function bodySchema(operationId: string): any {
  for (const item of Object.values<any>(spec.paths)) for (const m of ['get', 'put', 'post', 'delete', 'patch']) {
    if (item?.[m]?.operationId === operationId) return item[m].requestBody.content['application/json'].schema;
  }
  throw new Error(`no operation ${operationId}`);
}
/** ajv errors for `body` against the request body schema of the operation ([] = accepted) */
const errorsFor = (operationId: string, body: unknown) => {
  const v = compile({ schema: { components: spec.components, ...bodySchema(operationId) } }); return v(body) ? [] : [...(v.errors ?? [])];
};

describe('the schemas that carry the two fields', () => {
  it('there are exactly the three known carriers (a new one must be narrowed too)', () => {
    expect(CARRIERS.map(([p]) => p).sort()).toEqual(['#/components/schemas/PlatformTenantSettingsDto', '#/components/schemas/TenantSettingsDto', '#/components/schemas/TenantSettingsPatch']);
  });
  it.each(CARRIERS)('%s: idle_timeout_minutes is integer 15..30 and absolute_session_hours is integer 1..12', (_p, props) => {
    for (const [field, r] of FIELDS) {
      expect(props[field], `${_p} ${field}`).toMatchObject({ type: 'integer', minimum: r.minimum, maximum: r.maximum });
    }
  });
});

describe('request validation answers 400 common.validation_failed (ajv failure at the field pointer) outside the ranges', () => {
  // the two settings update operations; TenantSettingsPatch is the body of both (see the carriers test)
  const OPS = ['updateSettings', 'updateTenantSettingsAsPlatform'] as const;
  describe.each(OPS)('%s', (op) => {
    it.each([['idle_timeout_minutes', 14], ['idle_timeout_minutes', 31], ['idle_timeout_minutes', 1440], ['idle_timeout_minutes', 1], ['idle_timeout_minutes', 0],
      ['absolute_session_hours', 13], ['absolute_session_hours', 168], ['absolute_session_hours', 24], ['absolute_session_hours', 0]] as const)('%s = %i is rejected and the field is named', (field, value) => {
      const errs = errorsFor(op, { [field]: value });
      expect(errs.length, `${field}=${value} must fail validation`).toBeGreaterThan(0);
      expect(errs.some((e) => e.instancePath === `/${field}` && (e.keyword === 'minimum' || e.keyword === 'maximum')), JSON.stringify(errs)).toBe(true);
    });
    it.each([['idle_timeout_minutes', 15], ['idle_timeout_minutes', 20], ['idle_timeout_minutes', 30], ['absolute_session_hours', 1], ['absolute_session_hours', 8], ['absolute_session_hours', 12]] as const)(
      '%s = %i is accepted (the limits themselves are inside)', (field, value) => {
        expect(errorsFor(op, { [field]: value })).toEqual([]);
      });
    it('non-integers and strings are still rejected at the field (no coercion)', () => {
      for (const v of [20.5, '20', null, true]) {
        expect(errorsFor(op, { idle_timeout_minutes: v }).some((e) => e.instancePath === '/idle_timeout_minutes'), `idle ${String(v)}`).toBe(true);
      }
    });
    it('both fields wrong in one request: both are named', () => {
      const paths = errorsFor(op, { idle_timeout_minutes: 14, absolute_session_hours: 13 }).map((e) => e.instancePath);
      expect(paths).toContain('/idle_timeout_minutes'); expect(paths).toContain('/absolute_session_hours');
    });
  });
});

describe('response schemas hold the same ranges (what the API sends is what a session can hold)', () => {
  it.each(['TenantSettingsDto', 'PlatformTenantSettingsDto'])('%s: 14, 31 and 13 are not valid response values', (name) => {
    const v = compile({ schema: { components: spec.components, $ref: `#/components/schemas/${name}` } });
    const base: Record<string, unknown> = {
      calendar_display: 'AD', timezone: 'Asia/Kathmandu', idle_timeout_minutes: 15, absolute_session_hours: 12, password_min_length: 12, support_access_mode: 'notify',
      report_link_ttl_days: 30, release_requires_payment: true, partial_release_allowed: false, letterhead_default: 'with', numbering_prefix: 'SYN',
      display_name: 'Synthetic Lab', legal_name_snapshot: 'Synthetic Lab Pvt. Ltd.', version: 1, ...(name === 'PlatformTenantSettingsDto' ? { training_mode: false } : {}),
    };
    const failedPaths = (patch: object) => (v({ ...base, ...patch }) ? [] : (v.errors ?? []).map((e) => e.instancePath));
    expect(failedPaths({})).toEqual([]); // the base is a valid synthetic body
    expect(failedPaths({ idle_timeout_minutes: 14 })).toContain('/idle_timeout_minutes');
    expect(failedPaths({ idle_timeout_minutes: 31 })).toContain('/idle_timeout_minutes');
    expect(failedPaths({ absolute_session_hours: 13 })).toContain('/absolute_session_hours');
  });
});

describe('the declared error codes still match the answer (x-error-codes of the two update operations)', () => {
  it.each(['updateSettings', 'updateTenantSettingsAsPlatform'])('%s keeps identity.setting_out_of_range (service-level defence in depth) in x-error-codes', (op) => {
    for (const item of Object.values<any>(spec.paths)) for (const m of ['put', 'patch', 'post']) {
      if (item?.[m]?.operationId === op) expect(item[m]['x-error-codes']).toContain('identity.setting_out_of_range');
    }
  });
});
