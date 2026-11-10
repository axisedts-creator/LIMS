// WEB-T05 — BFF for SCR-09/10: E33 listInstrumentMessages, E34 searchInstrumentMessages, E35 getInstrumentMessage, E36 getInstrumentMessageRaw,
// E38 reprocessInstrumentMessage, E39 rematchInstrumentRecord, E42 listMessageRejections, the 5 server actions, the E37 attachment stream proxy
// (route handler) and static guards.
// ACs: AC-12.6 (E37 stream, headers, no Storage URL), AC-18.1 (31-day range, filters, barcode ONLY in a POST body — REQ-SEC-098),
//      AC-18.3 (raw on demand), AC-19.1–19.5 (reprocess / re-match bodies + errors surface). Synthetic data only.
// ASSUMED module/signature contract (spec gives operationIds + folders only; dispute to rename):
//   server/listInstrumentMessages.server.ts   listInstrumentMessages({receivedAtFrom, receivedAtTo, instrumentId?, agentId?, centreId?, messageKind?[], latestOutcome?[], hasUnmapped?, hasQc?, limit?, cursor?}) → {data, page}
//   server/searchInstrumentMessages.server.ts searchInstrumentMessages({sampleBarcode, receivedAtFrom?, receivedAtTo?, instrumentId?}) → {data}      POST body only
//   server/getInstrumentMessage.server.ts     getInstrumentMessage(id, {previewParse?}) → MessageDetail
//   server/getInstrumentMessageRaw.server.ts  getInstrumentMessageRaw(id) → {raw_base64, raw_text_escaped, raw_sha256, size_bytes}
//   server/reprocessInstrumentMessage.server.ts reprocessInstrumentMessage(id, {reasonCode, reasonText?}, idempotencyKey) → {run, records}
//   server/rematchInstrumentRecord.server.ts  rematchInstrumentRecord(recordId, {sampleBarcode, reasonCode, reasonText?}, idempotencyKey) → {run, record}
//   server/listMessageRejections.server.ts    listMessageRejections({receivedAtFrom, receivedAtTo, agentId?, reason?, limit?, cursor?}) → {data, page}
//   server/actions.ts   searchInstrumentMessagesAction(input) · getInstrumentMessageRawAction(id) · getInstrumentMessageAction(id, {previewParse?}) ·
//                       reprocessInstrumentMessageAction(id, input, key) · rematchInstrumentRecordAction(recordId, input, key)  → ActionResult<…> (ApiError → {ok:false,status,code})
//   app/(staff)/instruments/messages/[instrument_message_id]/attachment/route.ts   GET(req, {params: Promise<{instrument_message_id}>}) — E37 stream proxy
// Invalid input must throw ApiError(400 common.validation_failed) BEFORE any network call. None of these gate on the session (the API enforces instruments.message.*).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ token: 'jwt-synthetic' as string | undefined }));
vi.mock('@/core/session/server', () => ({ getAccessToken: async () => session.token, getShellSession: async () => undefined }));

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
const IM = `${ORIGIN}/v1/instruments`;
const MSG = '01a1a98a-ac40-7000-8000-0000000e0001';
const REC = '01a1a98a-ac40-7000-8000-0000000f0001';
const INST = '01a1a98a-ac40-7000-8000-0000000d0001';
const AGENT = '01a1a98a-ac40-7000-8000-0000000d0101';
const CENTRE = '01a1a98a-ac40-7000-8000-000000020001';
const KEY = 'idem-web-t05-0001';
const BARCODE = 'E2600000042'; // synthetic
const FROM = '2026-11-06T00:00:00.000Z';
const TO = '2026-11-07T00:00:00.000Z';
const RANGE = { receivedAtFrom: FROM, receivedAtTo: TO };

const seen: { url: URL; method: string; headers: Headers; body?: any }[] = [];
const rec = async (r: Request) => { seen.push({ url: new URL(r.url), method: r.method, headers: r.headers, body: r.method === 'GET' ? undefined : await r.clone().json().catch(() => undefined) }); };
const problem = (status: number, code: string) => HttpResponse.json({ type: `urn:lims:error:${code}`, title: code, status, code }, { status });
const summary = { id: MSG, instrument_id: INST, instrument_code: 'SIM-CHEM-1', agent_id: AGENT, centre_id: CENTRE, protocol: 'astm', message_kind: 'data', received_at: '2026-11-06T04:05:00.000Z', size_bytes: 412, latest_run: { run_no: 1, kind: 'live', outcome: 'parsed', patient_records: 3, qc_records: 0, calibrator_records: 0, unmapped_records: 0, emitted_events: 3 } };
const run = { id: '01a1a98a-ac40-7000-8000-0000000f0100', run_no: 2, kind: 'reprocess', driver_code: 'astm_generic_e1394', driver_version: '0.1.0', outcome: 'parsed', patient_records: 1, qc_records: 0, calibrator_records: 0, host_query_records: 0, unmapped_records: 0, skipped_no_barcode_records: 0, emitted_events: 1, skipped_records: 0, actor_type: 'user', created_at: '2026-11-07T01:00:00.000Z' };
const server = setupServer(
  http.get(`${IM}/messages`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: [summary], page: { limit: 50 } }); }),
  http.post(`${IM}/messages/search`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: [summary] }); }),
  http.get(`${IM}/messages/:id/raw`, async ({ request }) => { await rec(request); return HttpResponse.json({ raw_base64: 'U1lOVEhFVElD', raw_text_escaped: 'SYNTHETIC', raw_sha256: 'a'.repeat(64), size_bytes: 9 }); }),
  http.get(`${IM}/messages/:id`, async ({ request }) => { await rec(request); return HttpResponse.json({ ...summary, message_key_kind: 'msh10', warnings: [], runs: [], records: [], records_expired: false }); }),
  http.post(`${IM}/messages/:id/reprocess`, async ({ request }) => { await rec(request); return HttpResponse.json({ run, records: [] }); }),
  http.post(`${IM}/message-records/:id/rematch`, async ({ request }) => { await rec(request); return HttpResponse.json({ run: { ...run, kind: 'rematch' }, record: { id: REC } }); }),
  http.get(`${IM}/rejections`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: [], page: { limit: 50 } }); }),
);
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { server.resetHandlers(); seen.length = 0; session.token = 'jwt-synthetic'; });
afterAll(() => server.close());

const rejects400 = async (p: Promise<unknown>) => { await expect(p).rejects.toMatchObject({ status: 400, problem: { code: 'common.validation_failed' } }); expect(seen).toHaveLength(0); };
// Explicit imports (not a template string) so a missing module fails with "Failed to resolve import …/<name>.server".
const loaders: Record<string, () => Promise<any>> = {
  listInstrumentMessages: () => import('../server/listInstrumentMessages.server'),
  searchInstrumentMessages: () => import('../server/searchInstrumentMessages.server'),
  getInstrumentMessage: () => import('../server/getInstrumentMessage.server'),
  getInstrumentMessageRaw: () => import('../server/getInstrumentMessageRaw.server'),
  reprocessInstrumentMessage: () => import('../server/reprocessInstrumentMessage.server'),
  rematchInstrumentRecord: () => import('../server/rematchInstrumentRecord.server'),
  listMessageRejections: () => import('../server/listMessageRejections.server'),
};
const mod = async (n: string) => loaders[n]!();

// ================================================================================================================ E33
describe('E33 listInstrumentMessages (AC-18.1)', () => {
  it('GET /v1/instruments/messages with the required range, bearer token, no body; returns {data,page}', async () => {
    const { listInstrumentMessages } = await mod('listInstrumentMessages');
    const r = await listInstrumentMessages(RANGE);
    expect(seen).toHaveLength(1);
    const c = seen[0]!;
    expect(c.method).toBe('GET');
    expect(c.url.pathname).toBe('/v1/instruments/messages');
    expect(c.url.searchParams.get('received_at_from')).toBe(FROM);
    expect(c.url.searchParams.get('received_at_to')).toBe(TO);
    expect(c.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(r.data[0]).toMatchObject({ id: MSG, instrument_code: 'SIM-CHEM-1' });
    expect(r.page).toMatchObject({ limit: 50 });
  });

  it('maps every filter to its query name: instrument_id, agent_id, centre_id, message_kind csv, latest_outcome csv, has_unmapped, has_qc, cursor, limit', async () => {
    const { listInstrumentMessages } = await mod('listInstrumentMessages');
    await listInstrumentMessages({ ...RANGE, instrumentId: INST, agentId: AGENT, centreId: CENTRE, messageKind: ['data', 'incomplete'], latestOutcome: ['quarantined', 'shadow'], hasUnmapped: true, hasQc: true, limit: 25, cursor: 'abc' });
    const q = seen[0]!.url.searchParams;
    expect(q.get('instrument_id')).toBe(INST);
    expect(q.get('agent_id')).toBe(AGENT);
    expect(q.get('centre_id')).toBe(CENTRE);
    expect(q.get('message_kind')).toBe('data,incomplete');
    expect(q.get('latest_outcome')).toBe('quarantined,shadow');
    expect(q.get('has_unmapped')).toBe('true');
    expect(q.get('has_qc')).toBe('true');
    expect(q.get('limit')).toBe('25');
    expect(q.get('cursor')).toBe('abc');
  });

  it('a range of exactly 31 days is accepted; unset filters are not sent', async () => {
    const { listInstrumentMessages } = await mod('listInstrumentMessages');
    await listInstrumentMessages({ receivedAtFrom: '2026-10-07T00:00:00.000Z', receivedAtTo: '2026-11-07T00:00:00.000Z' });
    const q = seen[0]!.url.searchParams;
    for (const k of ['instrument_id', 'agent_id', 'centre_id', 'message_kind', 'latest_outcome', 'has_unmapped', 'has_qc', 'cursor']) expect(q.has(k), k).toBe(false);
  });

  it.each([
    ['31 days + 1 ms', { receivedAtFrom: '2026-10-07T00:00:00.000Z', receivedAtTo: '2026-11-07T00:00:00.001Z' }],
    ['a year', { receivedAtFrom: '2025-11-07T00:00:00.000Z', receivedAtTo: '2026-11-07T00:00:00.000Z' }],
    ['to before from', { receivedAtFrom: TO, receivedAtTo: FROM }],
    ['from missing', { receivedAtTo: TO }],
    ['to missing', { receivedAtFrom: FROM }],
    ['both missing', {}],
    ['from not a date', { receivedAtFrom: 'yesterday', receivedAtTo: TO }],
    ['to not a string', { receivedAtFrom: FROM, receivedAtTo: 20261107 }],
    ['instrument id not a UUID', { ...RANGE, instrumentId: '../x' }],
    ['agent id not a UUID', { ...RANGE, agentId: 'x' }],
    ['centre id not a UUID', { ...RANGE, centreId: '1' }],
    ['unknown message_kind', { ...RANGE, messageKind: ['data', 'evil'] }],
    ['unknown latest_outcome', { ...RANGE, latestOutcome: ['ok'] }],
    ['hasQc not boolean', { ...RANGE, hasQc: 'yes' }],
    ['limit 0', { ...RANGE, limit: 0 }],
    ['limit 201', { ...RANGE, limit: 201 }],
    ['limit 1.5', { ...RANGE, limit: 1.5 }],
  ])('%s → 400 before any network call', async (_n, q) => {
    const { listInstrumentMessages } = await mod('listInstrumentMessages');
    await rejects400(listInstrumentMessages(q as never));
  });

  it('SECURITY (REQ-SEC-098): a barcode-ish key smuggled into the query object is never put on the URL', async () => {
    const { listInstrumentMessages } = await mod('listInstrumentMessages');
    await listInstrumentMessages({ ...RANGE, sampleBarcode: BARCODE, sample_barcode: BARCODE, barcode: BARCODE } as never);
    expect(seen[0]!.url.toString()).not.toContain(BARCODE);
    expect(seen[0]!.url.searchParams.toString()).not.toMatch(/barcode/i);
  });

  it('403 / 400 from the API propagate as ApiError, not swallowed', async () => {
    const { listInstrumentMessages } = await mod('listInstrumentMessages');
    server.use(http.get(`${IM}/messages`, () => problem(403, 'auth.forbidden')));
    await expect(listInstrumentMessages(RANGE)).rejects.toMatchObject({ status: 403, problem: { code: 'auth.forbidden' } });
  });
});

// ================================================================================================================ E34
describe('E34 searchInstrumentMessages (AC-18.1 — barcode only in the POST body, REQ-SEC-098)', () => {
  it('POST /v1/instruments/messages/search with {sample_barcode} as JSON; the URL has no query and no barcode; no Idempotency-Key / If-Match needed', async () => {
    const { searchInstrumentMessages } = await mod('searchInstrumentMessages');
    const r = await searchInstrumentMessages({ sampleBarcode: BARCODE });
    expect(seen).toHaveLength(1);
    const c = seen[0]!;
    expect(c.method).toBe('POST');
    expect(c.url.pathname).toBe('/v1/instruments/messages/search');
    expect(c.url.search).toBe('');
    expect(c.url.toString()).not.toContain(BARCODE);
    expect(c.headers.get('content-type')).toMatch(/application\/json/);
    expect(c.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(c.body).toEqual({ sample_barcode: BARCODE });
    expect(r.data).toHaveLength(1);
    for (const [k, v] of c.headers) expect(`${k}:${v}`, k).not.toContain(BARCODE); // not in any header either (Referer, custom…)
  });

  it('optional received_at_from/to + instrument_id travel in the body, snake_case', async () => {
    const { searchInstrumentMessages } = await mod('searchInstrumentMessages');
    await searchInstrumentMessages({ sampleBarcode: BARCODE, ...RANGE, instrumentId: INST });
    expect(seen[0]!.body).toEqual({ sample_barcode: BARCODE, received_at_from: FROM, received_at_to: TO, instrument_id: INST });
    expect(seen[0]!.url.search).toBe('');
  });

  it.each([[''], ['abc'], ['E26 00042'], ['E26-00042'], ['E2600000042\n'], ['E'.repeat(41)], ['É2600000042'], ['../etc'], [' E2600000042'], [null], [undefined], [42]])('barcode %j violates ^[A-Z0-9]{1,40}$ → 400 before any network call', async (b) => {
    const { searchInstrumentMessages } = await mod('searchInstrumentMessages');
    await rejects400(searchInstrumentMessages({ sampleBarcode: b } as never));
  });

  it('a 40-char barcode is accepted (boundary)', async () => {
    const { searchInstrumentMessages } = await mod('searchInstrumentMessages');
    await searchInstrumentMessages({ sampleBarcode: 'A'.repeat(40) });
    expect(seen[0]!.body.sample_barcode).toHaveLength(40);
  });

  it('bad optional filters (non-UUID instrument, bad date) → 400 before any network call', async () => {
    const { searchInstrumentMessages } = await mod('searchInstrumentMessages');
    await rejects400(searchInstrumentMessages({ sampleBarcode: BARCODE, instrumentId: 'x' } as never));
    await rejects400(searchInstrumentMessages({ sampleBarcode: BARCODE, receivedAtFrom: 'x' } as never));
  });

  it('SECURITY: unknown body keys are rejected or dropped, never forwarded', async () => {
    const { searchInstrumentMessages } = await mod('searchInstrumentMessages');
    await searchInstrumentMessages({ sampleBarcode: BARCODE, evil: 1, centre_id: CENTRE } as never).catch(() => undefined);
    for (const c of seen) expect(Object.keys(c.body).sort()).toEqual(['sample_barcode']);
  });

  it('API 400/403 propagate', async () => {
    const { searchInstrumentMessages } = await mod('searchInstrumentMessages');
    server.use(http.post(`${IM}/messages/search`, () => problem(403, 'auth.forbidden')));
    await expect(searchInstrumentMessages({ sampleBarcode: BARCODE })).rejects.toMatchObject({ status: 403, problem: { code: 'auth.forbidden' } });
  });
});

// ================================================================================================================ E35 / E36
describe('E35 getInstrumentMessage / E36 getInstrumentMessageRaw (AC-18.2, AC-18.3)', () => {
  it('E35: GET /v1/instruments/messages/{id}; preview_parse only when asked', async () => {
    const { getInstrumentMessage } = await mod('getInstrumentMessage');
    const m = await getInstrumentMessage(MSG);
    expect(seen[0]!.method).toBe('GET');
    expect(seen[0]!.url.pathname).toBe(`/v1/instruments/messages/${MSG}`);
    expect(seen[0]!.url.searchParams.has('preview_parse')).toBe(false);
    expect(m).toMatchObject({ id: MSG, records_expired: false });
    await getInstrumentMessage(MSG, { previewParse: true });
    expect(seen[1]!.url.searchParams.get('preview_parse')).toBe('true');
  });

  it('E35: 404 propagates (page maps it to notFound)', async () => {
    const { getInstrumentMessage } = await mod('getInstrumentMessage');
    server.use(http.get(`${IM}/messages/:id`, () => problem(404, 'common.not_found')));
    await expect(getInstrumentMessage(MSG)).rejects.toMatchObject({ status: 404 });
  });

  it('E36: GET …/raw with the bearer token; returns the escaped text + sha + size', async () => {
    const { getInstrumentMessageRaw } = await mod('getInstrumentMessageRaw');
    const r = await getInstrumentMessageRaw(MSG);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe('GET');
    expect(seen[0]!.url.pathname).toBe(`/v1/instruments/messages/${MSG}/raw`);
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(r).toMatchObject({ raw_text_escaped: 'SYNTHETIC', size_bytes: 9 });
  });

  it.each([['getInstrumentMessage'], ['getInstrumentMessageRaw']])('%s: a non-UUID id → 400 before any network call (never forwarded, no path traversal)', async (n) => {
    const m = await mod(n);
    for (const bad of ['x', '../raw', `${MSG}/raw`, '', `${MSG}?x=1`, `${MSG}\n`]) await rejects400(m[n](bad));
  });
});

// ================================================================================================================ E38
describe('E38 reprocessInstrumentMessage (AC-19.1, AC-19.4)', () => {
  it('POST …/{id}/reprocess with Idempotency-Key, JSON {reason_code, reason_text?}; NO If-Match (A-class); returns {run, records}', async () => {
    const { reprocessInstrumentMessage } = await mod('reprocessInstrumentMessage');
    const r = await reprocessInstrumentMessage(MSG, { reasonCode: 'driver_fixed', reasonText: 'Driver 0.1.1 deployed' }, KEY);
    expect(seen).toHaveLength(1);
    const c = seen[0]!;
    expect(c.method).toBe('POST');
    expect(c.url.pathname).toBe(`/v1/instruments/messages/${MSG}/reprocess`);
    expect(c.headers.get('idempotency-key')).toBe(KEY);
    expect(c.headers.get('if-match')).toBeNull();
    expect(c.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(c.body).toEqual({ reason_code: 'driver_fixed', reason_text: 'Driver 0.1.1 deployed' });
    expect(r.run).toMatchObject({ kind: 'reprocess' });
  });

  it('reason_text omitted → absent from the body; all seven seeded reason codes are accepted', async () => {
    const { reprocessInstrumentMessage } = await mod('reprocessInstrumentMessage');
    for (const code of ['driver_fixed', 'mapping_added', 'quarantine_reviewed', 'barcode_keypad_error', 'barcode_label_misread', 'instrument_resent_wrong_id', 'other']) await reprocessInstrumentMessage(MSG, { reasonCode: code }, KEY);
    expect(seen).toHaveLength(7);
    expect(seen[0]!.body).toEqual({ reason_code: 'driver_fixed' });
    expect(seen[0]!.body).not.toHaveProperty('reason_text');
  });

  it.each([
    ['unknown reason code', MSG, { reasonCode: 'because' }, KEY],
    ['missing reason code', MSG, {}, KEY],
    ['reason_text 301 chars', MSG, { reasonCode: 'other', reasonText: 'x'.repeat(301) }, KEY],
    ['reason_text not a string', MSG, { reasonCode: 'other', reasonText: 5 }, KEY],
    ['non-UUID message id', 'x', { reasonCode: 'other' }, KEY],
    ['missing Idempotency-Key', MSG, { reasonCode: 'other' }, undefined],
    ['Idempotency-Key with CRLF', MSG, { reasonCode: 'other' }, 'a\r\nx-evil: 1'],
    ['Idempotency-Key 65 chars', MSG, { reasonCode: 'other' }, 'k'.repeat(65)],
  ])('%s → 400 before any network call', async (_n, id, input, key) => {
    const { reprocessInstrumentMessage } = await mod('reprocessInstrumentMessage');
    await rejects400(reprocessInstrumentMessage(id as never, input as never, key as never));
  });

  it('300-char reason_text is accepted (boundary)', async () => {
    const { reprocessInstrumentMessage } = await mod('reprocessInstrumentMessage');
    await reprocessInstrumentMessage(MSG, { reasonCode: 'other', reasonText: 'x'.repeat(300) }, KEY);
    expect(seen[0]!.body.reason_text).toHaveLength(300);
  });

  it.each([[409, 'instruments.reprocess_not_allowed'], [422, 'instruments.driver_not_available'], [403, 'auth.forbidden'], [404, 'common.not_found']])('API %s %s propagates with its code', async (status, code) => {
    const { reprocessInstrumentMessage } = await mod('reprocessInstrumentMessage');
    server.use(http.post(`${IM}/messages/:id/reprocess`, () => problem(status, code)));
    await expect(reprocessInstrumentMessage(MSG, { reasonCode: 'other' }, KEY)).rejects.toMatchObject({ status, problem: { code } });
  });
});

// ================================================================================================================ E39
describe('E39 rematchInstrumentRecord (AC-19.2, AC-19.5 — barcode only in the POST body)', () => {
  it('POST /v1/instruments/message-records/{record_id}/rematch with {sample_barcode, reason_code, reason_text?}; barcode not in URL or headers; Idempotency-Key; no If-Match', async () => {
    const { rematchInstrumentRecord } = await mod('rematchInstrumentRecord');
    const r = await rematchInstrumentRecord(REC, { sampleBarcode: BARCODE, reasonCode: 'barcode_keypad_error', reasonText: 'typo' }, KEY);
    const c = seen[0]!;
    expect(seen).toHaveLength(1);
    expect(c.method).toBe('POST');
    expect(c.url.pathname).toBe(`/v1/instruments/message-records/${REC}/rematch`);
    expect(c.url.search).toBe('');
    expect(c.url.toString()).not.toContain(BARCODE);
    expect(c.headers.get('idempotency-key')).toBe(KEY);
    expect(c.headers.get('if-match')).toBeNull();
    expect(c.body).toEqual({ sample_barcode: BARCODE, reason_code: 'barcode_keypad_error', reason_text: 'typo' });
    for (const [k, v] of c.headers) if (k !== 'idempotency-key') expect(`${k}:${v}`, k).not.toContain(BARCODE);
    expect(r.run).toMatchObject({ kind: 'rematch' });
  });

  it.each([
    ['lowercase barcode', { sampleBarcode: 'e2600000042', reasonCode: 'other' }],
    ['barcode with space', { sampleBarcode: 'E26 0042', reasonCode: 'other' }],
    ['41-char barcode', { sampleBarcode: 'E'.repeat(41), reasonCode: 'other' }],
    ['empty barcode', { sampleBarcode: '', reasonCode: 'other' }],
    ['missing barcode', { reasonCode: 'other' }],
    ['unknown reason', { sampleBarcode: BARCODE, reasonCode: 'nope' }],
    ['missing reason', { sampleBarcode: BARCODE }],
    ['note 301 chars', { sampleBarcode: BARCODE, reasonCode: 'other', reasonText: 'x'.repeat(301) }],
  ])('%s → 400 before any network call', async (_n, input) => {
    const { rematchInstrumentRecord } = await mod('rematchInstrumentRecord');
    await rejects400(rematchInstrumentRecord(REC, input as never, KEY));
  });

  it('non-UUID record id / missing key → 400 before any network call', async () => {
    const { rematchInstrumentRecord } = await mod('rematchInstrumentRecord');
    await rejects400(rematchInstrumentRecord('x', { sampleBarcode: BARCODE, reasonCode: 'other' }, KEY));
    await rejects400(rematchInstrumentRecord(`${REC}/x`, { sampleBarcode: BARCODE, reasonCode: 'other' }, KEY));
    await rejects400(rematchInstrumentRecord(REC, { sampleBarcode: BARCODE, reasonCode: 'other' }, undefined as never));
  });

  it('AC-19.5: the API\'s 400 common.validation_failed (barcode equals the original) propagates; AC-19.4: 409 instruments.reprocess_not_allowed propagates', async () => {
    const { rematchInstrumentRecord } = await mod('rematchInstrumentRecord');
    server.use(http.post(`${IM}/message-records/:id/rematch`, () => problem(400, 'common.validation_failed')));
    await expect(rematchInstrumentRecord(REC, { sampleBarcode: BARCODE, reasonCode: 'other' }, KEY)).rejects.toMatchObject({ status: 400, problem: { code: 'common.validation_failed' } });
    server.use(http.post(`${IM}/message-records/:id/rematch`, () => problem(409, 'instruments.reprocess_not_allowed')));
    await expect(rematchInstrumentRecord(REC, { sampleBarcode: BARCODE, reasonCode: 'other' }, KEY)).rejects.toMatchObject({ status: 409, problem: { code: 'instruments.reprocess_not_allowed' } });
  });
});

// ================================================================================================================ E42
describe('E42 listMessageRejections (SCR-09 second tab)', () => {
  it('GET /v1/instruments/rejections with range (+ agent_id, reason, limit, cursor)', async () => {
    const { listMessageRejections } = await mod('listMessageRejections');
    await listMessageRejections({ ...RANGE, agentId: AGENT, reason: 'instruments.device_mismatch', limit: 10, cursor: 'c' });
    const c = seen[0]!;
    expect(c.url.pathname).toBe('/v1/instruments/rejections');
    expect(c.url.searchParams.get('received_at_from')).toBe(FROM);
    expect(c.url.searchParams.get('received_at_to')).toBe(TO);
    expect(c.url.searchParams.get('agent_id')).toBe(AGENT);
    expect(c.url.searchParams.get('reason')).toBe('instruments.device_mismatch');
    expect(c.url.searchParams.get('limit')).toBe('10');
  });

  it.each([
    ['span > 31 days', { receivedAtFrom: '2026-09-01T00:00:00.000Z', receivedAtTo: '2026-11-07T00:00:00.000Z' }],
    ['no range', {}],
    ['unknown reason', { ...RANGE, reason: 'instruments.evil' }],
    ['agent not a UUID', { ...RANGE, agentId: 'x' }],
  ])('%s → 400 before any network call', async (_n, q) => {
    const { listMessageRejections } = await mod('listMessageRejections');
    await rejects400(listMessageRejections(q as never));
  });
});

// ================================================================================================================ actions
describe('server actions (ApiError → { ok:false, status, code, errors? })', () => {
  const act = async () => import('../server/actions');

  it('success → {ok:true,data}: search, raw, detail(preview), reprocess, rematch', async () => {
    const a = await act();
    expect(await a.searchInstrumentMessagesAction({ sampleBarcode: BARCODE })).toMatchObject({ ok: true, data: { data: [{ id: MSG }] } });
    expect(await a.getInstrumentMessageRawAction(MSG)).toMatchObject({ ok: true, data: { raw_text_escaped: 'SYNTHETIC' } });
    expect(await a.getInstrumentMessageAction(MSG, { previewParse: true })).toMatchObject({ ok: true, data: { id: MSG } });
    expect(await a.reprocessInstrumentMessageAction(MSG, { reasonCode: 'driver_fixed' }, KEY)).toMatchObject({ ok: true, data: { run: { kind: 'reprocess' } } });
    expect(await a.rematchInstrumentRecordAction(REC, { sampleBarcode: BARCODE, reasonCode: 'other' }, KEY)).toMatchObject({ ok: true, data: { run: { kind: 'rematch' } } });
    expect(seen.map((s) => s.method + ' ' + s.url.pathname.replace(/[0-9a-f-]{36}/g, ':id'))).toEqual([
      'POST /v1/instruments/messages/search', 'GET /v1/instruments/messages/:id/raw', 'GET /v1/instruments/messages/:id', 'POST /v1/instruments/messages/:id/reprocess', 'POST /v1/instruments/message-records/:id/rematch',
    ]);
    expect(seen[2]!.url.searchParams.get('preview_parse')).toBe('true');
  });

  it('API errors become data, not exceptions: 409 reprocess_not_allowed, 400 validation_failed, 422 driver_not_available, 404', async () => {
    const a = await act();
    server.use(http.post(`${IM}/messages/:id/reprocess`, () => problem(409, 'instruments.reprocess_not_allowed')));
    expect(await a.reprocessInstrumentMessageAction(MSG, { reasonCode: 'other' }, KEY)).toEqual({ ok: false, status: 409, code: 'instruments.reprocess_not_allowed' });
    server.use(http.post(`${IM}/message-records/:id/rematch`, () => problem(400, 'common.validation_failed')));
    expect(await a.rematchInstrumentRecordAction(REC, { sampleBarcode: BARCODE, reasonCode: 'other' }, KEY)).toMatchObject({ ok: false, status: 400, code: 'common.validation_failed' });
    server.use(http.get(`${IM}/messages/:id/raw`, () => problem(404, 'common.not_found')));
    expect(await a.getInstrumentMessageRawAction(MSG)).toEqual({ ok: false, status: 404, code: 'common.not_found' });
  });

  it('local validation failure → {ok:false,status:400} with no network call (invalid barcode / reason / id)', async () => {
    const a = await act();
    expect(await a.searchInstrumentMessagesAction({ sampleBarcode: 'bad barcode' })).toMatchObject({ ok: false, status: 400, code: 'common.validation_failed' });
    expect(await a.rematchInstrumentRecordAction(REC, { sampleBarcode: BARCODE, reasonCode: 'nope' }, KEY)).toMatchObject({ ok: false, status: 400 });
    expect(await a.getInstrumentMessageRawAction('x')).toMatchObject({ ok: false, status: 400 });
    expect(seen).toHaveLength(0);
  });

  it('a retry reuses the caller\'s Idempotency-Key (the action mints none)', async () => {
    const a = await act();
    await a.reprocessInstrumentMessageAction(MSG, { reasonCode: 'other' }, KEY);
    await a.reprocessInstrumentMessageAction(MSG, { reasonCode: 'other' }, KEY);
    expect(seen.map((s) => s.headers.get('idempotency-key'))).toEqual([KEY, KEY]);
  });
});

// ================================================================================================================ E37 route
describe('E37 attachment stream proxy (AC-12.6): GET /instruments/messages/{id}/attachment', () => {
  const ATT = `${IM}/messages/:id/attachment/content`;
  const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0xff, 0x00, 0x01]); // %PDF-1.4 + binary
  const upstream = (h: Record<string, string> = {}, body: BodyInit = PDF) => http.get(ATT, async ({ request }) => { await rec(request); return new HttpResponse(body, { status: 200, headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="report.pdf"', ...h } }); });
  const call = async (id: string = MSG) => {
    const { GET } = await import('../../../app/(staff)/instruments/messages/[instrument_message_id]/attachment/route');
    return GET(new Request(`http://web.test/instruments/messages/${id}/attachment`), { params: Promise.resolve({ instrument_message_id: id }) });
  };
  const bytes = async (r: Response) => new Uint8Array(await r.arrayBuffer());

  it('streams the upstream bytes untouched with Content-Disposition: attachment, nosniff, no-store; ONE upstream call with the bearer token', async () => {
    server.use(upstream());
    const r = await call();
    expect(r.status).toBe(200);
    expect(r.headers.get('content-disposition')).toMatch(/^attachment/i);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('cache-control')).toMatch(/no-store/);
    expect(r.headers.get('content-type')).toBe('application/pdf');
    expect(await bytes(r)).toEqual(PDF);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url.pathname).toBe(`/v1/instruments/messages/${MSG}/attachment/content`);
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer jwt-synthetic');
  });

  it('the body is a stream (not buffered into a string / JSON) and image types pass through', async () => {
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    server.use(upstream({ 'content-type': 'image/png', 'content-disposition': 'attachment; filename="a.png"' }, PNG));
    const r = await call();
    expect(r.body).not.toBeNull();
    expect(typeof (r.body as ReadableStream).getReader).toBe('function');
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(await bytes(r)).toEqual(PNG);
  });

  it('forces attachment when the upstream says inline or sends no Content-Disposition', async () => {
    server.use(upstream({ 'content-disposition': 'inline' }));
    expect((await call()).headers.get('content-disposition')).toMatch(/^attachment/i);
    server.use(http.get(ATT, () => new HttpResponse(PDF, { status: 200, headers: { 'content-type': 'application/pdf' } })));
    expect((await call()).headers.get('content-disposition')).toMatch(/^attachment/i);
  });

  it('SECURITY: an active content type (text/html, image/svg+xml) from upstream is never echoed — the browser must not render it', async () => {
    for (const ct of ['text/html', 'image/svg+xml', 'application/javascript']) {
      server.use(upstream({ 'content-type': ct }, '<script>alert(1)</script>'));
      const r = await call();
      expect(r.headers.get('content-type') ?? '', ct).not.toMatch(/html|svg|javascript/i);
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });

  it('SECURITY (08 A13 P-2): no Storage URL reaches the browser — upstream URL-bearing headers are not forwarded, and a redirect is NOT followed or exposed', async () => {
    server.use(upstream({ location: 'https://storage.example.test/instruments-attachments/t/2026/11/a.pdf?X-Amz-Signature=abc', 'x-storage-url': 'https://storage.example.test/b/o', link: '<https://storage.example.test/o>; rel=canonical' }));
    const ok = await call();
    for (const [k, v] of ok.headers) expect(`${k}: ${v}`, k).not.toMatch(/https?:\/\/|storage|signature/i);
    server.use(http.get(ATT, () => new HttpResponse(null, { status: 302, headers: { location: 'https://storage.example.test/instruments-attachments/t/a.pdf?X-Amz-Signature=abc' } })));
    const redirected = await call();
    expect(redirected.status).toBe(502);
    expect(redirected.headers.get('location')).toBeNull();
    expect(JSON.stringify([...redirected.headers]) + (await redirected.text())).not.toMatch(/storage\.example|X-Amz/i);
  });

  it.each([[422, 422], [404, 404], [403, 403]])('upstream %s → %s with an empty body and no upstream detail leaked (422 = common.upload_quarantined: "This file is not available.")', async (up, down) => {
    server.use(http.get(ATT, () => HttpResponse.json({ type: 'x', title: 'SECRET-TITLE', status: up, code: 'common.upload_quarantined', detail: 'file E2600000042.pdf at /srv/x' }, { status: up })));
    const r = await call();
    expect(r.status).toBe(down);
    const t = await r.text();
    expect(t).not.toMatch(/SECRET-TITLE|E2600000042|\/srv\/x/);
    expect(r.headers.get('content-disposition') ?? '').not.toMatch(/filename/i);
  });

  it('upstream 500 / network failure → 502 generic (no detail)', async () => {
    server.use(http.get(ATT, () => HttpResponse.json({ code: 'common.internal', detail: 'stack trace' }, { status: 500 })));
    const r = await call();
    expect(r.status).toBe(502);
    expect(await r.text()).not.toMatch(/stack trace/);
    server.use(http.get(ATT, () => HttpResponse.error()));
    expect((await call()).status).toBe(502);
  });

  it('401 without a session token, with NO upstream call', async () => {
    session.token = undefined;
    server.use(upstream());
    expect((await call()).status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it.each([['x'], ['../../v1/secrets'], [`${MSG}/../x`], [`${MSG}?a=1`], ['']])('non-UUID id %j → 400 with NO upstream call (never forwarded)', async (id) => {
    server.use(upstream());
    expect((await call(id)).status).toBe(400);
    expect(seen).toHaveLength(0);
  });
});

// ================================================================================================================ static
describe('static guards on the WEB-T05 files (REQ-SEC-068 / 098 / A13 P-2)', () => {
  const WEB = async () => (await import('node:path')).join(import.meta.dirname, '..', '..', '..', '..');
  const read = async (rel: string) => (await import('node:fs')).readFileSync((await import('node:path')).join(await WEB(), rel), 'utf8');
  const exists = async (rel: string) => (await import('node:fs')).existsSync((await import('node:path')).join(await WEB(), rel));
  const SERVER = ['listInstrumentMessages', 'searchInstrumentMessages', 'getInstrumentMessage', 'getInstrumentMessageRaw', 'reprocessInstrumentMessage', 'rematchInstrumentRecord', 'listMessageRejections'];
  const COMPONENTS_DIR = 'src/features/instruments/components';

  it('new server fns start with the "server-only" guard', async () => {
    for (const n of SERVER) {
      const p = `src/features/instruments/server/${n}.server.ts`;
      expect(await exists(p), n).toBe(true);
      expect(await read(p), n).toMatch(/^(\s*\/\/[^\n]*\n|\s*'use server';?\s*\n)*\s*import ['"]server-only['"]/);
    }
  });

  it('the new components never mention the API origin, bearer tokens, API paths, Storage hosts, persistence or raw HTML injection', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = path.join(await WEB(), COMPONENTS_DIR);
    const files = fs.readdirSync(dir).filter((f) => /^(Message|Raw|Attachment|Reprocess|Rematch)/.test(f) && f.endsWith('.tsx'));
    expect(files.length, 'expected the SCR-09/10 components (Messages*.tsx / MessageDetail*.tsx …)').toBeGreaterThan(0);
    for (const f of files) expect(fs.readFileSync(path.join(dir, f), 'utf8'), f).not.toMatch(/LIMS_ORIGIN_API|authorization|Bearer |localStorage|sessionStorage|indexedDB|document\.cookie|dangerouslySetInnerHTML|\/v1\/|createObjectURL|X-Amz|signed.?url/i);
  });

  it('raw text and barcodes are never written to storage, the console or a URL by the components (REQ-SEC-098)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = path.join(await WEB(), COMPONENTS_DIR);
    const files = fs.readdirSync(dir).filter((x) => /^(Message|Raw|Attachment|Reprocess|Rematch)/.test(x) && x.endsWith('.tsx'));
    expect(files, 'expected MessagesList.tsx and MessageDetail.tsx').toEqual(expect.arrayContaining(['MessagesList.tsx', 'MessageDetail.tsx']));
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(src, f).not.toMatch(/console\.(log|info|debug|warn|error)/);
      expect(src, f).not.toMatch(/(barcode|sample_barcode)[^;\n]{0,40}(encodeURIComponent|searchParams|URLSearchParams)|(encodeURIComponent|searchParams\.set|URLSearchParams)[^;\n]{0,60}(barcode|sample_barcode)/i);
    }
  });

  it('pages exist as server components; the list page does not read a barcode from the URL; the attachment route has no "use client"', async () => {
    const list = 'src/app/(staff)/instruments/messages/page.tsx';
    const detail = 'src/app/(staff)/instruments/messages/[instrument_message_id]/page.tsx';
    const route = 'src/app/(staff)/instruments/messages/[instrument_message_id]/attachment/route.ts';
    for (const p of [list, detail, route]) {
      expect(await exists(p), p).toBe(true);
      expect(await read(p), p).not.toMatch(/^\s*['"]use client['"]/);
    }
    expect(await read(list)).not.toMatch(/barcode/i);
    expect(await read(list)).not.toMatch(/serverFetch|fetch\(/);
    expect(await read(detail)).not.toMatch(/serverFetch|fetch\(/);
  });

  it('the attachment route never follows redirects and never forwards the upstream URL', async () => {
    const src = await read('src/app/(staff)/instruments/messages/[instrument_message_id]/attachment/route.ts');
    expect(src).toMatch(/redirect:\s*['"]error['"]/);
    expect(src).not.toMatch(/Response\.redirect|NextResponse\.redirect|headers\.get\(['"]location['"]\)|signedUrl|createSignedUrl/i);
  });
});
