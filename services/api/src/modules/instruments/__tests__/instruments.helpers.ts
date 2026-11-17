// C7 API-T05 test helpers (not a test file). Synthetic data only. SEAMS the spec leaves open — the writer must match them or raise a dispute:
//
//   ../repo/instruments.repo.ts        exports `InstrumentsRepo` (interface below), `createInstrumentsRepo(): InstrumentsRepo` (SQL on the request tx, explicit tenant predicate on every
//                                      statement). Tests inject FakeRepo. Column names are 05-SCHEMA §2.8/§2.16/§2.17/§2.18 verbatim.
//   ../service/instruments.service.ts  exports `createInstrumentsService(deps?: { repo?, publish?, now?, allowSketchDrivers?: boolean (default false), nodeEnv?: string })`
//                                      -> async methods `(ctx, input) => { status, body, version? }` for E22-E31:
//                                      listDrivers{protocol?,status?} · listInstruments{centreId?,agentId?,state?:string[],protocol?,sort?,cursor?,limit?} · createInstrument{body}
//                                      getInstrument{instrumentId} · updateInstrument{instrumentId,expectedVersion,patch} · startInstrumentCommissioning{instrumentId,expectedVersion}
//                                      goLiveInstrument{instrumentId,expectedVersion,body:{checklist,evidence_note}} · suspendInstrument|retireInstrument{instrumentId,expectedVersion,body:{reason_text}}
//                                      resumeInstrument{instrumentId,expectedVersion}.  `body`/`patch` are the SNAKE_CASE request bodies exactly as in the OpenAPI schemas.
//                                      expectedVersion undefined -> 428 common.precondition_required; mismatch -> 409 common.version_conflict.
//   ../service/settings.service.ts     exports `createSettingsService(deps?: { repo?, publish?, now? })` -> getInstrumentSettings(ctx) · updateInstrumentSettings(ctx,{expectedVersion,body}).
//   ../service/observedCodes.service.ts exports `createObservedCodesService(deps?: { repo? })` -> listObservedInstrumentCodes(ctx,{instrumentId,recordClass?,mappingStatus?,cursor?,limit?}).
//   `publish` = the config-version publisher (builds + signs via service/signing.ts and inserts agent_config_versions; its own tests are API-T06/T08):
//                 publish(tx, { tenantId, agentId, reason: 'instrument_changed'|'settings_changed', actorId }) => Promise<number /* new config_version */>.
//               The services call it INSIDE the request transaction (same `tx` object), AFTER the row change, and never swallow its errors (the core rolls the tx back).
//   ctx = same shape as API-T04 (tenantId, actor, tx, ports.IdentityPort.assertRole/getTenantSettings, audit.access).
import { makeCtx as baseCtx, idN, CENTRE_A1, CENTRE_A2, NOW, TENANT_A, TENANT_B, USER, forbidden, rejection, agentRow, type Row } from './agents.helpers.js';

export { idN, CENTRE_A1, CENTRE_A2, NOW, TENANT_A, TENANT_B, USER, forbidden, rejection };
export type { Row };

export const AGENT_A1 = idN(0x1000);            // active, centre A1
export const AGENT_A2 = idN(0x1001);            // active, centre A2
export const AGENT_RETIRED = idN(0x1002);       // retired, centre A1
export const AGENT_PENDING = idN(0x1003);       // pending_enrolment, centre A1
export const AGENT_B = idN(0x1b00);             // tenant B
export const INS = (n: number) => idN(0x2000 + n);

// ---------------------------------------------------------------------------------------------------- fixtures
export const SERIAL = { kind: 'serial', port_name: 'COM3', baud_rate: 9600, data_bits: 8, parity: 'none', stop_bits: '1' };
export const TCP = { kind: 'tcp_client', host: 'analyser.lab.local', port: 5000 };
export const driverRow = (o: Row = {}): Row => ({
  code: 'astm_generic_e1394', display_name: 'Generic ASTM E1394', protocol: 'astm', vendor: null, model_pattern: null, status: 'generic', driver_version: '1.0.0',
  cap_host_query: false, cap_worklist_download: false, cap_qc: true, cap_attachments: false, cap_calibration: false, manual_document_id: null, is_active: true, ...o,
});
export const DRIVERS = (): Row[] => [
  driverRow(),
  driverRow({ code: 'hl7v2_generic_oru', display_name: 'Generic HL7 v2 ORU', protocol: 'hl7v2' }),
  driverRow({ code: 'file_drop_generic', display_name: 'Generic file drop', protocol: 'file_drop', cap_qc: false, cap_attachments: true }),
  driverRow({ code: 'mindray_bc5380_sketch', display_name: 'Mindray BC-5380 (sketch)', protocol: 'hl7v2', status: 'sketch_blocked', cap_host_query: true, cap_qc: false }),
  driverRow({ code: 'syn_verified_astm', display_name: 'Synthetic verified ASTM', status: 'verified', cap_host_query: true, manual_document_id: 'SYN-MAN-1' }),
  driverRow({ code: 'syn_verified_inactive', display_name: 'Synthetic inactive verified', status: 'verified', manual_document_id: 'SYN-MAN-2', is_active: false }),
];
export const insRow = (n: number, o: Row = {}): Row => ({
  id: INS(n), tenant_id: TENANT_A, centre_id: CENTRE_A1, agent_id: AGENT_A1, agent_code: 'HUB-PC-01', instrument_code: `SIM-CHEM-${n}`, display_name: 'Synthetic chemistry analyser',
  vendor: 'Synthetic Vendor', model: 'SYN-100', serial_no: null, software_version: null, protocol: 'astm', driver_code: 'astm_generic_e1394', transport: structuredClone(SERIAL),
  protocol_options: {}, parser_options: {}, file_drop: null, cap_host_query: false, cap_worklist_download: false, qc_sample_id_patterns: [], timezone: 'Asia/Kathmandu',
  silence_window_minutes: null, silence_active_from: null, silence_active_to: null, state: 'draft', commissioned_at: null, live_at: null, live_by: null, suspended_at: null,
  retired_at: null, go_live_checklist: null, state_reason_text: null, version: 1, is_active: true, created_at: '2026-11-01T08:00:00.000Z', updated_at: '2026-11-01T08:00:00.000Z',
  created_by: USER, updated_by: USER, link_state: 'up', last_message_at: '2026-11-06T04:00:00.000Z', unmapped_code_count: 0, ...o,
});
export const obsRow = (code: string, o: Row = {}): Row => ({
  tenant_id: TENANT_A, centre_id: CENTRE_A1, instrument_id: INS(1), record_class: 'patient', instrument_analyte_code: code, first_seen_at: '2026-11-06T04:00:00.000Z',
  last_seen_at: '2026-11-06T04:05:00.000Z', seen_count: 12, last_mapping_status: 'mapped', last_analyte_id: idN(0xb001), last_mapping_checked_at: '2026-11-06T04:05:00.000Z',
  updated_at: '2026-11-06T04:05:00.000Z', updated_by: USER, ...o,
});
export const settingsRow = (o: Row = {}): Row => ({
  id: idN(0x5e01), tenant_id: TENANT_A, default_backlog_threshold: 500, backlog_max_oldest_pending_seconds: 900, clock_offset_warn_seconds: 300, agent_uploaded_retention_hours: 24,
  update_window_from: null, update_window_to: null, version: 1, is_active: true, created_at: NOW, updated_at: NOW, created_by: USER, updated_by: USER, ...o,
});
export const GOOD_CHECKLIST = { manual_reference_confirmed: true, sample_comparison_done: true, qc_comparison_done: true, mappings_reviewed: true };
export const createBody = (o: Row = {}): Row => ({
  instrument_code: 'SIM-CHEM-9', display_name: 'Synthetic chemistry analyser', agent_id: AGENT_A1, vendor: 'Synthetic Vendor', model: 'SYN-100', protocol: 'astm',
  driver_code: 'astm_generic_e1394', transport: structuredClone(SERIAL), capabilities: { host_query: false, worklist_download: false }, ...o,
});

// ---------------------------------------------------------------------------------------------------- fake repo
export interface InstrumentsRepo {
  findAgent(tx: any, tenantId: string, agentId: string): Promise<{ id: string; tenant_id: string; centre_id: string; status: string } | undefined>;   // RLS-invisible -> undefined
  listDrivers(tx: any): Promise<Row[]>;                                                                  // g_drivers rows (global, no tenant)
  insertInstrument(tx: any, tenantId: string, row: Row): Promise<Row>;                                   // also inserts instrument_status; duplicate (tenant_id, instrument_code) -> throws { code: '23505' }
  findInstrument(tx: any, tenantId: string, id: string): Promise<Row | undefined>;                       // instruments cols + agent_code + link_state + last_message_at (+ unmapped_code_count)
  listInstruments(tx: any, tenantId: string, q: Row): Promise<{ rows: Row[]; nextCursor?: string }>;
  updateInstrument(tx: any, tenantId: string, id: string, expectedVersion: number, patch: Row): Promise<Row | undefined>;   // undefined = version mismatch
  transitionInstrument(tx: any, tenantId: string, id: string, expectedVersion: number, o: { state: string; actorId: string; reasonText?: string; checklist?: Row }): Promise<Row | undefined>;
  listObservedCodes(tx: any, tenantId: string, instrumentId: string, q: Row): Promise<{ rows: Row[]; nextCursor?: string }>;
  getSettings(tx: any, tenantId: string): Promise<Row | undefined>;
  insertDefaultSettings(tx: any, tenantId: string, actorId: string): Promise<Row>;                       // lazy row on first E40
  updateSettings(tx: any, tenantId: string, expectedVersion: number, row: Row): Promise<Row | undefined>;   // undefined = version mismatch; row = the five value columns + window pair (null = cleared)
  listNonRetiredAgentIds(tx: any, tenantId: string): Promise<string[]>;
}
export interface FakeSeed { agents?: Row[]; drivers?: Row[]; instruments?: Row[]; observed?: Row[]; settings?: Row[] }
export function makeRepo(seed: FakeSeed = {}) {
  const agents: Row[] = seed.agents ?? [
    agentRow({ id: AGENT_A1, agent_code: 'HUB-PC-01', centre_id: CENTRE_A1 }), agentRow({ id: AGENT_A2, agent_code: 'HUB-PC-02', centre_id: CENTRE_A2 }),
    agentRow({ id: AGENT_RETIRED, agent_code: 'HUB-OLD', status: 'retired' }), agentRow({ id: AGENT_PENDING, agent_code: 'HUB-NEW', status: 'pending_enrolment' }),
    agentRow({ id: AGENT_B, agent_code: 'HUB-B', tenant_id: TENANT_B }),
  ];
  const drivers = (seed.drivers ?? DRIVERS()).map((r) => ({ ...r }));
  const instruments = (seed.instruments ?? []).map((r) => ({ ...r }));
  const observed = seed.observed ?? [];
  const settings = (seed.settings ?? []).map((r) => ({ ...r }));
  const calls: Array<{ op: string; tenantId?: string; args: unknown[] }> = [];
  const rec = <T>(op: string, tenantId: string | undefined, args: unknown[], fn: () => T): T => { calls.push({ op, tenantId, args }); return fn(); };
  const mine = <T extends Row>(xs: T[], t: string) => xs.filter((x) => x.tenant_id === t);
  const out = (r: Row | undefined) => (r ? structuredClone(r) : undefined);
  let seq = 0;
  const repo: InstrumentsRepo = {
    async findAgent(_tx, t, id) { return rec('findAgent', t, [id], () => out(mine(agents, t).find((a) => a.id === id)) as any); },
    async listDrivers() { return rec('listDrivers', undefined, [], () => structuredClone(drivers)); },
    async insertInstrument(_tx, t, row) {
      return rec('insertInstrument', t, [row], () => {
        if (mine(instruments, t).some((i) => i.instrument_code === row['instrument_code'])) throw Object.assign(new Error('duplicate key'), { code: '23505' });
        const r = insRow(0, { ...row, tenant_id: t, agent_code: agents.find((a) => a.id === row['agent_id'])?.agent_code }); instruments.push(r); return structuredClone(r);
      });
    },
    async findInstrument(_tx, t, id) { return rec('findInstrument', t, [id], () => out(mine(instruments, t).find((i) => i.id === id))); },
    async listInstruments(_tx, t, q) {
      return rec('listInstruments', t, [q], () => {
        let rows = mine(instruments, t);
        if (q['centreId']) rows = rows.filter((i) => i.centre_id === q['centreId']);
        if (q['agentId']) rows = rows.filter((i) => i.agent_id === q['agentId']);
        if (q['state']?.length) rows = rows.filter((i) => q['state'].includes(i.state));
        if (q['protocol']) rows = rows.filter((i) => i.protocol === q['protocol']);
        return { rows: structuredClone(rows) };
      });
    },
    async updateInstrument(_tx, t, id, v, patch) {
      return rec('updateInstrument', t, [id, v, patch], () => { const i = mine(instruments, t).find((x) => x.id === id); if (!i || i.version !== v) return undefined; Object.assign(i, patch, { version: i.version + 1 }); return structuredClone(i); });
    },
    async transitionInstrument(_tx, t, id, v, o) {
      return rec('transitionInstrument', t, [id, v, o], () => {
        const i = mine(instruments, t).find((x) => x.id === id); if (!i || i.version !== v) return undefined;
        Object.assign(i, { state: o.state, version: i.version + 1, state_reason_text: o.reasonText ?? i.state_reason_text });
        if (o.checklist) Object.assign(i, { go_live_checklist: o.checklist, live_at: NOW, live_by: o.actorId });
        return structuredClone(i);
      });
    },
    async listObservedCodes(_tx, t, id, q) {
      return rec('listObservedCodes', t, [id, q], () => {
        let rows = mine(observed, t).filter((o) => o.instrument_id === id);
        if (q['recordClass']) rows = rows.filter((o) => o.record_class === q['recordClass']);
        if (q['mappingStatus']) rows = rows.filter((o) => o.last_mapping_status === q['mappingStatus']);
        return { rows: structuredClone(rows) };
      });
    },
    async getSettings(_tx, t) { return rec('getSettings', t, [], () => out(mine(settings, t)[0])); },
    async insertDefaultSettings(_tx, t, actor) { return rec('insertDefaultSettings', t, [actor], () => { const r = settingsRow({ tenant_id: t, id: idN(0x5e00 + ++seq), created_by: actor }); settings.push(r); return structuredClone(r); }); },
    async updateSettings(_tx, t, v, row) {
      return rec('updateSettings', t, [v, row], () => { const s = mine(settings, t)[0]; if (!s || s.version !== v) return undefined; Object.assign(s, row, { version: s.version + 1 }); return structuredClone(s); });
    },
    async listNonRetiredAgentIds(_tx, t) { return rec('listNonRetiredAgentIds', t, [], () => mine(agents, t).filter((a) => a.status !== 'retired').map((a) => a.id).sort()); },
  };
  return {
    repo, agents, instruments, settings, calls, drivers,
    callsOf: (op: string) => calls.filter((c) => c.op === op),
    mutations: () => calls.filter((c) => /^(insert|update|transition)/.test(c.op)),
  };
}
export type FakeRepo = ReturnType<typeof makeRepo>;

// ---------------------------------------------------------------------------------------------------- publisher + ctx
export type PublishReason = 'instrument_changed' | 'settings_changed';
export function makePublisher(failOnCall?: number) {
  const calls: Array<{ tx: unknown; tenantId: string; agentId: string; reason: PublishReason; actorId: string }> = [];
  const versions = new Map<string, number>();
  const publish = async (tx: unknown, o: { tenantId: string; agentId: string; reason: PublishReason; actorId: string }): Promise<number> => {
    calls.push({ tx, ...o });
    if (failOnCall === calls.length) throw new Error('signing unavailable');
    const v = (versions.get(o.agentId) ?? 1) + 1; versions.set(o.agentId, v); return v;
  };
  return { publish, calls, agentIds: () => calls.map((c) => c.agentId), reasons: () => calls.map((c) => c.reason) };
}
export function makeCtx(over: Parameters<typeof baseCtx>[0] = {}) {
  const c = baseCtx(over);
  c.ctx.ports.IdentityPort.getTenantSettings = async () => ({ timezone: 'Asia/Kathmandu' });
  return c;
}
/** Holds instrument.read only (technologist-like): manage is refused. */
export const readOnly = (r: { permission: string }) => { if (r.permission !== 'instruments.instrument.read') throw forbidden(); };
/** Holds nothing for instruments. */
export const noRights = () => { throw forbidden(); };
export const OPS_E22_E32 = ['listDrivers', 'listInstruments', 'createInstrument', 'getInstrument', 'updateInstrument', 'startInstrumentCommissioning', 'goLiveInstrument', 'suspendInstrument', 'resumeInstrument', 'retireInstrument'] as const;
