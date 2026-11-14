// E05 submitHostQuery — host query (02-TRD §6.6; 01-PRD AC-10.1–10.5, AC-10.7; 07-SECURITY REQ-SEC-072, S-01, S-02, S-08).
// Reuses the E04 repo (steps 1-4, 8, 12 of §6.4). The query is archived like any message (kind host_query); the reply is built by the driver from C5's pending tests.
// Idempotency-Key replays are the core's job; an agent-key duplicate that gets here (no/expired key) rebuilds the reply from the STORED bytes.
// Logs, metrics and persisted fields carry codes and ids only: never a barcode (02-CV §9.2). This service logs nothing.
import { createHash } from 'node:crypto';
import { LimsError } from '../../../core/errors.js';
import { loadInstrumentsConfig, type InstrumentsConfig } from '../config.js';
import { capturedAt as correctedTime } from '../domain/instrumentTime.js';
import { getDriver as registryGetDriver } from '../drivers/registry.js';
import type { DriverContext, HostQueryAnswer, InstrumentDriver, ParseOk } from '../drivers/types.js';
import { createIngestRepo, type HostQueryRepo } from '../repo/ingest.repo.js';
import { isUuid } from './agents.service.js';
import { deviceScope, type DeviceCtx, type DeviceResult } from './enrolment.service.js';

type Row = Record<string, any>;
export interface HostQueryCtx extends DeviceCtx {
  readonly ports?: {
    readonly LabPort?: { getPendingTestsForBarcode(ctx: unknown, input: { instrumentId: string; barcode: string }): Promise<Row> };
    readonly CatalogPort?: { mapInstrumentCode(ctx: unknown, input: { instrumentId: string; direction: 'outbound'; analyteId: string }): Promise<Row> };
  };
  commitOnError?(): void;                     // core hook: keep this tx's rows although the request ends in a 4xx
}
export interface HostQueryDeps { repo?: HostQueryRepo; getDriver?: (code: string) => InstrumentDriver | undefined; maxMessageBytes?: number }

const MAX_BARCODES = 50;
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
const SEX = new Set(['male', 'female', 'other', 'unknown']);
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const obj = (v: unknown): Row => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Row) : {});
const code = (e: unknown) => (e as { code?: unknown } | null)?.code;
const COUNTERS = { patient_records: 0, qc_records: 0, calibrator_records: 0, host_query_records: 0, unmapped_records: 0, skipped_no_barcode_records: 0, emitted_events: 0, skipped_records: 0 };

export function createHostQueryService(deps: HostQueryDeps = {}) {
  const repo = deps.repo ?? createIngestRepo();
  const getDriver = deps.getDriver ?? registryGetDriver;
  let cfg: InstrumentsConfig | undefined;
  const conf = () => (cfg ??= loadInstrumentsConfig());

  /** C5 pending tests per barcode (one call each, in parallel), catalog OUTBOUND per analyte (memoised per request). */
  async function answerAll(ctx: HostQueryCtx, instrumentId: string, barcodes: readonly string[]): Promise<HostQueryAnswer[]> {
    if (barcodes.length === 0) return [];                 // no barcode asked: no LabPort/CatalogPort lookup
    const lab = ctx.ports?.LabPort; const cat = ctx.ports?.CatalogPort;
    if (!lab || !cat) throw new LimsError('common.internal');
    const memo = new Map<string, Promise<string | undefined>>();
    const instrumentCode = (analyteId: string) => {
      let p = memo.get(analyteId);
      if (!p) {
        p = cat.mapInstrumentCode(ctx, { instrumentId, direction: 'outbound', analyteId }).then(
          (r) => (typeof r['instrumentCode'] === 'string' && r['instrumentCode'].length >= 1 && r['instrumentCode'].length <= 64 ? r['instrumentCode'] : undefined),
          (e) => { if (code(e) !== 'catalog.instrument_code_unmapped') throw e; return undefined; });
        memo.set(analyteId, p);
      }
      return p;
    };
    return Promise.all(barcodes.map(async (barcode): Promise<HostQueryAnswer> => {
      let r: Row;
      try { r = await lab.getPendingTestsForBarcode(ctx, { instrumentId, barcode }); } catch (e) {
        if (code(e) === 'lab.specimen_not_found') return { barcode, status: 'not_found', tests: [] };
        if (code(e) === 'lab.specimen_not_receivable') return { barcode, status: 'not_receivable', tests: [] };
        throw e;                                          // anything else is not an answer
      }
      const tests: Array<{ testId: any; analyteId: any; instrumentCode: string }> = [];
      for (const t of Array.isArray(r['tests']) ? r['tests'] : []) {
        for (const analyteId of Array.isArray(t.analyteIds) ? t.analyteIds : []) {
          const c = await instrumentCode(analyteId);      // unmapped analytes are skipped
          if (c) tests.push({ testId: t.testId, analyteId, instrumentCode: c });
        }
      }
      if (!tests.length) return { barcode, status: 'no_mapped_tests', tests: [] };
      const pat = obj(r['patient']);
      return { barcode, status: 'found', ...(r['priority'] === 'routine' || r['priority'] === 'urgent' ? { priority: r['priority'] } : {}),
        ...(SEX.has(pat['sex']) ? { sex: pat['sex'] } : {}), ...(Number.isSafeInteger(pat['ageDays']) ? { ageDays: pat['ageDays'] } : {}), tests };
    }));
  }

  function driverCtx(ins: Row, tx: any, captured: string): DriverContext {
    return { receivedAt: new Date(tx.startedAt).toISOString() as DriverContext['receivedAt'], capturedAt: captured as DriverContext['capturedAt'], instrumentTimezone: ins['timezone'],
      qcSampleIdPatterns: [], options: obj(ins['parser_options']) };
  }

  function parseQuery(driver: InstrumentDriver, ins: Row, raw: Buffer, tx: any, captured: string): { parsed: ParseOk; barcodes: string[] } | undefined {
    const dctx = driverCtx(ins, tx, captured);
    try {
      const pr = driver.parse(raw, dctx);
      if (!pr.ok || pr.messageKind !== 'host_query') return undefined;
      const barcodes = driver.extractHostQueryBarcodes!(pr);
      // LD-163 / MET-T04 lead decision: [] is valid (Metis range modes are answered NF by the driver); gates in step 2 unchanged
      if (!Array.isArray(barcodes) || barcodes.length > MAX_BARCODES || !barcodes.every((b) => typeof b === 'string' && b.length >= 1 && b.length <= 40)) return undefined;
      return { parsed: pr, barcodes: [...barcodes] };
    } catch { return undefined; }                         // a driver bug on hostile bytes is a malformed query
  }

  const summarize = (answers: readonly HostQueryAnswer[]) => answers.map((a, index) => ({ index, status: a.status, test_count: a.tests.length }));

  return {
    /** E05 — `body` is the snake_case request body. Errors are thrown as LimsError (or the port/driver error, as is). */
    async submitHostQuery(ctx: HostQueryCtx, input: { body?: unknown }): Promise<DeviceResult> {
      const { tenantId, agentId } = deviceScope(ctx, 'device_token');
      const tx: any = ctx.tx; const b = obj(input?.body);
      const amid = b['agent_message_id']; const instrumentId = b['instrument_id']; const b64 = b['raw_base64'];
      if (!isUuid(amid) || !isUuid(instrumentId) || typeof b64 !== 'string' || b64.length % 4 !== 0 || !B64.test(b64)
        || typeof b['captured_at_agent'] !== 'string' || !Number.isSafeInteger(b['clock_offset_ms'])) throw new LimsError('common.validation_failed');
      const raw = Buffer.from(b64, 'base64');
      if (raw.length === 0) throw new LimsError('common.validation_failed');
      let captured: string;
      try { captured = correctedTime(b['captured_at_agent'], b['clock_offset_ms']); } catch { throw new LimsError('common.validation_failed'); }
      const sha = sha256(raw);
      const keep = () => ctx.commitOnError?.();
      const reply = (id: string, answers: readonly HostQueryAnswer[], buffers: readonly Uint8Array[]): DeviceResult => ({ status: 200, body: {
        server_time: new Date(ctx.now?.() ?? new Date()).toISOString(), instrument_message_id: id,
        reply_messages: buffers.map((m) => ({ raw_base64: Buffer.from(m).toString('base64') })), answer_summary: summarize(answers) } });

      const reject = async (reason: string, keepRaw: boolean): Promise<never> => {
        await repo.insertRejection(tx, tenantId, { agent_id: agentId, claimed_instrument_id: instrumentId, agent_message_id: amid, reason_code: reason, raw_bytes: keepRaw ? raw : null, raw_sha256: sha, size_bytes: raw.length });
        keep(); throw new LimsError(reason);
      };
      // 1-3 size, instrument visible to this device (RLS), bound to this agent, receivable state
      if (raw.length > (deps.maxMessageBytes ?? conf().maxMessageBytes)) return reject('instruments.message_too_large', false);
      const ins = await repo.findInstrument(tx, tenantId, instrumentId);
      if (!ins || (ins['tenant_id'] !== undefined && ins['tenant_id'] !== tenantId)) return reject('instruments.instrument_unknown', true);
      if (ins['agent_id'] !== agentId) return reject('instruments.device_mismatch', true);
      if (!['commissioning', 'live', 'suspended'].includes(ins['state'])) return reject('instruments.instrument_unknown', true);
      const driver = getDriver(ins['driver_code']);
      if (!driver) throw new LimsError('instruments.driver_not_available');
      // capability gate (AC-10.4): live instrument, host query on, verified driver that can do it
      const gated = ins['state'] !== 'live' || ins['cap_host_query'] !== true || driver.status !== 'verified' || !driver.capabilities.hostQuery
        || !driver.extractHostQueryBarcodes || !driver.buildHostQueryReply;

      // 4 L1 agent key: a retried query is a duplicate whatever its bytes; the reply is rebuilt against the stored message
      const l1 = await repo.findMessageByAgentKey(tx, tenantId, agentId, amid);
      if (l1) {
        await repo.insertDuplicate(tx, tenantId, { centre_id: ins['centre_id'], agent_id: agentId, instrument_id: ins['id'], original_message_id: l1.id, agent_message_id: amid, reason: 'agent_message_id' });
        if (gated) { keep(); throw new LimsError('instruments.capability_not_supported'); }
        const stored = await repo.findMessageRaw(tx, tenantId, l1.id);
        if (!stored) throw new LimsError('common.internal');
        const q = parseQuery(driver, ins, stored.raw_bytes, tx, captured);
        if (!q) { keep(); throw new LimsError('instruments.message_malformed'); }
        const answers = await answerAll(ctx, ins['id'], q.barcodes);
        return reply(l1.id, answers, driver.buildHostQueryReply!({ query: q.parsed, answers, ctx: driverCtx(ins, tx, captured) }));
      }
      if (String(b['raw_sha256']).toLowerCase() !== sha) throw new LimsError('common.validation_failed');

      // 7 message key (§6.5): a re-query of the same bytes is a NEW message (sha256_repeat), never a collision
      const keyFor = async (parsed?: ParseOk): Promise<{ key: string; kind: string; controlId: string | null; warnings: string[] }> => {
        const repeat = { key: `${sha}:${amid}`, kind: 'sha256_repeat', controlId: null, warnings: [] as string[] };
        const cid = parsed?.messageControlId;
        if (ins['protocol'] === 'hl7v2' && typeof cid === 'string' && cid.length >= 1 && cid.length <= 199) {
          const first = await repo.findMessageByKey(tx, tenantId, ins['id'], cid);
          if (!first) return { key: cid, kind: 'msh10', controlId: cid, warnings: [] };
          if (first.raw_sha256 === sha) return repeat;
          const reused = `${cid}:${sha.slice(0, 16)}`;                                   // D-12: control id reused with different bytes
          if (await repo.findMessageByKey(tx, tenantId, ins['id'], reused)) return repeat;
          return { key: reused, kind: 'msh10_reused', controlId: cid, warnings: ['control_id_reused'] };
        }
        return (await repo.findMessageByKey(tx, tenantId, ins['id'], sha)) ? repeat : { key: sha, kind: 'sha256', controlId: null, warnings: [] };
      };
      // 8 archive + 12 run (+ records)
      const archive = async (k: Awaited<ReturnType<typeof keyFor>>) => repo.insertMessage(tx, tenantId, { instrument_id: ins['id'], centre_id: ins['centre_id'], agent_id: agentId, agent_message_id: amid,
        protocol: ins['protocol'], message_kind: 'host_query', message_key: k.key, message_key_kind: k.kind, message_control_id: k.controlId, raw_bytes: raw, raw_sha256: sha, size_bytes: raw.length,
        captured_at_agent: b['captured_at_agent'], agent_clock_offset_ms: b['clock_offset_ms'], captured_at: captured, link_meta: {}, warnings: k.warnings, created_by: agentId });
      const run = (messageId: string, outcome: string, errorCode: string | null, hostQueryRecords = 0) => repo.insertRun(tx, tenantId, { centre_id: ins['centre_id'], message_id: messageId, run_no: 1, kind: 'live',
        driver_code: driver.code, driver_version: driver.version.slice(0, 32), outcome, error_code: errorCode, error_reason: null, ...COUNTERS, host_query_records: hostQueryRecords, actor_type: 'device', created_by: agentId });

      if (gated) {                                                       // archived, never interpreted (hostile bytes stay bytes)
        const stored = await archive(await keyFor());
        await run(stored.id, 'rejected_capability', 'instruments.capability_not_supported');
        keep(); throw new LimsError('instruments.capability_not_supported');
      }
      const q = parseQuery(driver, ins, raw, tx, captured);
      if (!q) {
        const stored = await archive(await keyFor());
        await run(stored.id, 'quarantined', 'instruments.message_malformed');
        keep(); throw new LimsError('instruments.message_malformed');
      }
      const answers = await answerAll(ctx, ins['id'], q.barcodes);       // a failure here rolls everything back: the agent retries cleanly
      const buffers = driver.buildHostQueryReply!({ query: q.parsed, answers, ctx: driverCtx(ins, tx, captured) });
      const stored = await archive(await keyFor(q.parsed));
      const r = await run(stored.id, 'parsed', null, answers.length);
      await repo.insertRecords(tx, tenantId, answers.map((a, i) => ({ centre_id: ins['centre_id'], message_id: stored.id, run_id: r.id, instrument_id: ins['id'], record_seq: i + 1, record_class: 'host_query',
        sample_barcode: a.barcode, emit_status: 'not_applicable', detail: { status: a.status, test_count: a.tests.length }, warnings: [], created_by: agentId })));
      await repo.recordInstrumentActivity(tx, tenantId, ins['id'], { lastMessageAt: new Date(stored.received_at).toISOString(), lastMessageAtAgent: new Date(b['captured_at_agent']).toISOString(), actorId: agentId });
      return reply(stored.id, answers, buffers);
    },
  };
}
export type HostQueryService = ReturnType<typeof createHostQueryService>;
