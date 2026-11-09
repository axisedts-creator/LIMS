// C7 API-T09 test helpers (not a test file). Synthetic data only. SEAMS the spec leaves open — the writer must match them or raise a dispute:
//
//   ../events/publish.ts           exports `createInstrumentEvents(events: { publish(ctx, type, input) })` -> { resultReceived(ctx, payload), qcReceived(ctx, payload, { rawSha256 }) } (payload = SNAKE_CASE
//                                  03-IC §3.14/§3.15, verbatim; the publisher adds aggregate { type:'instrument_message', id: payload.instrument_message_id, seq:1 } and the §6.5 idempotency key), plus the pure
//                                  `resultIdempotencyKey(payload)` / `qcIdempotencyKey(payload, rawSha256)`. (API-T16 adds calibrationReceived + health_changed to the same file.)
//   ../repo/ingest.repo.ts         exports `IngestRepo` (interface below) + `createIngestRepo(): IngestRepo` (SQL on the request tx, explicit tenant predicate on every statement; reads run under device RLS).
//   ../service/ingest.service.ts   `createIngestService(deps?: { repo?, getDriver?: (code) => InstrumentDriver|undefined (default: drivers/registry), monotonicMs?: () => number (default performance.now),
//                                  budgetMs?: number (default config batchTimeBudgetMs 8000), maxMessageBytes?: number (default 1 MiB) })` -> submitMessageBatch(ctx, { body }) [E04] -> { status: 200, body: { server_time, results } }.
//                                  `body` = SNAKE_CASE request body as in contracts/openapi/instruments.yaml. Events: the service builds `createInstrumentEvents(ctx.events)` per call.
//                                  Per message the service runs `ctx.tx.savepoint(fn)` (core Tx.savepoint): a throw rolls repo writes AND published events of THAT message back; outcome `retry`, error_code `common.internal`.
//                                  Catalog: `ctx.ports.CatalogPort.mapInstrumentCode(ctx, { instrumentId, direction:'inbound', instrumentCode })`, memoised per batch.
//   ../handlers/ingest.handlers.ts exports `ingestHandlers` = { submitMessageBatch } (replaces the E04 stub in handlers/index.ts); body passed through as `{ body }`; result passthrough.
//
//   ctx (device) = { tenantId, actor:{type:'device', id:<agent_id>}, claims:{credential_kind:'device_token', credential_id}, clientIp, requestId, tx, events (REAL core createEvents), ports:{CatalogPort}, log, metrics?, now }.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createEvents } from '../../../core/events/publish.js';
import type { InstrumentDriver, ParseOk, ParsedRecord } from '../drivers/types.js';
import { AGENT_A1, AGENT_A2, INS, insRow, type Row } from './instruments.helpers.js';
import { CENTRE_A1, CENTRE_A2, NOW, REQ_ID, TENANT_A, TENANT_B, idN } from './agents.helpers.js';

export { idN, CENTRE_A1, CENTRE_A2, NOW, TENANT_A, TENANT_B, REQ_ID, AGENT_A1, AGENT_A2, INS };
export type { Row };
export const AGENT_A1B = idN(0x1010);          // second agent of centre A1 (same-centre mismatch, AC-09.9)
export const AGENT_B = idN(0x1b00);
export const CRED = idN(0x6002);
export const sha256hex = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
export const MiB = 1024 * 1024;
export const PLANT = { barcode: 'E2600000042', name: 'Testpatient', value: '7731.4421' };   // planted PHI sentinels (log-scan)

// ---------------------------------------------------------------------------------------------------- raw fixtures (driver golden files, used as-is)
const raw = (driver: string, f: string) => readFileSync(new URL(`../drivers/${driver}/testdata/${f}.raw`, import.meta.url), 'latin1');
export const ASTM_PATIENT = raw('astm_generic_e1394', 'patient-two-results');   // E2600000042: GLU 5.4 + NA 141, H.14 10:15 local, R.13 10:12 local
export const ASTM_QC = raw('astm_generic_e1394', 'qc-sample-pattern');            // sample id QC-L1-0007, GLU 5.0
export const HL7_ORU = raw('hl7v2_generic_oru', 'oru-patient');                    // MSH-10 MSG00001, GLU 5.4 + HBSAG Negative
export const bytes = (s: string) => Buffer.from(s, 'latin1');

// ---------------------------------------------------------------------------------------------------- request fixtures
let seq = 0;
export const msgId = (n: number) => idN(0x9000 + n);
export function message(o: { n?: number; instrument?: string; protocol?: 'astm' | 'hl7v2'; raw?: Buffer | string; kind?: string; sha?: string; capturedAtAgent?: string; offsetMs?: number } & Row = {}): Row {
  const buf = Buffer.isBuffer(o.raw) ? o.raw : bytes((o.raw as string | undefined) ?? ASTM_PATIENT);
  const { n, instrument, protocol, raw: _r, kind, sha, capturedAtAgent, offsetMs, ...rest } = o;
  return { agent_message_id: msgId(n ?? ++seq), instrument_id: instrument ?? INS(1), protocol: protocol ?? 'astm', kind: kind ?? 'data', raw_base64: buf.toString('base64'),
    raw_sha256: sha ?? sha256hex(buf), captured_at_agent: capturedAtAgent ?? '2026-11-07T04:26:50.000Z', clock_offset_ms: offsetMs ?? 8000, ...rest };
}
export const batch = (messages: Row[], o: Row = {}): Row => ({ sent_at_agent: '2026-11-07T04:27:00.000Z', clock_offset_ms: 111, messages, ...o });
/** instrument rows: live ASTM (INS 1), live HL7 (INS 2), centre A2 (INS 3), bound to a second A1 agent (INS 4), draft (INS 5), commissioning (INS 6), suspended (INS 7), tenant B (INS 8). */
export const seedInstruments = (): Row[] => [
  insRow(1, { state: 'live', agent_id: AGENT_A1, qc_sample_id_patterns: ['^QC-'] }),
  insRow(2, { state: 'live', agent_id: AGENT_A1, protocol: 'hl7v2', driver_code: 'hl7v2_generic_oru', qc_sample_id_patterns: ['^QC-'] }),
  insRow(3, { state: 'live', agent_id: AGENT_A2, centre_id: CENTRE_A2 }),
  insRow(4, { state: 'live', agent_id: AGENT_A1B }),
  insRow(5, { state: 'draft' }), insRow(6, { state: 'commissioning' }), insRow(7, { state: 'suspended' }),
  insRow(8, { state: 'live', tenant_id: TENANT_B, agent_id: AGENT_B, centre_id: CENTRE_A1 }),
];

// ---------------------------------------------------------------------------------------------------- the repo seam
export interface IngestRepo {
  /** instruments row (cols of 05-SCHEMA §2.8: id, centre_id, agent_id, protocol, driver_code, state, timezone, parser_options, qc_sample_id_patterns, …) visible to the DEVICE under RLS (its own centre only); else undefined. */
  findInstrument(tx: any, tenantId: string, instrumentId: string): Promise<Row | undefined>;
  /** step 4 */
  findMessageByAgentKey(tx: any, tenantId: string, agentId: string, agentMessageId: string): Promise<{ id: string } | undefined>;
  /** step 7: (instrument_id, message_key) */
  findMessageByKey(tx: any, tenantId: string, instrumentId: string, messageKey: string): Promise<{ id: string; raw_sha256: string } | undefined>;
  /** step 8: columns of 05-SCHEMA §2.10 (instrument_id, centre_id, agent_id, agent_message_id, protocol, message_kind, message_key, message_key_kind, message_control_id, raw_bytes (Buffer), raw_sha256, size_bytes,
   *  captured_at_agent, agent_clock_offset_ms, captured_at, link_meta, warnings, created_by). received_at = tx time (set by the repo/DB). */
  insertMessage(tx: any, tenantId: string, row: Row): Promise<{ id: string; received_at: string }>;
  /** message_duplicates: centre_id, agent_id, instrument_id, original_message_id, agent_message_id, reason ('agent_message_id'|'message_key'). */
  insertDuplicate(tx: any, tenantId: string, row: Row): Promise<void>;
  /** message_rejections: agent_id, claimed_instrument_id, agent_message_id, reason_code, raw_bytes (Buffer|null), raw_sha256, size_bytes. centre_id = the AGENT's centre, derived by the repo. */
  insertRejection(tx: any, tenantId: string, row: Row): Promise<void>;
  /** processing_runs (class A, ONE insert with final counters): centre_id, message_id, run_no, kind, driver_code, driver_version, outcome, error_code?, error_reason?, the 8 counters, actor_type. */
  insertRun(tx: any, tenantId: string, row: Row): Promise<{ id: string }>;
  /** message_records (class A, one batched insert per message, final emit_status/event_id): rows of 05-SCHEMA §2.12 incl. run_id, message_id, centre_id, instrument_id. */
  insertRecords(tx: any, tenantId: string, rows: Row[]): Promise<void>;
  /** observed_codes upsert: { centre_id, instrument_id, record_class, instrument_analyte_code, mapping_status, analyte_id|null }[] */
  upsertObservedCodes(tx: any, tenantId: string, rows: Row[]): Promise<void>;
  /** instrument_status: { lastMessageAt, lastMessageAtAgent, instrumentClockOffsetSeconds?: number|null } — offset left untouched when null/undefined. */
  recordInstrumentActivity(tx: any, tenantId: string, instrumentId: string, o: { lastMessageAt: string; lastMessageAtAgent: string; instrumentClockOffsetSeconds?: number | null }): Promise<void>;
}

// ---------------------------------------------------------------------------------------------------- the world: in-memory DB with savepoint semantics + core event_log
export interface WorldOpts { instruments?: Row[]; deviceAgent?: string; agents?: Row[] }
export function makeWorld(o: WorldOpts = {}) {
  const agents = o.agents ?? [{ id: AGENT_A1, tenant_id: TENANT_A, centre_id: CENTRE_A1 }, { id: AGENT_A1B, tenant_id: TENANT_A, centre_id: CENTRE_A1 }, { id: AGENT_A2, tenant_id: TENANT_A, centre_id: CENTRE_A2 }, { id: AGENT_B, tenant_id: TENANT_B, centre_id: CENTRE_A1 }];
  const deviceAgent = o.deviceAgent ?? AGENT_A1;
  const deviceCentre = agents.find((a) => a['id'] === deviceAgent)!['centre_id'];
  let s = { messages: [] as Row[], runs: [] as Row[], records: [] as Row[], duplicates: [] as Row[], rejections: [] as Row[], observed: [] as Row[], status: [] as Row[], events: [] as Row[], jobs: 0, order: [] as string[] };
  const instruments = (o.instruments ?? seedInstruments()).map((r) => structuredClone(r));
  const calls: Array<{ op: string; tenantId: string; args: unknown[] }> = [];
  const failures: Array<{ op: string; when: (a: unknown[]) => boolean; err: () => Error }> = [];
  let n = 0;
  const uid = () => idN(0xa000 + ++n);
  const rec = async <T>(op: string, tenantId: string, args: unknown[], fn: () => T): Promise<T> => {
    calls.push({ op, tenantId, args }); await Promise.resolve();
    for (const f of failures) if (f.op === op && f.when(args)) throw f.err();
    s.order.push(op); return fn();
  };
  const tx: any = {
    startedAt: new Date(NOW), operation: { module: 'instruments', operationId: 'submitMessageBatch' }, savepoints: 0, rollbacks: 0,
    async query(text: string, values: unknown[] = []) {                  // only what core events.publish issues
      if (/INSERT\s+INTO\s+core\.event_log/i.test(text)) {
        const env = values.find((v) => v && typeof v === 'object' && !(v instanceof Date) && 'event_id' in (v as object)) as Row;
        if (s.events.some((e) => e['tenant_id'] === env['tenant_id'] && e['event_type'] === env['event_type'] && e['idempotency_key'] === env['idempotency_key'])) return { rows: [] };
        s.events.push(env); s.order.push('event'); return { rows: [{ event_id: env['event_id'] }] };
      }
      if (/FROM\s+core\.event_log/i.test(text)) { const hit = s.events.find((e) => values.includes(e['event_type']) && values.includes(e['idempotency_key'])); return { rows: hit ? [{ event_id: hit['event_id'] }] : [] }; }
      if (/app\.enqueue_job/i.test(text)) { s.jobs++; return { rows: [{ enqueue_job: null }] }; }
      return { rows: [] };
    },
    async savepoint<T>(fn: (t: unknown) => Promise<T>): Promise<T> {
      tx.savepoints++; const snap = structuredClone(s);
      try { return await fn(tx); } catch (e) { s = snap; tx.rollbacks++; throw e; }
    },
  };
  const mine = (t: string, rows: Row[]) => rows.filter((r) => r['tenant_id'] === t);
  const repo: IngestRepo = {
    findInstrument: (_tx, t, id) => rec('findInstrument', t, [id], () => { const r = mine(t, instruments).find((i) => i['id'] === id && i['centre_id'] === deviceCentre); return r ? structuredClone(r) : undefined; }),
    findMessageByAgentKey: (_tx, t, agent, amid) => rec('findMessageByAgentKey', t, [agent, amid], () => { const m = mine(t, s.messages).find((x) => x['agent_id'] === agent && x['agent_message_id'] === amid); return m ? { id: m['id'] } : undefined; }),
    findMessageByKey: (_tx, t, ins, key) => rec('findMessageByKey', t, [ins, key], () => { const m = mine(t, s.messages).find((x) => x['instrument_id'] === ins && x['message_key'] === key); return m ? { id: m['id'], raw_sha256: m['raw_sha256'] } : undefined; }),
    insertMessage: (_tx, t, row) => rec('insertMessage', t, [row], () => {
      if (mine(t, s.messages).some((x) => x['agent_id'] === row['agent_id'] && x['agent_message_id'] === row['agent_message_id'])) throw Object.assign(new Error('duplicate key'), { code: '23505' });
      if (mine(t, s.messages).some((x) => x['instrument_id'] === row['instrument_id'] && x['message_key'] === row['message_key'])) throw Object.assign(new Error('duplicate key'), { code: '23505' });
      const r = { tenant_id: t, id: uid(), received_at: tx.startedAt.toISOString(), ...structuredClone(row) }; s.messages.push(r); return { id: r['id'], received_at: r['received_at'] };
    }),
    insertDuplicate: (_tx, t, row) => rec('insertDuplicate', t, [row], () => { s.duplicates.push({ tenant_id: t, id: uid(), ...structuredClone(row) }); }),
    insertRejection: (_tx, t, row) => rec('insertRejection', t, [row], () => { s.rejections.push({ tenant_id: t, id: uid(), centre_id: agents.find((a) => a['id'] === row['agent_id'])?.['centre_id'], ...structuredClone(row) }); }),
    insertRun: (_tx, t, row) => rec('insertRun', t, [row], () => { const r = { tenant_id: t, id: uid(), ...structuredClone(row) }; s.runs.push(r); return { id: r['id'] }; }),
    insertRecords: (_tx, t, rows) => rec('insertRecords', t, [rows], () => { for (const r of rows) s.records.push({ tenant_id: t, id: uid(), ...structuredClone(r) }); }),
    upsertObservedCodes: (_tx, t, rows) => rec('upsertObservedCodes', t, [rows], () => { for (const r of rows) s.observed.push({ tenant_id: t, ...structuredClone(r) }); }),
    recordInstrumentActivity: (_tx, t, id, a) => rec('recordInstrumentActivity', t, [id, a], () => { s.status.push({ tenant_id: t, instrument_id: id, ...a }); }),
  };
  return {
    repo, tx, calls, deviceAgent, deviceCentre,
    get messages() { return s.messages; }, get runs() { return s.runs; }, get records() { return s.records; }, get duplicates() { return s.duplicates; },
    get rejections() { return s.rejections; }, get observed() { return s.observed; }, get status() { return s.status; }, get events() { return s.events; }, get order() { return s.order; },
    callsOf: (op: string) => calls.filter((c) => c.op === op),
    eventsOf: (type: string) => s.events.filter((e) => e['event_type'] === type),
    mutations: () => calls.filter((c) => /^(insert|upsert|record)/.test(c.op)),
    failOn: (op: string, when: (a: unknown[]) => boolean = () => true, err: () => Error = () => new Error('db down')) => { failures.push({ op, when, err }); },
    instrument: (id: string) => instruments.find((i) => i['id'] === id) as Row,
  };
}
export type World = ReturnType<typeof makeWorld>;

// ---------------------------------------------------------------------------------------------------- ctx + catalog + log capture
export const GLU_MAP = { analyteId: idN(0xb001), testId: idN(0xb002) };
export function makeCatalog(unmappedPrefix = 'NA') {
  const calls: Array<{ ctx: unknown; input: Row }> = [];
  const mapInstrumentCode = async (ctx: unknown, input: Row) => {
    calls.push({ ctx, input });
    const code = String(input['instrumentCode']);
    if (code.startsWith(unmappedPrefix) || code.startsWith('UN')) throw Object.assign(new Error('catalog.instrument_code_unmapped'), { code: 'catalog.instrument_code_unmapped' });
    return { mappingId: idN(0xb100), instrumentId: input['instrumentId'], instrumentCode: code, analyteId: GLU_MAP.analyteId, testId: GLU_MAP.testId };
  };
  return { mapInstrumentCode, calls };
}
export function makeIngestCtx(world: World, o: { tenantId?: string; agentId?: string; catalog?: ReturnType<typeof makeCatalog> } = {}) {
  const lines: string[] = [];
  const metricCalls: string[] = [];
  const catalog = o.catalog ?? makeCatalog();
  const rec = (level: string) => (...a: unknown[]) => { lines.push(JSON.stringify({ level, a }, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : typeof v === 'bigint' ? String(v) : v))); };
  const events = createEvents({ producer: 'instruments', log: { warn: rec('warn') as any, error: rec('error') as any } as any });
  const ctx: any = {
    tenantId: o.tenantId ?? TENANT_A, actor: { type: 'device', id: o.agentId ?? world.deviceAgent }, claims: { credential_kind: 'device_token', credential_id: CRED },
    clientIp: '203.0.113.9', requestId: REQ_ID, tx: world.tx, events, now: () => NOW,
    ports: { CatalogPort: { mapInstrumentCode: catalog.mapInstrumentCode } },
    log: { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') },
    metrics: { inc: (...a: unknown[]) => { metricCalls.push(JSON.stringify(a)); } },
  };
  return { ctx, lines, metricCalls, catalog, logText: () => lines.join('\n') + '\n' + metricCalls.join('\n') };
}

// ---------------------------------------------------------------------------------------------------- synthetic drivers (for cases the generic drivers cannot produce)
export const rec1 = (o: Partial<ParsedRecord> & { recordSeq: number }): ParsedRecord => ({ recordClass: 'patient', recordKind: 'quantitative', instrumentFlags: [], warnings: [], ...o });
export function fakeDriver(records: ParsedRecord[], o: { code?: string; messageKind?: ParseOk['messageKind']; calibration?: boolean; controlId?: string } = {}) {
  const parse = Object.assign(((_raw: Uint8Array, _ctx: unknown) => ({ ok: true as const, messageKind: o.messageKind ?? 'results', records, warnings: [] })) as InstrumentDriver['parse'], {});
  let parseCalls = 0;
  const driver: InstrumentDriver = {
    code: o.code ?? 'astm_generic_e1394', version: '9.9.9', protocol: 'astm', status: 'generic', optionsSchema: {},
    capabilities: { resultUpload: true, hostQuery: false, worklistDownload: false, qc: true, attachments: false, calibration: o.calibration ?? false },
    parse: (r, c) => { parseCalls++; return parse(r, c); },
  };
  return { driver, getDriver: (_code: string) => driver, parseCalls: () => parseCalls };
}
/** wraps the REAL registry driver of a code and counts parse() calls ("nothing is parsed"). */
export async function spyRegistry() {
  const { getDriver } = await import('../drivers/registry.js');
  let parses = 0;
  return { getDriver: (code: string) => { const d = getDriver(code); return d && { ...d, parse: (r: Uint8Array, c: any) => { parses++; return d.parse(r, c); } }; }, parses: () => parses };
}
