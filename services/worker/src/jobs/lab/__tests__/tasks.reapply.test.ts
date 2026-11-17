// C5 T-23 — worker side of the exception queue: tasks `lab.reapply_exceptions_for_specimen` and `lab.reapply_unmapped_exceptions` and the `catalog.changed.v1` consumer that enqueues the latter
// (02-TRD §7.2 row catalog.changed.v1, §8; PRD AC-04.5, AC-14.3, AC-14.5; 07-SECURITY P-08, REQ-SEC-024, REQ-SEC-098; 03-APP-FLOW §1.3). No database.
// SEAM (spec fixes behaviour, not names):
//   tasks/lab.reapply_exceptions_for_specimen.ts and tasks/lab.reapply_unmapped_exceptions.ts each `export const handle: TaskHandler`, registered in ../index.ts `manifest.tasks` under the task ids,
//   maxAttempts 10 (02-TRD §8), no crontab entry. consumers/catalog.changed.v1.ts `export const handle: ConsumerHandler`, registered under 'catalog.changed.v1'.
//   Payloads (ids only, no barcode / value — patient-linked): specimen task { tenant_id, specimen_id }; unmapped task { tenant_id, revision }. Enqueue = `SELECT app.enqueue_job($1, $2::jsonb, $3, ...)` on ctx.tx
//   with params [identifier, JSON payload, job_key]: job_key = specimen_id (specimen task) and `<tenant_id>:<revision>` (unmapped task) (02-TRD §8).
//   Task ctx = the job ctx (ctx.tx, ctx.tenantId, ctx.actor system, ctx.now() ISO string, ctx.events, ctx.ports) plus ctx.store = the T-22 IngestStore (api/.../ingest.service.ts) PLUS
//     listOpenExceptions(tx, tenantId, { reasons: string[], barcode?: string, limit: number }) -> rows   (lab.ingest_exceptions rows, snake_case, status open, oldest first)
//     getSpecimenBarcode(tx, tenantId, specimenId) -> string | undefined
//   Each listed exception is turned back into an InstrumentResultInput (same result_key) and re-run through the §4.5 pipeline (ingest.service). A technical failure rejects the task (retry, dead letter).
//   The tenant guard is the job tenant: a payload of another tenant (or a job without one) touches no store / port / tx and logs no payload.
import { describe, expect, it } from 'vitest';
import { isLimsError, LimsError } from '../../../../../api/src/core/errors.js';
import { handle as specimenTask } from '../tasks/lab.reapply_exceptions_for_specimen.js';
import { handle as unmappedTask } from '../tasks/lab.reapply_unmapped_exceptions.js';
import { handle as catalogChanged } from '../consumers/catalog.changed.v1.js';
import { manifest } from '../index.js';

const A = '01a1a98a-ac40-7000-8000-00000000a001', B = '01a1a98a-ac40-7000-8000-00000000b001', SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const u = (n: number) => `0190c609-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const INSTR = u(2), CENTRE = u(4), HGB = u(5), TEST = u(6), SPEC = u(0x70), ORDER = u(0x71), ITEM = u(0x72), R_HGB = u(0x73), PATIENT = u(0x74);
const BARCODE = 'SN2606150042', SPEC_TASK = 'lab.reapply_exceptions_for_specimen', UNMAPPED_TASK = 'lab.reapply_unmapped_exceptions', NOW = '2026-06-15T05:00:30.000Z';
const mkExc = (n: number, over: Record<string, unknown> = {}) => ({
  id: u(0x1000 + n), tenant_id: A, centre_id: CENTRE, result_key: `${INSTR}:${BARCODE}:HGB:2026-06-15T04:${String(n % 60).padStart(2, '0')}:00.000Z#${n}`, reason: 'specimen_not_received', status: 'open',
  instrument_id: INSTR, instrument_message_id: u(0x2000 + n), agent_id: u(3), protocol: 'astm', sample_barcode: BARCODE, record_kind: 'quantitative', instrument_analyte_code: 'HGB', analyte_id: HGB, test_id: TEST,
  value_raw: '13.4', value_numeric: '13.4', unit_raw: 'g/dL', unit_code: 'g/dL', instrument_flags: [], instrument_result_time: new Date('2026-06-15T04:55:00.000Z'), received_at: new Date('2026-06-15T04:56:00.000Z'),
  is_rerun: false, attachment: null, specimen_id: SPEC, result_id: null, attempts: 1, version: 1, ...over,
});
const hgbRow = (over: Record<string, unknown> = {}) => ({
  resultId: R_HGB, rowVersion: 3, status: 'pending', orderId: ORDER, orderItemId: ITEM, specimenId: SPEC, patientId: PATIENT, testId: TEST, analyteId: HGB, centreId: CENTRE, currentVersionNo: 1,
  sex: 'female', patientAgeDays: 12000, specimenTypeCode: 'EDTA', unitCode: 'g/dL', departmentId: u(0xd1), analyte: { id: HGB, code: 'HGB', resultType: 'numeric', decimals: 1 }, ...over,
});

interface Opt { tenant?: string | undefined; rows?: any[]; unmapped?: boolean; barcode?: string | null; saveThrows?: Error; queryThrows?: Error }
function make(opt: Opt = {}) {
  const hasTenant = 'tenant' in opt;
  const tenant = hasTenant ? opt.tenant : A;
  const touched: { fn: string; arg: any }[] = [], enq: { identifier: string; payload: any; key: string }[] = [], logged: unknown[][] = [];
  const open = new Map<string, any>((opt.rows ?? []).map((r) => [r.result_key, { ...r }]));
  const rec = (fn: string, arg?: any) => touched.push({ fn, arg });
  const store: any = {
    async listOpenExceptions(_t: unknown, tn: string, q: any) { rec('listOpenExceptions', { tn, ...q }); return [...open.values()].filter((r) => r.status === 'open' && q.reasons.includes(r.reason) && (q.barcode === undefined || r.sample_barcode === q.barcode)).slice(0, q.limit); },
    async getSpecimenBarcode(_t: unknown, tn: string, id: string) { rec('getSpecimenBarcode', { tn, id }); return opt.barcode === null ? undefined : (opt.barcode ?? BARCODE); },
    async claimKey(_t: unknown, tn: string, a: any) { rec('claimKey', { tn, ...a }); const o = open.get(a.resultKey); return o ? { inserted: false, logId: u(0x99), lastOutcome: 'unmatched', openExceptionId: o.id } : { inserted: true, logId: u(0x99), lastOutcome: 'unmatched' }; },
    async findSpecimen(_t: unknown, _tn: string, b: string) { rec('findSpecimen', b); return b === BARCODE ? { specimenId: SPEC, status: 'received', isActive: true, centreId: CENTRE, processingCentreId: CENTRE } : undefined; },
    async getIngestAutoReceive() { return false; },
    async lockSpecimenResults() { return [hgbRow()]; },
    async receiveSpecimen(_t: unknown, _tn: string, a: any) { rec('receiveSpecimen', a); },
    async isOnQcHold() { return false; },
    async deltaInputs() { return { candidates: [] }; },
    async saveInstrumentResult(_t: unknown, tn: string, a: any) {
      rec('saveInstrumentResult', { tn, ...a }); if (opt.saveThrows) throw opt.saveThrows;
      return { id: a.resultId, version: a.expectedRowVersion + 1, status: 'resulted', origin: 'instrument', on_hold: false, unit_mismatch: false, specimen_id: SPEC };
    },
    async insertAttachment() {},
    async upsertOpenException(_t: unknown, _tn: string, a: any) { rec('upsertOpenException', a); const o = open.get(a.resultKey); if (o) { o.reason = a.reason; o.attempts += 1; } return { exceptionId: o?.id ?? u(0xee) }; },
    async closeOpenExceptions(_t: unknown, _tn: string, a: any) { rec('closeOpenExceptions', a); const o = open.get(a.resultKey); if (o) Object.assign(o, { status: 'resolved', resolution: a.resolution }); },
    async finishLog(_t: unknown, _tn: string, _id: string, a: any) { rec('finishLog', a); },
    async rollupSpecimen() {}, async lockForVerify() { return []; }, async verify() { return {}; },
    async listCriticalLog() { return []; }, async insertCriticalLog() { return { criticalEventId: u(0xce) }; }, async markCriticalValueChanged() {},
  };
  const ctx: any = {
    tenantId: tenant, actor: { type: 'system', id: SYS }, requestId: u(8), now: () => NOW, store, config: { autoverifyHookEnabled: false },
    tx: { async query(sql: string, params: unknown[]) { rec('tx.query', { sql }); if (opt.queryThrows) throw opt.queryThrows; if (/app\.enqueue_job/.test(sql)) enq.push({ identifier: params[0] as string, payload: JSON.parse(params[1] as string), key: params[2] as string }); return { rows: [], rowCount: 0 }; } },
    events: { async publish() { return { eventId: 'e', duplicate: false }; } },
    audit: { async access() {} },
    log: { info: (...a: unknown[]) => logged.push(a), warn: (...a: unknown[]) => logged.push(a), error: (...a: unknown[]) => logged.push(a), debug: (...a: unknown[]) => logged.push(a), child() { return this; } },
    ports: {
      CatalogPort: {
        async mapInstrumentCode() { rec('mapInstrumentCode'); if (opt.unmapped) throw new LimsError('catalog.instrument_code_unmapped'); return { analyteId: HGB, testId: TEST }; },
        async referenceRangeFor() { return { referenceRangeId: 'rr-1', version: 1, low: '12.0', high: '17.0', unitCode: 'g/dL' }; },
        async criticalLimitsFor() { return undefined; },
      },
      QualityPort: { async canAutoVerify() { return { decision: 'deny', reasons: ['feature_disabled'] }; } },
      IdentityPort: { async assertRole() {}, async getTenantSettings() { return { autoVerificationEnabled: false }; } },
    },
  };
  return { ctx, touched, enq, logged, open, of: (fn: string) => touched.filter((t) => t.fn === fn).map((t) => t.arg), nothingTouched: () => touched.length === 0 };
}
const failure = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, but it resolved'); };
const runTask = (h: any, payload: Record<string, unknown>, ctx: unknown) => Promise.resolve(h(payload, ctx));

describe('T-23 tasks and the catalog consumer are registered (not stubs)', () => {
  it('manifest.tasks declares both reapply tasks, max 10 attempts (02-TRD §8), and no crontab entry for them', () => {
    expect(Object.keys(manifest.tasks ?? {})).toEqual(expect.arrayContaining([SPEC_TASK, UNMAPPED_TASK]));
    expect(manifest.tasks?.[SPEC_TASK]).toBe(specimenTask);
    expect(manifest.tasks?.[UNMAPPED_TASK]).toBe(unmappedTask);
    expect(manifest.maxAttempts?.[SPEC_TASK]).toBe(10);
    expect(manifest.maxAttempts?.[UNMAPPED_TASK]).toBe(10);
    expect((manifest.crontab ?? []).map((c) => c.identifier)).not.toContain(SPEC_TASK);
    expect((manifest.crontab ?? []).map((c) => c.identifier)).not.toContain(UNMAPPED_TASK);
  });
  it('catalog.changed.v1 is a real handler (not the common.internal stub)', async () => {
    expect(manifest.subscriptions?.['catalog.changed.v1']).toBe(catalogChanged);
    const m = make();
    await expect(Promise.resolve(catalogChanged(envelope(A, { entity_type: 'price_list' }), m.ctx))).resolves.toBeUndefined();
  });
});

describe('T-23 lab.reapply_exceptions_for_specimen (AC-04.5)', () => {
  const payload = (tenant = A) => ({ tenant_id: tenant, specimen_id: SPEC });
  it('AC-04.5: re-runs §4.5 for the open specimen_not_received / unknown_barcode exceptions of the received specimen\'s barcode; they are applied and resolved', async () => {
    const m = make({ rows: [mkExc(1), mkExc(2, { reason: 'unknown_barcode' }), mkExc(3, { reason: 'unmapped_code' }), mkExc(4, { sample_barcode: 'OTHER00001' })] });
    await runTask(specimenTask, payload(), m.ctx);
    expect(m.of('getSpecimenBarcode')[0]).toMatchObject({ tn: A, id: SPEC });
    const q = m.of('listOpenExceptions')[0];
    expect(q).toMatchObject({ tn: A, barcode: BARCODE });
    expect([...q.reasons].sort()).toEqual(['specimen_not_received', 'unknown_barcode']);
    expect(m.of('saveInstrumentResult')).toHaveLength(2);
    expect(m.open.get(mkExc(1).result_key)).toMatchObject({ status: 'resolved' });
    expect(m.open.get(mkExc(2).result_key)).toMatchObject({ status: 'resolved' });
    expect(m.open.get(mkExc(3).result_key)).toMatchObject({ status: 'open' });   // other reason: not this task's business
    expect(m.open.get(mkExc(4).result_key)).toMatchObject({ status: 'open' });   // other barcode
  });
  it('every re-run claims the stored result key of its exception (same key = the replay of step 1, CR-C7-011)', async () => {
    const m = make({ rows: [mkExc(1), mkExc(2)] });
    await runTask(specimenTask, payload(), m.ctx);
    expect(m.of('claimKey').map((c) => c.resultKey).sort()).toEqual([mkExc(1).result_key, mkExc(2).result_key].sort());
    expect(m.of('claimKey').every((c) => c.tn === A)).toBe(true);
  });
  it('no open exception for the barcode -> a clean no-op (nothing saved, no error)', async () => {
    const m = make({ rows: [] });
    await expect(runTask(specimenTask, payload(), m.ctx)).resolves.toBeUndefined();
    expect(m.of('saveInstrumentResult')).toHaveLength(0);
  });
  it('a specimen that no longer exists is a clean no-op (no list, no save)', async () => {
    const m = make({ rows: [mkExc(1)], barcode: null });
    await expect(runTask(specimenTask, payload(), m.ctx)).resolves.toBeUndefined();
    expect(m.of('listOpenExceptions')).toHaveLength(0);
    expect(m.of('saveInstrumentResult')).toHaveLength(0);
  });
  it('a record that cannot be applied yet stays open (still unmapped) and does not fail the task', async () => {
    const m = make({ rows: [mkExc(1)], unmapped: true });
    await expect(runTask(specimenTask, payload(), m.ctx)).resolves.toBeUndefined();
    expect(m.open.get(mkExc(1).result_key)).toMatchObject({ status: 'open', reason: 'unmapped_code' });
  });
  it('a technical failure rejects the task (retry, dead letter) — never a silent ack', async () => {
    const m = make({ rows: [mkExc(1)], saveThrows: new LimsError('common.version_conflict') });
    expect((await failure(runTask(specimenTask, payload(), m.ctx))).code).toBe('common.version_conflict');
  });
  it('tenant guard: a payload of tenant B on a tenant-A job touches no store, port or tx (REQ-SEC-024, P-08); same for a job without a tenant', async () => {
    const m = make({ rows: [mkExc(1)] });
    await runTask(specimenTask, payload(B), m.ctx).catch(() => undefined);
    expect(m.nothingTouched()).toBe(true);
    const none = make({ tenant: undefined, rows: [mkExc(1)] });
    await runTask(specimenTask, payload(A), none.ctx).catch(() => undefined);
    expect(none.nothingTouched()).toBe(true);
  });
  it('REQ-SEC-098: neither the barcode nor the value is logged', async () => {
    const m = make({ rows: [mkExc(1)], unmapped: true });
    await runTask(specimenTask, payload(), m.ctx);
    const text = JSON.stringify(m.logged);
    expect(text).not.toContain(BARCODE);
    expect(text).not.toContain('13.4');
  });
});

describe('T-23 lab.reapply_unmapped_exceptions (AC-14.3 / AC-14.5 after the mapping is fixed)', () => {
  const payload = (tenant = A, revision = 418) => ({ tenant_id: tenant, revision });
  it('re-runs §4.5 for the open unmapped_code exceptions only, at most 500 per run; mapped now -> applied and resolved', async () => {
    const m = make({ rows: [mkExc(1, { reason: 'unmapped_code' }), mkExc(2, { reason: 'unmapped_code' }), mkExc(3, { reason: 'specimen_not_received' })] });
    await runTask(unmappedTask, payload(), m.ctx);
    const q = m.of('listOpenExceptions')[0];
    expect(q).toMatchObject({ tn: A, reasons: ['unmapped_code'], limit: 500 });
    expect(m.of('saveInstrumentResult')).toHaveLength(2);
    expect(m.open.get(mkExc(1).result_key)).toMatchObject({ status: 'resolved' });
    expect(m.open.get(mkExc(3).result_key)).toMatchObject({ status: 'open' });
    expect(m.enq).toHaveLength(0);   // fewer than 500: nothing left to re-enqueue
  });
  it('AC-14.3: still unmapped -> the exceptions stay open (unmapped_code) with attempts + 1; the task succeeds', async () => {
    const m = make({ rows: [mkExc(1, { reason: 'unmapped_code' })], unmapped: true });
    await expect(runTask(unmappedTask, payload(), m.ctx)).resolves.toBeUndefined();
    expect(m.open.get(mkExc(1).result_key)).toMatchObject({ status: 'open', reason: 'unmapped_code', attempts: 2 });
    expect(m.of('saveInstrumentResult')).toHaveLength(0);
  });
  it('a full page (500) re-enqueues the same task for the rest: same tenant + revision payload, a job_key that is not the already-used `<tenant>:<revision>` (else it would be deduplicated away)', async () => {
    const rows = Array.from({ length: 500 }, (_, i) => mkExc(i + 1, { reason: 'unmapped_code' }));
    const m = make({ rows, unmapped: true });
    await runTask(unmappedTask, payload(A, 418), m.ctx);
    expect(m.of('listOpenExceptions')[0]).toMatchObject({ limit: 500 });
    expect(m.enq).toHaveLength(1);
    expect(m.enq[0]).toMatchObject({ identifier: UNMAPPED_TASK, payload: { tenant_id: A, revision: 418 } });
    expect(m.enq[0]!.key).not.toBe(`${A}:418`);
    expect(m.enq[0]!.key.startsWith(`${A}:418`)).toBe(true);
  });
  it('tenant guard (REQ-SEC-024): a payload of tenant B on a tenant-A job touches nothing', async () => {
    const m = make({ rows: [mkExc(1, { reason: 'unmapped_code' })] });
    await runTask(unmappedTask, payload(B), m.ctx).catch(() => undefined);
    expect(m.nothingTouched()).toBe(true);
  });
  it('a technical failure rejects the task', async () => {
    const m = make({ rows: [mkExc(1, { reason: 'unmapped_code' })], saveThrows: new Error('db down') });
    expect(await failure(runTask(unmappedTask, payload(), m.ctx))).toBeInstanceOf(Error);
  });
});

const envelope = (tenant: string, over: Record<string, unknown> = {}) => ({
  event_id: u(9), event_type: 'catalog.changed.v1', tenant_id: tenant, producer: 'catalog', aggregate: { type: 'catalog', id: u(10), seq: 418 },
  payload: { catalog_revision: 418, entity_type: 'instrument_code_map', entity_id: u(11), change_kind: 'updated', effective_from: '2026-06-15T05:00:00.000Z', ...over },
});

describe('T-23 catalog.changed.v1 consumer: auto reapply on catalog change (02-TRD §7.2)', () => {
  it('entity_type instrument_code_map -> enqueues lab.reapply_unmapped_exceptions with { tenant_id, revision } and job_key `<tenant_id>:<revision>`', async () => {
    const m = make();
    await catalogChanged(envelope(A), m.ctx);
    expect(m.enq).toEqual([{ identifier: UNMAPPED_TASK, payload: { tenant_id: A, revision: 418 }, key: `${A}:418` }]);
  });
  it.each(['price_list', 'test', 'global_reference', 'catalog_import', 'a_value_added_in_a_later_version'])('entity_type %s (known or unknown, x-extensible) enqueues nothing and does not fail', async (entity_type) => {
    const m = make();
    await expect(Promise.resolve(catalogChanged(envelope(A, { entity_type }), m.ctx))).resolves.toBeUndefined();
    expect(m.enq).toHaveLength(0);
  });
  it('the same event twice yields the same job key (the queue dedupes on it)', async () => {
    const m = make();
    await catalogChanged(envelope(A), m.ctx);
    await catalogChanged(envelope(A), m.ctx);
    expect(new Set(m.enq.map((e) => e.key)).size).toBe(1);
  });
  it('an envelope of tenant B on a tenant-A job is refused (common.internal) before any query (REQ-SEC-024, P-08); a job without a tenant too', async () => {
    const m = make();
    const err = await failure(Promise.resolve(catalogChanged(envelope(B), m.ctx)));
    expect(isLimsError(err, 'common.internal')).toBe(true);
    expect(m.nothingTouched()).toBe(true);
    const none = make({ tenant: undefined });
    expect(isLimsError(await failure(Promise.resolve(catalogChanged(envelope(A), none.ctx))), 'common.internal')).toBe(true);
    expect(none.nothingTouched()).toBe(true);
  });
  it('a failing enqueue rejects the consumer (the job retries / dead-letters), never a silent ack', async () => {
    const m = make({ queryThrows: new Error('enqueue failed') });
    expect(await failure(Promise.resolve(catalogChanged(envelope(A), m.ctx)))).toBeInstanceOf(Error);
  });
});
