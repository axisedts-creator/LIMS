// instruments.scan_attachment (02-TRD §6.8 step 3, §10; 01-PRD AC-12.4; 07-SECURITY AB8, S-11, REQ-SEC-083..085).
// Enqueued by E06 (job_key = attachment_id). Scans the STORED quarantine object (fail closed): clean -> move out of quarantine, `clean`, append run
// `attachment_scan` + ONE new message_records row (the table is append-only), emit instruments.result.received.v1 only for a live instrument with a barcode;
// hit -> `quarantined` (never moved, never emitted); scanner unavailable -> throw (graphile retries), on the last attempt `failed`.
// Logs and metrics carry ids and codes only: never a barcode, file name or content.
import { createHash } from 'node:crypto';
import { assertBucket, assertTenantPath } from '../../../../api/src/core/storage/index.js';
import { getDriver } from '../../../../api/src/modules/instruments/drivers/registry.js';
import { createInstrumentEvents } from '../../../../api/src/modules/instruments/events/publish.js';
import { jobTenant, iso, type Ctx } from './shared.js';

type Row = Record<string, any>;
export interface ScanRepo {
  loadForScan(tx: any, tenantId: string, attachmentId: string): Promise<{ attachment: Row; instrument: Row; message: Row; record: Row } | undefined>;
  setScanState(tx: any, tenantId: string, attachmentId: string, o: { scanState: 'clean' | 'quarantined' | 'failed'; scanAttempts: number; actorId: string; objectPath?: string; sha256?: string }): Promise<void>;
  nextRunNo(tx: any, tenantId: string, messageId: string): Promise<number>;
  insertRun(tx: any, tenantId: string, row: Row): Promise<{ id: string }>;
  insertRecords(tx: any, tenantId: string, rows: Row[]): Promise<void>;
}

const METRIC = 'lims_instruments_attachment_scans_total';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
type ScanCtx = Ctx & { readonly files: { scan(bytes: Uint8Array): Promise<'clean' | 'infected' | 'unavailable'> }; readonly storage: { read(b: any, p: string): Promise<Uint8Array>; move(b: any, f: string, t: string): Promise<void> } };

export function createScanRepo(): ScanRepo {
  return {
    async loadForScan(tx, tenantId, attachmentId) {
      const q = async (sql: string, v: unknown[]) => (await tx.query(sql, v)).rows[0] as Row | undefined;
      const attachment = await q('SELECT * FROM instruments.attachments WHERE tenant_id = $1 AND id = $2', [tenantId, attachmentId]);
      if (!attachment) return undefined;
      const instrument = await q('SELECT id, tenant_id, centre_id, agent_id, state, protocol, driver_code FROM instruments.instruments WHERE tenant_id = $1 AND id = $2', [tenantId, attachment['instrument_id']]);
      const message = await q('SELECT id, centre_id, agent_id, instrument_id, received_at FROM instruments.messages WHERE tenant_id = $1 AND id = $2', [tenantId, attachment['message_id']]);
      const record = await q(`SELECT * FROM instruments.message_records WHERE tenant_id = $1 AND message_id = $2 AND emit_status = 'pending_scan' ORDER BY created_at, id LIMIT 1`, [tenantId, attachment['message_id']]);
      return instrument && message && record ? { attachment, instrument, message, record } : undefined;
    },
    async setScanState(tx, tenantId, attachmentId, o) {
      await tx.query(
        `UPDATE instruments.attachments SET scan_state = $3, scan_attempts = $4, scanned_at = now(), version = version + 1, updated_at = now(), updated_by = $5,
                object_path = COALESCE($6, object_path), sha256 = COALESCE($7, sha256) WHERE tenant_id = $1 AND id = $2`,
        [tenantId, attachmentId, o.scanState, o.scanAttempts, o.actorId, o.objectPath ?? null, o.sha256 ?? null]);
    },
    async nextRunNo(tx, tenantId, messageId) {
      return Number((await tx.query('SELECT COALESCE(MAX(run_no), 0) + 1 AS n FROM instruments.processing_runs WHERE tenant_id = $1 AND message_id = $2', [tenantId, messageId])).rows[0].n);
    },
    async insertRun(tx, tenantId, r) {
      const id = (await tx.query('SELECT gen_random_uuid() AS id')).rows[0].id as string;   // ponytail: uuidv4 (not v7) until the worker shares the API uuidv7 helper
      await tx.query(
        `INSERT INTO instruments.processing_runs (id, tenant_id, centre_id, message_id, run_no, kind, driver_code, driver_version, outcome, error_code, error_reason,
            patient_records, emitted_events, actor_type, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [id, tenantId, r['centre_id'], r['message_id'], r['run_no'], r['kind'], r['driver_code'], r['driver_version'], r['outcome'], r['error_code'] ?? null, r['error_reason'] ?? null,
          r['patient_records'] ?? 0, r['emitted_events'] ?? 0, r['actor_type'], r['created_by']]);
      return { id };
    },
    async insertRecords(tx, tenantId, rows) {
      for (const r of rows) {
        await tx.query(
          `INSERT INTO instruments.message_records (id, tenant_id, centre_id, message_id, run_id, instrument_id, record_seq, record_class, sample_barcode, record_kind, instrument_analyte_code,
              mapping_status, analyte_id, test_id, result_key_sha256, emit_status, event_id, source_record_id, created_by)
           VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
          [tenantId, r['centre_id'], r['message_id'], r['run_id'], r['instrument_id'], r['record_seq'], r['record_class'], r['sample_barcode'] ?? null, r['record_kind'] ?? null,
            r['instrument_analyte_code'] ?? null, r['mapping_status'] ?? null, r['analyte_id'] ?? null, r['test_id'] ?? null, r['result_key_sha256'] ?? null, r['emit_status'], r['event_id'] ?? null,
            r['source_record_id'] ?? null, r['created_by']]);
      }
    },
  };
}

export function createScanAttachment(deps: { repo?: ScanRepo } = {}) {
  const repo = deps.repo ?? createScanRepo();
  return async function scanAttachment(payload: { tenant_id?: unknown; attachment_id?: unknown }, ctx: ScanCtx): Promise<void> {
    const tenantId = jobTenant(payload, ctx);
    const id = payload?.attachment_id;
    if (typeof id !== 'string' || !UUID.test(id)) throw new Error('instruments.scan_attachment: attachment_id must be a uuid');
    const tx = ctx.tx; const actorId = ctx.actor.id;
    const loaded = await repo.loadForScan(tx, tenantId, id);
    if (!loaded) { ctx.log.warn({ event: 'scan_attachment_not_found', attachment_id: id }, 'scan_attachment_not_found'); return; }   // not visible: nothing to retry
    const { attachment: a, instrument, message, record } = loaded;
    if (a['scan_state'] !== 'pending') return;                                                         // clean / quarantined / failed are final: a redelivery is a no-op

    const last = ctx.attempt >= ctx.maxAttempts;
    const fail = async (reason: string, retryable: boolean): Promise<void> => {
      if (retryable && !last) throw new Error(`instruments.scan_attachment: ${reason}`);              // graphile retries; nothing was written
      await repo.setScanState(tx, tenantId, id, { scanState: 'failed', scanAttempts: ctx.attempt, actorId });
      ctx.metrics.inc(METRIC, { outcome: 'failed' });
      ctx.log.error({ event: 'attachment_scan_failed', attachment_id: id, reason }, 'attachment_scan_failed');
    };

    // a corrupt row never reads outside the tenant (path tenant check): permanent -> failed at once
    const from = String(a['object_path']);
    try { assertBucket(a['bucket']); assertTenantPath(tenantId, from); } catch { return fail('object_path_invalid', false); }
    const ext = from.split('.').pop() ?? 'bin';
    const received = new Date(message['received_at']);
    const to = `${tenantId}/${received.getUTCFullYear()}/${String(received.getUTCMonth() + 1).padStart(2, '0')}/${id}.${ext}`;

    let bytes: Uint8Array; let src = from;
    try { bytes = await ctx.storage.read(a['bucket'], from); } catch {
      try { bytes = await ctx.storage.read(a['bucket'], to); src = to; } catch { return fail('object_unreadable', true); }   // a previous attempt may have moved it before the tx failed
    }
    const verdict = await ctx.files.scan(bytes).catch((): 'unavailable' => 'unavailable');
    if (verdict === 'unavailable') return fail('scanner_unavailable', true);                           // fail closed: never clean

    const clean = verdict === 'clean';
    let finalPath: string | undefined;
    if (clean) {
      if (src !== to) await ctx.storage.move(a['bucket'], from, to);
      finalPath = to;                                                                                  // ponytail: no qpdf sanitise step yet (needs the sandbox helper); sha256 = stored bytes
    }
    const storedSha = sha256(bytes);

    // run + one NEW record row (append-only); event first (like E04) so the row carries its id
    const live = instrument['state'] === 'live';
    const barcode = typeof record['sample_barcode'] === 'string' && record['sample_barcode'].length > 0 ? record['sample_barcode'] : undefined;
    const code = record['instrument_analyte_code'];
    let status: string; let eventId: string | undefined; let resultKey: string | undefined;
    if (!clean) status = 'quarantined_attachment';
    else if (typeof code !== 'string' || code.length < 1 || code.length > 64) status = 'skipped_invalid';
    else if (!barcode) status = 'skipped_no_barcode';
    else if (!live) status = 'shadow';
    else {
      const payload = { instrument_message_id: message['id'], instrument_id: instrument['id'], agent_id: message['agent_id'], centre_id: instrument['centre_id'], protocol: 'file_drop', sample_barcode: barcode,
        record_kind: 'attachment', instrument_analyte_code: code, mapping_status: record['mapping_status'] ?? 'unmapped', ...(record['analyte_id'] ? { analyte_id: record['analyte_id'] } : {}),
        ...(record['test_id'] ? { test_id: record['test_id'] } : {}), received_at: iso(message['received_at']),
        attachment: { bucket: a['bucket'], object_path: to, sha256: storedSha, mime_type: a['mime_type'] } };
      const events = createInstrumentEvents(ctx.events as any);
      const out = await events.resultReceived(ctx, payload);
      eventId = out.eventId; status = out.duplicate ? 'duplicate_event' : 'emitted';
      resultKey = `${instrument['id']}:${barcode}:${code}:none`;
    }
    const driver = getDriver(instrument['driver_code']);
    const run = await repo.insertRun(tx, tenantId, { centre_id: instrument['centre_id'], message_id: message['id'], run_no: await repo.nextRunNo(tx, tenantId, message['id']), kind: 'attachment_scan',
      driver_code: instrument['driver_code'], driver_version: (driver?.version ?? 'unknown').slice(0, 32), outcome: clean ? 'parsed' : 'quarantined', error_code: null, error_reason: null,
      patient_records: 1, emitted_events: status === 'emitted' ? 1 : 0, actor_type: 'system', created_by: actorId });
    await repo.insertRecords(tx, tenantId, [{ centre_id: instrument['centre_id'], message_id: message['id'], run_id: run.id, instrument_id: instrument['id'], record_seq: record['record_seq'] ?? 1,
      record_class: record['record_class'] ?? 'patient', sample_barcode: record['sample_barcode'] ?? null, record_kind: 'attachment', instrument_analyte_code: record['instrument_analyte_code'] ?? null,
      mapping_status: record['mapping_status'] ?? null, analyte_id: record['analyte_id'] ?? null, test_id: record['test_id'] ?? null, result_key_sha256: resultKey ? sha256(resultKey) : null,
      emit_status: status, event_id: eventId ?? null, source_record_id: record['id'], created_by: actorId }]);
    await repo.setScanState(tx, tenantId, id, clean ? { scanState: 'clean', scanAttempts: ctx.attempt, actorId, objectPath: finalPath!, sha256: storedSha } : { scanState: 'quarantined', scanAttempts: ctx.attempt, actorId });
    ctx.metrics.inc(METRIC, { outcome: clean ? 'clean' : 'quarantined' });
    if (!clean) ctx.log.warn({ event: 'attachment_quarantined', attachment_id: id, instrument_id: instrument['id'], request_id: ctx.requestId }, 'attachment_quarantined');   // security alert: no file, name or barcode
  };
}
export const scanAttachment = createScanAttachment();
