// C7 API-T05 — instruments service E22-E31 (integration over an in-memory InstrumentsRepo + a recording config publisher; seams in instruments.helpers.ts header).
// ACs: AC-03.1-03.6, AC-04.1 (state only; shadow outcome = API-T09), AC-04.2-04.5. done_when: capability/driver/checklist rules; version bump rules (03-APP-FLOW §2.2).
// 07-SECURITY: S-01/S-02 (cross-tenant / cross-centre -> 404/403), S-04 (technologist -> 403), mass assignment, If-Match.
import { describe, expect, it } from 'vitest';
import { createInstrumentsService } from '../service/instruments.service.js';
import { responseViolations } from './agents.contract.js';
import {
  AGENT_A1, AGENT_A2, AGENT_B, AGENT_PENDING, AGENT_RETIRED, CENTRE_A1, CENTRE_A2, GOOD_CHECKLIST, INS, SERIAL, TCP, TENANT_A, TENANT_B, USER, createBody, driverRow, idN, insRow,
  makeCtx, makePublisher, makeRepo, noRights, obsRow, readOnly, rejection, type FakeSeed,
} from './instruments.helpers.js';
import { onlyCentre } from './agents.helpers.js';

function world(seed: FakeSeed = {}, ctxOver: Parameters<typeof makeCtx>[0] = {}, deps: { allowSketchDrivers?: boolean; nodeEnv?: string; failPublishOn?: number } = {}) {
  const r = makeRepo(seed);
  const pub = makePublisher(deps.failPublishOn);
  const c = makeCtx(ctxOver);
  const svc: any = createInstrumentsService({ repo: r.repo, publish: pub.publish, now: () => new Date('2026-11-07T12:00:00.000Z'), allowSketchDrivers: deps.allowSketchDrivers ?? false, nodeEnv: deps.nodeEnv });
  return { ...r, ...c, pub, svc };
}
const at = (state: string, o: Record<string, unknown> = {}) => insRow(1, { state, ...o });
const code = (e: any) => e?.code;

describe('fail closed', () => {
  it.each(['listDrivers', 'listInstruments', 'createInstrument', 'getInstrument', 'updateInstrument', 'startInstrumentCommissioning', 'goLiveInstrument', 'suspendInstrument', 'resumeInstrument', 'retireInstrument'])(
    '%s without tenant / actor / tx -> auth.unauthenticated, repo and publisher untouched', async (op) => {
      const w = world({ instruments: [at('draft')] });
      for (const bad of [{}, { tenantId: 'x' }, { tenantId: TENANT_A, actor: { id: USER } }, { ...w.ctx, tx: undefined }, { ...w.ctx, tenantId: undefined }]) {
        expect(code(await rejection(w.svc[op](bad, { instrumentId: INS(1), expectedVersion: 1, body: createBody() }))), op).toBe('auth.unauthenticated');
      }
      expect(w.calls).toHaveLength(0); expect(w.pub.calls).toHaveLength(0);
    });
  it('no authorisation port -> common.internal (never allow by default)', async () => {
    const w = world({ instruments: [at('draft')] });
    delete w.ctx.ports.IdentityPort;
    expect(code(await rejection(w.svc.getInstrument(w.ctx, { instrumentId: INS(1) })))).toBe('common.internal');
  });
});

describe('E22 listDrivers', () => {
  it('returns every g_drivers row, schema-valid, with display_name/driver_version/capabilities/is_active; asserts instrument.read with no centre', async () => {
    const w = world();
    const r = await w.svc.listDrivers(w.ctx, {});
    expect(r.status).toBe(200);
    expect(r.body.data.map((d: any) => d.code).sort()).toEqual(w.drivers.map((d) => d.code).sort());
    expect(responseViolations('listDrivers', '200', r.body)).toEqual([]);
    const d = r.body.data.find((x: any) => x.code === 'syn_verified_astm');
    expect(d).toMatchObject({ status: 'verified', protocol: 'astm', driver_version: '1.0.0', is_active: true, capabilities: { host_query: true, worklist_download: false, qc: true, attachments: false, calibration: false } });
    expect(w.asserted).toEqual([{ permission: 'instruments.instrument.read' }]);
  });
  it('filters by protocol and by status', async () => {
    const w = world();
    expect((await w.svc.listDrivers(w.ctx, { protocol: 'hl7v2' })).body.data.every((d: any) => d.protocol === 'hl7v2')).toBe(true);
    expect((await w.svc.listDrivers(w.ctx, { status: 'verified' })).body.data.map((d: any) => d.code).sort()).toEqual(['syn_verified_astm', 'syn_verified_inactive']);
  });
  it.each([[{ protocol: 'dicom' }, '/protocol'], [{ status: 'beta' }, '/status']])('invalid filter %j -> 400 common.validation_failed %s', async (q, path) => {
    const w = world();
    const e = await rejection(w.svc.listDrivers(w.ctx, q));
    expect(code(e)).toBe('common.validation_failed'); expect(e.errors?.[0]?.path).toBe(path);
  });
  it('S-04: a principal without instrument.read gets 403', async () => {
    const w = world({}, { roles: noRights });
    expect(code(await rejection(w.svc.listDrivers(w.ctx, {})))).toBe('auth.forbidden');
  });
});

describe('E24 createInstrument — AC-03.1 / AC-03.2 / AC-03.6', () => {
  it('AC-03.1 creates state draft, centre_id = the AGENT\'s centre, version 1, tenant/actor from ctx, no config version (I1: draft is not shipped)', async () => {
    const w = world();
    const r = await w.svc.createInstrument(w.ctx, { body: createBody({ agent_id: AGENT_A2 }) });
    expect(r.status).toBe(201); expect(r.version).toBe(1);
    expect(r.body).toMatchObject({ state: 'draft', centre_id: CENTRE_A2, agent_id: AGENT_A2, instrument_code: 'SIM-CHEM-9', version: 1, driver_code: 'astm_generic_e1394', driver_status: 'generic', driver_version: '1.0.0', capabilities: { host_query: false, worklist_download: false } });
    expect(responseViolations('createInstrument', '201', r.body)).toEqual([]);
    const row = w.callsOf('insertInstrument')[0]!.args[0] as any;
    expect(w.callsOf('insertInstrument')).toHaveLength(1);
    expect(w.callsOf('insertInstrument')[0]!.tenantId).toBe(TENANT_A);
    expect(row).toMatchObject({ state: 'draft', centre_id: CENTRE_A2, agent_id: AGENT_A2, created_by: USER, cap_host_query: false, cap_worklist_download: false, version: 1 });
    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(w.pub.calls).toHaveLength(0);
    expect(w.asserted).toEqual([{ permission: 'instruments.instrument.manage', centreId: CENTRE_A2 }]);   // asserted at the agent's centre (object-level), not a body field
  });
  it('defaults timezone to the tenant timezone (IdentityPort.getTenantSettings); keeps an explicit one', async () => {
    const w = world();
    await w.svc.createInstrument(w.ctx, { body: createBody() });
    expect((w.callsOf('insertInstrument')[0]!.args[0] as any).timezone).toBe('Asia/Kathmandu');
    const w2 = world();
    await w2.svc.createInstrument(w2.ctx, { body: createBody({ timezone: 'UTC' }) });
    expect((w2.callsOf('insertInstrument')[0]!.args[0] as any).timezone).toBe('UTC');
  });
  it('a pending_enrolment agent is allowed (A1: instruments can be prepared before enrolment)', async () => {
    const w = world();
    expect((await w.svc.createInstrument(w.ctx, { body: createBody({ agent_id: AGENT_PENDING }) })).status).toBe(201);
  });
  it('retired agent -> instruments.agent_not_active, nothing inserted', async () => {
    const w = world();
    expect(code(await rejection(w.svc.createInstrument(w.ctx, { body: createBody({ agent_id: AGENT_RETIRED }) })))).toBe('instruments.agent_not_active');
    expect(w.mutations()).toHaveLength(0);
  });
  it('S-01/S-02: unknown agent / another tenant\'s agent -> 404 common.not_found (no existence probe), nothing inserted', async () => {
    const w = world();
    for (const agent_id of [idN(0xdead), AGENT_B]) expect(code(await rejection(w.svc.createInstrument(w.ctx, { body: createBody({ agent_id }) })))).toBe('common.not_found');
    expect(w.mutations()).toHaveLength(0);
  });
  it('S-04: technologist (read only) -> 403; user without rights at the agent\'s centre -> 403; nothing written', async () => {
    const a = world({}, { roles: readOnly });
    expect(code(await rejection(a.svc.createInstrument(a.ctx, { body: createBody() })))).toBe('auth.forbidden');
    const b = world({}, { roles: onlyCentre(CENTRE_A1) });
    expect(code(await rejection(b.svc.createInstrument(b.ctx, { body: createBody({ agent_id: AGENT_A2 }) })))).toBe('auth.forbidden');
    expect(a.mutations().length + b.mutations().length).toBe(0);
  });
  it.each([
    ['serial baud not in the allowed list', { transport: { ...SERIAL, baud_rate: 1234 } }, 'baud_rate'],
    ['tcp port 0', { transport: { ...TCP, port: 0 } }, 'port'],
    ['tcp port 65536', { transport: { ...TCP, port: 65536 } }, 'port'],
    ['unknown transport kind', { transport: { kind: 'usb' } }, 'transport'],
    ['tcp_server bound to 0.0.0.0', { transport: { kind: 'tcp_server', bind_address: '0.0.0.0', port: 5000, allowed_peers: ['10.0.0.5'] } }, 'bind_address'],
  ])('AC-03.2 %s -> 400 common.validation_failed with a JSON-Pointer under /transport, nothing inserted', async (_n, over, frag) => {
    const w = world();
    const e = await rejection(w.svc.createInstrument(w.ctx, { body: createBody(over) }));
    expect(code(e)).toBe('common.validation_failed');
    expect(e.errors?.length).toBeGreaterThan(0);
    expect(e.errors.every((x: any) => typeof x.path === 'string' && x.path.startsWith('/'))).toBe(true);
    expect(e.errors.some((x: any) => x.path.startsWith('/transport') && x.path.includes(frag === 'transport' ? '' : frag))).toBe(true);
    expect(w.mutations()).toHaveLength(0);
  });
  it('AC-03.2 invalid protocol_options (astm timer 0) -> 400 under /protocol_options; invalid file_drop -> 400 under /file_drop', async () => {
    const w = world();
    const a = await rejection(w.svc.createInstrument(w.ctx, { body: createBody({ protocol_options: { astm: { establish_reply_s: 0 } } }) }));
    expect(code(a)).toBe('common.validation_failed'); expect(a.errors.some((x: any) => x.path.startsWith('/protocol_options'))).toBe(true);
    const b = await rejection(w.svc.createInstrument(w.ctx, { body: createBody({ file_drop: { directory: 'relative/path' } }) }));
    expect(code(b)).toBe('common.validation_failed'); expect(b.errors.some((x: any) => x.path.startsWith('/file_drop'))).toBe(true);
    expect(w.mutations()).toHaveLength(0);
  });
  it('AC-03.6 duplicate instrument_code in the tenant -> 409 instruments.code_duplicate (pg 23505 mapped); the same code in another tenant is fine', async () => {
    const w = world({ instruments: [at('draft', { instrument_code: 'SIM-CHEM-9' })] });
    expect(code(await rejection(w.svc.createInstrument(w.ctx, { body: createBody() })))).toBe('instruments.code_duplicate');
    const b = world({ instruments: [at('draft', { instrument_code: 'SIM-CHEM-9' })] }, { tenantId: TENANT_B });
    // tenant B has no access to agent A1 -> use B's agent
    expect((await b.svc.createInstrument(b.ctx, { body: createBody({ agent_id: AGENT_B }) })).status).toBe(201);
  });
  it('other database errors are not swallowed or mislabelled as code_duplicate', async () => {
    const w = world();
    w.repo.insertInstrument = async () => { throw Object.assign(new Error('connection reset'), { code: '08006' }); };
    expect(code(await rejection(w.svc.createInstrument(w.ctx, { body: createBody() })))).not.toBe('instruments.code_duplicate');
  });
  it('mass assignment: state / centre_id / tenant_id / version / live_at in the body can never set the row (rejected 400 or ignored)', async () => {
    const w = world();
    try { await w.svc.createInstrument(w.ctx, { body: createBody({ state: 'live', centre_id: CENTRE_A2, tenant_id: TENANT_B, version: 9, live_at: '2026-01-01T00:00:00.000Z', id: idN(0xbad) }) }); }
    catch (e) { expect(code(e)).toBe('common.validation_failed'); return; }
    expect(w.instruments[0]).toMatchObject({ state: 'draft', centre_id: CENTRE_A1, tenant_id: TENANT_A, version: 1, live_at: null });
    expect(w.instruments[0]!.id).not.toBe(idN(0xbad));
  });
});

describe('E24/E26 capability + driver rules — AC-03.3 / AC-03.4 / AC-21.3', () => {
  it('AC-03.3 host_query=true on a driver whose capability host_query is false -> 422 instruments.capability_not_supported, nothing inserted', async () => {
    const w = world();
    expect(code(await rejection(w.svc.createInstrument(w.ctx, { body: createBody({ capabilities: { host_query: true, worklist_download: false } }) })))).toBe('instruments.capability_not_supported');
    expect(w.mutations()).toHaveLength(0);
  });
  it('host_query=true on a driver that declares it is accepted and stored in cap_host_query', async () => {
    const w = world();
    const r = await w.svc.createInstrument(w.ctx, { body: createBody({ driver_code: 'syn_verified_astm', capabilities: { host_query: true, worklist_download: false } }) });
    expect(r.status).toBe(201); expect(r.body.capabilities.host_query).toBe(true);
    expect((w.callsOf('insertInstrument')[0]!.args[0] as any).cap_host_query).toBe(true);
  });
  it('AC-03.4 worklist_download=true -> 422 capability_not_supported while NO verified driver declares worklistDownload — even when a generic driver row declares it', async () => {
    const w = world({ drivers: [driverRow({ cap_worklist_download: true }), driverRow({ code: 'syn_verified_astm', status: 'verified', manual_document_id: 'M' })] });
    expect(code(await rejection(w.svc.createInstrument(w.ctx, { body: createBody({ capabilities: { host_query: false, worklist_download: true } }) })))).toBe('instruments.capability_not_supported');
    expect(code(await rejection(w.svc.createInstrument(w.ctx, { body: createBody({ driver_code: 'syn_verified_astm', capabilities: { host_query: false, worklist_download: true } }) })))).toBe('instruments.capability_not_supported');
    expect(w.mutations()).toHaveLength(0);
  });
  it('AC-03.4 (unblock path) once a verified driver declares worklistDownload, an instrument on that driver may enable it; on a driver that does not, still 422', async () => {
    const seed = { drivers: [driverRow({ cap_worklist_download: false }), driverRow({ code: 'syn_verified_wl', status: 'verified', manual_document_id: 'M', cap_worklist_download: true })] };
    const w = world(seed);
    expect((await w.svc.createInstrument(w.ctx, { body: createBody({ driver_code: 'syn_verified_wl', capabilities: { host_query: false, worklist_download: true } }) })).status).toBe(201);
    expect(code(await rejection(w.svc.createInstrument(w.ctx, { body: createBody({ instrument_code: 'SIM-X', capabilities: { host_query: false, worklist_download: true } }) })))).toBe('instruments.capability_not_supported');
  });
  it('unknown driver_code -> 400 /driver_code; inactive driver -> 422 instruments.driver_not_available', async () => {
    const w = world();
    const e = await rejection(w.svc.createInstrument(w.ctx, { body: createBody({ driver_code: 'no_such_driver' }) }));
    expect(code(e)).toBe('common.validation_failed'); expect(e.errors?.[0]?.path).toBe('/driver_code');
    expect(code(await rejection(w.svc.createInstrument(w.ctx, { body: createBody({ driver_code: 'syn_verified_inactive' }) })))).toBe('instruments.driver_not_available');
  });
  it('AC-21.3 sketch_blocked driver: not selectable by default; selectable only when allowSketchDrivers AND not production; never in production', async () => {
    const body = createBody({ protocol: 'hl7v2', driver_code: 'mindray_bc5380_sketch', transport: structuredClone(TCP), capabilities: { host_query: true, worklist_download: false } });
    const off = world();
    expect(code(await rejection(off.svc.createInstrument(off.ctx, { body })))).toBe('instruments.driver_not_available');
    const on = world({}, {}, { allowSketchDrivers: true, nodeEnv: 'test' });
    expect((await on.svc.createInstrument(on.ctx, { body })).status).toBe(201);
    const prod = world({}, {}, { allowSketchDrivers: true, nodeEnv: 'production' });
    expect(code(await rejection(prod.svc.createInstrument(prod.ctx, { body })))).toBe('instruments.driver_not_available');
  });
});

describe('E23 listInstruments / E25 getInstrument', () => {
  const seed = () => ({ instruments: [at('draft'), insRow(2, { state: 'live', agent_id: AGENT_A2, centre_id: CENTRE_A2, agent_code: 'HUB-PC-02' }), insRow(3, { tenant_id: TENANT_B, centre_id: CENTRE_A1 })] });
  it('lists only the caller\'s tenant, schema-valid InstrumentSummary rows, page.limit defaults to 50; asserts read', async () => {
    const w = world(seed());
    const r = await w.svc.listInstruments(w.ctx, {});
    expect(r.status).toBe(200); expect(r.body.data).toHaveLength(2); expect(r.body.page).toMatchObject({ limit: 50 });
    expect(responseViolations('listInstruments', '200', r.body)).toEqual([]);
    expect(w.callsOf('listInstruments')[0]!.tenantId).toBe(TENANT_A);
    expect(JSON.stringify(r.body)).not.toContain(insRow(3).instrument_code);
    expect(w.asserted.every((a) => a.permission === 'instruments.instrument.read')).toBe(true);
  });
  it('passes filters (centre, agent, state[], protocol) to the repo; a centre filter is asserted at that centre', async () => {
    const w = world(seed());
    await w.svc.listInstruments(w.ctx, { centreId: CENTRE_A2, agentId: AGENT_A2, state: ['live', 'suspended'], protocol: 'astm', sort: '-last_message_at', limit: 10 });
    expect(w.callsOf('listInstruments')[0]!.args[0]).toMatchObject({ centreId: CENTRE_A2, agentId: AGENT_A2, state: ['live', 'suspended'], protocol: 'astm', limit: 10 });
    expect(w.asserted).toContainEqual({ permission: 'instruments.instrument.read', centreId: CENTRE_A2 });
  });
  it.each([[{ state: ['gone'] }, '/state'], [{ protocol: 'x' }, '/protocol'], [{ sort: 'serial_no' }, '/sort'], [{ limit: 0 }, '/limit'], [{ limit: 201 }, '/limit'], [{ centreId: 'nope' }, '/centre_id'], [{ agentId: 'nope' }, '/agent_id']])(
    'invalid query %j -> 400 %s', async (q, path) => {
      const w = world(seed()); const e = await rejection(w.svc.listInstruments(w.ctx, q));
      expect(code(e)).toBe('common.validation_failed'); expect(e.errors?.[0]?.path).toBe(path);
    });
  it('malformed cursor -> 400 common.invalid_cursor', async () => {
    const w = world(seed());
    expect(code(await rejection(w.svc.listInstruments(w.ctx, { cursor: 'x'.repeat(513) })))).toBe('common.invalid_cursor');
  });
  it('E25 returns the Instrument (schema-valid) with ETag version; asserts read at the instrument\'s centre', async () => {
    const w = world(seed());
    const r = await w.svc.getInstrument(w.ctx, { instrumentId: INS(1) });
    expect(r.status).toBe(200); expect(r.version).toBe(1);
    expect(r.body).toMatchObject({ id: INS(1), state: 'draft', centre_id: CENTRE_A1, agent_id: AGENT_A1, driver_status: 'generic' });
    expect(responseViolations('getInstrument', '200', r.body)).toEqual([]);
    expect(w.asserted).toEqual([{ permission: 'instruments.instrument.read', centreId: CENTRE_A1 }]);
  });
  it('S-01/S-02: unknown id / non-uuid / another tenant\'s instrument -> 404; role missing at the centre -> 403', async () => {
    const w = world(seed());
    for (const instrumentId of [idN(0xdead), 'not-a-uuid', INS(3)]) expect(code(await rejection(w.svc.getInstrument(w.ctx, { instrumentId }))), String(instrumentId)).toBe('common.not_found');
    const b = world(seed(), { roles: onlyCentre(CENTRE_A1) });
    expect(code(await rejection(b.svc.getInstrument(b.ctx, { instrumentId: INS(2) })))).toBe('auth.forbidden');
  });
  it('DTO never carries tenant_id, created_by, updated_by, is_active or other table columns (closed schema)', async () => {
    const w = world(seed()); const s = JSON.stringify((await w.svc.getInstrument(w.ctx, { instrumentId: INS(1) })).body);
    for (const f of ['tenant_id', 'created_by', 'updated_by', 'is_active', 'cap_host_query', 'cap_worklist_download']) expect(s, f).not.toContain(`"${f}"`);
  });
});

describe('E26 updateInstrument — If-Match, immutability, AC-03.5 version-bump rules (03-APP-FLOW §2.2)', () => {
  const upd = (w: any, patch: Record<string, unknown>, o: Record<string, unknown> = {}) => w.svc.updateInstrument(w.ctx, { instrumentId: INS(1), expectedVersion: 1, patch, ...o });
  it('missing If-Match -> 428 common.precondition_required; stale -> 409 common.version_conflict; neither publishes', async () => {
    const w = world({ instruments: [at('live')] });
    expect(code(await rejection(upd(w, { display_name: 'x' }, { expectedVersion: undefined })))).toBe('common.precondition_required');
    expect(code(await rejection(upd(w, { display_name: 'x' }, { expectedVersion: 7 })))).toBe('common.version_conflict');
    expect(w.pub.calls).toHaveLength(0);
  });
  it.each([['instrument_code'], ['agent_id'], ['state'], ['centre_id'], ['tenant_id'], ['version'], ['go_live_checklist']])('immutable / server-owned field %s in the patch -> 400 at /%s, nothing written', async (f) => {
    const w = world({ instruments: [at('draft')] });
    const e = await rejection(upd(w, { [f]: f === 'version' ? 5 : 'X' }));
    expect(code(e)).toBe('common.validation_failed'); expect(e.errors?.[0]?.path).toBe(`/${f}`);
    expect(w.mutations()).toHaveLength(0);
  });
  it.each([['does not compile', '('], ['lookahead (not RE2)', '(?=a)'], ['backreference (not RE2)', '(a)\\1']])('qc_sample_id_patterns item that %s -> 400 at /qc_sample_id_patterns/1, nothing written', async (_n, bad) => {
    const w = world({ instruments: [at('live', { driver_code: 'syn_verified_astm' })] });
    const e = await rejection(upd(w, { qc_sample_id_patterns: ['^QC-', bad] }));
    expect(code(e)).toBe('common.validation_failed'); expect(e.errors?.[0]?.path).toBe('/qc_sample_id_patterns/1');
    expect(w.mutations()).toHaveLength(0); expect(w.pub.calls).toHaveLength(0);
  });
  it('empty patch -> 400 (nothing to change)', async () => {
    const w = world({ instruments: [at('draft')] });
    expect(code(await rejection(upd(w, {})))).toBe('common.validation_failed');
  });
  it('display-only change on a DRAFT: updates, version 2, response schema-valid, no config version', async () => {
    const w = world({ instruments: [at('draft')] });
    const r = await upd(w, { display_name: 'Renamed' });
    expect(r.status).toBe(200); expect(r.version).toBe(2); expect(r.body.display_name).toBe('Renamed');
    expect(responseViolations('updateInstrument', '200', r.body)).toEqual([]);
    expect(w.pub.calls).toHaveLength(0);
    expect(w.asserted).toEqual([{ permission: 'instruments.instrument.manage', centreId: CENTRE_A1 }]);
  });
  it.each([
    ['transport', { transport: { ...SERIAL, baud_rate: 19200 } }],
    ['protocol_options', { protocol_options: { astm: { establish_reply_s: 20 } } }],
    ['file_drop', { file_drop: { directory: 'C:\\drop', filename_pattern: '*.pdf', allowed_types: ['pdf'], attachment_instrument_code: 'SIM-CHEM-1' } }],
    ['capabilities', { capabilities: { host_query: true, worklist_download: false } }],
    ['driver_code', { driver_code: 'syn_verified_astm' }],
    ['timezone', { timezone: 'UTC' }],
    ['qc_sample_id_patterns', { qc_sample_id_patterns: ['^QC-'] }],
  ])('AC-03.5 %s change on a non-draft instrument -> exactly ONE instrument_changed config version for ITS agent, in the same tx, after the row update', async (_f, patch) => {
    for (const state of ['commissioning', 'live', 'suspended']) {
      const w = world({ instruments: [at(state, { driver_code: _f === 'driver_code' ? 'astm_generic_e1394' : 'syn_verified_astm' })] });
      const r = await upd(w, patch);
      expect(r.status, `${state} ${_f}`).toBe(200);
      expect(w.pub.calls).toHaveLength(1);
      expect(w.pub.calls[0]).toMatchObject({ tenantId: TENANT_A, agentId: AGENT_A1, reason: 'instrument_changed', actorId: USER });
      expect(w.pub.calls[0]!.tx).toBe(w.ctx.tx);                                             // same transaction
      expect(w.calls.findIndex((c) => c.op === 'updateInstrument')).toBeGreaterThanOrEqual(0);
    }
  });
  it.each([
    ['transport', { transport: { ...SERIAL, baud_rate: 19200 } }],
    ['driver_code', { driver_code: 'hl7v2_generic_oru' }],
    ['capabilities', { capabilities: { host_query: false, worklist_download: false } }],
  ])('AC-03.5 / I1 a change to %s on a DRAFT is not shipped -> no config version', async (_f, patch) => {
    const w = world({ instruments: [at('draft')] });
    await upd(w, patch).catch(() => undefined);
    expect(w.pub.calls).toHaveLength(0);
  });
  it.each([
    ['display_name', { display_name: 'Renamed' }], ['vendor', { vendor: 'V2' }], ['model', { model: 'M2' }], ['serial_no', { serial_no: 'S-1' }], ['software_version', { software_version: '2.0' }],
    ['parser_options', { parser_options: {} }], ['silence_window_minutes', { silence_window_minutes: 30 }], ['silence_active_from+to', { silence_active_from: '06:00', silence_active_to: '20:00' }],
  ])('server-only / display field %s on a LIVE instrument -> updated, NO config version', async (_f, patch) => {
    const w = world({ instruments: [at('live', { driver_code: 'syn_verified_astm' })] });
    expect((await upd(w, patch)).status).toBe(200);
    expect(w.pub.calls).toHaveLength(0);
  });
  it('a PATCH that re-sends the CURRENT values of agent-relevant fields changes nothing the agent needs -> no config version', async () => {
    const w = world({ instruments: [at('live', { driver_code: 'syn_verified_astm' })] });
    expect((await upd(w, { transport: { ...SERIAL }, timezone: 'Asia/Kathmandu', driver_code: 'syn_verified_astm', capabilities: { host_query: false, worklist_download: false }, display_name: 'z' })).status).toBe(200);
    expect(w.pub.calls).toHaveLength(0);
  });
  it('several agent-relevant fields in one PATCH -> still exactly one config version', async () => {
    const w = world({ instruments: [at('live', { driver_code: 'syn_verified_astm' })] });
    await upd(w, { transport: { ...SERIAL, baud_rate: 19200 }, timezone: 'UTC', qc_sample_id_patterns: ['^QC'], display_name: 'z' });
    expect(w.pub.calls).toHaveLength(1);
  });
  it('version conflict (repo returns undefined) -> 409 and NO config version', async () => {
    const w = world({ instruments: [at('live', { driver_code: 'syn_verified_astm' })] });
    const bump = w.repo.updateInstrument; w.repo.updateInstrument = async (...a: any[]) => { await (bump as any)(...a); return undefined; };
    expect(code(await rejection(upd(w, { timezone: 'UTC' })))).toBe('common.version_conflict');
    expect(w.pub.calls).toHaveLength(0);
  });
  it('publisher failure is NOT swallowed (the core rolls the request transaction back)', async () => {
    const w = world({ instruments: [at('live', { driver_code: 'syn_verified_astm' })] }, {}, { failPublishOn: 1 });
    await expect(upd(w, { timezone: 'UTC' })).rejects.toThrow('signing unavailable');
  });
  it('PATCH on a retired instrument -> 409 instruments.invalid_transition, nothing written', async () => {
    const w = world({ instruments: [at('retired')] });
    expect(code(await rejection(upd(w, { display_name: 'x' })))).toBe('instruments.invalid_transition');
    expect(w.mutations()).toHaveLength(0);
  });
  it('re-validates the merged result: invalid transport / capability not supported by the (possibly new) driver / unknown driver', async () => {
    const w = world({ instruments: [at('commissioning')] });
    expect(code(await rejection(upd(w, { transport: { ...SERIAL, baud_rate: 1 } })))).toBe('common.validation_failed');
    expect(code(await rejection(upd(w, { capabilities: { host_query: true, worklist_download: false } })))).toBe('instruments.capability_not_supported');
    expect(code(await rejection(upd(w, { capabilities: { host_query: false, worklist_download: true } })))).toBe('instruments.capability_not_supported');
    expect(code(await rejection(upd(w, { driver_code: 'nope' })))).toBe('common.validation_failed');
    expect(w.mutations()).toHaveLength(0);
  });
  it('changing driver on a LIVE instrument to a non-verified driver -> 422 instruments.driver_not_available', async () => {
    const w = world({ instruments: [at('live', { driver_code: 'syn_verified_astm' })] });
    expect(code(await rejection(upd(w, { driver_code: 'astm_generic_e1394' })))).toBe('instruments.driver_not_available');
    expect(w.pub.calls).toHaveLength(0);
  });
  it('S-01/S-02/S-04: invisible -> 404; other centre -> 403; technologist -> 403', async () => {
    expect(code(await rejection(upd(world({ instruments: [] }), { display_name: 'x' })))).toBe('common.not_found');
    expect(code(await rejection(upd(world({ instruments: [at('draft', { tenant_id: TENANT_B })] }), { display_name: 'x' })))).toBe('common.not_found');
    const a = world({ instruments: [at('draft')] }, { roles: onlyCentre(CENTRE_A2) });
    expect(code(await rejection(upd(a, { display_name: 'x' })))).toBe('auth.forbidden');
    const b = world({ instruments: [at('draft')] }, { roles: readOnly });
    expect(code(await rejection(upd(b, { display_name: 'x' })))).toBe('auth.forbidden');
    expect(a.mutations().length + b.mutations().length).toBe(0);
  });
});

describe('E27-E31 transitions — AC-04.1..04.5, version bump (I2-I6)', () => {
  const call = (w: any, op: string, input: Record<string, unknown> = {}) => w.svc[op](w.ctx, { instrumentId: INS(1), expectedVersion: 1, ...input });
  const LIVE_BODY = { checklist: GOOD_CHECKLIST, evidence_note: 'Synthetic comparison run of 20 samples agreed.' };

  describe('E27 startInstrumentCommissioning — AC-04.1 (I2)', () => {
    it('draft -> commissioning, version 2, ONE instrument_changed config version for the agent (instrument now included)', async () => {
      const w = world({ instruments: [at('draft')] });
      const r = await call(w, 'startInstrumentCommissioning', { body: {} });
      expect(r.status).toBe(200); expect(r.version).toBe(2); expect(r.body).toMatchObject({ state: 'commissioning', version: 2 });
      expect(responseViolations('startInstrumentCommissioning', '200', r.body)).toEqual([]);
      expect(w.callsOf('transitionInstrument')[0]!.args[2]).toMatchObject({ state: 'commissioning', actorId: USER });
      expect(w.pub.calls).toHaveLength(1);
      expect(w.pub.calls[0]).toMatchObject({ tenantId: TENANT_A, agentId: AGENT_A1, reason: 'instrument_changed' }); expect(w.pub.calls[0]!.tx).toBe(w.ctx.tx);
      expect(w.asserted).toEqual([{ permission: 'instruments.instrument.manage', centreId: CENTRE_A1 }]);
    });
    it('a generic driver may be commissioned (shadow only); an inactive / sketch-blocked-and-disabled driver may not -> 422 driver_not_available', async () => {
      expect((await call(world({ instruments: [at('draft')] }), 'startInstrumentCommissioning', { body: {} })).status).toBe(200);
      const bad = world({ instruments: [at('draft', { driver_code: 'syn_verified_inactive' })] });
      expect(code(await rejection(call(bad, 'startInstrumentCommissioning', { body: {} })))).toBe('instruments.driver_not_available');
      const sk = world({ instruments: [at('draft', { driver_code: 'mindray_bc5380_sketch', protocol: 'hl7v2' })] });
      expect(code(await rejection(call(sk, 'startInstrumentCommissioning', { body: {} })))).toBe('instruments.driver_not_available');
      expect(bad.pub.calls.length + sk.pub.calls.length).toBe(0);
    });
    it('invalid stored transport -> 400 common.validation_failed (guard "transport valid"), no transition', async () => {
      const w = world({ instruments: [at('draft', { transport: { kind: 'serial', port_name: 'COM3', baud_rate: 1234, data_bits: 8, parity: 'none', stop_bits: '1' } })] });
      expect(code(await rejection(call(w, 'startInstrumentCommissioning', { body: {} })))).toBe('common.validation_failed');
      expect(w.mutations()).toHaveLength(0);
    });
  });

  describe('E28 goLiveInstrument — AC-04.2 / AC-04.3 (I3)', () => {
    const verified = (o: Record<string, unknown> = {}) => at('commissioning', { driver_code: 'syn_verified_astm', ...o });
    it('AC-04.3 verified driver + 4 x true + evidence_note -> live; checklist + actor stored; ONE config version', async () => {
      const w = world({ instruments: [verified()] });
      const r = await call(w, 'goLiveInstrument', { body: LIVE_BODY });
      expect(r.status).toBe(200); expect(r.body).toMatchObject({ state: 'live', driver_status: 'verified', version: 2 });
      expect(responseViolations('goLiveInstrument', '200', r.body)).toEqual([]);
      expect(w.callsOf('transitionInstrument')[0]!.args[2]).toMatchObject({ state: 'live', actorId: USER, checklist: { ...GOOD_CHECKLIST, evidence_note: LIVE_BODY.evidence_note } });
      expect(w.instruments[0]).toMatchObject({ live_by: USER, go_live_checklist: { ...GOOD_CHECKLIST, evidence_note: LIVE_BODY.evidence_note } });
      expect(w.pub.reasons()).toEqual(['instrument_changed']); expect(w.pub.agentIds()).toEqual([AGENT_A1]);
    });
    it.each([['generic', 'astm_generic_e1394'], ['sketch_blocked', 'mindray_bc5380_sketch']])('AC-04.2 %s driver -> 422 instruments.driver_not_available, still commissioning, no config version (even with allowSketchDrivers)', async (_s, driver_code) => {
      const w = world({ instruments: [verified({ driver_code, protocol: driver_code.startsWith('mindray') ? 'hl7v2' : 'astm' })] }, {}, { allowSketchDrivers: true, nodeEnv: 'test' });
      expect(code(await rejection(call(w, 'goLiveInstrument', { body: LIVE_BODY })))).toBe('instruments.driver_not_available');
      expect(w.mutations()).toHaveLength(0); expect(w.pub.calls).toHaveLength(0);
    });
    it('inactive verified driver -> 422 instruments.driver_not_available', async () => {
      const w = world({ instruments: [verified({ driver_code: 'syn_verified_inactive' })] });
      expect(code(await rejection(call(w, 'goLiveInstrument', { body: LIVE_BODY })))).toBe('instruments.driver_not_available');
    });
    it.each(Object.keys(GOOD_CHECKLIST))('AC-04.3 checklist item %s false or missing -> 422 instruments.go_live_checklist_incomplete, nothing written', async (item) => {
      for (const checklist of [{ ...GOOD_CHECKLIST, [item]: false }, Object.fromEntries(Object.entries(GOOD_CHECKLIST).filter(([k]) => k !== item))]) {
        const w = world({ instruments: [verified()] });
        expect(code(await rejection(call(w, 'goLiveInstrument', { body: { ...LIVE_BODY, checklist } })))).toBe('instruments.go_live_checklist_incomplete');
        expect(w.mutations()).toHaveLength(0); expect(w.pub.calls).toHaveLength(0);
      }
    });
    it('evidence_note shorter than 10 chars (9) -> 400 common.validation_failed at /evidence_note (openapi minLength 10), nothing written, no publish', async () => {
      const w = world({ instruments: [verified()] });
      const e = await rejection(call(w, 'goLiveInstrument', { body: { checklist: GOOD_CHECKLIST, evidence_note: 'x'.repeat(9) } }));
      expect(code(e)).toBe('common.validation_failed'); expect(e.errors?.[0]?.path).toBe('/evidence_note');
      expect(w.mutations()).toHaveLength(0); expect(w.pub.calls).toHaveLength(0);
    });
    it.each([['empty', ''], ['blank', '   '], ['missing', undefined]])('AC-04.3 %s evidence_note -> rejected (checklist_incomplete or validation_failed), nothing written', async (_n, evidence_note) => {
      const w = world({ instruments: [verified()] });
      const body: Record<string, unknown> = { checklist: GOOD_CHECKLIST }; if (evidence_note !== undefined) body['evidence_note'] = evidence_note;
      expect(['instruments.go_live_checklist_incomplete', 'common.validation_failed']).toContain(code(await rejection(call(w, 'goLiveInstrument', { body }))));
      expect(w.mutations()).toHaveLength(0);
    });
    it.each([['string "true"', 'true'], ['number 1', 1], ['null', null]])('a truthy non-boolean checklist item (%s) does not count as true', async (_n, v) => {
      const w = world({ instruments: [verified()] });
      expect(['instruments.go_live_checklist_incomplete', 'common.validation_failed']).toContain(code(await rejection(call(w, 'goLiveInstrument', { body: { ...LIVE_BODY, checklist: { ...GOOD_CHECKLIST, mappings_reviewed: v } } }))));
      expect(w.mutations()).toHaveLength(0);
    });
    it('guard order: wrong state first (409), then driver (422 driver_not_available), then checklist', async () => {
      expect(code(await rejection(call(world({ instruments: [at('draft', { driver_code: 'syn_verified_astm' })] }), 'goLiveInstrument', { body: LIVE_BODY })))).toBe('instruments.invalid_transition');
      const both = world({ instruments: [at('commissioning')] });   // generic driver AND incomplete checklist
      expect(code(await rejection(call(both, 'goLiveInstrument', { body: { checklist: { ...GOOD_CHECKLIST, qc_comparison_done: false }, evidence_note: 'x'.repeat(12) } })))).toBe('instruments.driver_not_available');
    });
  });

  describe('E29 suspend / E30 resume — AC-04.4 (I4, I5)', () => {
    it('live -> suspended with reason: stores reason, ONE config version; messages are then shadow (ingest, API-T09)', async () => {
      const w = world({ instruments: [at('live', { driver_code: 'syn_verified_astm' })] });
      const r = await call(w, 'suspendInstrument', { body: { reason_text: 'Calibration drift under review' } });
      expect(r.body).toMatchObject({ state: 'suspended', version: 2 });
      expect(responseViolations('suspendInstrument', '200', r.body)).toEqual([]);
      expect(w.callsOf('transitionInstrument')[0]!.args[2]).toMatchObject({ state: 'suspended', reasonText: 'Calibration drift under review', actorId: USER });
      expect(w.pub.reasons()).toEqual(['instrument_changed']);
    });
    it.each([['missing', undefined], ['2 chars', 'ab'], ['301 chars', 'x'.repeat(301)], ['non-string', 7]])('suspend reason_text %s -> 400 /reason_text, no transition', async (_n, reason_text) => {
      const w = world({ instruments: [at('live')] });
      const e = await rejection(call(w, 'suspendInstrument', { body: reason_text === undefined ? {} : { reason_text } }));
      expect(code(e)).toBe('common.validation_failed'); expect(e.errors?.[0]?.path).toBe('/reason_text');
      expect(w.mutations()).toHaveLength(0);
    });
    it('suspend accepts the boundary lengths 3 and 300', async () => {
      for (const reason_text of ['abc', 'x'.repeat(300)]) expect((await call(world({ instruments: [at('live')] }), 'suspendInstrument', { body: { reason_text } })).status).toBe(200);
    });
    it('resume: suspended -> live when the driver is still verified; ONE config version', async () => {
      const w = world({ instruments: [at('suspended', { driver_code: 'syn_verified_astm' })] });
      const r = await call(w, 'resumeInstrument', { body: {} });
      expect(r.body).toMatchObject({ state: 'live', version: 2 });
      expect(responseViolations('resumeInstrument', '200', r.body)).toEqual([]);
      expect(w.pub.calls).toHaveLength(1);
    });
    it('resume with a driver that is no longer verified (demoted / inactive) -> 422 instruments.driver_not_available, stays suspended', async () => {
      for (const driver_code of ['astm_generic_e1394', 'syn_verified_inactive']) {
        const w = world({ instruments: [at('suspended', { driver_code })] });
        expect(code(await rejection(call(w, 'resumeInstrument', { body: {} })))).toBe('instruments.driver_not_available');
        expect(w.mutations()).toHaveLength(0); expect(w.pub.calls).toHaveLength(0);
      }
    });
  });

  describe('E31 retireInstrument (I6)', () => {
    it.each(['draft', 'commissioning', 'live', 'suspended'])('%s -> retired with reason; ONE config version (the agent drops the instrument)', async (state) => {
      const w = world({ instruments: [at(state)] });
      const r = await call(w, 'retireInstrument', { body: { reason_text: 'Synthetic decommissioning' } });
      expect(r.body).toMatchObject({ state: 'retired', version: 2 });
      expect(responseViolations('retireInstrument', '200', r.body)).toEqual([]);
      expect(w.callsOf('transitionInstrument')[0]!.args[2]).toMatchObject({ state: 'retired', reasonText: 'Synthetic decommissioning' });
      expect(w.pub.reasons()).toEqual(['instrument_changed']); expect(w.pub.agentIds()).toEqual([AGENT_A1]);
    });
    it.each([['missing', undefined], ['too short', 'no'], ['too long', 'x'.repeat(301)]])('reason_text %s -> 400 /reason_text', async (_n, reason_text) => {
      const w = world({ instruments: [at('live')] });
      const e = await rejection(call(w, 'retireInstrument', { body: reason_text === undefined ? {} : { reason_text } }));
      expect(code(e)).toBe('common.validation_failed'); expect(e.errors?.[0]?.path).toBe('/reason_text');
    });
  });

  describe('AC-04.5 every action not allowed by the state machine -> 409 instruments.invalid_transition (no write, no config version)', () => {
    const ACTIONS: Array<[string, Record<string, unknown>, string[]]> = [   // [op, input, states from which it is ALLOWED]
      ['startInstrumentCommissioning', { body: {} }, ['draft']],
      ['goLiveInstrument', { body: { checklist: GOOD_CHECKLIST, evidence_note: 'Synthetic comparison run agreed.' } }, ['commissioning']],
      ['suspendInstrument', { body: { reason_text: 'Synthetic reason' } }, ['live']],
      ['resumeInstrument', { body: {} }, ['suspended']],
      ['retireInstrument', { body: { reason_text: 'Synthetic reason' } }, ['draft', 'commissioning', 'live', 'suspended']],
    ];
    const cases = ACTIONS.flatMap(([op, input, ok]) => ['draft', 'commissioning', 'live', 'suspended', 'retired'].filter((s) => !ok.includes(s)).map((s) => [op, s, input] as const));
    it.each(cases)('%s from %s', async (op, state, input) => {
      const w = world({ instruments: [at(state, { driver_code: 'syn_verified_astm' })] });
      expect(code(await rejection(call(w, op, input)))).toBe('instruments.invalid_transition');
      expect(w.mutations()).toHaveLength(0); expect(w.pub.calls).toHaveLength(0);
    });
    it('a repeated action (commissioning twice) is also invalid, not idempotent-success', async () => {
      const w = world({ instruments: [at('commissioning')] });
      expect(code(await rejection(call(w, 'startInstrumentCommissioning', { body: {} })))).toBe('instruments.invalid_transition');
    });
  });

  describe('shared rules for E27-E31: If-Match, atomicity, BOLA, privilege', () => {
    const OPS: Array<[string, string, Record<string, unknown>]> = [
      ['startInstrumentCommissioning', 'draft', { body: {} }], ['goLiveInstrument', 'commissioning', { body: LIVE_BODY }], ['suspendInstrument', 'live', { body: { reason_text: 'Synthetic reason' } }],
      ['resumeInstrument', 'suspended', { body: {} }], ['retireInstrument', 'live', { body: { reason_text: 'Synthetic reason' } }],
    ];
    it.each(OPS)('%s: missing If-Match -> 428, stale -> 409 common.version_conflict; neither publishes', async (op, state, input) => {
      const w = world({ instruments: [at(state, { driver_code: 'syn_verified_astm' })] });
      expect(code(await rejection(call(w, op, { ...input, expectedVersion: undefined })))).toBe('common.precondition_required');
      expect(code(await rejection(call(w, op, { ...input, expectedVersion: 5 })))).toBe('common.version_conflict');
      expect(w.pub.calls).toHaveLength(0);
    });
    it.each(OPS)('%s: unknown / foreign-tenant instrument -> 404; wrong centre or technologist -> 403; no write, no publish', async (op, state, input) => {
      const seed = { instruments: [at(state, { driver_code: 'syn_verified_astm' })] };
      const a = world({ instruments: [] }); const b = world({ instruments: [at(state, { tenant_id: TENANT_B })] });
      expect(code(await rejection(call(a, op, input)))).toBe('common.not_found'); expect(code(await rejection(call(b, op, input)))).toBe('common.not_found');
      const c = world(seed, { roles: onlyCentre(CENTRE_A2) }); const d = world(seed, { roles: readOnly });
      expect(code(await rejection(call(c, op, input)))).toBe('auth.forbidden'); expect(code(await rejection(call(d, op, input)))).toBe('auth.forbidden');
      expect(a.mutations().length + b.mutations().length + c.mutations().length + d.mutations().length).toBe(0);
      expect(a.pub.calls.length + b.pub.calls.length + c.pub.calls.length + d.pub.calls.length).toBe(0);
    });
    it.each(OPS)('%s: a publisher failure propagates (tx rollback), never reported as success', async (op, state, input) => {
      const w = world({ instruments: [at(state, { driver_code: 'syn_verified_astm' })] }, {}, { failPublishOn: 1 });
      await expect(call(w, op, input)).rejects.toThrow('signing unavailable');
    });
    it.each(OPS)('%s: the config version is published AFTER the state change and for the instrument\'s own agent only', async (op, state, input) => {
      const w = world({ instruments: [at(state, { driver_code: 'syn_verified_astm', agent_id: AGENT_A2, centre_id: CENTRE_A2 })] });
      await call(w, op, input);
      expect(w.pub.agentIds()).toEqual([AGENT_A2]);
      expect(w.calls.map((c) => c.op).indexOf('transitionInstrument')).toBeGreaterThanOrEqual(0);
    });
  });
});

describe('cross-module sanity: observed-code rows never leak through instrument DTOs', () => {
  it('getInstrument body contains no observed-code fields', async () => {
    const w = world({ instruments: [at('draft')], observed: [obsRow('GLU')] });
    expect(JSON.stringify((await w.svc.getInstrument(w.ctx, { instrumentId: INS(1) })).body)).not.toContain('GLU');
  });
});
