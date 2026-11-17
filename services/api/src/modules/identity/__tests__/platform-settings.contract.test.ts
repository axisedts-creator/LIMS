// T0B-PROVFIX-4 (LD-299): platformDto (tenant.service.ts) adds training_mode (LD-26) to the tenant settings body, but TenantSettingsDto (additionalProperties false) has no such key, so the
// response validator turns the 200 of getTenantSettingsAsPlatform / updateTenantSettingsAsPlatform into 500 common.internal (staging 2026-11-16 23:42:56 NPT, response_contract_violation).
// Bodies are produced by the REAL tenant service over the fake repo and checked against the response schemas of contracts/openapi/identity.yaml with the SAME ajv options as
// core/openapi.ts (AJV_OPTIONS + coerceTypes false + useDefaults false, strict ON; same recipe as session-actor.contract.test.ts).
// Expected now: the 8 service-body tests fail with additionalProperties /training_mode (missing PlatformTenantSettingsDto), the schema/drift tests fail on the missing schema.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AjvCompiler } from '@fastify/ajv-compiler';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../core/module.js';
import { AJV_OPTIONS } from '../../../core/openapi.js';
import { EDITABLE, PLATFORM_ONLY, toDto } from '../domain/settings.fields.js';
import { createTenantService } from '../service/tenant.service.js';
import { TENANT_A, idN, makeCtx, makeGotrue, makeRepo, nextId, seedA, seedB } from '../service/__tests__/tenant.helpers.js';

const spec: any = loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'identity.yaml'));
const factory = AjvCompiler() as unknown as (ext: object, o: { customOptions: object }) => (c: { schema: object }) => ((v: unknown) => boolean) & { errors?: any[] };
const compile = factory({}, { customOptions: { ...AJV_OPTIONS, coerceTypes: false, useDefaults: false, keywords: [...AJV_OPTIONS.keywords, 'components'] } });
function op(operationId: string): any {
  for (const item of Object.values<any>(spec.paths)) for (const m of ['get', 'put', 'post', 'delete', 'patch']) if (item?.[m]?.operationId === operationId) return item[m];
  throw new Error(`no operation ${operationId}`);
}
const responseSchema200 = (operationId: string): any => {
  const s = op(operationId).responses?.['200']?.content?.['application/json']?.schema; if (!s) throw new Error(`${operationId} has no 200 json schema`);
  return s;
};
/** [] when valid, else the ajv errors */
function violations(operationId: string, body: unknown): any[] {
  const v = compile({ schema: { components: spec.components, ...responseSchema200(operationId) } }); return v(body) ? [] : [...(v.errors ?? [])];
}
const SCHEMAS = spec.components.schemas as Record<string, any>;
const TENANT_PROPS = Object.keys(SCHEMAS['TenantSettingsDto'].properties);
const NOT_ROW_KEYS = new Set(['pending_numbering', 'version']);

/** a settings row with EVERY DTO_KEYS column set to a schema-valid synthetic value (+ version) */
const FULL: Record<string, any> = {
  calendar_display: 'AD_BS', timezone: 'Asia/Kathmandu', idle_timeout_minutes: 30, absolute_session_hours: 12, password_min_length: 10, support_access_mode: 'notify',
  report_link_ttl_days: 30, release_requires_payment: true, partial_release_allowed: false, letterhead_default: 'with', numbering_prefix: 'SYN',
  patient_code_pattern: 'P-{seq}', registration_no_pattern: 'R-{seq}', barcode_pattern: 'B-{seq}', invoice_no_pattern: 'INV-{seq}', credit_note_no_pattern: 'CN-{seq}', receipt_no_pattern: 'RC-{seq}',
  barcode_prefix: 'BC', accession_no_pattern: 'A-{seq}', accession_prefix_histology: 'H', accession_prefix_cytology: 'C', accession_prefix_ihc: 'I', accession_prefix_molecular: 'M',
  whatsapp_enabled: true, sms_enabled: false, email_enabled: true, sms_sender_id: 'SynLab', retention_clinical_years: 10, retention_audit_years: 7, retention_raw_instrument_years: 3,
  auto_verification_enabled: false, westgard_mode: 'modern', ird_pan: '123456789', cbms_realtime_required: false, abbreviated_invoice_limit_paisa: 1000000, ird_annex_1_record_id: idN(0x901),
  display_name: 'Synthetic Alpha', address_lines: ['1 Synthetic Road', 'Kathmandu'], phones: ['+977-1-0000000'], contact_email: 'lab@example.org', website: 'https://synthetic.example.org',
  logo_asset_id: idN(0x911), letterhead_header_asset_id: idN(0x912), letterhead_footer_asset_id: idN(0x913), receipt_footer_note: 'Synthetic footer', accent_color: '#1A2B3C',
  legal_name_snapshot: 'Synthetic Alpha Lab Pvt. Ltd.', version: 2,
};
const PENDING = { pending_invoice_no_pattern: 'INV2-{seq}', pending_credit_note_no_pattern: 'CN2-{seq}', pending_effective_fy_bs: '2083/84' };

function setup(row: Record<string, any>) {
  const f = makeRepo({ tenants: [seedA('active'), seedB()] }); f.data(TENANT_A).settings = { ...row };
  const { ctx } = makeCtx(f);
  const svc = createTenantService({ repo: f.repo, gotrue: makeGotrue(f, {}), emailHmac: (e: string) => Buffer.from(`hmac:${e}`), userExists: async () => false, newId: nextId } as never) as any;
  return { svc, ctx };
}
const VARIANTS: Array<[string, Record<string, any>]> = [
  ['training_mode true, pending numbering present', { training_mode: true, ...PENDING }],
  ['training_mode false, pending numbering present', { training_mode: false, ...PENDING }],
  ['training_mode true, pending numbering absent', { training_mode: true }],
  ['training_mode false, pending numbering absent', { training_mode: false }],
];

describe('the validator is the real one (guards against a vacuous pass)', () => {
  it('a tenant-facing settings body that carries training_mode is the staging violation: additionalProperties', () => {
    const v = violations('getSettings', { ...toDto(FULL), training_mode: true });
    expect(v.some((e) => e.keyword === 'additionalProperties' && e.params?.additionalProperty === 'training_mode')).toBe(true);
  });
  it('the tenant-facing body without training_mode is valid, and a wrong-typed value is still refused', () => {
    expect(violations('getSettings', toDto(FULL))).toEqual([]);
    expect(violations('getSettings', { ...toDto(FULL), idle_timeout_minutes: '30' }).length).toBeGreaterThan(0);
  });
  it('the FULL fixture row covers every TenantSettingsDto property except pending_numbering/version, so the tests below cannot pass by omission', () => {
    expect(TENANT_PROPS.filter((k) => !NOT_ROW_KEYS.has(k) && FULL[k] === undefined)).toEqual([]);
  });
});

describe('platformDto -> response schema of BOTH platform operations (real service, real validator)', () => {
  for (const [name, extra] of VARIANTS) {
    const row = { ...FULL, ...extra };
    it(`getTenantSettingsAsPlatform 200 body validates: ${name}`, async () => {
      const { svc, ctx } = setup(row); const r = await svc.getTenantSettingsAsPlatform(ctx, { tenantId: TENANT_A });
      expect(r.status).toBe(200); expect(r.body.training_mode).toBe(extra['training_mode']);
      expect(Object.hasOwn(r.body, 'pending_numbering')).toBe('pending_effective_fy_bs' in extra);
      expect(violations('getTenantSettingsAsPlatform', r.body)).toEqual([]);
    });
    it(`updateTenantSettingsAsPlatform 200 body validates: ${name}`, async () => {
      const { svc, ctx } = setup(row); const r = await svc.updateTenantSettingsAsPlatform(ctx, { tenantId: TENANT_A, expectedVersion: 2, patch: { receipt_footer_note: 'Updated footer' } });
      expect(r.status).toBe(200); expect(r.body.receipt_footer_note).toBe('Updated footer'); expect(r.body.training_mode).toBe(extra['training_mode']);
      expect(violations('updateTenantSettingsAsPlatform', r.body)).toEqual([]);
    });
  }
  it('a row without a training_mode column value still validates (property is optional)', async () => {
    const { svc, ctx } = setup(FULL); const r = await svc.getTenantSettingsAsPlatform(ctx, { tenantId: TENANT_A });
    expect('training_mode' in r.body).toBe(false); expect(violations('getTenantSettingsAsPlatform', r.body)).toEqual([]);
  });
  it('the platform schema is not loosened: an unknown key on the platform body is still refused', async () => {
    const { svc, ctx } = setup({ ...FULL, training_mode: true });
    const r = await svc.getTenantSettingsAsPlatform(ctx, { tenantId: TENANT_A });
    expect(violations('getTenantSettingsAsPlatform', { ...r.body, not_a_setting: 1 }).some((e) => e.keyword === 'additionalProperties')).toBe(true);
    expect(violations('getTenantSettingsAsPlatform', { ...r.body, training_mode: 'yes' }).length).toBeGreaterThan(0);
  });
});

describe('tenants must not see training_mode: the tenant-facing operations keep TenantSettingsDto (LD-26, LD-299)', () => {
  it('getSettings and updateSettings 200 still $ref TenantSettingsDto; TenantSettingsDto has no training_mode and additionalProperties false', () => {
    expect(responseSchema200('getSettings')).toEqual({ $ref: '#/components/schemas/TenantSettingsDto' });
    expect(responseSchema200('updateSettings')).toEqual({ $ref: '#/components/schemas/TenantSettingsDto' });
    expect(TENANT_PROPS).not.toContain('training_mode'); expect(SCHEMAS['TenantSettingsDto'].additionalProperties).toBe(false);
  });
  it('the tenant PATCH body schema never lists training_mode (immutable after provisioning; checkPlatformPatch unchanged, AC 6)', () => {
    expect(Object.keys(SCHEMAS['TenantSettingsPatch'].properties)).not.toContain('training_mode');
    expect(op('updateTenantSettingsAsPlatform').requestBody.content['application/json'].schema).toEqual({ $ref: '#/components/schemas/TenantSettingsPatch' });
  });
});

describe('contract shape: PlatformTenantSettingsDto (platform-only response schema)', () => {
  it('exists, additionalProperties false, = every TenantSettingsDto property + training_mode boolean, same required (training_mode optional)', () => {
    const p = SCHEMAS['PlatformTenantSettingsDto']; expect(p).toBeDefined();
    expect(p.additionalProperties).toBe(false);
    expect(Object.keys(p.properties).sort()).toEqual([...TENANT_PROPS, 'training_mode'].sort());
    expect(p.properties['training_mode'].type).toBe('boolean');
    expect([...p.required].sort()).toEqual([...SCHEMAS['TenantSettingsDto'].required].sort()); expect(p.required).not.toContain('training_mode');
    for (const k of TENANT_PROPS) expect(p.properties[k]).toEqual(SCHEMAS['TenantSettingsDto'].properties[k]);
  });
  it('exactly the two platform operations point at it (200)', () => {
    for (const id of ['getTenantSettingsAsPlatform', 'updateTenantSettingsAsPlatform']) expect(responseSchema200(id)).toEqual({ $ref: '#/components/schemas/PlatformTenantSettingsDto' });
    const users = Object.values<any>(spec.paths).flatMap((it) => ['get', 'put', 'post', 'delete', 'patch'].map((m) => it?.[m])).filter(Boolean)
      .filter((o) => JSON.stringify(o).includes('PlatformTenantSettingsDto')).map((o) => o.operationId).sort();
    expect(users).toEqual(['getTenantSettingsAsPlatform', 'updateTenantSettingsAsPlatform']);
  });
});

describe('DTO_KEYS vs the schema property list, both directions (done_when 4)', () => {
  const COLUMNS = [...EDITABLE, ...PLATFORM_ONLY, 'legal_name_snapshot'];   // the row columns toDto reads (settings.fields.ts DTO_KEYS)
  it('every key toDto can emit is a TenantSettingsDto property', () => {
    const out = Object.keys(toDto({ ...Object.fromEntries(COLUMNS.map((k) => [k, 'x'])), version: 1 })).filter((k) => k !== 'version');
    expect(out.filter((k) => !TENANT_PROPS.includes(k))).toEqual([]);
  });
  it('every TenantSettingsDto property (but pending_numbering, version) is emitted by toDto from a full row', () => {
    const out = new Set(Object.keys(toDto(FULL)));
    expect(TENANT_PROPS.filter((k) => !NOT_ROW_KEYS.has(k) && !out.has(k))).toEqual([]);
  });
});

describe('derived artefacts carry the new schema (regenerated by the repo command, drift)', () => {
  const block = (file: string, name: string): string => {
    const src = readFileSync(join(REPO_ROOT, 'packages', 'api-client-ts', 'src', file), 'utf8').replace(/\r\n/g, '\n'); const start = src.indexOf(`\n  ${name}: {\n`);
    if (start < 0) throw new Error(`${name} not in ${file}`);
    const next = src.slice(start + 1).search(/\n  [A-Za-z0-9_]+: \{\n/); return src.slice(start, next < 0 ? undefined : start + 1 + next);
  };
  for (const file of ['identity.ts', join('server', 'operations.ts')]) {
    it(`${file}: both platform operations list training_mode (optional boolean); the tenant operations do not`, () => {
      for (const id of ['getTenantSettingsAsPlatform', 'updateTenantSettingsAsPlatform']) expect(block(file, id)).toMatch(/training_mode\??:\s*boolean/);
      for (const id of ['getSettings', 'updateSettings']) expect(block(file, id)).not.toContain('training_mode');
    });
  }
});
