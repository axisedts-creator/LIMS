// Instrument operations E22-E31 (02-TRD §7.3/§7.5; 01-PRD AC-03.1-03.6, AC-04.1-04.5; 03-APP-FLOW §2.2 I1-I6; 07-SECURITY S-01/S-02/S-04).
// Object-level rule (02-CV §10.1): load through the repo (RLS + tenant predicate) -> 404 if invisible -> assertRole(permission, object centre).
// Tenant and actor come from ctx only. A config version (agent_config_versions) is published by the injected `publish` INSIDE the request tx, AFTER the
// row change, for the instrument's own agent; its errors are never swallowed (the core rolls the tx back).
import { isDeepStrictEqual } from 'node:util';
import { LimsError, type FieldError } from '../../../core/errors.js';
// [CONV] relative import until @lims/shared-ts is a services/api dependency (same as agents.service.ts).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { instrumentNext, INSTRUMENT_STATES, type InstrumentAction } from '../domain/instrument.state.js';
import { validateFileDrop, validateProtocolOptions, validateTransport, type ValidationResult } from '../domain/transportSchemas.js';
import { assertDriverSelectable, type DriverPurpose } from '../drivers/registry.js';
import { toDriver, toInstrument, toInstrumentSummary } from '../mappers/instruments.mapper.js';
import { createInstrumentsRepo, type InstrumentsRepo, type Row } from '../repo/instruments.repo.js';
import { cursorOf, enumList, fail, isInt, isUuid, limitOf, page, scope, version, type AgentsCtx, type Result, type Scope } from './agents.service.js';

export type ConfigPublishReason = 'instrument_changed' | 'settings_changed';
/** Builds + signs + inserts the next agent_config_versions row for one agent (API-T06/T08); returns the new config_version. */
export type ConfigPublisher = (tx: unknown, o: { tenantId: string; agentId: string; reason: ConfigPublishReason; actorId: string }) => Promise<number>;
/** ponytail: until the publisher is wired (API-T06) every config-affecting write fails closed instead of silently skipping the agent's new config. */
export const unwiredPublisher: ConfigPublisher = async () => { throw new LimsError('common.internal'); };

export type InstrumentsCtx = AgentsCtx;
export interface InstrumentsDeps { repo?: InstrumentsRepo; publish?: ConfigPublisher; now?: () => Date; allowSketchDrivers?: boolean; nodeEnv?: string }

const READ = 'instruments.instrument.read';
const MANAGE = 'instruments.instrument.manage';
const PROTOCOLS = ['astm', 'hl7v2', 'file_drop'];
const DRIVER_STATUSES = ['generic', 'verified', 'sketch_blocked'];
const SORTS = ['instrument_code', '-last_message_at'];
const CODE = /^[A-Z0-9-]{2,32}$/;
const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const CREATE_KEYS = [
  'instrument_code', 'display_name', 'agent_id', 'vendor', 'model', 'serial_no', 'software_version', 'protocol', 'driver_code', 'transport', 'protocol_options', 'parser_options',
  'file_drop', 'capabilities', 'qc_sample_id_patterns', 'timezone', 'silence_window_minutes', 'silence_active_from', 'silence_active_to',
];
const REQUIRED = ['instrument_code', 'display_name', 'agent_id', 'vendor', 'model', 'protocol', 'driver_code', 'transport', 'capabilities'];
const UPDATE_KEYS = CREATE_KEYS.filter((k) => k !== 'instrument_code' && k !== 'agent_id');   // immutable: retire and recreate
const AGENT_KEYS = ['protocol', 'driver_code', 'transport', 'protocol_options', 'file_drop', 'capabilities', 'timezone', 'qc_sample_id_patterns'];   // what the agent config carries
const CHECKLIST_KEYS = ['manual_reference_confirmed', 'sample_comparison_done', 'qc_comparison_done', 'mappings_reviewed'];

const isObj = (v: unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (path: string, v: unknown, min: number, max: number) => { if (typeof v !== 'string' || v.length < min || v.length > max) fail(path); };
/** Key names are echoed in the error pointer: only plain snake_case names are, anything else points at the body. */
const keyPath = (k: string) => (/^[a-z_]{1,40}$/.test(k) ? `/${k}` : '/');
function schemaFail(base: string, res: ValidationResult): void {
  if (res.valid) return;
  const seen = new Set<string>();
  const errors: FieldError[] = [];
  for (const e of res.errors) {                                 // "<instancePath|/> <keyword>": never carries instance values
    const p = e.split(' ')[0]!;
    const path = base + (p === '/' ? '' : p);
    if (!seen.has(path)) { seen.add(path); errors.push({ path, code: 'common.field_invalid', message: 'Field invalid' }); }
  }
  throw new LimsError('common.validation_failed', undefined, errors);
}
function validZone(tz: unknown): boolean {
  if (typeof tz !== 'string' || tz.length < 1 || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}
/** 02-TRD.md:728 — QC patterns are RE2: must compile, no lookaround / backreference. ponytail: syntactic screen, not a full RE2 parser. */
function re2ish(x: string): boolean {
  if (/\(\?<?[=!]|\\[1-9]|\\k</.test(x)) return false;
  try { new RegExp(x); return true; } catch { return false; }
}

const CHECK: Record<string, (v: unknown) => void> = {
  instrument_code: (v) => { if (typeof v !== 'string' || !CODE.test(v)) fail('/instrument_code'); },
  display_name: (v) => str('/display_name', v, 1, 80),
  agent_id: (v) => { if (!isUuid(v)) fail('/agent_id'); },
  vendor: (v) => str('/vendor', v, 1, 60),
  model: (v) => str('/model', v, 1, 60),
  serial_no: (v) => str('/serial_no', v, 0, 60),
  software_version: (v) => str('/software_version', v, 0, 40),
  protocol: (v) => { if (typeof v !== 'string' || !PROTOCOLS.includes(v)) fail('/protocol'); },
  driver_code: (v) => str('/driver_code', v, 1, 64),
  transport: (v) => schemaFail('/transport', validateTransport(v)),
  protocol_options: (v) => { if (!isObj(v)) fail('/protocol_options'); },                      // per-protocol content: checkShape
  parser_options: (v) => { if (!isObj(v)) fail('/parser_options'); },                          // ponytail: shape only; the driver's optionsSchema (API-T07+) validates further
  file_drop: (v) => schemaFail('/file_drop', validateFileDrop(v)),
  capabilities: (v) => {
    if (!isObj(v) || Object.keys(v).some((k) => k !== 'host_query' && k !== 'worklist_download') || typeof v['host_query'] !== 'boolean' || typeof v['worklist_download'] !== 'boolean') fail('/capabilities');
  },
  qc_sample_id_patterns: (v) => {
    if (!Array.isArray(v) || v.length > 10) fail('/qc_sample_id_patterns');
    (v as unknown[]).forEach((x, i) => { if (typeof x !== 'string' || x.length < 1 || x.length > 100 || !re2ish(x)) fail(`/qc_sample_id_patterns/${i}`); });
  },
  timezone: (v) => { if (!validZone(v)) fail('/timezone'); },
  silence_window_minutes: (v) => { if (!isInt(v, 15, 1440)) fail('/silence_window_minutes'); },
  silence_active_from: (v) => { if (typeof v !== 'string' || !HHMM.test(v)) fail('/silence_active_from'); },
  silence_active_to: (v) => { if (typeof v !== 'string' || !HHMM.test(v)) fail('/silence_active_to'); },
};
/** Closed body: unknown / server-owned keys -> 400 at that key (mass assignment); each present field validated alone. */
function checkFields(body: unknown, allowed: string[]): Row {
  if (!isObj(body)) fail('/');
  const b = body as Row;
  for (const k of Object.keys(b)) if (!allowed.includes(k)) fail(keyPath(k));
  for (const k of allowed) if (b[k] !== undefined) CHECK[k]!(b[k]);
  return b;
}
/** Cross-field rules on the (merged) instrument: protocol <-> transport kind, file_drop column, protocol_options keyed by the instrument's protocol, silence pair. */
function checkShape(m: Row): void {
  if ((m['protocol'] === 'file_drop') !== (m['transport']?.kind === 'file_drop')) fail('/transport');
  if (m['protocol'] === 'file_drop' && m['file_drop'] != null) fail('/file_drop');
  for (const [k, val] of Object.entries((m['protocol_options'] ?? {}) as Row)) {
    if ((k !== 'astm' && k !== 'hl7v2') || k !== m['protocol']) fail(`/protocol_options${k === 'astm' || k === 'hl7v2' ? `/${k}` : ''}`);
    schemaFail(`/protocol_options/${k}`, validateProtocolOptions(k as 'astm' | 'hl7v2', val));   // k is narrowed by the check above
  }
  if ((m['silence_active_from'] == null) !== (m['silence_active_to'] == null)) fail(m['silence_active_from'] == null ? '/silence_active_from' : '/silence_active_to');
}

export async function loadInstrument(repo: InstrumentsRepo, s: Scope, id: unknown, permission: string): Promise<Row> {
  if (!isUuid(id)) throw new LimsError('common.not_found');
  const row = await repo.findInstrument(s.tx, s.tenantId, id);
  if (!row || row.tenant_id !== s.tenantId) throw new LimsError('common.not_found');
  await s.assert(permission, row.centre_id);
  return row;
}

export function createInstrumentsService(deps: InstrumentsDeps = {}) {
  const repo = deps.repo ?? createInstrumentsRepo();
  const publish = deps.publish ?? unwiredPublisher;
  const allowSketchDrivers = deps.allowSketchDrivers ?? false;
  const nodeEnv = deps.nodeEnv ?? process.env['NODE_ENV'];

  const driverOf = (drivers: Row[], code: unknown): Row => {
    const d = drivers.find((x) => x['code'] === code);
    if (!d) throw new LimsError('common.internal');            // FK instruments__driver__fk makes this unreachable
    return d;
  };
  /** AC-04.2 / AC-21.3: inactive or not selectable for this purpose -> 422 instruments.driver_not_available. */
  function selectable(d: Row, purpose: DriverPurpose): void {
    if (!d['is_active']) throw new LimsError('instruments.driver_not_available');
    assertDriverSelectable({ status: d['status'] }, { allowSketchDrivers, purpose, ...(nodeEnv === undefined ? {} : { nodeEnv }) });
  }
  /** Driver exists and speaks the instrument's protocol (400 /driver_code), optional selectable check, then AC-03.3 / AC-03.4 capability rules. */
  function checkDriver(drivers: Row[], m: Row, purpose: DriverPurpose | undefined): void {
    const d = drivers.find((x) => x['code'] === m['driver_code']);
    if (!d || d['protocol'] !== m['protocol']) fail('/driver_code');
    if (purpose) selectable(d!, purpose);
    const caps = m['capabilities'] as { host_query: boolean; worklist_download: boolean };
    if (caps.host_query && !d!['cap_host_query']) throw new LimsError('instruments.capability_not_supported');
    // AC-03.4: worklist download stays blocked until a VERIFIED driver declares it (DB CHECK instruments__worklist_blocked__ck mirrors this)
    if (caps.worklist_download && !(d!['status'] === 'verified' && d!['cap_worklist_download'])) throw new LimsError('instruments.capability_not_supported');
  }
  const view = (r: Row): Row => ({
    protocol: r['protocol'], driver_code: r['driver_code'], transport: r['transport'], protocol_options: r['protocol_options'] ?? {}, file_drop: r['file_drop'] ?? null,
    capabilities: { host_query: r['cap_host_query'], worklist_download: r['cap_worklist_download'] }, timezone: r['timezone'], qc_sample_id_patterns: r['qc_sample_id_patterns'] ?? [],
    silence_active_from: r['silence_active_from'] ?? null, silence_active_to: r['silence_active_to'] ?? null,
  });
  const publishFor = (s: Scope, agentId: string) => publish(s.tx, { tenantId: s.tenantId, agentId, reason: 'instrument_changed', actorId: s.actorId });

  /** E27-E31 shared pipeline: If-Match (428) -> body shape (400) -> load (404/403) -> state machine (409) -> version (409) -> guards (422/400) -> write -> publish. */
  function transition(action: InstrumentAction, parse: (body: unknown) => Row, guard: (row: Row, drivers: Row[], parsed: Row) => Row) {
    return async (ctx: InstrumentsCtx, input: { instrumentId?: unknown; expectedVersion?: unknown; body?: unknown }): Promise<Result> => {
      const s = scope(ctx);
      const v = version(input?.expectedVersion);
      const parsed = parse(input.body);
      const row = await loadInstrument(repo, s, input.instrumentId, MANAGE);
      const to = instrumentNext(row['state'], action);
      if (row['version'] !== v) throw new LimsError('common.version_conflict');
      const drivers = await repo.listDrivers(s.tx);
      const extra = guard(row, drivers, parsed);
      const out = await repo.transitionInstrument(s.tx, s.tenantId, row['id'], v, { state: to, actorId: s.actorId, ...extra } as Parameters<InstrumentsRepo['transitionInstrument']>[4]);
      if (!out) throw new LimsError('common.version_conflict');
      await publishFor(s, out['agent_id']);
      return { status: 200, body: toInstrument(out, driverOf(drivers, out['driver_code'])), version: out['version'] };
    };
  }
  const reasonOf = (body: unknown): Row => {
    const t = isObj(body) ? body['reason_text'] : undefined;
    if (typeof t !== 'string' || t.trim().length < 3 || t.length > 300) fail('/reason_text');
    return { reasonText: t };
  };
  const live = (row: Row, drivers: Row[]) => selectable(driverOf(drivers, row['driver_code']), 'live');

  return {
    /** E22 */
    async listDrivers(ctx: InstrumentsCtx, q: { protocol?: unknown; status?: unknown } = {}): Promise<Result> {
      const s = scope(ctx);
      if (q?.protocol !== undefined && !PROTOCOLS.includes(q.protocol as string)) fail('/protocol');
      if (q?.status !== undefined && !DRIVER_STATUSES.includes(q.status as string)) fail('/status');
      await s.assert(READ);
      const rows = (await repo.listDrivers(s.tx)).filter((d) => (q?.protocol === undefined || d['protocol'] === q.protocol) && (q?.status === undefined || d['status'] === q.status));
      return { status: 200, body: { data: rows.map(toDriver) } };
    },

    /** E23 */
    async listInstruments(ctx: InstrumentsCtx, q: { centreId?: unknown; agentId?: unknown; state?: unknown; protocol?: unknown; sort?: unknown; cursor?: unknown; limit?: unknown } = {}): Promise<Result> {
      const s = scope(ctx);
      if (q?.centreId !== undefined && !isUuid(q.centreId)) fail('/centre_id');
      if (q?.agentId !== undefined && !isUuid(q.agentId)) fail('/agent_id');
      const state = enumList(q?.state, [...INSTRUMENT_STATES], '/state');
      if (q?.protocol !== undefined && !PROTOCOLS.includes(q.protocol as string)) fail('/protocol');
      if (q?.sort !== undefined && !SORTS.includes(q.sort as string)) fail('/sort');
      const limit = limitOf(q?.limit);
      const cursor = cursorOf(q?.cursor);
      await s.assert(READ, q?.centreId as string | undefined);
      const res = await repo.listInstruments(s.tx, s.tenantId, { centreId: q?.centreId, agentId: q?.agentId, state, protocol: q?.protocol, sort: q?.sort ?? 'instrument_code', cursor, limit });
      const drivers = await repo.listDrivers(s.tx);
      return { status: 200, body: { data: res.rows.filter((r) => r['tenant_id'] === s.tenantId).map((r) => toInstrumentSummary(r, driverOf(drivers, r['driver_code']))), page: page(limit, res.nextCursor) } };
    },

    /** E24 — AC-03.1 / AC-03.2 / AC-03.3 / AC-03.4 / AC-03.6. centre_id is the AGENT's centre, never a body field; the row is a draft (I1: not shipped, no config version). */
    async createInstrument(ctx: InstrumentsCtx, input: { body?: unknown }): Promise<Result> {
      const s = scope(ctx);
      const b = checkFields(input?.body, CREATE_KEYS);
      for (const k of REQUIRED) if (b[k] === undefined) fail(`/${k}`);
      checkShape(b);
      const agent = await repo.findAgent(s.tx, s.tenantId, b['agent_id']);
      if (!agent || agent.tenant_id !== s.tenantId) throw new LimsError('common.not_found');
      await s.assert(MANAGE, agent.centre_id);
      if (agent.status === 'retired') throw new LimsError('instruments.agent_not_active');   // pending_enrolment is fine: instruments can be prepared before enrolment
      const drivers = await repo.listDrivers(s.tx);
      checkDriver(drivers, b, 'create');
      let timezone = b['timezone'] as string | undefined;
      if (timezone === undefined) {
        const idp = ctx.ports?.IdentityPort as { getTenantSettings?: (c: unknown) => Promise<{ timezone?: unknown }> } | undefined;
        const t = (await idp?.getTenantSettings?.(ctx))?.timezone;
        if (!validZone(t)) throw new LimsError('common.internal');
        timezone = t as string;
      }
      const caps = b['capabilities'] as { host_query: boolean; worklist_download: boolean };
      const row: Row = {
        id: uuidv7(), centre_id: agent.centre_id, agent_id: agent.id, instrument_code: b['instrument_code'], display_name: b['display_name'], vendor: b['vendor'], model: b['model'],
        serial_no: b['serial_no'] ?? null, software_version: b['software_version'] ?? null, protocol: b['protocol'], driver_code: b['driver_code'], transport: b['transport'],
        protocol_options: b['protocol_options'] ?? {}, parser_options: b['parser_options'] ?? {}, file_drop: b['file_drop'] ?? null,
        cap_host_query: caps.host_query, cap_worklist_download: caps.worklist_download, qc_sample_id_patterns: b['qc_sample_id_patterns'] ?? [], timezone,
        silence_window_minutes: b['silence_window_minutes'] ?? null, silence_active_from: b['silence_active_from'] ?? null, silence_active_to: b['silence_active_to'] ?? null,
        state: instrumentNext(null, 'create'), version: 1, created_by: s.actorId,
      };
      let created: Row;
      try {
        created = await repo.insertInstrument(s.tx, s.tenantId, row);
      } catch (e) {
        if ((e as { code?: unknown })?.code === '23505') throw new LimsError('instruments.code_duplicate');   // AC-03.6
        throw e;
      }
      return { status: 201, body: toInstrument(created, driverOf(drivers, created['driver_code'])), version: created['version'] };
    },

    /** E25 */
    async getInstrument(ctx: InstrumentsCtx, input: { instrumentId?: unknown }): Promise<Result> {
      const s = scope(ctx);
      const row = await loadInstrument(repo, s, input?.instrumentId, READ);
      const drivers = await repo.listDrivers(s.tx);
      return { status: 200, body: toInstrument(row, driverOf(drivers, row['driver_code'])), version: row['version'] };
    },

    /** E26 — AC-03.5. A config version is published only when a field the agent config carries really changes on a non-draft instrument (03-APP-FLOW §2.2). */
    async updateInstrument(ctx: InstrumentsCtx, input: { instrumentId?: unknown; expectedVersion?: unknown; patch?: unknown }): Promise<Result> {
      const s = scope(ctx);
      const v = version(input?.expectedVersion);
      const patch = checkFields(input.patch ?? {}, UPDATE_KEYS);
      if (Object.keys(patch).length === 0) fail('/');
      const row = await loadInstrument(repo, s, input.instrumentId, MANAGE);
      if (row['state'] === 'retired') throw new LimsError('instruments.invalid_transition');
      if (row['version'] !== v) throw new LimsError('common.version_conflict');
      const current = view(row);
      const merged: Row = { ...current, ...patch };
      if (['protocol', 'transport', 'protocol_options', 'file_drop', 'silence_active_from', 'silence_active_to'].some((k) => k in patch)) checkShape(merged);
      const drivers = await repo.listDrivers(s.tx);
      if (['driver_code', 'capabilities', 'protocol'].some((k) => k in patch)) {
        const purpose: DriverPurpose = row['state'] === 'draft' ? 'create' : row['state'] === 'commissioning' ? 'commissioning' : 'live';
        checkDriver(drivers, merged, 'driver_code' in patch || 'protocol' in patch ? purpose : undefined);
      }
      const { capabilities, ...rest } = patch;
      const cols: Row = { ...rest, updated_by: s.actorId };
      if (capabilities !== undefined) Object.assign(cols, { cap_host_query: capabilities.host_query, cap_worklist_download: capabilities.worklist_download });
      const out = await repo.updateInstrument(s.tx, s.tenantId, row['id'], v, cols);
      if (!out) throw new LimsError('common.version_conflict');
      if (row['state'] !== 'draft' && AGENT_KEYS.some((k) => k in patch && !isDeepStrictEqual(patch[k], current[k]))) await publishFor(s, out['agent_id']);
      return { status: 200, body: toInstrument(out, driverOf(drivers, out['driver_code'])), version: out['version'] };
    },

    /** E27 — AC-04.1 (I2): a generic driver may be commissioned (shadow only); transport must be valid. */
    startInstrumentCommissioning: transition('startCommissioning', () => ({}), (row, drivers) => {
      selectable(driverOf(drivers, row['driver_code']), 'commissioning');
      schemaFail('/transport', validateTransport(row['transport']));
      return {};
    }),

    /** E28 — AC-04.2 / AC-04.3 (I3). Guard order: state -> driver -> checklist. */
    goLiveInstrument: transition('goLive', (body) => {
      if (!isObj(body) || !isObj(body['checklist'])) fail(isObj(body) ? '/checklist' : '/');
      const b = body as Row;
      for (const k of Object.keys(b)) if (k !== 'checklist' && k !== 'evidence_note') fail(keyPath(k));
      for (const k of Object.keys(b['checklist'])) if (!CHECKLIST_KEYS.includes(k)) fail('/checklist');
      if (b['evidence_note'] !== undefined && (typeof b['evidence_note'] !== 'string' || b['evidence_note'].length > 2000
        || (b['evidence_note'].trim().length > 0 && b['evidence_note'].length < 10))) fail('/evidence_note');   // 10–2000 (02-TRD.md:706); blank -> checklist_incomplete below
      return { checklist: b['checklist'], evidenceNote: b['evidence_note'] };
    }, (row, drivers, p) => {
      live(row, drivers);
      const note = p['evidenceNote'];
      if (CHECKLIST_KEYS.some((k) => p['checklist'][k] !== true) || typeof note !== 'string' || note.trim().length === 0) throw new LimsError('instruments.go_live_checklist_incomplete');
      return { checklist: { ...Object.fromEntries(CHECKLIST_KEYS.map((k) => [k, true])), evidence_note: note } };
    }),

    /** E29 — AC-04.4 (I4) */
    suspendInstrument: transition('suspend', reasonOf, (_row, _drivers, p) => p),

    /** E30 — AC-04.4 (I5): the driver must still be verified. */
    resumeInstrument: transition('resume', () => ({}), (row, drivers) => { live(row, drivers); return {}; }),

    /** E31 (I6) */
    retireInstrument: transition('retire', reasonOf, (_row, _drivers, p) => p),
  };
}
export type InstrumentsService = ReturnType<typeof createInstrumentsService>;
