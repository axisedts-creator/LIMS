// C9 T-25 — S-17 (dynamic) + S-15 (07-SECURITY §5; AB-09; REQ-SEC-095/098; 02-CV §9.2): PHI planted in `instruments.result.received.v1` fixtures and in decision `inputs` / free text never reaches a log
// line, a metric, an access-log row or an error message; the consumer stores no barcode/value. No database; the logger and the tx are capturing fakes.
// The static half (no console.*, no denylisted key in a log call) is static.probes.test.ts.
// Fails now if: any captured log/audit/error text contains a planted marker (barcode, value, patient name, free text, raw control id), or the consumer's SQL parameters carry them.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { handle as resultReceived } from '../../../../../../worker/src/jobs/quality/consumers/instruments.result.received.v1.js';
import { TENANT_A, TENANT_B, fire, loadManifest, makeHarness, opById, requestFor, seen, uid } from './kit.js';

const BARCODE = 'SENTINEL-BARCODE-SYN-77421';
const VALUE = '987.654';
const NAME = 'SENTINEL-PATIENT-Sita-Karki';
const FREE = 'SENTINEL-FREETEXT-7c1e';
const RAWCTL = 'SENTINEL-RAW-CONTROL-ID-31';
const MARKERS = [BARCODE, VALUE, NAME, FREE, RAWCTL];
const ALL = ['quality.autoverify.manage', 'quality.autoverify.read', 'quality.config.manage', 'quality.qc.manage', 'quality.qc_run.read', 'quality.qc_run.review', 'quality.tat_alert.ack', 'quality.tat_alert.read'];

// ------------------------------------------------------------------------------------------------ S-15 / S-17 the consumer
function jobCtx(tenant: string | undefined, queryFails = false) {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const logs: string[] = [];
  const sink = (...a: unknown[]) => { logs.push(JSON.stringify(a)); };
  const ctx: any = {
    tenantId: tenant, actor: { type: 'system', id: '01a1b34e-1000-7eee-9d29-d7ca59a102b5' }, requestId: uid(), now: () => '2026-11-14T10:00:00.000Z', attempt: 1, maxAttempts: 10, jobId: '1',
    tx: { async query(text: string, values: unknown[] = []) { queries.push({ text, values }); if (queryFails) throw new Error('db down'); return { rows: [] }; } },
    log: { info: sink, warn: sink, error: sink, debug: sink, child() { return this; } },
  };
  return { ctx, queries, logs };
}
const envelope = (tenant: string, payload: Record<string, unknown> = {}) => ({
  event_id: uid(), event_type: 'instruments.result.received.v1', tenant_id: tenant, producer: 'instruments', occurred_at: '2026-11-14T09:59:59.000Z', request_id: uid(), idempotency_key: 'k1',
  aggregate: { type: 'instrument_message', id: uid(), seq: 1 },
  payload: { instrument_message_id: uid(), instrument_id: uid(), agent_id: uid(), centre_id: uid(), protocol: 'astm', sample_barcode: BARCODE, record_kind: 'quantitative', instrument_analyte_code: RAWCTL,
    mapping_status: 'mapped', analyte_id: uid(), test_id: uid(), value_raw: VALUE, value_numeric: VALUE, patient_name: NAME, comment: FREE, unit_raw: 'mmol/L', instrument_flags: ['H'],
    received_at: '2026-11-14T09:59:58.123Z', is_rerun: false, ...payload },
});
const outOf = (...xs: unknown[]) => JSON.stringify(xs);

describe('S-15 / S-17 consumer instruments.result.received.v1 with planted PHI', () => {
  it('success: SQL parameters, SQL text and logs contain none of barcode / value / patient name / free text / raw code', async () => {
    const { ctx, queries, logs } = jobCtx(TENANT_A);
    await resultReceived(envelope(TENANT_A), ctx);
    expect(queries.length).toBe(1);
    const all = outOf(queries, logs);
    for (const m of MARKERS) expect(all, m).not.toContain(m);
  });
  it('malformed payload: the thrown error and the logs echo nothing of the payload', async () => {
    for (const bad of [{ instrument_id: BARCODE }, { analyte_id: VALUE }, { received_at: NAME }]) {
      const { ctx, queries, logs } = jobCtx(TENANT_A);
      const e: any = await resultReceived(envelope(TENANT_A, bad), ctx).then(() => undefined, (x) => x);
      expect(e, JSON.stringify(bad)).toBeInstanceOf(Error);
      expect(queries, 'no statement for a malformed event').toEqual([]);
      for (const m of MARKERS) expect(outOf(String(e.message), e.detail, logs), m).not.toContain(m);
    }
  });
  it('database failure: the rejection carries no event content', async () => {
    const { ctx, logs } = jobCtx(TENANT_A, true);
    const e: any = await resultReceived(envelope(TENANT_A), ctx).then(() => undefined, (x) => x);
    expect(e).toBeInstanceOf(Error);
    for (const m of MARKERS) expect(outOf(String(e.message), logs), m).not.toContain(m);
  });
  it('an event of ANOTHER tenant is refused before any statement (REQ-SEC-024); the refusal echoes no content', async () => {
    const { ctx, queries, logs } = jobCtx(TENANT_A);
    const e: any = await resultReceived(envelope(TENANT_B), ctx).then(() => undefined, (x) => x);
    expect(e).toBeInstanceOf(Error);
    expect(queries).toEqual([]);
    for (const m of MARKERS) expect(outOf(String(e.message), logs), m).not.toContain(m);
  });
  it('unmapped or analyte-less results are a no-op: no statement, nothing logged', async () => {
    for (const p of [{ mapping_status: 'unmapped' }, { analyte_id: null }, { analyte_id: '' }]) {
      const { ctx, queries, logs } = jobCtx(TENANT_A);
      await resultReceived(envelope(TENANT_A, p), ctx);
      expect(queries).toEqual([]);
      expect(outOf(logs)).not.toContain(BARCODE);
    }
  });
  it('unknown extra payload fields are ignored (S-15): same single statement with or without them', async () => {
    const a = jobCtx(TENANT_A), b = jobCtx(TENANT_A);
    const base = envelope(TENANT_A);
    await resultReceived(base, a.ctx);
    await resultReceived({ ...base, payload: { ...base.payload, brand_new_field: FREE, nested: { x: NAME } } }, b.ctx);
    expect(b.queries).toEqual(a.queries);
  });
});

// ------------------------------------------------------------------------------------------------ S-17 decisions / free text through the real handlers
describe('S-17 decision detail and free text through the real handlers', () => {
  let handlers: Record<string, (...a: any[]) => Promise<any>>;
  beforeAll(async () => { vi.stubEnv('LIMS_QUALITY_ENABLED', 'true'); handlers = (await loadManifest()).handlers; });
  const DEC = uid();
  const decisionRow = () => ({ id: DEC, tenant_id: TENANT_A, decided_at: '2026-11-14T09:00:00.000Z', mode: 'live', version_id: uid(), result_id: uid(), analyte_id: uid(), instrument_id: uid(), decision: 'allow',
    reasons: [], matched_rule_key: 'K_ANY', qc_status: 'in_control', qc_run_id: uid(), created_by: uid(), inputs: { value_numeric: VALUE, patient_name: NAME, sample_barcode: BARCODE, comment: FREE } });
  const rows = (text: string) => (/autoverify_decisions/.test(text) ? [decisionRow()] : undefined);

  it('getAutoverifyDecision: the planted inputs may be returned to the reader (detail response, REQ-SEC-081) but never logged, and the access-log row carries ids only', async () => {
    const h = makeHarness({ permissions: ALL, aal: 'aal2', rows }, 'getAutoverifyDecision');
    const out = await fire(handlers['getAutoverifyDecision']!, requestFor(opById('getAutoverifyDecision'), { ids: { decision_id: DEC } }), h.ctx);
    expect(out.error, seen(out.error)).toBeUndefined();
    for (const m of MARKERS) { expect(outOf(h.logs), `log: ${m}`).not.toContain(m); expect(outOf(h.audits), `access log: ${m}`).not.toContain(m); }
    expect(h.audits).toEqual([{ action: 'autoverify_decision.view', entityType: 'autoverify_decision', entityId: DEC, outcome: 'allowed' }]);
  });
  it('listAutoverifyDecisions: the LIST never carries decision inputs (REQ-SEC-081) and logs nothing planted', async () => {
    const op = opById('listAutoverifyDecisions');
    const h = makeHarness({ permissions: ALL, aal: 'aal2', rows }, op.id);
    const out = await fire(handlers[op.id]!, requestFor(op, { query: { decided_at_from: '2026-11-13T00:00:00.000Z', decided_at_to: '2026-11-14T10:00:00.000Z' } }), h.ctx);
    if (out.reply) for (const m of MARKERS) expect(JSON.stringify(out.reply.body), `list body: ${m}`).not.toContain(m);
    for (const m of MARKERS) expect(outOf(h.logs), m).not.toContain(m);
  });
  it('a failing audit write or a failing read never puts the planted body text into the error or the logs', async () => {
    for (const op of ['createAutoverifyVersion', 'excludeQcObservation', 'recordCorrectiveAction', 'closeQcRun', 'acknowledgeTatAlert', 'updateQualitySettings'] as const) {
      const info = opById(op);
      const h = makeHarness({ permissions: ALL, aal: 'aal2' }, op);
      const body: any = { ...(requestFor(info).body as object), comment: FREE, description: FREE, note: FREE, change_reason: FREE, reason_code: 'wrong_material', definition: { comment: FREE } };
      const out = await fire(handlers[op]!, requestFor(info, { body }), h.ctx);
      for (const m of MARKERS) {
        expect(seen(out.error), `${op}: error echoes ${m}`).not.toContain(m);
        expect(outOf(h.logs), `${op}: log has ${m}`).not.toContain(m);
        expect(outOf(h.audits), `${op}: access log has ${m}`).not.toContain(m);
      }
    }
  });
});
