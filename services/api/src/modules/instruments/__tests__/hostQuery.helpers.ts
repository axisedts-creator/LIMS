// C7 API-T10 test helpers (not a test file). Synthetic data only. Builds on ingest.helpers.ts (T09). SEAMS the spec leaves open — the writer must match them or raise a dispute:
//
//   ../service/hostQuery.service.ts  `createHostQueryService(deps?: { repo?: IngestRepo & { findMessageRaw }, getDriver?: (code) => InstrumentDriver|undefined (default: drivers/registry) })`
//                                    -> submitHostQuery(ctx, { body }) [E05] -> { status: 200, body: { server_time, instrument_message_id, reply_messages: [{ raw_base64 }], answer_summary: [{ index, status, test_count }] } }.
//                                    `body` = SNAKE_CASE request body (contracts/openapi/instruments.yaml, no `kind`). Errors are thrown as LimsError (code asserted); the Idempotency-Key replay is the core's job.
//   ../repo/ingest.repo.ts           the T09 `IngestRepo` is reused AS IS (findInstrument, findMessageByAgentKey, findMessageByKey, insertMessage, insertDuplicate, insertRejection, insertRun, insertRecords,
//                                    recordInstrumentActivity) PLUS ONE new method for 02-TRD §6.6 "rebuild the reply against the stored message":
//                                      findMessageRaw(tx, tenantId, messageId): Promise<{ raw_bytes: Buffer; raw_sha256: string } | undefined>
//   ctx (device)                     as makeIngestCtx + `ports.LabPort.getPendingTestsForBarcode(ctx, { instrumentId, barcode })`, `ports.CatalogPort.mapInstrumentCode(ctx, { instrumentId, direction:'outbound', analyteId })`
//                                    -> { instrumentCode, analyteId, testId, ... } (throws code `catalog.instrument_code_unmapped`), and `ctx.commitOnError()` (core hook; the service calls it before every throw that must keep rows).
//   Rows written                     messages.message_kind='host_query'; processing_runs kind 'live', outcome 'parsed' (or 'rejected_capability'), host_query_records = barcodes; ONE message_records row per barcode
//                                    (record_class 'host_query', emit_status 'not_applicable', detail { status, test_count }).
import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import { idN } from './agents.helpers.js';
import { CENTRE_A1, GLU_MAP, INS, TENANT_A, batch, bytes, makeCatalog, makeIngestCtx, makeWorld, msgId, sha256hex, seedInstruments, type IngestRepo, type Row, type World } from './ingest.helpers.js';
import type { HostQueryAnswer, InstrumentDriver, ParseResult } from '../drivers/types.js';

export { idN, INS, TENANT_A, CENTRE_A1, GLU_MAP, msgId, sha256hex, bytes, batch, seedInstruments, makeCatalog };
export type { Row, World };

export const HQ_DRIVER = 'fake_hq_verified';
export const BARCODE = 'E2600000042';                      // planted PHI sentinel (log scan): must never reach logs / metrics / answer_summary
export const BARCODE_2 = 'E2600000043';
export const BARCODE_3 = 'E2600000044';
export const AN = { glu: idN(0xc001), na: idN(0xc002), k: idN(0xc003) };
export const TEST = { glu: idN(0xd001), elec: idN(0xd002) };
export const ORDER_CODES: Record<string, string> = { [AN.glu]: 'GLU', [AN.na]: 'NA' };   // outbound map; AN.k is deliberately unmapped

/** query bytes the fake driver understands: `Q:<barcode>;<barcode>`; anything starting `BAD` is malformed. */
export const queryBytes = (...barcodes: string[]) => bytes(`Q:${barcodes.join(';')}`);

export interface HqDriverOpts { protocol?: 'astm' | 'hl7v2'; status?: InstrumentDriver['status']; hostQuery?: boolean; controlId?: string; replyMessages?: number; buildThrows?: Error }
export function hqDriver(o: HqDriverOpts = {}) {
  const calls = { parse: 0, build: [] as Array<{ answers: readonly HostQueryAnswer[]; ctx: unknown }> };
  const driver: InstrumentDriver = {
    code: HQ_DRIVER, version: '9.9.9', protocol: o.protocol ?? 'astm', status: o.status ?? 'verified', optionsSchema: {},
    capabilities: { resultUpload: true, hostQuery: o.hostQuery ?? true, worklistDownload: false, qc: true, attachments: false, calibration: false },
    parse(raw): ParseResult {
      calls.parse++;
      const text = Buffer.from(raw).toString('latin1');
      if (!text.startsWith('Q:')) return { ok: false, errorCode: 'instruments.message_malformed', reason: 'not_a_query' };
      const codes = text.slice(2).split(';').filter(Boolean);
      return { ok: true, messageKind: 'host_query', ...(o.controlId ? { messageControlId: o.controlId } : {}),
        records: codes.map((c, i) => ({ recordSeq: i + 1, recordClass: 'host_query' as const, sampleBarcode: c, instrumentFlags: [], warnings: [] })), warnings: [] };
    },
    extractHostQueryBarcodes: (parsed) => parsed.records.map((r) => r.sampleBarcode as string),
    buildHostQueryReply({ answers, ctx }) {
      calls.build.push({ answers, ctx });
      if (o.buildThrows) throw o.buildThrows;
      const body = answers.map((a) => `${a.status}:${a.tests.map((t) => t.instrumentCode).join(',')}`).join(';');
      return Array.from({ length: o.replyMessages ?? 1 }, (_v, i) => Buffer.from(`R${i}|${body}`, 'latin1'));
    },
  };
  return { driver, calls, getDriver: (code: string) => (code === HQ_DRIVER ? driver : undefined) };
}
export const expectedReply = (answers: string, i = 0) => Buffer.from(`R${i}|${answers}`, 'latin1').toString('base64');

// ---------------------------------------------------------------------------------------------------- LabPort fake (C5): barcode -> pending tests | error code
export type LabEntry = { priority?: 'routine' | 'urgent'; sex?: string; ageDays?: number; tests: Array<{ testId: string; analyteIds: string[] }> } | { error: string };
export function makeLab(table: Record<string, LabEntry>, o: { delayMs?: number } = {}) {
  const calls: Array<{ ctx: any; input: Row }> = [];
  const getPendingTestsForBarcode = async (ctx: any, input: Row) => {
    calls.push({ ctx, input });
    if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
    const e = table[String(input['barcode'])] ?? { error: 'lab.specimen_not_found' };
    if ('error' in e) throw Object.assign(new Error(e.error), { code: e.error });
    return { specimenId: idN(0xe001), priority: e.priority ?? 'routine', patient: { sex: e.sex ?? 'female', ...(e.ageDays === undefined ? {} : { ageDays: e.ageDays }) },
      tests: e.tests.map((t, i) => ({ orderItemId: idN(0xe100 + i), testId: t.testId, analyteIds: t.analyteIds })) };
  };
  return { calls, port: { getPendingTestsForBarcode } };
}
/** outbound catalog: analyteId -> instrument code (ORDER_CODES), others unmapped. */
export function makeOutboundCatalog(codes: Record<string, string> = ORDER_CODES) {
  const calls: Array<{ ctx: unknown; input: Row }> = [];
  const mapInstrumentCode = async (ctx: unknown, input: Row) => {
    calls.push({ ctx, input });
    const code = input['direction'] === 'outbound' ? codes[String(input['analyteId'])] : undefined;
    if (!code) throw Object.assign(new Error('catalog.instrument_code_unmapped'), { code: 'catalog.instrument_code_unmapped' });
    return { mappingId: idN(0xb100), instrumentId: input['instrumentId'], instrumentCode: code, analyteId: input['analyteId'], testId: TEST.glu };
  };
  return { calls, mapInstrumentCode };
}

// ---------------------------------------------------------------------------------------------------- the E05 world
export function hqRepo(w: World): IngestRepo & { findMessageRaw(tx: any, tenantId: string, messageId: string): Promise<{ raw_bytes: Buffer; raw_sha256: string } | undefined> } {
  return { ...w.repo, async findMessageRaw(_tx, t, id) { const m = w.messages.find((x) => x['tenant_id'] === t && x['id'] === id); return m ? { raw_bytes: m['raw_bytes'], raw_sha256: m['raw_sha256'] } : undefined; } };
}
export interface HqOpts { instruments?: Row[]; driver?: HqDriverOpts; lab?: Record<string, LabEntry>; labDelayMs?: number; deviceAgent?: string; catalog?: Record<string, string> }
export function hqSetup(o: HqOpts = {}) {
  const world = makeWorld({ ...(o.deviceAgent ? { deviceAgent: o.deviceAgent } : {}), instruments: o.instruments ?? defaultInstruments() });
  const driver = hqDriver(o.driver);
  const lab = makeLab(o.lab ?? { [BARCODE]: { priority: 'urgent', ageDays: 9000, tests: [{ testId: TEST.glu, analyteIds: [AN.glu] }, { testId: TEST.elec, analyteIds: [AN.na, AN.k] }] } }, { ...(o.labDelayMs ? { delayMs: o.labDelayMs } : {}) });
  const catalog = makeOutboundCatalog(o.catalog);
  const c = makeIngestCtx(world);
  const commitOnError = vi.fn();
  Object.assign(c.ctx, { commitOnError, ports: { CatalogPort: { mapInstrumentCode: catalog.mapInstrumentCode }, LabPort: lab.port } });
  return { world, driver, lab, ...c, catalog, commitOnError, repo: hqRepo(world) };
}
/** INS 1 live ASTM (agent A1) with host query on; INS 2 live HL7; INS 3 other centre; INS 4 other agent of A1; INS 5 draft; INS 6 commissioning; INS 7 suspended; INS 8 tenant B. */
export function defaultInstruments(): Row[] {
  const base = seedInstruments();
  const pick = (n: number, o: Row = {}) => ({ ...structuredClone(base[n - 1]!), driver_code: HQ_DRIVER, cap_host_query: true, ...o });
  return [pick(1, { state: 'live' }), pick(2, { state: 'live', protocol: 'hl7v2' }), pick(3), pick(4), pick(5), pick(6), pick(7), pick(8)];
}
let counter = 0;
export const hqBody = (o: { n?: number; instrument?: string; protocol?: 'astm' | 'hl7v2'; raw?: Buffer; sha?: string } & Row = {}): Row => {
  const buf = o.raw ?? queryBytes(BARCODE);
  const { n, instrument, protocol, raw: _r, sha, ...rest } = o;
  return { instrument_id: instrument ?? INS(1), agent_message_id: msgId(n ?? 500 + ++counter), protocol: protocol ?? 'astm', raw_base64: buf.toString('base64'), raw_sha256: sha ?? sha256hex(buf),
    captured_at_agent: '2026-11-07T04:26:50.000Z', clock_offset_ms: 8000, ...rest };
};
export const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
