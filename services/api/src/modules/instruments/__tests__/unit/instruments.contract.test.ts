// C7 API-T05 — contract probes for E22-E32, E40, E41 against contracts/openapi/instruments.yaml + contracts/permissions.yaml (02-TRD §7.3; 07-SECURITY S-04, REQ-SEC-080).
// Spec-level: these pass or fail on the contract itself; behaviour is in ../instruments.service.test.ts, ../settings.service.test.ts, ../observedCodes.service.test.ts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { REPO_ROOT } from '../../../../core/module.js';
import { operation, propertyNames, spec } from '../agents.contract.js';

// [opId, method, path, permission, x-idempotency]
const OPS: Array<[string, string, string, string, string]> = [
  ['listDrivers', 'get', '/v1/instruments/drivers', 'instruments.instrument.read', 'none'],
  ['listInstruments', 'get', '/v1/instruments/instruments', 'instruments.instrument.read', 'none'],
  ['createInstrument', 'post', '/v1/instruments/instruments', 'instruments.instrument.manage', 'required'],
  ['getInstrument', 'get', '/v1/instruments/instruments/{instrument_id}', 'instruments.instrument.read', 'none'],
  ['updateInstrument', 'patch', '/v1/instruments/instruments/{instrument_id}', 'instruments.instrument.manage', 'none'],
  ['startInstrumentCommissioning', 'post', '/v1/instruments/instruments/{instrument_id}/start-commissioning', 'instruments.instrument.manage', 'optional'],
  ['goLiveInstrument', 'post', '/v1/instruments/instruments/{instrument_id}/go-live', 'instruments.instrument.manage', 'optional'],
  ['suspendInstrument', 'post', '/v1/instruments/instruments/{instrument_id}/suspend', 'instruments.instrument.manage', 'optional'],
  ['resumeInstrument', 'post', '/v1/instruments/instruments/{instrument_id}/resume', 'instruments.instrument.manage', 'optional'],
  ['retireInstrument', 'post', '/v1/instruments/instruments/{instrument_id}/retire', 'instruments.instrument.manage', 'optional'],
  ['listObservedInstrumentCodes', 'get', '/v1/instruments/instruments/{instrument_id}/observed-codes', 'instruments.instrument.read', 'none'],
  ['getInstrumentSettings', 'get', '/v1/instruments/settings', 'instruments.instrument.read', 'none'],
  ['updateInstrumentSettings', 'put', '/v1/instruments/settings', 'instruments.instrument.manage', 'none'],
];
const TRANSITIONS = ['startInstrumentCommissioning', 'goLiveInstrument', 'suspendInstrument', 'resumeInstrument', 'retireInstrument'];
const code = (id: string) => operation(id).op['x-error-codes'] as string[];

describe('E22-E32 / E40-E41 route table (TRD §7.3)', () => {
  it.each(OPS)('%s: method, path, x-permission, x-idempotency match the TRD', (id, method, path, perm, idem) => {
    const o = operation(id);
    expect([o.method, o.path]).toEqual([method, path]);
    expect(o.op['x-permission']).toBe(perm);
    expect(o.op['x-idempotency']).toBe(idem);
    expect(o.op.security).toEqual([{ bearerJwt: [] }]);
  });
  it('every state-changing instrument op and E41 take If-Match; E26 and E27-E31 can answer 409 (version/transition) and 428 (missing If-Match)', () => {
    for (const id of ['updateInstrument', ...TRANSITIONS, 'updateInstrumentSettings']) {
      const refs = JSON.stringify(operation(id).op.parameters);
      expect(refs, id).toContain('IfMatch');
      expect(Object.keys(operation(id).op.responses), id).toEqual(expect.arrayContaining(['409', '428']));
      expect(code(id), id).toEqual(expect.arrayContaining(['common.version_conflict', 'common.precondition_required']));
    }
  });
  it('rule-bearing error codes are declared where AC-03/AC-04 need them', () => {
    expect(code('createInstrument')).toEqual(expect.arrayContaining(['instruments.code_duplicate', 'instruments.capability_not_supported', 'instruments.driver_not_available', 'instruments.agent_not_active', 'common.validation_failed']));
    expect(code('updateInstrument')).toEqual(expect.arrayContaining(['instruments.capability_not_supported', 'instruments.driver_not_available', 'instruments.invalid_transition']));
    expect(code('goLiveInstrument')).toEqual(expect.arrayContaining(['instruments.driver_not_available', 'instruments.go_live_checklist_incomplete', 'instruments.invalid_transition']));
    for (const id of ['startInstrumentCommissioning', 'suspendInstrument', 'resumeInstrument', 'retireInstrument']) expect(code(id), id).toContain('instruments.invalid_transition');
    expect(code('startInstrumentCommissioning')).toContain('instruments.driver_not_available');
  });
  it('422 is declared on the ops that return a rule violation (create, update, commissioning, go-live)', () => {
    for (const id of ['createInstrument', 'updateInstrument', 'startInstrumentCommissioning', 'goLiveInstrument']) expect(Object.keys(operation(id).op.responses), id).toContain('422');
  });
  it('every op can answer 403 and 404 (BOLA: load under RLS, then assertRole at the object centre)', () => {
    for (const [id] of OPS) expect(Object.keys(operation(id).op.responses), id).toEqual(expect.arrayContaining(['403', '404']));
  });
  it('E41 documents the settings_changed fan-out (every non-retired agent of the tenant)', () => {
    expect(operation('updateInstrumentSettings').op.description).toMatch(/settings_changed/);
    expect(operation('updateInstrumentSettings').op.description).toMatch(/every non-retired agent/);
  });
});

describe('request bodies (AC-03.1/03.2/04.3 inputs are closed and bounded)', () => {
  it('InstrumentCreate / InstrumentUpdate / InstrumentSettingsUpdate / GoLiveChecklist reject unknown properties (mass assignment)', () => {
    for (const n of ['InstrumentCreate', 'InstrumentUpdate', 'InstrumentSettingsUpdate', 'GoLiveChecklist', 'InstrumentCapabilities']) expect(spec.components.schemas[n].additionalProperties, n).toBe(false);
  });
  it('InstrumentUpdate omits the immutable / server-owned fields', () => {
    const props = Object.keys(spec.components.schemas.InstrumentUpdate.properties);
    for (const f of ['instrument_code', 'agent_id', 'centre_id', 'tenant_id', 'state', 'version', 'go_live_checklist', 'id']) expect(props, f).not.toContain(f);
  });
  it('InstrumentCreate does not accept state / centre_id (centre comes from the agent)', () => {
    const props = Object.keys(spec.components.schemas.InstrumentCreate.properties);
    for (const f of ['state', 'centre_id', 'tenant_id', 'version', 'id']) expect(props, f).not.toContain(f);
  });
  it('GoLiveChecklist = exactly the four booleans; go-live body requires checklist + evidence_note (10-2000 chars)', () => {
    const c = spec.components.schemas.GoLiveChecklist;
    expect(c.required.sort()).toEqual(['manual_reference_confirmed', 'mappings_reviewed', 'qc_comparison_done', 'sample_comparison_done']);
    expect(Object.values<any>(c.properties).every((p) => p.type === 'boolean')).toBe(true);
    const body = operation('goLiveInstrument').op.requestBody.content['application/json'].schema;
    expect(body.required.sort()).toEqual(['checklist', 'evidence_note']);
    expect(body.properties.evidence_note).toMatchObject({ minLength: 10, maxLength: 2000 });
  });
  it('suspend / retire require reason_text of 3-300 chars', () => {
    for (const id of ['suspendInstrument', 'retireInstrument']) {
      const b = operation(id).op.requestBody.content['application/json'].schema;
      expect(b.required, id).toEqual(['reason_text']); expect(b.properties.reason_text, id).toMatchObject({ minLength: 3, maxLength: 300 });
    }
  });
  it('settings ranges equal 05-SCHEMA §2.17 and the window pair is HH:MM', () => {
    const p = spec.components.schemas.InstrumentSettingsUpdate.properties;
    expect(p.default_backlog_threshold).toMatchObject({ minimum: 10, maximum: 100000 });
    expect(p.backlog_max_oldest_pending_seconds).toMatchObject({ minimum: 60, maximum: 86400 });
    expect(p.clock_offset_warn_seconds).toMatchObject({ minimum: 30, maximum: 3600 });
    expect(p.agent_uploaded_retention_hours).toMatchObject({ minimum: 1, maximum: 72 });
    for (const k of ['update_window_from', 'update_window_to']) expect(p[k].pattern).toBe('^([01][0-9]|2[0-3]):[0-5][0-9]$');
  });
  it('no raw-archive retention field exists in settings (it is a C2 tenant setting — 08 A13 D-42)', () => {
    expect(propertyNames(spec.components.schemas.InstrumentSettings).filter((n) => /retention/i.test(n))).toEqual(['agent_uploaded_retention_hours']);
  });
});

describe('S-04 privilege: instrument.manage is privileged (aal2 enforced by the core from permissions.yaml); read is not', () => {
  const perms = parse(readFileSync(join(REPO_ROOT, 'contracts', 'permissions.yaml'), 'utf8'));
  const list: Array<{ code: string; privileged: boolean; roles: string[] }> = Array.isArray(perms) ? perms : (perms.permissions ?? Object.values(perms).find(Array.isArray));
  const p = (c: string) => list.find((x) => x.code === c);
  it('instruments.instrument.manage privileged:true, lab_manager only (no technologist)', () => {
    expect(p('instruments.instrument.manage')).toMatchObject({ privileged: true, roles: ['lab_manager'] });
  });
  it('instruments.instrument.read privileged:false and includes lab_technologist', () => {
    expect(p('instruments.instrument.read')).toMatchObject({ privileged: false });
    expect(p('instruments.instrument.read')!.roles).toContain('lab_technologist');
  });
  it('every op in E22-E32/E40-E41 uses one of those two permissions only', () => {
    for (const [id] of OPS) expect(['instruments.instrument.read', 'instruments.instrument.manage'], id).toContain(operation(id).op['x-permission']);
  });
});

describe('response schemas are closed and carry no internals (S-06)', () => {
  const FORBIDDEN = ['tenant_id', 'created_by', 'updated_by', 'is_active_row', 'secret_sha256', 'raw_bytes', 'cap_host_query', 'cap_worklist_download', 'go_live_checklist_row'];
  it('Instrument, InstrumentSummary, Driver, ObservedCode, InstrumentSettings: additionalProperties false', () => {
    for (const n of ['Instrument', 'InstrumentSummary', 'Driver', 'ObservedCode', 'InstrumentSettings']) expect(spec.components.schemas[n].additionalProperties, n).toBe(false);
  });
  it.each(OPS)('%s success schema names no table-internal column', (id) => {
    const names = new Set<string>();
    for (const [status, r] of Object.entries<any>(operation(id).op.responses ?? {})) if (/^2/.test(status)) for (const n of propertyNames(r?.content?.['application/json']?.schema)) names.add(n);
    expect([...names].filter((n) => FORBIDDEN.includes(n))).toEqual([]);
  });
  it('E32 ObservedCode has the AC-17.1 fields: record_class, instrument_analyte_code, last_mapping_status (mapped|unmapped), seen_count, first/last seen', () => {
    const o = spec.components.schemas.ObservedCode;
    expect(o.required).toEqual(expect.arrayContaining(['instrument_id', 'record_class', 'instrument_analyte_code', 'first_seen_at', 'last_seen_at', 'seen_count', 'last_mapping_status', 'last_mapping_checked_at']));
    expect(o.properties.last_mapping_status.enum).toEqual(['mapped', 'unmapped']);
    expect(o.properties.record_class.enum).toEqual(['patient', 'qc', 'calibrator']);
  });
  it('E22 Driver exposes status generic|verified|sketch_blocked and the five capability flags', () => {
    const d = spec.components.schemas.Driver;
    expect(d.properties.status.enum).toEqual(['generic', 'verified', 'sketch_blocked']);
    expect(Object.keys(d.properties.capabilities.properties ?? spec.components.schemas[(d.properties.capabilities.$ref ?? '').split('/').pop()]?.properties ?? {}).sort()).toEqual(['attachments', 'calibration', 'host_query', 'qc', 'worklist_download']);
  });
});
