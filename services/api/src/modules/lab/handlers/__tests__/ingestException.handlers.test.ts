// C5 T-23 handlers #38 listIngestExceptions, #39 getIngestException, #40 assignIngestException, #41 reapplyIngestException, #42 discardIngestException
// (02-TRD §5.6, §4.5 step 1 replay, §11; 03-APP-FLOW §1.3; 04-UI-UX §3.10; PRD AC-14.3, AC-14.5; 07-SECURITY P-01/P-02/P-03/P-07, REQ-SEC-024/098/099; CR-C7-011).
// Fails now: handlers/index.ts maps all five to the T-01 stub (common.internal) and service/exception.service.ts does not exist.
// No database: a fake store/ctx, same convention as critical.handlers.test.ts (core pipeline enforces schema, x-permission, Idempotency-Key; lab.yaml is read below to pin the contract).
//
// SEAM (spec fixes behaviour, not names). Handler contract (req:{params,query,headers,body}, ctx) -> {status, body}; ctx without tenantId/actor.id/tx -> auth.unauthenticated;
//   ctx without `store` or `audit` -> common.internal (fail closed). The handlers map snake_case <-> camelCase and rows -> lab.yaml DTOs (IngestExceptionDto / IngestExceptionDetail /
//   IngestExceptionActionResponse; timestamps ISO strings; absent values omitted, never null; allowlist keys only). Logic lives in service/exception.service.ts.
//   ctx.store = the T-22 IngestStore (ingest.service.ts) PLUS these exception members, every call (tx, tenantId, ...):
//     listExceptions(tx, t, { status, reasons?: string[], instrumentId?, cursor?, limit })        -> { rows, nextCursor? }   status default 'open'; `reason` csv -> reasons
//     getExceptionRow(tx, t, id)                                                                 -> row | undefined        (lab.ingest_exceptions row, snake_case columns of repository/ingest.repo.ts)
//     lockException(tx, t, id)                                                                   -> row | undefined        FOR UPDATE; every write op starts here
//     getResultForAssign(tx, t, resultId)                                                        -> EntryRow | undefined   FOR UPDATE, same shape as lockSpecimenResults rows
//     isActiveDiscardReason(tx, t, code)                                                         -> boolean                coded set lab.exception_discard_reasons (tenant rows shadow global)
//     discardException(tx, t, { id, reasonCode, comment?, resolverMembershipId, occurredAt })    -> void                   status discarded, resolution 'discarded', discard_reason_code, resolved_at
//     resolveException(tx, t, { id, resolution: 'applied'|'assigned', resolverMembershipId, occurredAt }) -> void          OPTIONAL: the writer may instead extend closeOpenExceptions({ resultKey, resolution })
//   Reapply = the exception row is turned back into an InstrumentResultInput (same result_key) and run through ingestInstrumentResult (port path, caller actor, step 1 replay of an
//   `unmatched`/`rejected_state` key with an open exception, CR-C7-011); the response carries the exception re-read AFTER the run and the pipeline outcome.
//   Assign = the same pipeline with the target row chosen by the caller (store.getResultForAssign) instead of the barcode match; on success the exception is `resolved`, resolution 'assigned'.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { handlers } from '../index.js';

const spec: any = parse(readFileSync(fileURLToPath(new URL('../../../../../../../contracts/openapi/lab.yaml', import.meta.url)), 'utf8'));
const S = spec.components.schemas;
const keysOf = (n: string): string[] => Object.keys(S[n].properties);
const TENANT = '01a1a98a-ac40-7000-8000-00000000a001', OTHER_TENANT = '01a1a98a-ac40-7000-8000-00000000b001';
const ACTOR = '01a1b34e-1000-7eee-9d29-d7ca59a102b5', MEMBERSHIP = '01a1b34e-2000-7eee-9d29-d7ca59a102b6';
const NOW = new Date('2026-06-15T05:00:00Z');
const u = (n: number) => `01a1a98a-ac40-7000-8000-${n.toString(16).padStart(12, '0')}`;
const INSTR = u(0xd0f1), MSG = u(0xd0c1), AGENT = u(0xd0a1), CENTRE = u(0xa201), SPEC = u(0xe001), ORDER = u(0xc001), ITEM = u(0xb001), PATIENT = u(0xd001);
const HGB = u(0xa001), WBC = u(0xa002), TEST = u(0xf001), R_HGB = u(0xa1001), R_WBC = u(0xa1002), LOG_ID = u(0xa2001);
const EXC = u(0xe1), EXC2 = u(0xe2), FOREIGN_EXC = u(0xe9);
const BARCODE = 'SN2606150042', RESULT_TIME = '2026-06-15T04:55:00.000Z';
const KEY = `${INSTR}:${BARCODE}:HGB:${RESULT_TIME}`;

const excRow = (over: Record<string, unknown> = {}) => ({
  id: EXC, tenant_id: TENANT, centre_id: CENTRE, processing_centre_id: null, result_key: KEY, reason: 'unmapped_code', status: 'open', instrument_id: INSTR, instrument_message_id: MSG, agent_id: AGENT,
  protocol: 'astm', sample_barcode: BARCODE, record_kind: 'quantitative', instrument_analyte_code: 'HGB', analyte_id: HGB, test_id: TEST, value_raw: '13.4', value_numeric: '13.4', unit_raw: 'g/dL',
  unit_code: 'g/dL', instrument_flags: ['H'], instrument_result_time: new Date(RESULT_TIME), received_at: new Date('2026-06-15T04:56:00.000Z'), is_rerun: false, attachment: null, specimen_id: null,
  result_id: null, attempts: 2, last_attempt_at: new Date('2026-06-15T04:58:00.000Z'), resolution: null, resolved_at: null, resolved_by_membership_id: null, discard_reason_code: null,
  comment: null, version: 3, created_at: new Date('2026-06-15T04:56:30.000Z'), created_by: ACTOR, updated_by: ACTOR, ...over,
});
const hgbRow = (over: Record<string, unknown> = {}) => ({
  resultId: R_HGB, rowVersion: 3, status: 'pending', orderId: ORDER, orderItemId: ITEM, specimenId: SPEC, patientId: PATIENT, testId: TEST, analyteId: HGB, centreId: CENTRE, currentVersionNo: 1,
  sex: 'female', patientAgeDays: 12000, specimenTypeCode: 'EDTA', unitCode: 'g/dL', departmentId: u(0xd1), analyte: { id: HGB, code: 'HGB', resultType: 'numeric', decimals: 1 }, ...over,
});

interface Opt {
  rows?: any[]; unmapped?: boolean; specimen?: Record<string, unknown> | null; specimenRows?: any[]; target?: any | null; discardReasons?: string[]; nextCursor?: string; saveThrows?: Error; noStore?: boolean;
}
function make(opt: Opt = {}) {
  const calls: { fn: string; tenantId: unknown; tx: unknown; arg: any }[] = [];
  const access: any[] = [], mapAsked: any[] = [];
  const tx = { id: 'tx-1' };
  const rec = (fn: string, t: unknown, tenantId: unknown, arg?: any) => calls.push({ fn, tenantId, tx: t, arg });
  const rows = new Map<string, any>((opt.rows ?? [excRow()]).map((r) => [r.id, { ...r }]));
  const visible = (tenantId: string, id: string) => { const r = rows.get(id); return r && r.tenant_id === tenantId ? r : undefined; };
  const spec = opt.specimen === null ? undefined : { specimenId: SPEC, status: 'received', isActive: true, centreId: CENTRE, processingCentreId: CENTRE, ...(opt.specimen ?? {}) };
  const closeByKey = (key: string, a: any) => {
    for (const r of rows.values()) if (r.result_key === key && r.status === 'open') Object.assign(r, { status: 'resolved', resolution: a.resolution, resolved_at: new Date(a.occurredAt), resolved_by_membership_id: a.resolverMembershipId ?? null });
  };
  const store = {
    async listExceptions(t: unknown, tn: string, q: any) { rec('listExceptions', t, tn, q); return { rows: [...rows.values()].filter((r) => r.tenant_id === tn && r.status === q.status), ...(opt.nextCursor === undefined ? {} : { nextCursor: opt.nextCursor }) }; },
    async getExceptionRow(t: unknown, tn: string, id: string) { rec('getExceptionRow', t, tn, id); const r = visible(tn, id); return r && { ...r }; },
    async lockException(t: unknown, tn: string, id: string) { rec('lockException', t, tn, id); const r = visible(tn, id); return r && { ...r }; },
    async getResultForAssign(t: unknown, tn: string, id: string) { rec('getResultForAssign', t, tn, id); return opt.target === null ? undefined : (opt.target ?? hgbRow()); },
    async isActiveDiscardReason(t: unknown, tn: string, code: string) { rec('isActiveDiscardReason', t, tn, code); return (opt.discardReasons ?? ['DUPLICATE_RUN', 'TEST_SAMPLE']).includes(code); },
    async discardException(t: unknown, tn: string, a: any) {
      rec('discardException', t, tn, a);
      Object.assign(visible(tn, a.id)!, { status: 'discarded', resolution: 'discarded', discard_reason_code: a.reasonCode, comment: a.comment ?? null, resolved_at: new Date(a.occurredAt), resolved_by_membership_id: a.resolverMembershipId });
    },
    async resolveException(t: unknown, tn: string, a: any) {
      rec('resolveException', t, tn, a);
      Object.assign(visible(tn, a.id)!, { status: 'resolved', resolution: a.resolution, resolved_at: new Date(a.occurredAt), resolved_by_membership_id: a.resolverMembershipId });
    },
    // ---- T-22 IngestStore
    async claimKey(t: unknown, tn: string, a: any) {
      rec('claimKey', t, tn, a);
      const open = [...rows.values()].find((r) => r.tenant_id === tn && r.result_key === a.resultKey && r.status === 'open');
      return open ? { inserted: false, logId: LOG_ID, lastOutcome: 'unmatched', openExceptionId: open.id } : { inserted: true, logId: LOG_ID, lastOutcome: 'unmatched' };
    },
    async findSpecimen(t: unknown, tn: string, b: string) { rec('findSpecimen', t, tn, b); return b === BARCODE ? spec : undefined; },
    async getIngestAutoReceive(t: unknown, tn: string) { rec('getIngestAutoReceive', t, tn); return false; },
    async lockSpecimenResults(t: unknown, tn: string, s: string) { rec('lockSpecimenResults', t, tn, s); return opt.specimenRows ?? [hgbRow()]; },
    async receiveSpecimen(t: unknown, tn: string, a: any) { rec('receiveSpecimen', t, tn, a); },
    async isOnQcHold(t: unknown, tn: string, a: any) { rec('isOnQcHold', t, tn, a); return false; },
    async deltaInputs(t: unknown, tn: string, r: any) { rec('deltaInputs', t, tn, r); return { candidates: [] }; },
    async saveInstrumentResult(t: unknown, tn: string, a: any) {
      rec('saveInstrumentResult', t, tn, a);
      if (opt.saveThrows) throw opt.saveThrows;
      return { id: a.resultId, version: a.expectedRowVersion + 1, status: 'resulted', origin: 'instrument', analyte_code: 'HGB', on_hold: a.onHold, unit_mismatch: a.unitMismatch, specimen_id: SPEC, order_id: ORDER,
        order_item_id: ITEM, test_id: TEST, analyte_id: HGB, value_numeric: a.value?.numeric, tenant_id: TENANT, created_by: ACTOR, updated_by: ACTOR, current_version_no: 1 };
    },
    async insertAttachment(t: unknown, tn: string, a: any) { rec('insertAttachment', t, tn, a); },
    async upsertOpenException(t: unknown, tn: string, a: any) {
      rec('upsertOpenException', t, tn, a);
      const r = [...rows.values()].find((x) => x.tenant_id === tn && x.result_key === a.resultKey && x.status === 'open');
      if (r) Object.assign(r, { reason: a.reason, attempts: r.attempts + 1, last_attempt_at: new Date(a.occurredAt), version: r.version + 1 });
      return { exceptionId: r?.id ?? EXC };
    },
    async closeOpenExceptions(t: unknown, tn: string, a: any) { rec('closeOpenExceptions', t, tn, a); closeByKey(a.resultKey, a); },
    async finishLog(t: unknown, tn: string, id: string, a: any) { rec('finishLog', t, tn, { logId: id, ...a }); },
    async rollupSpecimen(t: unknown, tn: string, s: string) { rec('rollupSpecimen', t, tn, s); },
    async lockForVerify() { return []; }, async verify() { return {}; },
    async listCriticalLog() { return []; }, async insertCriticalLog() { return { criticalEventId: u(0xce) }; }, async markCriticalValueChanged() {},
  };
  const ctx: any = {
    operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} }, tenantId: TENANT, actor: { type: 'user', id: ACTOR, membershipId: MEMBERSHIP }, tx, now: () => NOW,
    config: { autoverifyHookEnabled: false },
    events: { async publish() { return { eventId: 'e', duplicate: false }; } },
    audit: { async access(e: unknown) { access.push(e); } },
    ports: {
      CatalogPort: {
        async mapInstrumentCode(_c: unknown, q: any) {
          mapAsked.push(q);
          if (opt.unmapped) throw new LimsError('catalog.instrument_code_unmapped');
          return { mappingId: 'm-1', instrumentId: INSTR, instrumentCode: 'HGB', analyteId: HGB, testId: TEST };
        },
        async referenceRangeFor() { return { referenceRangeId: 'rr-1', version: 1, low: '12.0', high: '17.0', unitCode: 'g/dL' }; },
        async criticalLimitsFor() { return undefined; },
      },
      IdentityPort: { async assertRole() {}, async getTenantSettings() { return { autoVerificationEnabled: false }; } },
    },
  };
  if (opt.noStore) delete ctx.store; else ctx.store = store;
  return { ctx, calls, of: (fn: string) => calls.filter((c) => c.fn === fn), access, mapAsked, rows, tx, wrote: () => calls.filter((c) => WRITES.includes(c.fn)).map((c) => c.fn) };
}
const WRITES = ['saveInstrumentResult', 'insertAttachment', 'closeOpenExceptions', 'resolveException', 'discardException', 'receiveSpecimen', 'rollupSpecimen'];
const run = (op: string, req: unknown, c: unknown): Promise<any> => (handlers as any)[op](req, c);
const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } throw new Error('expected rejection'); };
const listReq = (query: Record<string, unknown> = {}) => ({ params: {}, query, headers: {}, body: undefined }) as never;
const getReq = (id: string) => ({ params: { exception_id: id }, query: {}, headers: {}, body: undefined }) as never;
const postReq = (id: string, body: unknown, key = 't23-1') => ({ params: { exception_id: id }, query: {}, headers: { 'idempotency-key': key }, body }) as never;
const LEAK = /tenant_id|created_by|updated_by|agent_id|protocol|value_numeric|"value_raw"|instrument_flags|attachment|processing_centre|resolved_by|discard_reason_code|"version"|specimen_id|"comment"/;
const NOT_OPEN_CODES = ['common.validation_failed', 'common.not_found'];

describe('T-23 contract of lab.yaml #38–#42 (the handlers must fit it)', () => {
  const op = (path: string, m: string) => spec.paths[path][m];
  it('operations, permissions and idempotency', () => {
    expect(op('/v1/lab/ingest-exceptions', 'get')).toMatchObject({ operationId: 'listIngestExceptions', 'x-permission': 'lab.result.read' });
    expect(op('/v1/lab/ingest-exceptions/{exception_id}', 'get')).toMatchObject({ operationId: 'getIngestException', 'x-permission': 'lab.result.read' });
    expect(op('/v1/lab/ingest-exceptions/{exception_id}/assign', 'post')).toMatchObject({ operationId: 'assignIngestException', 'x-permission': 'lab.result.enter', 'x-idempotency': 'required' });
    expect(op('/v1/lab/ingest-exceptions/{exception_id}/reapply', 'post')).toMatchObject({ operationId: 'reapplyIngestException', 'x-permission': 'lab.result.enter', 'x-idempotency': 'optional' });
    expect(op('/v1/lab/ingest-exceptions/{exception_id}/discard', 'post')).toMatchObject({ operationId: 'discardIngestException', 'x-permission': 'lab.result.enter', 'x-idempotency': 'optional' });
  });
  it('request bodies are closed objects (no tenant / actor field can be sent)', () => {
    const body = (p: string) => op(p, 'post').requestBody.content['application/json'].schema;
    expect(body('/v1/lab/ingest-exceptions/{exception_id}/assign')).toMatchObject({ additionalProperties: false, required: ['result_id'] });
    expect(Object.keys(body('/v1/lab/ingest-exceptions/{exception_id}/assign').properties).sort()).toEqual(['override_analyte', 'result_id']);
    expect(body('/v1/lab/ingest-exceptions/{exception_id}/reapply')).toMatchObject({ additionalProperties: false, properties: {} });
    const d = body('/v1/lab/ingest-exceptions/{exception_id}/discard');
    expect(d).toMatchObject({ additionalProperties: false, required: ['reason_code'] });
    expect(d.properties.reason_code['x-coded-set']).toBe('lab.exception_discard_reasons');
    expect(d.properties.comment.maxLength).toBe(300);
  });
  it('the list DTO carries no raw instrument value or flags (only #39 does, access-logged — 07-SECURITY §data classes)', () => {
    for (const k of keysOf('IngestExceptionDto')) expect(k).not.toMatch(/raw_value|raw_flags|unit_raw|tenant|created_by/);
    expect(keysOf('IngestExceptionDetail')).toEqual(expect.arrayContaining(['raw_value', 'raw_flags', 'unit_raw']));
  });
});

describe('T-23 are real handlers, not the T-01 stub (REQ-SEC-099)', () => {
  const REQS: Record<string, unknown> = {
    listIngestExceptions: listReq(), getIngestException: getReq(EXC), assignIngestException: postReq(EXC, { result_id: R_HGB }),
    reapplyIngestException: postReq(EXC, {}), discardIngestException: postReq(EXC, { reason_code: 'DUPLICATE_RUN' }),
  };
  for (const opId of Object.keys(REQS)) {
    it(`${opId}: ctx without tenantId/actor/tx -> auth.unauthenticated (the stub answers common.internal)`, async () => {
      const bare = { operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } };
      expect((await fail(run(opId, REQS[opId], bare))).code).toBe('auth.unauthenticated');
    });
    it(`${opId}: a ctx without store fails closed with common.internal`, async () => {
      expect((await fail(run(opId, REQS[opId], make({ noStore: true }).ctx))).code).toBe('common.internal');
    });
  }
});

describe('T-23 listIngestExceptions (#38; AC-14.3 "visible on /lab/ingest-exceptions")', () => {
  it('default status = open, limit 50; rows -> IngestExceptionDto allowlist; page.limit echoed; foreign-tenant rows never come back (P-03)', async () => {
    const m = make({ rows: [excRow(), excRow({ id: FOREIGN_EXC, tenant_id: OTHER_TENANT, result_key: 'other' })] });
    const r = await run('listIngestExceptions', listReq(), m.ctx);
    expect(r.status).toBe(200);
    expect(m.of('listExceptions')[0]!.arg).toMatchObject({ status: 'open', limit: 50 });
    expect(m.of('listExceptions')[0]!.tenantId).toBe(TENANT);
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0]).toMatchObject({ id: EXC, status: 'open', reason: 'unmapped_code', instrument_id: INSTR, result_key: KEY, sample_barcode: BARCODE, instrument_analyte_code: 'HGB', created_at: '2026-06-15T04:56:30.000Z' });
    expect(r.body.page).toMatchObject({ limit: 50 });
    for (const k of Object.keys(r.body.data[0])) expect(keysOf('IngestExceptionDto'), k).toContain(k);
    expect(JSON.stringify(r.body)).not.toMatch(LEAK);
    expect(JSON.stringify(r.body)).not.toContain(OTHER_TENANT);
  });
  it('absent values are omitted, never null (result_id / resolved_at / resolution on an open exception)', async () => {
    const r = await run('listIngestExceptions', listReq(), make().ctx);
    for (const k of ['result_id', 'resolved_at', 'resolution']) expect(Object.keys(r.body.data[0]), k).not.toContain(k);
    expect(JSON.stringify(r.body)).not.toContain('null');
  });
  it('status, reason (csv -> array), instrument_id, cursor and limit are forwarded to the store', async () => {
    const m = make({ nextCursor: 'CUR2' });
    const r = await run('listIngestExceptions', listReq({ status: 'resolved', reason: 'unmapped_code,unknown_barcode', instrument_id: INSTR, cursor: 'CUR1', limit: '25' }), m.ctx);
    expect(m.of('listExceptions')[0]!.arg).toMatchObject({ status: 'resolved', reasons: ['unmapped_code', 'unknown_barcode'], instrumentId: INSTR, cursor: 'CUR1', limit: 25 });
    expect(r.body.page).toMatchObject({ limit: 25, next_cursor: 'CUR2' });
  });
  it('a resolved exception shows resolution and resolved_at (ISO)', async () => {
    const m = make({ rows: [excRow({ status: 'resolved', resolution: 'assigned', resolved_at: new Date('2026-06-15T04:59:00Z'), result_id: R_HGB })] });
    const r = await run('listIngestExceptions', listReq({ status: 'resolved' }), m.ctx);
    expect(r.body.data[0]).toMatchObject({ status: 'resolved', resolution: 'assigned', resolved_at: '2026-06-15T04:59:00.000Z', result_id: R_HGB });
  });
});

describe('T-23 getIngestException (#39)', () => {
  it('detail has raw_value / raw_flags / unit_raw from value_raw / instrument_flags / unit_raw and writes ONE ingest_exception.view access-log row (REQ-SEC-096, 02-TRD §11)', async () => {
    const m = make();
    const r = await run('getIngestException', getReq(EXC), m.ctx);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: EXC, status: 'open', reason: 'unmapped_code', raw_value: '13.4', raw_flags: ['H'], unit_raw: 'g/dL' });
    for (const k of Object.keys(r.body)) expect(keysOf('IngestExceptionDetail'), k).toContain(k);
    expect(m.access).toHaveLength(1);
    expect(m.access[0]).toMatchObject({ action: 'ingest_exception.view', entityType: 'ingest_exception', entityId: EXC, outcome: 'allowed' });
    expect(JSON.stringify(m.access)).not.toContain('13.4');   // the log names the record, it does not copy the value (REQ-SEC-098)
  });
  it('another tenant\'s id -> 404 common.not_found, no body data, no access-log row (P-01)', async () => {
    const m = make({ rows: [excRow({ id: FOREIGN_EXC, tenant_id: OTHER_TENANT })] });
    const e = await fail(run('getIngestException', getReq(FOREIGN_EXC), m.ctx));
    expect(e.code).toBe('common.not_found'); expect(e.statusCode).toBe(404);
    expect(JSON.stringify(e)).not.toContain(OTHER_TENANT);
    expect(m.access).toHaveLength(0);
  });
  it('unknown id -> 404', async () => {
    expect((await fail(run('getIngestException', getReq(u(0xdead)), make().ctx))).code).toBe('common.not_found');
  });
});

describe('T-23 reapplyIngestException (#41; AC-14.5 "re-applies after the mapping is fixed", AC-14.3 "still unmapped")', () => {
  it('mapping fixed: the pipeline runs under the SAME result key, saves the instrument result on the received specimen, and the exception becomes resolved (resolver + time) — outcome applied', async () => {
    const m = make();
    const r = await run('reapplyIngestException', postReq(EXC, {}), m.ctx);
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe('applied');
    expect(r.body.exception).toMatchObject({ id: EXC, status: 'resolved', resolution: 'applied', resolved_at: NOW.toISOString() });
    expect(m.of('claimKey')[0]!.arg).toMatchObject({ resultKey: KEY, firstSource: 'port' });
    expect(m.of('saveInstrumentResult')[0]!.arg).toMatchObject({ resultId: R_HGB, origin: 'instrument', instrumentId: INSTR, value: { numeric: '13.4' }, valueRaw: '13.4', instrumentMessageId: MSG, transition: 'R2' });
    expect(m.rows.get(EXC)).toMatchObject({ status: 'resolved', resolved_by_membership_id: MEMBERSHIP });
    for (const k of Object.keys(r.body.exception)) expect(keysOf('IngestExceptionDto'), k).toContain(k);
  });
  it('the catalog is asked for the INBOUND mapping of the stored instrument code (the tenant comes from ctx only)', async () => {
    const m = make();
    await run('reapplyIngestException', postReq(EXC, {}), m.ctx);
    expect(m.mapAsked[0]).toMatchObject({ instrumentId: INSTR, direction: 'inbound', instrumentCode: 'HGB' });
    expect(m.calls.every((c) => c.tenantId === TENANT && c.tx === m.tx || c.tenantId === undefined), 'every store call is (ctx.tx, ctx.tenantId, ...)').toBe(true);
  });
  it('AC-14.3: still unmapped -> outcome unmatched, the exception stays OPEN with attempts + 1 and a fresh last_attempt_at; nothing is saved', async () => {
    const m = make({ unmapped: true });
    const r = await run('reapplyIngestException', postReq(EXC, {}), m.ctx);
    expect(r.body.outcome).toBe('unmatched');
    expect(r.body.exception).toMatchObject({ id: EXC, status: 'open', reason: 'unmapped_code' });
    expect(m.rows.get(EXC)).toMatchObject({ status: 'open', attempts: 3 });
    expect(m.of('saveInstrumentResult')).toHaveLength(0);
    expect(m.of('upsertOpenException')).toHaveLength(1);
    expect(m.of('upsertOpenException')[0]!.arg).toMatchObject({ resultKey: KEY, reason: 'unmapped_code' });
  });
  it('specimen still not received -> unmatched, reason specimen_not_received, exception open (the reason follows the latest attempt, 03-APP-FLOW §1.3)', async () => {
    const m = make({ specimen: { status: 'collected' } });
    const r = await run('reapplyIngestException', postReq(EXC, {}), m.ctx);
    expect(r.body.outcome).toBe('unmatched');
    expect(r.body.exception).toMatchObject({ status: 'open', reason: 'specimen_not_received' });
    expect(m.of('saveInstrumentResult')).toHaveLength(0);
  });
  it('approved target -> rejected_state (result_locked), never a thrown lab.result_locked (CR-C5-008); exception stays open', async () => {
    const m = make({ specimenRows: [hgbRow({ status: 'approved' })] });
    const r = await run('reapplyIngestException', postReq(EXC, {}), m.ctx);
    expect(r.body.outcome).toBe('rejected_state');
    expect(r.body.exception).toMatchObject({ status: 'open', reason: 'result_locked' });
    expect(m.of('saveInstrumentResult')).toHaveLength(0);
  });
  it('a resolved / discarded exception cannot be re-applied: rejected (validation_failed or not_found), no pipeline call, no write', async () => {
    for (const status of ['resolved', 'discarded']) {
      const m = make({ rows: [excRow({ status, resolution: status === 'resolved' ? 'applied' : 'discarded', resolved_at: NOW })] });
      const e = await fail(run('reapplyIngestException', postReq(EXC, {}), m.ctx));
      expect(NOT_OPEN_CODES, `${status}: ${e.code}`).toContain(e.code);
      expect(m.of('claimKey')).toHaveLength(0);
      expect(m.wrote()).toEqual([]);
    }
  });
  it('another tenant\'s exception id -> 404 and no store write (P-01, P-07)', async () => {
    const m = make({ rows: [excRow({ id: FOREIGN_EXC, tenant_id: OTHER_TENANT })] });
    const e = await fail(run('reapplyIngestException', postReq(FOREIGN_EXC, {}), m.ctx));
    expect(e.code).toBe('common.not_found');
    expect(m.of('claimKey')).toHaveLength(0);
    expect(m.wrote()).toEqual([]);
  });
  it('a technical failure inside the pipeline propagates (the request rolls back): never a 200 with a half-resolved exception', async () => {
    const m = make({ saveThrows: new LimsError('common.version_conflict') });
    expect((await fail(run('reapplyIngestException', postReq(EXC, {}), m.ctx))).code).toBe('common.version_conflict');
  });
  it('a record that is not a value record (attachment / organism_id) is reported not_applicable, not applied', async () => {
    const m = make({ rows: [excRow({ record_kind: 'organism_id' })] });
    const r = await run('reapplyIngestException', postReq(EXC, {}), m.ctx);
    expect(r.body.outcome).toBe('not_applicable');
    expect(m.of('saveInstrumentResult')).toHaveLength(0);
  });
});

describe('T-23 assignIngestException (#40; AC-14.5 "assigns it to a specimen/result")', () => {
  const assign = (body: Record<string, unknown> = { result_id: R_HGB }) => postReq(EXC, body);
  it('assigns an unknown-barcode exception to a pending result of the same analyte: pipeline saves on THAT result, exception resolved with resolution assigned, response carries the ResultDto', async () => {
    const m = make({ rows: [excRow({ reason: 'unknown_barcode' })], specimen: null });
    const r = await run('assignIngestException', assign(), m.ctx);
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe('applied');
    expect(r.body.exception).toMatchObject({ id: EXC, status: 'resolved', resolution: 'assigned', resolved_at: NOW.toISOString() });
    expect(r.body.result).toMatchObject({ id: R_HGB, status: 'resulted', origin: 'instrument' });
    expect(m.of('getResultForAssign')[0]!.arg).toBe(R_HGB);
    expect(m.of('saveInstrumentResult')[0]!.arg).toMatchObject({ resultId: R_HGB, expectedRowVersion: 3, origin: 'instrument', instrumentId: INSTR, value: { numeric: '13.4' }, valueRaw: '13.4', transition: 'R2' });
    expect(m.rows.get(EXC)).toMatchObject({ status: 'resolved', resolution: 'assigned', resolved_by_membership_id: MEMBERSHIP });
    expect(m.of('finishLog')[0]!.arg).toMatchObject({ lastOutcome: 'applied', resultId: R_HGB });
    expect(JSON.stringify(r.body.result)).not.toMatch(/tenant_id|created_by|updated_by/);
  });
  it('analyte of the target differs from the mapped analyte -> rejected without override_analyte (validation_failed on /override_analyte), nothing saved', async () => {
    const m = make({ target: hgbRow({ resultId: R_WBC, analyteId: WBC, analyte: { id: WBC, code: 'WBC', resultType: 'numeric', decimals: 1 } }) });
    const e = await fail(run('assignIngestException', assign({ result_id: R_WBC }), m.ctx));
    expect(e.code).toBe('common.validation_failed');
    expect(JSON.stringify(e.details ?? e.errors ?? [])).toContain('override_analyte');
    expect(m.wrote()).toEqual([]);
    expect(m.rows.get(EXC)!.status).toBe('open');
  });
  it('override_analyte: true applies to the different analyte', async () => {
    const m = make({ target: hgbRow({ resultId: R_WBC, analyteId: WBC, analyte: { id: WBC, code: 'WBC', resultType: 'numeric', decimals: 1 } }) });
    const r = await run('assignIngestException', assign({ result_id: R_WBC, override_analyte: true }), m.ctx);
    expect(r.body.outcome).toBe('applied');
    expect(m.of('saveInstrumentResult')[0]!.arg).toMatchObject({ resultId: R_WBC });
  });
  it('a result of another tenant / unknown result id -> 404 common.not_found, nothing written (P-07: "assign exception to tenant-B result")', async () => {
    const m = make({ target: null });
    const e = await fail(run('assignIngestException', assign({ result_id: u(0xb0b) }), m.ctx));
    expect(e.code).toBe('common.not_found');
    expect(m.wrote()).toEqual([]);
    expect(m.of('getResultForAssign')[0]!.tenantId).toBe(TENANT);
  });
  it('an approved target is NOT overwritten: outcome rejected_state, exception stays open, no save (04 R1)', async () => {
    const m = make({ target: hgbRow({ status: 'approved' }) });
    const r = await run('assignIngestException', assign(), m.ctx);
    expect(r.body.outcome).toBe('rejected_state');
    expect(r.body.exception.status).toBe('open');
    expect(m.of('saveInstrumentResult')).toHaveLength(0);
  });
  it('a resolved or discarded exception cannot be assigned; another tenant\'s exception id -> 404', async () => {
    const done = make({ rows: [excRow({ status: 'discarded', resolution: 'discarded', resolved_at: NOW, discard_reason_code: 'DUPLICATE_RUN' })] });
    expect(NOT_OPEN_CODES).toContain((await fail(run('assignIngestException', assign(), done.ctx))).code);
    expect(done.wrote()).toEqual([]);
    const foreign = make({ rows: [excRow({ id: FOREIGN_EXC, tenant_id: OTHER_TENANT })] });
    expect((await fail(run('assignIngestException', postReq(FOREIGN_EXC, { result_id: R_HGB }), foreign.ctx))).code).toBe('common.not_found');
    expect(foreign.wrote()).toEqual([]);
  });
});

describe('T-23 discardIngestException (#42; AC-14.5 "When discarded with a reason, Then discarded")', () => {
  it('stores the reason code, comment, resolver and time; status discarded; the pipeline is NOT run', async () => {
    const m = make();
    const r = await run('discardIngestException', postReq(EXC, { reason_code: 'DUPLICATE_RUN', comment: 'Run repeated on the bench' }), m.ctx);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: EXC, status: 'discarded', resolution: 'discarded', resolved_at: NOW.toISOString() });
    expect(m.of('discardException')[0]!.arg).toMatchObject({ id: EXC, reasonCode: 'DUPLICATE_RUN', comment: 'Run repeated on the bench', resolverMembershipId: MEMBERSHIP, occurredAt: NOW.toISOString() });
    expect(m.of('claimKey')).toHaveLength(0);
    expect(m.of('saveInstrumentResult')).toHaveLength(0);
    for (const k of Object.keys(r.body)) expect(keysOf('IngestExceptionDto'), k).toContain(k);
    expect(JSON.stringify(r.body)).not.toMatch(LEAK);
  });
  it('a reason code that is not an active lab.exception_discard_reasons code -> 400/422 common.validation_failed on /reason_code, exception stays open', async () => {
    const m = make();
    const e = await fail(run('discardIngestException', postReq(EXC, { reason_code: 'NOT_A_REASON' }), m.ctx));
    expect(e.code).toBe('common.validation_failed');
    expect(JSON.stringify(e.details ?? e.errors ?? [])).toContain('reason_code');
    expect(m.of('discardException')).toHaveLength(0);
    expect(m.rows.get(EXC)!.status).toBe('open');
  });
  it('without a reason_code -> validation_failed (the DB check ingest_exceptions__discard__ck would also refuse it)', async () => {
    const m = make();
    expect((await fail(run('discardIngestException', postReq(EXC, {}), m.ctx))).code).toBe('common.validation_failed');
    expect(m.of('discardException')).toHaveLength(0);
  });
  it('already resolved / discarded -> rejected, no second write; another tenant\'s id -> 404', async () => {
    for (const status of ['resolved', 'discarded']) {
      const m = make({ rows: [excRow({ status, resolution: status === 'resolved' ? 'applied' : 'discarded', resolved_at: NOW })] });
      expect(NOT_OPEN_CODES).toContain((await fail(run('discardIngestException', postReq(EXC, { reason_code: 'DUPLICATE_RUN' }), m.ctx))).code);
      expect(m.of('discardException')).toHaveLength(0);
    }
    const foreign = make({ rows: [excRow({ id: FOREIGN_EXC, tenant_id: OTHER_TENANT })] });
    expect((await fail(run('discardIngestException', postReq(FOREIGN_EXC, { reason_code: 'DUPLICATE_RUN' }), foreign.ctx))).code).toBe('common.not_found');
    expect(foreign.of('discardException')).toHaveLength(0);
  });
  it('the coded-set check runs under the ctx tenant (tenant rows shadow global rows)', async () => {
    const m = make();
    await run('discardIngestException', postReq(EXC, { reason_code: 'TEST_SAMPLE' }), m.ctx);
    expect(m.of('isActiveDiscardReason')[0]).toMatchObject({ tenantId: TENANT, arg: 'TEST_SAMPLE' });
  });
});
