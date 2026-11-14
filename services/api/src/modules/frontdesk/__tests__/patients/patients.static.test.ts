// FD-T04 (C4 Patients F1-F6) — contract + file-layout facts. No DB. Spec: 06-PLAN row FD-T04; 02-TRD §5.1 F1-F6; 07-SECURITY.
// LD-70 (2026-11-08): probes/pending.json is owned by the writer/debugger; it is deliberately NOT asserted here.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec, operationIds } from '../../../../core/module.js';
import { handlers } from '../../handlers/index.js';
import { manifest } from '../../index.js';

const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/frontdesk.yaml'));
const opOf = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };
const MOD = join(REPO_ROOT, 'services/api/src/modules/frontdesk');

const OPS = {
  searchPatients: { perm: 'frontdesk.patient.read', idem: 'none' },
  createPatient: { perm: 'frontdesk.registration.create', idem: 'required' },
  getPatient: { perm: 'frontdesk.patient.read', idem: 'none' },
  updatePatient: { perm: 'frontdesk.registration.create', idem: 'optional' },
  recordPatientConsent: { perm: 'frontdesk.registration.create', idem: 'required' },
  listPatientOrders: { perm: 'frontdesk.order.read', idem: 'none' },
} as const;

describe('FD-T04 files exist (plan row FD-T04)', () => {
  it.each([
    'handlers/searchPatients.ts', 'handlers/createPatient.ts', 'handlers/getPatient.ts', 'handlers/updatePatient.ts', 'handlers/recordPatientConsent.ts',
    'handlers/listPatientOrders.ts', 'service/patient.service.ts', 'mappers/patient.dto.ts',
  ])('%s', (f) => { expect(existsSync(join(MOD, f)), f).toBe(true); });
});

describe('the six operations are real handlers wired in the manifest (no CR/stub: common.service_unavailable)', () => {
  it.each(Object.keys(OPS))('%s is in frontdesk.yaml and in manifest.handlers', (id) => {
    expect(operationIds(spec)).toContain(id);
    expect(typeof (manifest.handlers as any)[id]).toBe('function');
    expect((manifest.handlers as any)[id]).toBe((handlers as any)[id]);
  });
  it.each(Object.keys(OPS))('%s no longer answers common.service_unavailable when given no context (it fails closed with auth.unauthenticated/forbidden/internal instead)', async (id) => {
    let code: string | undefined;
    try { await (handlers as any)[id]({ params: {}, query: {}, headers: {}, body: undefined }, { operationId: id, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } }); }
    catch (e: any) { code = e?.code; }
    expect(code).not.toBe('common.service_unavailable');
  });
  it('handlers/index.ts no longer maps these six ids to the shared stub (each has its own module)', () => {
    const src = readFileSync(join(MOD, 'handlers/index.ts'), 'utf8');
    for (const id of Object.keys(OPS)) expect(src, id).toMatch(new RegExp(`from '\\./${id}\\.js'|\\./${id}`));
  });
});

describe('contract facts the handlers rely on (02-TRD §5.1)', () => {
  it.each(Object.entries(OPS))('%s: x-permission + x-idempotency', (id, o) => {
    expect(opOf(id)['x-permission']).toBe(o.perm);
    expect(opOf(id)['x-idempotency']).toBe(o.idem);
  });
  it.each([
    ['searchPatients', ['common.validation_failed']],
    ['createPatient', ['frontdesk.patient_duplicate_suspected', 'frontdesk.consent_required', 'common.validation_failed', 'common.idempotency_key_reused']],
    ['updatePatient', ['common.version_conflict', 'common.precondition_required', 'common.not_found']],
    ['listPatientOrders', ['common.invalid_cursor', 'common.not_found']],
    ['getPatient', ['common.not_found']], ['recordPatientConsent', ['common.not_found']],
  ] as const)('%s declares its error codes', (id, codes) => {
    for (const c of codes) expect(opOf(id)['x-error-codes'], `${id} ${c}`).toContain(c);
  });
  it('request/response schemas are strict (additionalProperties:false) so unknown/forged fields are rejected by the core', () => {
    const s = spec.components.schemas;
    for (const n of ['NewPatient', 'PatientUpdate', 'Consents', 'SearchPatientsRequest', 'PatientSummary', 'Patient', 'ConsentRecord']) expect(s[n].additionalProperties, n).toBe(false);
    for (const forbidden of ['tenant_id', 'id', 'patient_code', 'version']) expect(Object.keys(s.NewPatient.properties)).not.toContain(forbidden);
    expect(Object.keys(s.PatientSummary.properties)).not.toContain('phone_e164');   // summaries carry the masked phone only
  });
  it('error registry has both create-patient codes with the HTTP statuses the PRD names (409 / 422)', () => {
    const reg = readFileSync(join(REPO_ROOT, 'contracts/errors.yaml'), 'utf8');
    expect(reg).toMatch(/code: frontdesk\.patient_duplicate_suspected, http: 409/);
    expect(reg).toMatch(/code: frontdesk\.consent_required,\s+http: 422/);
  });
});

describe('static guards on the new code (07-SECURITY REQ-SEC-024 / REQ-SEC-095 / A13 D-27a)', () => {
  const read = (f: string) => (existsSync(join(MOD, f)) ? readFileSync(join(MOD, f), 'utf8') : '');
  const files = ['handlers/searchPatients.ts', 'handlers/createPatient.ts', 'handlers/getPatient.ts', 'handlers/updatePatient.ts', 'handlers/recordPatientConsent.ts',
    'handlers/listPatientOrders.ts', 'service/patient.service.ts', 'mappers/patient.dto.ts'];
  it('no file reads billing.* tables (02-CV §5.13) and none builds SQL by string-concatenating a request value', () => {
    for (const f of files) {
      const s = read(f);
      expect(s, f).not.toMatch(/\bbilling\./);
      expect(s, f).not.toMatch(/query\(\s*`[^`]*\$\{\s*(req|body|query|params|input)\b/);   // template-literal SQL fed from request data
    }
  });
  it('search logs no query text: the search handler/service never passes the query to ctx.log or to the access-log detail', () => {
    const s = read('handlers/searchPatients.ts') + read('service/patient.service.ts');
    expect(s).not.toMatch(/log\.(info|warn|error)\([^)]*\bquery\b/);
    expect(s).not.toMatch(/detail:\s*\{[^}]*\bquery\b/);
  });
});
