// Instrument apply pipeline (02-TRD §4.5 steps 1-12 + attachment rule; 03-IC §3.14, §4.5 ingestInstrumentResult; PRD AC-14.1..14.4, 14.7, 14.8;
// 07-SECURITY P-08, S-07, S-08, REQ-SEC-024, REQ-SEC-098, REQ-SEC-121; 08 A13 D-10, A17.1, CR-C5-008, CR-C7-011, CR-C9-004). Runs in the caller's transaction (ctx.tx).
// Two entries, one pipeline: ingestInstrumentResult (port path, caller actor) and applyInstrumentResultEvent (bulk path, system actor).
// Tenant comes from ctx only (never from the payload); every store call is (ctx.tx, ctx.tenantId, ...). Logs carry outcome codes only: the result key
// contains the barcode (P2) and values are P3 (REQ-SEC-098). A technical failure propagates (the caller rolls back / the job retries): never a silent ack.
// Decision table = ../domain/matching.ts (pure).
import { LimsError, isLimsError } from '../../../core/errors.js';
import { attachmentTenantOk, classifyRecord, decideMatch, decideUnit, resultKey, type IngestReason, type MatchDecision, type RecordKind } from '../domain/matching.js';
import { DECIMAL_RE, fractionDigits } from '../domain/flags.js';
import { createLabEvents } from '../events/publish.js';
import type { RepoCtx } from '../repository/base.repo.js';
import { claimIngestKey, closeOpenIngestExceptions, finishIngestLog, upsertOpenIngestException } from '../repository/ingest.repo.js';
import { getLabSettings } from '../repository/labSettings.repo.js';
import { findSpecimenByBarcode } from '../repository/specimens.repo.js';
import { enqueueReapplyForSpecimen } from './exception.service.js';
import { labMetrics } from './metrics.js';
import { evaluateValue, criticalAction, type EvalCtx, type Evaluation } from './evaluation.service.js';
import {
  assertManualValueAllowed, autoVerifyAfterInstrumentSave, type EntryRow, type EntryStore, type EntryValue, type ResultRow, type VerifyStore,
} from './result.service.js';

export type IngestOutcome = 'applied' | 'duplicate' | 'unmatched' | 'rejected_state' | 'held' | 'not_applicable';
export interface IngestResult { outcome: IngestOutcome; resultId?: string; specimenId?: string; reasonCode?: string; saved?: ResultRow }   // `saved` (T-23): the row after the save, for the assign response
/** T-23 (§4.5 replay): `resultKey` keeps the stored key of an exception; `assign` replaces steps 4-9 by the caller's target row (override_analyte lets the analyte differ). */
export interface RunOptions { resultKey?: string; assign?: { target: EntryRow; overrideAnalyte: boolean } }

/** InstrumentResultInput (03-IC §4.5) = the instruments.result.received.v1 payload camelCased (08 A13 D-10). */
export interface InstrumentResultInput {
  instrumentMessageId: string; instrumentId: string; agentId: string; centreId: string; protocol: 'astm' | 'hl7v2' | 'file_drop';
  sampleBarcode: string; recordKind: RecordKind; instrumentAnalyteCode: string; mappingStatus: 'mapped' | 'unmapped'; analyteId?: string; testId?: string;
  valueRaw?: string; valueNumeric?: string; unitRaw?: string; unitCode?: string; instrumentFlags?: readonly string[];
  instrumentResultTime?: string; instrumentClockOffsetSeconds?: number; receivedAt: string; isRerun?: boolean;
  capturedAt?: string; processingKind?: 'live' | 'reprocess' | 'rematch'; sourceRecordId?: string;
  attachment?: { bucket: string; objectPath: string; sha256: string; mimeType: string };
}
export interface InstrumentResultEnvelope { event_id: string; tenant_id: string; payload: Record<string, any> }

export interface ClaimResult { inserted: boolean; logId: string; lastOutcome: IngestOutcome; resultId?: string; specimenId?: string; openExceptionId?: string }
export interface IngestSpecimen { specimenId: string; status: string; isActive: boolean; centreId: string; processingCentreId?: string | undefined }
export interface ExceptionInput {
  resultKey: string; reason: IngestReason; centreId: string; processingCentreId?: string; instrumentId: string; instrumentMessageId: string; agentId?: string; protocol?: string;
  sampleBarcode: string; recordKind: RecordKind; instrumentAnalyteCode: string; analyteId?: string; testId?: string; specimenId?: string; resultId?: string;
  valueRaw?: string; valueNumeric?: string; unitRaw?: string; unitCode?: string; instrumentFlags: readonly string[]; instrumentResultTime?: string; receivedAt: string; isRerun?: boolean;
  attachment?: InstrumentResultInput['attachment']; occurredAt: string;
}
export interface SaveInstrumentInput {
  resultId: string; expectedRowVersion: number; transition: 'R2' | 'R3'; origin: 'instrument'; instrumentId: string; value: EntryValue; unitCode?: string; unitMismatch: boolean; onHold: boolean;
  instrumentFlags: readonly string[]; rawInstrumentFlags: readonly string[]; valueRaw?: string; unitRaw?: string; evaluation?: Evaluation; instrumentResultTime?: string;
  receivedAt: string; isRerun: boolean; instrumentMessageId: string;
}
/** Every call takes (tx, tenantId, ...). The production (SQL) store is wired with the core pipeline (as T-14/T-16). */
export interface IngestStore extends Pick<EntryStore, 'deltaInputs' | 'listCriticalLog' | 'insertCriticalLog' | 'markCriticalValueChanged'>, Pick<VerifyStore, 'lockForVerify' | 'verify' | 'rollupSpecimen'> {
  /** step 1: INSERT lab.ingest_log ... ON CONFLICT DO NOTHING; on conflict the stored outcome (+ the open C5 exception of the key). */
  claimKey(tx: unknown, tenantId: string, a: { resultKey: string; centreId: string; firstSource: 'event' | 'port'; firstEventId?: string; occurredAt: string }): Promise<ClaimResult>;
  findSpecimen(tx: unknown, tenantId: string, barcode: string): Promise<IngestSpecimen | undefined>;
  getIngestAutoReceive(tx: unknown, tenantId: string): Promise<boolean>;
  /** non-cancelled results of the specimen, ids ascending, FOR UPDATE (02-TRD §3.2). */
  lockSpecimenResults(tx: unknown, tenantId: string, specimenId: string): Promise<EntryRow[]>;
  /** S4 as system (03-IC §10.1). */
  receiveSpecimen(tx: unknown, tenantId: string, a: { specimenId: string; processingCentreId: string; occurredAt: string }): Promise<void>;
  isOnQcHold(tx: unknown, tenantId: string, a: { instrumentId: string; analyteId: string; at: string }): Promise<boolean>;
  /** R2/R3 UPDATE ... WHERE version (common.version_conflict on a lost race) + lab.result_observations row. */
  saveInstrumentResult(tx: unknown, tenantId: string, a: SaveInstrumentInput): Promise<ResultRow>;
  insertAttachment(tx: unknown, tenantId: string, a: { resultId: string; bucket: string; objectPath: string; sha256: string; mimeType: string }): Promise<void>;
  /** upsert on the open key (tenant_id, result_key) WHERE status = 'open'. */
  upsertOpenException(tx: unknown, tenantId: string, a: ExceptionInput): Promise<{ exceptionId: string }>;
  closeOpenExceptions(tx: unknown, tenantId: string, a: { resultKey: string; resolution: 'applied' | 'assigned'; resolverMembershipId?: string; resultId?: string; occurredAt: string }): Promise<void>;
  finishLog(tx: unknown, tenantId: string, logId: string, a: { lastOutcome: IngestOutcome; resultId?: string; specimenId?: string; processingCentreId?: string; exceptionId?: string; occurredAt: string }): Promise<void>;
}

interface LogLike { info(...a: unknown[]): unknown; warn(...a: unknown[]): unknown }
export interface IngestCtx {
  readonly tenantId: string;
  readonly actor: { readonly type?: string; readonly id: string; readonly membershipId?: string };
  readonly tx: object;
  now(): Date;
  readonly store: IngestStore;
  readonly config: { readonly autoverifyHookEnabled: boolean };
  readonly events: { publish(ctx: any, type: string, input: any): Promise<unknown> };
  readonly audit?: unknown;
  readonly log?: LogLike;
  readonly ports: {
    readonly CatalogPort: EvalCtx['ports']['CatalogPort'] & {
      mapInstrumentCode(ctx: any, q: { instrumentId: string; direction: 'inbound' | 'outbound'; instrumentCode?: string }): Promise<{
        analyteId: string; testId?: string; unitConversion?: { fromUnitRaw: string; toUnitCode: string; factor: string }; flagMap?: Readonly<Record<string, string>>;
      }>;
    };
    readonly QualityPort?: unknown;
    readonly IdentityPort?: unknown;
  };
}

// ----------------------------------------------------------------------------------------------------------------------------------------- SQL store
const RESULT_SIDE = ['lockSpecimenResults', 'receiveSpecimen', 'isOnQcHold', 'saveInstrumentResult', 'insertAttachment', 'deltaInputs', 'listCriticalLog', 'insertCriticalLog',
  'markCriticalValueChanged', 'lockForVerify', 'verify', 'rollupSpecimen'] as const;

/**
 * Production store for the job/request transaction. Ingest tables, specimen lookup and lab_settings are SQL here (repository/ingest.repo.ts, specimens.repo.ts, labSettings.repo.ts).
 * The result-side members (row locks, R2/R3 save, S4, QC hold, critical log, verify, roll-up) are the core-pipeline store of T-14/T-16 (`resultSide`); without it they fail closed
 * with common.internal (the transaction rolls back, the job retries) — never a silent ack.
 */
export function sqlIngestStore(actorId: string, resultSide?: Partial<IngestStore>): IngestStore {
  const rc = (tx: unknown, tenantId: string): RepoCtx => ({ tx: tx as RepoCtx['tx'], tenantId, actorId });
  const delegate = Object.fromEntries(RESULT_SIDE.map((m) => [m, async (...a: unknown[]) => {
    const f = (resultSide as Record<string, unknown> | undefined)?.[m];
    if (typeof f !== 'function') throw new LimsError('common.internal');
    return (f as (...x: unknown[]) => unknown).apply(resultSide, a);
  }])) as unknown as Pick<IngestStore, (typeof RESULT_SIDE)[number]>;
  return {
    ...delegate,
    claimKey: (tx, t, a) => claimIngestKey(rc(tx, t), a),
    async findSpecimen(tx, t, barcode) {
      const r = await findSpecimenByBarcode(rc(tx, t), barcode);
      return r ? { specimenId: r['id'], status: r['status'], isActive: r['is_active'] === true, centreId: r['centre_id'], processingCentreId: r['processing_centre_id'] ?? undefined } : undefined;
    },
    async getIngestAutoReceive(tx, t) { return (await getLabSettings(rc(tx, t)))?.['ingest_auto_receive'] === true; },   // no row = column default (false)
    upsertOpenException: (tx, t, a) => upsertOpenIngestException(rc(tx, t), a as unknown as Record<string, unknown>),
    closeOpenExceptions: (tx, t, a) => closeOpenIngestExceptions(rc(tx, t), a),
    finishLog: (tx, t, id, a) => finishIngestLog(rc(tx, t), id, a),
  };
}

// ----------------------------------------------------------------------------------------------------------------------------------------- input checks
const BARCODE = /^[A-Za-z0-9]{1,40}$/;        // label alphabet [A-Z0-9] (02-TRD §4.2); the payload cap is 40 (03-IC §3.14). No quote, space or control character reaches a query or a key.
const MAX_VALUE_RAW = 200, MAX_CODE = 64;     // 03-IC §3.14 payload caps
const MAX_FRACTION = 6;                       // evaluateValue's default when an analyte has no decimals (evaluation.service DEFAULT_MAX_DECIMALS)
const bad = () => new LimsError('common.validation_failed');   // never echoes the value (REQ-SEC-098)

function checkInput(i: InstrumentResultInput): void {
  if (typeof i?.sampleBarcode !== 'string' || !BARCODE.test(i.sampleBarcode)) throw bad();
  if (typeof i.instrumentAnalyteCode !== 'string' || i.instrumentAnalyteCode.length < 1 || i.instrumentAnalyteCode.length > MAX_CODE) throw bad();
  if (i.valueRaw !== undefined && (typeof i.valueRaw !== 'string' || i.valueRaw.length > MAX_VALUE_RAW)) throw bad();
  if (typeof i.instrumentId !== 'string' || typeof i.instrumentMessageId !== 'string' || typeof i.centreId !== 'string' || typeof i.receivedAt !== 'string') throw bad();
  if (i.instrumentFlags !== undefined && !Array.isArray(i.instrumentFlags)) throw bad();
}

/** snake_case event payload (03-IC §3.14) -> InstrumentResultInput. Only declared fields are read; the tenant is never taken from the payload. */
function fromPayload(p: Record<string, any>): InstrumentResultInput {
  const o: Record<string, unknown> = {};
  const map: [string, string][] = [
    ['instrument_message_id', 'instrumentMessageId'], ['instrument_id', 'instrumentId'], ['agent_id', 'agentId'], ['centre_id', 'centreId'], ['protocol', 'protocol'],
    ['sample_barcode', 'sampleBarcode'], ['record_kind', 'recordKind'], ['instrument_analyte_code', 'instrumentAnalyteCode'], ['mapping_status', 'mappingStatus'],
    ['analyte_id', 'analyteId'], ['test_id', 'testId'], ['value_raw', 'valueRaw'], ['value_numeric', 'valueNumeric'], ['unit_raw', 'unitRaw'], ['unit_code', 'unitCode'],
    ['instrument_flags', 'instrumentFlags'], ['instrument_result_time', 'instrumentResultTime'], ['instrument_clock_offset_seconds', 'instrumentClockOffsetSeconds'],
    ['received_at', 'receivedAt'], ['is_rerun', 'isRerun'], ['captured_at', 'capturedAt'], ['processing_kind', 'processingKind'], ['source_record_id', 'sourceRecordId'],
  ];
  for (const [s, c] of map) if (p?.[s] !== undefined && p[s] !== null) o[c] = p[s];
  const a = p?.['attachment'];
  if (a && typeof a === 'object') o['attachment'] = { bucket: a.bucket, objectPath: a.object_path, sha256: a.sha256, mimeType: a.mime_type };
  return o as unknown as InstrumentResultInput;
}

// ----------------------------------------------------------------------------------------------------------------------------------------- exact decimals
/** value x factor without floating point; result rounded half away from zero to MAX_FRACTION digits (raw as received stays in the observation). */
function mulDecimal(a: string, b: string): string {
  const p = (s: string) => {
    const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
    if (!m) throw bad();
    return { neg: m[1] === '-', digits: BigInt(`${m[2]}${m[3] ?? ''}`), scale: (m[3] ?? '').length };
  };
  const x = p(a), y = p(b);
  let digits = x.digits * y.digits, scale = x.scale + y.scale;
  if (scale > MAX_FRACTION) {
    const div = 10n ** BigInt(scale - MAX_FRACTION);
    digits = (digits + div / 2n) / div;
    scale = MAX_FRACTION;
  }
  const s = digits.toString().padStart(scale + 1, '0');
  const int = scale === 0 ? s : s.slice(0, s.length - scale);
  const frac = scale === 0 ? '' : s.slice(s.length - scale).replace(/0+$/, '');
  const text = frac ? `${int}.${frac}` : int;
  return digits !== 0n && x.neg !== y.neg ? `-${text}` : text;
}

const KIND_FIELD: Record<string, 'numeric' | 'ordinal' | 'text' | undefined> = { numeric: 'numeric', ordinal: 'ordinal', coded: 'ordinal', text: 'text' };

// ----------------------------------------------------------------------------------------------------------------------------------------- pipeline
async function run(ctx: IngestCtx, i: InstrumentResultInput, source: 'event' | 'port', eventId?: string, opts: RunOptions = {}): Promise<IngestResult> {
  const { tx, tenantId, store } = ctx;
  checkInput(i);
  const key = opts.resultKey ?? resultKey(i);
  const assign = opts.assign;
  const at = ctx.now().toISOString();
  const flags = [...(i.instrumentFlags ?? [])];

  // step 1: claim the result-level key; a stored unmatched/rejected_state outcome WITH an open exception is re-evaluated (replay after a fix, CR-C7-011)
  const claim = await store.claimKey(tx, tenantId, { resultKey: key, centreId: i.centreId, firstSource: source, ...(eventId === undefined ? {} : { firstEventId: eventId }), occurredAt: at });
  if (!claim.inserted) {
    const replay = (claim.lastOutcome === 'unmatched' || claim.lastOutcome === 'rejected_state') && claim.openExceptionId !== undefined;
    if (!replay) return { outcome: 'duplicate', ...(claim.resultId === undefined ? {} : { resultId: claim.resultId }), ...(claim.specimenId === undefined ? {} : { specimenId: claim.specimenId }) };
  }

  const exceptionFor = (reason: IngestReason, extra: { specimenId?: string; processingCentreId?: string; resultId?: string; analyteId?: string; testId?: string } = {}): ExceptionInput => ({
    resultKey: key, reason, centreId: i.centreId, instrumentId: i.instrumentId, instrumentMessageId: i.instrumentMessageId, agentId: i.agentId, protocol: i.protocol,
    sampleBarcode: i.sampleBarcode, recordKind: i.recordKind, instrumentAnalyteCode: i.instrumentAnalyteCode, instrumentFlags: flags, receivedAt: i.receivedAt, occurredAt: at,
    ...(i.valueRaw === undefined ? {} : { valueRaw: i.valueRaw }), ...(i.valueNumeric === undefined ? {} : { valueNumeric: i.valueNumeric }),
    ...(i.unitRaw === undefined ? {} : { unitRaw: i.unitRaw }), ...(i.unitCode === undefined ? {} : { unitCode: i.unitCode }),
    ...(i.instrumentResultTime === undefined ? {} : { instrumentResultTime: i.instrumentResultTime }), ...(i.isRerun === undefined ? {} : { isRerun: i.isRerun }),
    ...(reason === 'attachment_tenant_mismatch' || i.attachment === undefined ? {} : { attachment: i.attachment }),   // a foreign-tenant path is not persisted
    ...(i.analyteId === undefined ? {} : { analyteId: i.analyteId }), ...(i.testId === undefined ? {} : { testId: i.testId }),
    ...extra,
  });
  /** unmatched / rejected_state: open exception + log, nothing saved. */
  const refuse = async (outcome: 'unmatched' | 'rejected_state', reason: IngestReason, extra: { specimenId?: string; processingCentreId?: string; resultId?: string; analyteId?: string; testId?: string } = {}, reasonCode?: string): Promise<IngestResult> => {
    const { exceptionId } = await store.upsertOpenException(tx, tenantId, exceptionFor(reason, extra));
    await store.finishLog(tx, tenantId, claim.logId, {
      lastOutcome: outcome, exceptionId, occurredAt: at,
      ...(extra.specimenId === undefined ? {} : { specimenId: extra.specimenId }), ...(extra.processingCentreId === undefined ? {} : { processingCentreId: extra.processingCentreId }),
      ...(extra.resultId === undefined ? {} : { resultId: extra.resultId }),
    });
    ctx.log?.info({ msg: 'lab.ingest', outcome, reason });
    return { outcome, ...(extra.specimenId === undefined ? {} : { specimenId: extra.specimenId }), ...(extra.resultId === undefined ? {} : { resultId: extra.resultId }), ...(reasonCode === undefined ? {} : { reasonCode }) };
  };

  // step 2: organism_id / ast are C10's
  if (classifyRecord(i.recordKind) === 'not_applicable') {
    await store.finishLog(tx, tenantId, claim.logId, { lastOutcome: 'not_applicable', occurredAt: at });
    ctx.log?.info({ msg: 'lab.ingest', outcome: 'not_applicable' });
    return { outcome: 'not_applicable' };
  }

  // attachment guard (REQ-SEC-121): the object path must live under ctx.tenantId. Checked before any lookup so a mis-bound device learns nothing.
  if (i.recordKind === 'attachment') {
    const a = i.attachment;
    if (!a || !attachmentTenantOk(a.objectPath, tenantId)) return refuse('unmatched', 'attachment_tenant_mismatch', {}, 'attachment_tenant_mismatch');
  }

  // step 3: the analyte, from the catalog (always: it also carries flagMap and unitConversion). Only `unmapped` is an outcome; any other failure propagates.
  type Mapping = Awaited<ReturnType<IngestCtx['ports']['CatalogPort']['mapInstrumentCode']>>;
  let mapping: Mapping | undefined;
  try {
    mapping = await ctx.ports.CatalogPort.mapInstrumentCode(ctx, { instrumentId: i.instrumentId, direction: 'inbound', instrumentCode: i.instrumentAnalyteCode });
  } catch (e) {
    if (!isLimsError(e, 'catalog.instrument_code_unmapped')) throw e;
    // T-24 (02-TRD §4.5 step 3): the catalog is the fallback only for a record WITHOUT its analyte. A record the instrument module already resolved (mappingStatus mapped + analyteId)
    // continues on its own analyte, without flagMap / unitConversion; an assignment does not need the mapping either (only the analyte check below does).
    if (!assign && !(i.mappingStatus === 'mapped' && i.analyteId !== undefined)) return refuse('unmatched', 'unmapped_code');
  }
  if (assign) {   // T-23: the caller picked the target; a different (or unmapped) analyte needs override_analyte (04-UI-UX §3.10)
    if (!assign.overrideAnalyte && mapping?.analyteId !== assign.target.analyteId) {
      throw new LimsError('common.validation_failed', undefined, [{ path: '/override_analyte', code: 'common.field_invalid', message: 'override_analyte is required to apply to a different analyte' }]);
    }
  } else if (!mapping?.analyteId && !(i.mappingStatus === 'mapped' && i.analyteId !== undefined)) return refuse('unmatched', 'unmapped_code');
  const fromPayload = !mapping?.analyteId && i.mappingStatus === 'mapped' && i.analyteId !== undefined;
  const analyteId = fromPayload ? i.analyteId : mapping?.analyteId, testId = fromPayload ? i.testId : mapping?.testId;
  const known = { ...(analyteId === undefined ? {} : { analyteId }), ...(testId === undefined ? {} : { testId }) };

  // steps 4-9: the pure table. The results are read (and locked, 02-TRD §3.2: results before specimen) only once steps 4-6 let the record through.
  let specimen: IngestSpecimen | undefined;
  let decision: MatchDecision;
  let rows: EntryRow[] = [];
  if (assign) {   // steps 4-7 are the caller's choice; 8-9 still protect approved / verified rows (04 R1)
    const t = assign.target;
    if (!t.specimenId) throw new LimsError('common.validation_failed', undefined, [{ path: '/result_id', code: 'common.field_invalid', message: 'result has no specimen' }]);
    specimen = { specimenId: t.specimenId, status: 'received', isActive: true, centreId: t.centreId };
    rows = [t];
    if (t.status === 'approved') decision = { outcome: 'rejected_state', exception: 'result_locked', reasonCode: 'result_locked', resultId: t.resultId };
    else if (t.status === 'verified') decision = { outcome: 'unmatched', exception: 'result_already_verified', resultId: t.resultId };
    else if (t.status === 'pending' || t.status === 'resulted') decision = { outcome: 'apply', resultId: t.resultId, receive: false };
    else throw new LimsError('common.not_found');   // cancelled / unknown: not a target
  } else {
    specimen = await store.findSpecimen(tx, tenantId, i.sampleBarcode);
    const waiting = specimen !== undefined && (specimen.status === 'collected' || specimen.status === 'in_transit');
    const autoReceive = waiting ? await store.getIngestAutoReceive(tx, tenantId) : false;
    const view = specimen && { status: specimen.status, isActive: specimen.isActive };
    const first = decideMatch({ specimen: view, autoReceive, analyteId: analyteId as string, testId, results: [] });
    decision = first;
    if (specimen && first.outcome === 'unmatched' && first.exception === 'analyte_not_ordered') {   // steps 4-6 passed
      rows = await store.lockSpecimenResults(tx, tenantId, specimen.specimenId);
      decision = decideMatch({
        specimen: view, autoReceive, analyteId: analyteId as string, testId,
        results: rows.map((r) => ({ resultId: r.resultId, analyteId: r.analyteId, testId: r.testId, status: r.status })),
      });
    }
  }
  let processingCentreId = specimen?.processingCentreId;
  if (specimen && decision.receive === true) {   // S4 as system, processing centre = the event centre; stays done even if the analyte turns out not to be ordered (same tx)
    await store.receiveSpecimen(tx, tenantId, { specimenId: specimen.specimenId, processingCentreId: i.centreId, occurredAt: at });
    await enqueueReapplyForSpecimen(ctx as never, specimen.specimenId);   // T-23 review: S4 side effect (03-APP-FLOW S4, 02-TRD §8 "enqueued in the receive tx"); same ctx.tx, rollback drops the job
    processingCentreId = i.centreId;
  }
  const spec = specimen === undefined ? {} : { specimenId: specimen.specimenId, ...(processingCentreId === undefined ? {} : { processingCentreId }) };
  if (decision.outcome !== 'apply') {
    return refuse(decision.outcome, decision.exception, { ...spec, ...(decision.resultId === undefined ? {} : { resultId: decision.resultId }), ...known }, decision.reasonCode);
  }
  const row = rows.find((r) => r.resultId === decision.resultId);
  if (!specimen || !row) throw new LimsError('common.internal');   // the table picked a row the store did not return

  // attachment: attach the file to the matched result; no value is saved
  if (i.recordKind === 'attachment') {
    const a = i.attachment as NonNullable<InstrumentResultInput['attachment']>;
    await store.insertAttachment(tx, tenantId, { resultId: row.resultId, bucket: a.bucket, objectPath: a.objectPath, sha256: a.sha256, mimeType: a.mimeType });
    return finishApplied(row, 'applied');
  }

  // step 10: unit
  assertManualValueAllowed(row);   // a calculated analyte never takes a measured value (AC-09.7)
  const map = mapping && mapping.analyteId === row.analyteId ? mapping : undefined;   // conversion / flag map belong to the mapped analyte only (assign with override_analyte)
  const unit = decideUnit({ unitRaw: i.unitRaw, unitCode: i.unitCode, analyteUnitCode: row.unitCode, unitConversion: map?.unitConversion });
  const field = KIND_FIELD[row.analyte.resultType];
  if (field === undefined) throw new LimsError('lab.result_value_invalid');   // narrative / attachment analytes take no value
  const raw = field === 'numeric' ? i.valueNumeric : i.valueRaw;
  if (raw === undefined || raw === '') throw new LimsError('lab.result_value_invalid');
  let text = raw;
  if (field === 'numeric') {
    if (!DECIMAL_RE.test(raw)) throw new LimsError('lab.result_value_invalid');   // no NaN / text into a numeric result
    text = unit.valueFactor === undefined ? raw : mulDecimal(raw, unit.valueFactor);
    if (fractionDigits(text) > MAX_FRACTION) text = mulDecimal(text, '1');
  }
  const value: EntryValue = field === 'numeric' ? { numeric: text } : field === 'ordinal' ? { ordinalCode: text } : { text };

  // step 11: hold, evaluation (skipped on a unit mismatch), save
  const onHold = await store.isOnQcHold(tx, tenantId, { instrumentId: i.instrumentId, analyteId: row.analyteId, at: i.instrumentResultTime ?? i.receivedAt });
  let evaluation: Evaluation | undefined;
  if (!unit.unitMismatch) {
    const delta = await store.deltaInputs(tx, tenantId, row);
    evaluation = await evaluateValue(ctx as unknown as EvalCtx, {
      analyte: { id: row.analyte.id, resultType: row.analyte.resultType, ...(row.analyte.ordinalSetValues === undefined ? {} : { ordinalSetValues: row.analyte.ordinalSetValues }) },   // reporting decimals are not enforced on a device value
      value: text, sex: row.sex, patientAgeDays: row.patientAgeDays,
      ...(row.specimenTypeCode === undefined ? {} : { specimenTypeCode: row.specimenTypeCode }), ...(row.collectedAt === undefined ? {} : { collectedAt: row.collectedAt }),
      ...(unit.storedUnitCode === undefined ? (row.unitCode === undefined ? {} : { unitCode: row.unitCode }) : { unitCode: unit.storedUnitCode }),
      ...(delta.rule === undefined ? {} : { deltaRule: delta.rule }), deltaCandidates: delta.candidates,
    });
  }
  const mappedFlags = flags.map((f) => (map?.flagMap && Object.hasOwn(map.flagMap, f) ? (map.flagMap[f] as string) : f));
  const saved = await store.saveInstrumentResult(tx, tenantId, {
    resultId: row.resultId, expectedRowVersion: row.rowVersion, transition: row.status === 'pending' ? 'R2' : 'R3', origin: 'instrument', instrumentId: i.instrumentId, value,
    ...(unit.storedUnitCode === undefined ? {} : { unitCode: unit.storedUnitCode }), unitMismatch: unit.unitMismatch, onHold, instrumentFlags: mappedFlags, rawInstrumentFlags: flags,
    ...(i.valueRaw === undefined ? {} : { valueRaw: i.valueRaw }), ...(i.unitRaw === undefined ? {} : { unitRaw: i.unitRaw }), ...(evaluation === undefined ? {} : { evaluation }),
    ...(i.instrumentResultTime === undefined ? {} : { instrumentResultTime: i.instrumentResultTime }), receivedAt: i.receivedAt, isRerun: i.isRerun ?? false, instrumentMessageId: i.instrumentMessageId,
  });

  // critical value (02-TRD §4.3 step 4): same log/event rule as manual entry; idempotent on (result, version, value hash). No value in the event (S-12).
  if (evaluation) {
    const hash = evaluation.valueSha256Prefix16;
    const existing = await store.listCriticalLog(tx, tenantId, row.resultId);
    const act = criticalAction({ isCritical: evaluation.critical.isCritical, valueSha256Prefix16: hash, existing });
    if (act.markValueChangedAfterDetection) await store.markCriticalValueChanged(tx, tenantId, row.resultId);
    if (act.insertLogAndEmit && evaluation.critical.direction) {
      const kind = field === 'numeric' ? 'n' : field === 'ordinal' ? 'o' : 't';
      const { criticalEventId } = await store.insertCriticalLog(tx, tenantId, {
        resultId: row.resultId, resultVersionNo: row.currentVersionNo, orderId: row.orderId, patientId: row.patientId, analyteId: row.analyteId, centreId: row.centreId,
        direction: evaluation.critical.direction, valueSha256Prefix16: hash, value,
        ...(evaluation.critical.criticalLimitId === undefined ? {} : { criticalLimitId: evaluation.critical.criticalLimitId }),
        ...(evaluation.critical.version === undefined ? {} : { criticalLimitVersion: evaluation.critical.version }), detectedAt: at,
      });
      await createLabEvents(ctx.events as never).criticalValueDetected(ctx as never, {
        critical_event_id: criticalEventId, result_id: row.resultId, result_version_no: row.currentVersionNo, order_id: row.orderId, patient_id: row.patientId,
        centre_id: row.centreId, analyte_id: row.analyteId, direction: evaluation.critical.direction, detected_at: at,
      }, { value: { kind, value: (value.numeric ?? value.text ?? value.ordinalCode) as string }, resultRowVersion: Number(saved['version']) });
    }
  }
  await store.rollupSpecimen(tx, tenantId, specimen.specimenId);

  // step 12 (+ unit mismatch exception, which must outlive the close): close the open exceptions of this key, then open unit_mismatch for the saved result
  const outcome = onHold ? 'held' : 'applied';
  const result = await finishApplied(row, outcome, unit.unitMismatch, saved);
  // step 11 hook: only a result that is not held, has no unit mismatch (and, inside, no unknown-age range) is ever offered to canAutoVerify (CR-C9-004, 08 A17.1)
  if (!onHold && !unit.unitMismatch) {
    const av = await autoVerifyAfterInstrumentSave(ctx, { resultId: row.resultId });
    if (av.verified && av.result) return { ...result, saved: av.result };
  }
  return result;

  async function finishApplied(target: EntryRow, out: 'applied' | 'held', mismatch = false, savedRow?: ResultRow): Promise<IngestResult> {
    await store.closeOpenExceptions(tx, tenantId, { resultKey: key, resolution: assign ? 'assigned' : 'applied', resultId: target.resultId, ...(source === 'port' && ctx.actor.membershipId !== undefined ? { resolverMembershipId: ctx.actor.membershipId } : {}), occurredAt: at });
    let exceptionId: string | undefined;
    if (mismatch) ({ exceptionId } = await store.upsertOpenException(tx, tenantId, exceptionFor('unit_mismatch', { ...spec, resultId: target.resultId, ...known })));
    await store.finishLog(tx, tenantId, claim.logId, {
      lastOutcome: out, resultId: target.resultId, specimenId: (specimen as IngestSpecimen).specimenId, occurredAt: at,
      ...(processingCentreId === undefined ? {} : { processingCentreId }), ...(exceptionId === undefined ? {} : { exceptionId }),
    });
    ctx.log?.info({ msg: 'lab.ingest', outcome: out, ...(mismatch ? { reason: 'unit_mismatch' } : {}) });
    return { outcome: out, resultId: target.resultId, specimenId: (specimen as IngestSpecimen).specimenId, ...(savedRow === undefined ? {} : { saved: savedRow }) };
  }
}

/** T-31 (02-TRD §11): one lims_lab_results_ingested_total{outcome} per finished ingest call; outcome is the IngestOutcome code only. A thrown ingest counts nothing. */
const counted = (ctx: unknown, r: IngestResult): IngestResult => { labMetrics.resultIngested(ctx, r.outcome); return r; };

/** T-23 replay of a stored exception (reapply / assign): port path under the exception's own result key (CR-C7-011); the caller actor resolves it. */
export async function reapplyInstrumentResult(rawCtx: unknown, input: InstrumentResultInput, opts: RunOptions): Promise<IngestResult> {
  const ctx = rawCtx as IngestCtx;
  if (typeof ctx?.tenantId !== 'string' || !ctx.tenantId) throw new LimsError('common.internal');
  return counted(ctx, await run(ctx, input, 'port', undefined, opts));
}

/** Port path (LabPort.ingestInstrumentResult): caller actor, first_source 'port'. Never throws lab.result_locked: an approved target is returned as rejected_state (CR-C5-008). */
export async function ingestInstrumentResult(rawCtx: unknown, input: InstrumentResultInput): Promise<IngestResult> {
  const ctx = rawCtx as IngestCtx;
  if (typeof ctx?.tenantId !== 'string' || !ctx.tenantId) throw new LimsError('common.internal');
  return counted(ctx, await run(ctx, input, 'port'));   // the tenant is ctx.tenantId only; a tenant field in the input is never read
}

/** Bulk path (instruments.result.received.v1 consumer): system actor, first_source 'event'. An envelope of another tenant is refused before any store/port call (REQ-SEC-024, P-08). */
export async function applyInstrumentResultEvent(rawCtx: unknown, envelope: InstrumentResultEnvelope): Promise<IngestResult> {
  const ctx = rawCtx as IngestCtx;
  if (typeof ctx?.tenantId !== 'string' || !ctx.tenantId || envelope?.tenant_id !== ctx.tenantId) throw new LimsError('common.internal');
  return counted(ctx, await run(ctx, fromPayload(envelope.payload), 'event', envelope.event_id));
}
