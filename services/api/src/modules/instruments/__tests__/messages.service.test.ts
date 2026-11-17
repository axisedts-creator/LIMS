// C7 API-T12 — E33 listInstrumentMessages, E34 searchInstrumentMessages, E35 getInstrumentMessage (+ preview parse), E36 getInstrumentMessageRaw (+ access_log), E42 listMessageRejections.
// AC-18.1, AC-18.2, AC-18.3 (CR-C7-008); 07-SECURITY S-01/S-02 (cross-tenant/centre), S-06 (no raw outside E36), S-12 (no PHI in logs), AB10, AB13, REQ-SEC-098 (barcode never in a URL). Seams: messages.helpers.ts header.
import { describe, expect, it } from 'vitest';
import { createMessagesService } from '../service/messages.service.js';
import { responseViolations } from './agents.contract.js';
import { onlyCentre } from './agents.helpers.js';
import { spyRegistry } from './ingest.helpers.js';
import {
  AGENT_A1, ASTM_PATIENT, CENTRE_A1, CENTRE_A2, DAY, FROM, INS, NOW, PLANT, RAW_ASTM, RAW_CTRL, READ, TENANT_A, TENANT_B, TO, USER, ago, attachmentRow, bytes, detailRow, failure, forbidden, idN, latestRun,
  makeCtx, makeMessagesWorld, msgId, recordRow, rejectionRow, runRow, sha256hex, summaryRow, type Row, type Seed,
} from './messages.helpers.js';

const code = (e: any) => e?.code;
function world(seed: Seed = {}, o: Parameters<typeof makeCtx>[0] = {}, deps: { getDriver?: any } = {}) {
  const w = makeMessagesWorld(seed); const c = makeCtx(o);
  const svc: any = createMessagesService({ repo: w.repo, ...deps });
  return { ...w, ...c, svc };
}
const list = (w: any, q: Row = {}) => w.svc.listInstrumentMessages(w.ctx, { receivedAtFrom: FROM, receivedAtTo: TO, ...q });
const search = (w: any, body: unknown) => w.svc.searchInstrumentMessages(w.ctx, { body });
const detail = (w: any, id: unknown, q: Row = {}) => w.svc.getInstrumentMessage(w.ctx, { instrumentMessageId: id, ...q });
const rawOf = (w: any, id: unknown) => w.svc.getInstrumentMessageRaw(w.ctx, { instrumentMessageId: id });
const rejections = (w: any, q: Row = {}) => w.svc.listMessageRejections(w.ctx, { receivedAtFrom: FROM, receivedAtTo: TO, ...q });
const rawViews = (w: any) => w.accessRows().filter((r: Row) => r.action === 'instrument_message.raw_view');
const M1 = msgId(1);
const detailSeed = (o: Seed = {}): Seed => ({
  messages: [detailRow(1)], runs: [runRow(M1, 1)], records: [recordRow(M1, 1), recordRow(M1, 2)], ...o,
});

describe('E33 listInstrumentMessages (AC-18.1)', () => {
  it('lists schema-valid MessageSummary rows, 200, page.limit 50; asserts instruments.message.read at tenant level', async () => {
    const w = world({ messages: [summaryRow(1), summaryRow(2, { message_kind: 'host_query', latest_run: latestRun({ qc_records: 1 }) })] });
    const r = await list(w);
    expect(r.status).toBe(200); expect(r.body.data.map((x: Row) => x.id)).toEqual([msgId(1), msgId(2)]); expect(r.body.page).toMatchObject({ limit: 50 });
    expect(responseViolations('listInstrumentMessages', '200', r.body)).toEqual([]);
    expect(w.asserted).toEqual([{ permission: READ }]);
  });
  it('NO barcode and no internal column in any list item (REQ-SEC-098; TRD MessageSummary): planted sample_barcode / message_key / agent_message_id / link_meta / tenant_id never serialised', async () => {
    const w = world({ messages: [summaryRow(1)] });
    const s = JSON.stringify((await list(w)).body);
    for (const leak of [PLANT.barcode, 'sample_barcode', 'LEAK-message-key', 'message_key', 'agent_message_id', 'link_meta', 'tenant_id', 'created_by', 'raw_bytes']) expect(s, leak).not.toContain(leak);
  });
  it('null captured_at is omitted (no nulls on the wire)', async () => {
    const w = world({ messages: [summaryRow(1, { captured_at: null })] });
    const item = (await list(w)).body.data[0];
    expect('captured_at' in item).toBe(false); expect(responseViolations('listInstrumentMessages', '200', { data: [item], page: { limit: 50 } })).toEqual([]);
  });
  it('every filter (instrument, agent, centre, kind csv, outcome csv, has_unmapped, has_qc, cursor, limit) reaches the repo unchanged; has_qc=false is kept; range is from/to', async () => {
    const w = world({ messages: [summaryRow(1)] });
    await list(w, { instrumentId: INS(1), agentId: AGENT_A1, centreId: CENTRE_A1, messageKind: ['data', 'attachment'], latestOutcome: ['parsed', 'quarantined'], hasUnmapped: true, hasQc: false, sort: '-received_at', cursor: 'C1', limit: 25 });
    expect(w.callsOf('listMessages')[0]!.tenantId).toBe(TENANT_A);
    expect(w.callsOf('listMessages')[0]!.args[0]).toEqual({ receivedAtFrom: FROM, receivedAtTo: TO, instrumentId: INS(1), agentId: AGENT_A1, centreId: CENTRE_A1, messageKind: ['data', 'attachment'], latestOutcome: ['parsed', 'quarantined'], hasUnmapped: true, hasQc: false, cursor: 'C1', limit: 25 });
    expect(w.asserted).toEqual([{ permission: READ, centreId: CENTRE_A1 }]);
  });
  it('repo next cursor is surfaced as page.next_cursor', async () => {
    const w = world({ messages: [summaryRow(1)], nextCursor: 'opaque' });
    const r = await list(w, { limit: 1 });
    expect(r.body.page).toEqual({ limit: 1, next_cursor: 'opaque' }); expect(responseViolations('listInstrumentMessages', '200', r.body)).toEqual([]);
  });
  it('rows of another tenant that a misbehaving repo returns are dropped (BOLA defence in depth, S-01)', async () => {
    const w = world({ messages: [summaryRow(1), summaryRow(2, { tenant_id: TENANT_B, id: msgId(99) })] });
    // fake repo already filters by tenant; force the leak by returning everything
    w.repo.listMessages = async () => ({ rows: [summaryRow(1), summaryRow(2, { tenant_id: TENANT_B, id: msgId(99) })] });
    expect((await list(w)).body.data.map((x: Row) => x.id)).toEqual([msgId(1)]);
  });
  it('a caller without instruments.message.read (or not at the filtered centre) gets auth.forbidden and the repo is never queried', async () => {
    const a = world({ messages: [summaryRow(1)] }, { roles: () => { throw forbidden(); } });
    expect(code(await failure(list(a)))).toBe('auth.forbidden'); expect(a.calls).toEqual([]);
    const b = world({ messages: [summaryRow(1)] }, { roles: onlyCentre(CENTRE_A1) });
    expect(code(await failure(list(b, { centreId: CENTRE_A2 })))).toBe('auth.forbidden'); expect(b.calls).toEqual([]);
  });
  it.each([
    ['missing received_at_from', { receivedAtFrom: undefined }], ['missing received_at_to', { receivedAtTo: undefined }], ['not an ISO instant', { receivedAtFrom: '2026-11-07' }],
    ['from after to', { receivedAtFrom: TO, receivedAtTo: FROM }], ['span 31 days + 1 ms', { receivedAtFrom: FROM, receivedAtTo: new Date(Date.parse(FROM) + 31 * DAY + 1).toISOString() }],
    ['span 400 days', { receivedAtFrom: '2025-01-01T00:00:00.000Z', receivedAtTo: '2026-02-05T00:00:00.000Z' }],
    ['centre_id not a uuid', { centreId: 'nope' }], ['instrument_id not a uuid', { instrumentId: "1' OR '1'='1" }], ['agent_id not a uuid', { agentId: 7 }],
    ['unknown message_kind', { messageKind: ['data', 'bogus'] }], ['unknown latest_outcome', { latestOutcome: ['parsed', 'x'] }], ['has_qc not boolean', { hasQc: 'yes' }], ['has_unmapped not boolean', { hasUnmapped: 1 }],
    ['unknown sort', { sort: 'received_at' }], ['limit 0', { limit: 0 }], ['limit 201', { limit: 201 }], ['limit 1.5', { limit: 1.5 }],
  ])('400 common.validation_failed: %s — repo untouched', async (_n, over) => {
    const w = world({ messages: [summaryRow(1)] });
    expect(code(await failure(list(w, over)))).toBe('common.validation_failed'); expect(w.callsOf('listMessages')).toEqual([]);
  });
  it('a span of exactly 31 days is accepted', async () => {
    const w = world({ messages: [] });
    expect((await list(w, { receivedAtTo: new Date(Date.parse(FROM) + 31 * DAY).toISOString() })).status).toBe(200);
  });
  it.each([[''], [7], ['x'.repeat(513)]])('bad cursor %j -> common.invalid_cursor', async (cursor) => {
    expect(code(await failure(list(world({ messages: [] }), { cursor })))).toBe('common.invalid_cursor');
  });
  it('empty window -> 200 { data: [], page }', async () => {
    const r = await list(world({ messages: [] }));
    expect(r.status).toBe(200); expect(r.body.data).toEqual([]); expect(responseViolations('listInstrumentMessages', '200', r.body)).toEqual([]);
  });
});

describe('E34 searchInstrumentMessages — barcode in the POST body only (AC-18.1, REQ-SEC-098, AB10)', () => {
  it('finds by barcode: ≤ 50 rows asked from the repo, schema-valid MessageSummary, 200; the result carries NO barcode', async () => {
    const w = world({ search: [summaryRow(1), summaryRow(2)] });
    const r = await search(w, { sample_barcode: PLANT.barcode, received_at_from: FROM, received_at_to: TO, instrument_id: INS(1) });
    expect(r.status).toBe(200); expect(r.body.data.map((x: Row) => x.id)).toEqual([msgId(1), msgId(2)]); expect(responseViolations('searchInstrumentMessages', '200', r.body)).toEqual([]);
    expect(w.callsOf('searchMessages')[0]).toMatchObject({ tenantId: TENANT_A }); expect(w.callsOf('searchMessages')[0]!.args[0]).toEqual({ sampleBarcode: PLANT.barcode, receivedAtFrom: FROM, receivedAtTo: TO, instrumentId: INS(1), limit: 50 });
    const s = JSON.stringify(r.body); expect(s).not.toContain(PLANT.barcode); expect(s).not.toContain('sample_barcode');
    expect(w.asserted).toEqual([{ permission: READ }]);
  });
  it('range and instrument are optional; response never has more than 50 rows even if the repo over-delivers; other tenants dropped', async () => {
    const many = Array.from({ length: 60 }, (_v, i) => summaryRow(100 + i));
    const w = world({ search: many });
    const r = await search(w, { sample_barcode: 'ABC123' });
    expect(r.body.data).toHaveLength(50); expect(w.callsOf('searchMessages')[0]!.args[0]).toEqual({ sampleBarcode: 'ABC123', limit: 50 });
    const x = world({ search: [] }); x.repo.searchMessages = async () => [summaryRow(1), summaryRow(2, { tenant_id: TENANT_B })];
    expect((await search(x, { sample_barcode: 'ABC123' })).body.data.map((m: Row) => m.id)).toEqual([msgId(1)]);
  });
  it('no match -> 200 { data: [] } (not 404)', async () => {
    const r = await search(world({ search: [] }), { sample_barcode: 'NOSUCH1' });
    expect(r.status).toBe(200); expect(r.body).toEqual({ data: [] });
  });
  it.each([
    ['lower case', 'e2600000042'], ['empty', ''], ['41 chars', 'B'.repeat(41)], ['space', 'AB 12'], ['wildcard %', 'AB%'], ['wildcard _', 'A_B'], ['sql quote', "A'; DROP TABLE x;--"], ['dash', 'AB-12'],
    ['unicode digits', 'AB١٢'], ['newline', 'AB\n12'], ['path', '../etc'], ['number', 42], ['null', null], ['array', ['AB']], ['object', { $ne: '' }],
  ])('barcode %s is rejected with common.validation_failed, the repo is untouched and the offending value is NOT echoed in the error or the logs', async (_n, bad) => {
    const w = world({ search: [summaryRow(1)] });
    const e = await failure(search(w, { sample_barcode: bad }));
    expect(code(e)).toBe('common.validation_failed'); expect(w.callsOf('searchMessages')).toEqual([]);
    if (typeof bad === 'string' && bad.length > 3) { expect(JSON.stringify({ m: e.message, f: e.fields ?? e.details ?? null })).not.toContain(bad); expect(w.logText()).not.toContain(bad); }
  });
  it.each([
    ['no body', undefined], ['empty body', {}], ['array body', ['A']], ['unknown extra key', { sample_barcode: 'AB1', q: 'x' }], ['barcode as query-ish key', { barcode: 'AB1' }],
    ['bad instrument_id', { sample_barcode: 'AB1', instrument_id: 'x' }], ['bad from', { sample_barcode: 'AB1', received_at_from: 'yesterday' }],
    ['from after to', { sample_barcode: 'AB1', received_at_from: TO, received_at_to: FROM }], ['span > 31 days', { sample_barcode: 'AB1', received_at_from: '2026-09-01T00:00:00.000Z', received_at_to: '2026-11-08T00:00:00.000Z' }],
  ])('body %s -> common.validation_failed', async (_n, body) => {
    const w = world({ search: [summaryRow(1)] });
    expect(code(await failure(search(w, body)))).toBe('common.validation_failed'); expect(w.callsOf('searchMessages')).toEqual([]);
  });
  it('without instruments.message.read -> auth.forbidden, repo untouched', async () => {
    const w = world({ search: [summaryRow(1)] }, { roles: () => { throw forbidden(); } });
    expect(code(await failure(search(w, { sample_barcode: 'AB1' })))).toBe('auth.forbidden'); expect(w.calls).toEqual([]);
  });
  it('the barcode is never logged, even on success (S-12; planted E2600000042)', async () => {
    const w = world({ search: [summaryRow(1)] });
    await search(w, { sample_barcode: PLANT.barcode });
    expect(w.logText()).not.toContain(PLANT.barcode);
  });
});

describe('E35 getInstrumentMessage (AC-18.2)', () => {
  it('detail = summary + runs + records of the LATEST run (barcode, code, value, unit, flags, mapping status, event id); schema-valid; asserts read at the message\'s centre AFTER loading it', async () => {
    const w = world(detailSeed({ runs: [runRow(M1, 1), runRow(M1, 2, { kind: 'reprocess', actor_type: 'user', actor_display: 'Synthetic User', id: idN(0xe202) })], messages: [detailRow(1, { latest_run: latestRun({ run_no: 2, kind: 'reprocess' }) })],
      records: [recordRow(M1, 1, { run_no: 2 }), recordRow(M1, 2, { run_no: 2 }), recordRow(M1, 1, { run_no: 1, instrument_analyte_code: 'OLD' })] }));
    const r = await detail(w, M1);
    expect(r.status).toBe(200); expect(responseViolations('getInstrumentMessage', '200', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: M1, instrument_code: 'SIM-CHEM-1', centre_id: CENTRE_A1, message_key_kind: 'sha256', records_expired: false, latest_run: { run_no: 2 } });
    expect(r.body.runs.map((x: Row) => x.run_no)).toEqual([1, 2]); expect(r.body.runs[1]).toMatchObject({ actor_type: 'user', actor_display: 'Synthetic User' });
    expect(r.body.records.map((x: Row) => x.instrument_analyte_code)).toEqual(['GLU', 'NA']);          // latest run only: run 1's 'OLD' is not shown
    expect(w.callsOf('listRecords')[0]!.args).toEqual([M1, 2]);
    expect(r.body.records[0]).toMatchObject({ sample_barcode: PLANT.barcode, instrument_analyte_code: 'GLU', value_raw: '5.4', unit_raw: 'mmol/L', instrument_flags: ['N'], mapping_status: 'mapped', emit_status: 'emitted', event_id: idN(0xe301) });
    expect(w.calls.map((c) => c.op)[0]).toBe('findMessage'); expect(w.asserted).toEqual([{ permission: READ, centreId: CENTRE_A1 }]);
  });
  it('nulls are omitted; internal columns never leak (tenant_id, run actor_id, value_numeric, created_by, message_key, raw_bytes)', async () => {
    const w = world(detailSeed());
    const r = await detail(w, M1); const s = JSON.stringify(r.body);
    expect('analyte_id' in r.body.records[0]).toBe(true); expect('control_id_raw' in r.body.records[0]).toBe(false); expect('message_control_id' in r.body).toBe(false); expect('error_code' in r.body.runs[0]).toBe(false);
    for (const leak of ['tenant_id', 'actor_id', 'value_numeric', 'created_by', 'LEAK-message-key', 'raw_bytes', 'link_meta', 'driver_code":"astm_generic_e1394","timezone', 'parser_options', 'timezone', 'run_id', 'message_id']) expect(s, leak).not.toContain(leak);
  });
  it('a record whose port outcome is unmatched/held carries port_outcome + port_reason_code (the UI links to the C5 exception list, AC-18.2)', async () => {
    const w = world(detailSeed({ records: [recordRow(M1, 1, { port_outcome: 'unmatched', port_reason_code: 'lab.no_matching_sample' }), recordRow(M1, 2, { port_outcome: 'held', port_reason_code: 'lab.sample_not_receivable' })] }));
    const r = await detail(w, M1);
    expect(r.body.records.map((x: Row) => x.port_outcome)).toEqual(['unmatched', 'held']); expect(responseViolations('getInstrumentMessage', '200', r.body)).toEqual([]);
  });
  it('attachment summary has id/scan_state/mime/size/name only — never bucket, object_path, sha256 or a URL (A13 P-2)', async () => {
    const w = world(detailSeed({ messages: [detailRow(1, { message_kind: 'attachment', protocol: 'file_drop' })], attachments: [attachmentRow(M1)] }));
    const r = await detail(w, M1);
    expect(r.body.attachment).toEqual({ attachment_id: idN(0xe001), scan_state: 'clean', mime_type: 'application/pdf', size_bytes: 321, original_file_name: 'slide-0042.pdf' });
    const a = JSON.stringify(r.body.attachment); for (const leak of ['bucket', 'object_path', 'instruments-attachments', 'sha256', 'http', 'token=']) expect(a, leak).not.toContain(leak);
    const s = JSON.stringify(r.body); for (const leak of ['"bucket"', '"object_path"', '"file_sha256"', '"raw_sha256"', 'instruments-attachments', 'http', 'token=']) expect(s, leak).not.toContain(leak);
    expect(responseViolations('getInstrumentMessage', '200', r.body)).toEqual([]);
  });
  it('a message without attachment has no `attachment` key', async () => { expect('attachment' in (await detail(world(detailSeed()), M1)).body).toBe(false); });
  it('unknown id, malformed id, and another tenant\'s id -> 404 common.not_found; no role check and no raw read for a row that is not visible (S-01)', async () => {
    const w = world(detailSeed({ messages: [detailRow(1), detailRow(2, { tenant_id: TENANT_B })] }));
    for (const id of [msgId(404), 'not-a-uuid', msgId(2), undefined, 7, "x' OR 1=1"]) expect(code(await failure(detail(w, id))), String(id)).toBe('common.not_found');
    expect(w.asserted).toEqual([]); expect(w.callsOf('getMessageRawBytes')).toEqual([]);
  });
  it('a misbehaving repo returning another tenant\'s row is still a 404', async () => {
    const w = world(detailSeed()); w.repo.findMessage = async () => detailRow(1, { tenant_id: TENANT_B });
    expect(code(await failure(detail(w, M1)))).toBe('common.not_found');
  });
  it('centre probe (S-02): a centre-A1 user reading a centre-A2 message is refused (auth.forbidden from assertRole at the message\'s centre) and nothing but metadata was loaded', async () => {
    const w = world(detailSeed({ messages: [detailRow(1, { centre_id: CENTRE_A2 })] }), { roles: onlyCentre(CENTRE_A1) });
    expect(code(await failure(detail(w, M1)))).toBe('auth.forbidden'); expect(w.asserted).toEqual([{ permission: READ, centreId: CENTRE_A2 }]);
    expect(w.callsOf('listRuns')).toEqual([]); expect(w.callsOf('listRecords')).toEqual([]);
  });
  it('preview_parse must be a boolean when given', async () => {
    expect(code(await failure(detail(world(detailSeed()), M1, { previewParse: 'yes' })))).toBe('common.validation_failed');
  });
  it('the barcode of a viewed detail is never logged (S-12)', async () => {
    const w = world(detailSeed()); await detail(w, M1); expect(w.logText()).not.toContain(PLANT.barcode);
  });
});

describe('E35 records_expired + preview parse (D-11: parse raw now, in memory, no writes)', () => {
  const old = (o: Row = {}) => detailRow(1, { received_at: ago(100), ...o });
  const oldSeed = (o: Seed = {}): Seed => ({ messages: [old()], runs: [runRow(M1, 1)], records: [], raw: { [M1]: RAW_ASTM }, ...o });
  it('message older than 90 days: records_expired=true, records [] and the raw is NOT read or parsed unless preview_parse', async () => {
    const spy = await spyRegistry(); const w = world(oldSeed(), {}, { getDriver: spy.getDriver });
    const r = await detail(w, M1);
    expect(r.body).toMatchObject({ records_expired: true, records: [] }); expect(responseViolations('getInstrumentMessage', '200', r.body)).toEqual([]);
    expect(w.callsOf('getMessageRawBytes')).toEqual([]); expect(spy.parses()).toBe(0);
    expect(code(await failure(detail(world(oldSeed()), M1, { previewParse: 'true' })))).toBe('common.validation_failed');
  });
  it('younger than 90 days: records_expired=false', async () => {
    const w = world(detailSeed({ messages: [detailRow(1, { received_at: ago(89) })] }));
    expect((await detail(w, M1)).body.records_expired).toBe(false);
  });
  it('preview_parse=true on an expired message parses the stored raw with the driver NOW: records appear (barcode, codes, values), stay expired, nothing is written, no event id', async () => {
    const spy = await spyRegistry(); const w = world(oldSeed(), {}, { getDriver: spy.getDriver });
    const r = await detail(w, M1, { previewParse: true });
    expect(spy.parses()).toBe(1); expect(w.callsOf('getMessageRawBytes')).toHaveLength(1);
    expect(r.body.records_expired).toBe(true); expect(responseViolations('getInstrumentMessage', '200', r.body)).toEqual([]);
    expect(r.body.records.map((x: Row) => [x.sample_barcode, x.instrument_analyte_code, x.value_raw])).toEqual([[PLANT.barcode, 'GLU', '5.4'], [PLANT.barcode, 'NA', '141']]);
    for (const rec of r.body.records) { expect(rec.run_no).toBe(1); expect('event_id' in rec).toBe(false); expect(rec.emit_status).not.toBe('emitted'); }
    expect(w.writes()).toEqual([]); expect(w.accessRows().filter((a: Row) => /^instrument_message\.(reprocess|rematch)$/.test(a.action))).toEqual([]);
    expect(w.logText()).not.toContain(PLANT.barcode);
  });
  it('preview_parse=true on a message that still has stored records returns the STORED records and does not touch the raw', async () => {
    const spy = await spyRegistry(); const w = world(detailSeed(), {}, { getDriver: spy.getDriver });
    const r = await detail(w, M1, { previewParse: true });
    expect(r.body.records.map((x: Row) => x.id)).toEqual([idN(0xe101), idN(0xe102)]); expect(spy.parses()).toBe(0); expect(w.callsOf('getMessageRawBytes')).toEqual([]);
  });
  it('preview of unparseable raw or a throwing driver is a 200 with no records — never a 5xx (hostile bytes, S-08 spirit)', async () => {
    const junk = world(oldSeed({ raw: { [M1]: Buffer.from([0xff, 0x00, 0x02, 0x41]) } })); const a = await detail(junk, M1, { previewParse: true });
    expect(a.status).toBe(200); expect(a.body.records).toEqual([]);
    const boom = world(oldSeed(), {}, { getDriver: () => ({ code: 'astm_generic_e1394', version: '1', parse: () => { throw new Error('driver bug'); } }) }); const b = await detail(boom, M1, { previewParse: true });
    expect(b.status).toBe(200); expect(b.body.records).toEqual([]);
  });
  it('preview respects the centre check BEFORE the raw is loaded', async () => {
    const w = world(oldSeed({ messages: [old({ centre_id: CENTRE_A2 })] }), { roles: onlyCentre(CENTRE_A1) });
    expect(code(await failure(detail(w, M1, { previewParse: true })))).toBe('auth.forbidden'); expect(w.callsOf('getMessageRawBytes')).toEqual([]);
  });
});

describe('E36 getInstrumentMessageRaw — raw on demand + access_log in the same transaction (AC-18.3, CR-C7-008, AB13)', () => {
  it('returns the exact bytes (binary-safe base64), sha256 and size; schema-valid', async () => {
    const w = world(detailSeed({ raw: { [M1]: RAW_CTRL } }));
    const r = await rawOf(w, M1);
    expect(r.status).toBe(200); expect(responseViolations('getInstrumentMessageRaw', '200', r.body)).toEqual([]);
    expect(Buffer.from(r.body.raw_base64, 'base64').equals(RAW_CTRL)).toBe(true); expect(r.body.raw_sha256).toBe(sha256hex(RAW_CTRL)); expect(r.body.size_bytes).toBe(RAW_CTRL.length);
    expect(Object.keys(r.body).sort()).toEqual(['raw_base64', 'raw_sha256', 'raw_text_escaped', 'size_bytes']);
  });
  it('raw_text_escaped: no raw control character survives (STX/CR/NUL/ETX/LF become visible text), printable content is kept', async () => {
    const t = (await rawOf(world(detailSeed({ raw: { [M1]: RAW_CTRL } })), M1)).body.raw_text_escaped as string;
    expect(t).not.toMatch(/[\u0000-\u001f\u007f]/); expect(t).toContain(PLANT.barcode); expect(t.length).toBeGreaterThan(RAW_CTRL.length - 3);
  });
  it('writes EXACTLY ONE access_log row in the same tx: instrument_message.raw_view / instrument_message / message id / message centre / allowed / actor; detail carries no raw, no hash, no barcode', async () => {
    const w = world(detailSeed({ raw: { [M1]: RAW_CTRL } }));
    await rawOf(w, M1);
    expect(w.accessRows()).toHaveLength(1);
    expect(w.accessRows()[0]).toMatchObject({ tenantId: TENANT_A, centreId: CENTRE_A1, actorId: USER, action: 'instrument_message.raw_view', entityType: 'instrument_message', entityId: M1, outcome: 'allowed' });
    const d = JSON.stringify(w.accessRows()[0]!.detail ?? {}); for (const leak of [PLANT.barcode, RAW_CTRL.toString('base64').slice(0, 20), sha256hex(RAW_CTRL)]) expect(d).not.toContain(leak);
  });
  it('every view is logged (no dedupe): 3 views -> 3 rows (AB13 insider copy detection counts them)', async () => {
    const w = world(detailSeed()); for (let i = 0; i < 3; i++) await rawOf(w, M1);
    expect(rawViews(w)).toHaveLength(3);
  });
  it('fails closed: if the access_log write fails the raw is NOT returned', async () => {
    const w = world(detailSeed(), { failAudit: true });
    const e = await failure(rawOf(w, M1)); expect(code(e)).toBe('common.internal'); expect(JSON.stringify(e)).not.toContain(RAW_ASTM.toString('base64').slice(0, 24));
  });
  it('the access row is written through ctx.tx (so it rolls back with the action): the SAME tx object received the insert', async () => {
    const w = world(detailSeed()); await rawOf(w, M1);
    expect(w.inserts.filter((i) => /audit\.access_log/.test(i.text))).toHaveLength(1);
  });
  it('denied role: no raw bytes are loaded, no raw_view row is written, auth.forbidden', async () => {
    const w = world(detailSeed({ messages: [detailRow(1, { centre_id: CENTRE_A2 })] }), { roles: onlyCentre(CENTRE_A1) });
    expect(code(await failure(rawOf(w, M1)))).toBe('auth.forbidden'); expect(w.callsOf('getMessageRawBytes')).toEqual([]); expect(rawViews(w)).toEqual([]);
    const n = world(detailSeed(), { roles: () => { throw forbidden(); } });
    expect(code(await failure(rawOf(n, M1)))).toBe('auth.forbidden'); expect(n.accessRows().filter((a: Row) => a.outcome === 'allowed')).toEqual([]);
  });
  it('404 for unknown / malformed / other-tenant ids — no access row, no raw read (S-01)', async () => {
    const w = world(detailSeed({ messages: [detailRow(1), detailRow(2, { tenant_id: TENANT_B })] }));
    for (const id of [msgId(404), 'x', msgId(2), undefined]) expect(code(await failure(rawOf(w, id)))).toBe('common.not_found');
    expect(w.accessRows()).toEqual([]); expect(w.callsOf('getMessageRawBytes')).toEqual([]);
  });
  it('a misbehaving repo that hands back another tenant\'s raw row is a 404 and is not logged as a view', async () => {
    const w = world(detailSeed()); w.repo.getMessageRawBytes = async () => ({ id: M1, tenant_id: TENANT_B, centre_id: CENTRE_A1, raw_bytes: RAW_ASTM, raw_sha256: sha256hex(RAW_ASTM), size_bytes: RAW_ASTM.length });
    expect(code(await failure(rawOf(w, M1)))).toBe('common.not_found'); expect(rawViews(w)).toEqual([]);
  });
  it('raw bytes never reach the log (S-12), neither base64 nor text', async () => {
    const w = world(detailSeed()); await rawOf(w, M1);
    expect(w.logText()).not.toContain(PLANT.barcode); expect(w.logText()).not.toContain(RAW_ASTM.toString('base64').slice(0, 24));
  });
  it('raw is exposed ONLY by E36: no other read operation returns raw_base64 / raw_text_escaped / raw_bytes (S-06)', async () => {
    const w = world({ ...detailSeed(), rejections: [rejectionRow(1)], search: [summaryRow(1)] });
    const outs = [await list(w), await search(w, { sample_barcode: 'AB1' }), await detail(w, M1), await rejections(w)].map((r) => JSON.stringify(r.body)).join('\n');
    for (const leak of ['raw_base64', 'raw_text_escaped', 'raw_bytes', RAW_ASTM.toString('base64').slice(0, 24)]) expect(outs, leak).not.toContain(leak);
  });
});

describe('E42 listMessageRejections', () => {
  it('lists MessageRejection rows, 200, schema-valid; NEVER raw_bytes (and no tenant_id/centre_id leak)', async () => {
    const w = world({ rejections: [rejectionRow(1), rejectionRow(2, { reason_code: 'instruments.message_too_large', size_bytes: 1048577 })] });
    const r = await rejections(w);
    expect(r.status).toBe(200); expect(r.body.data).toHaveLength(2); expect(r.body.page).toMatchObject({ limit: 50 }); expect(responseViolations('listMessageRejections', '200', r.body)).toEqual([]);
    expect(r.body.data[0]).toEqual({ id: idN(0xd101), received_at: '2026-11-07T05:00:00.000Z', agent_id: AGENT_A1, claimed_instrument_id: INS(77), agent_message_id: idN(0x9101), reason_code: 'instruments.instrument_unknown', size_bytes: 412, raw_sha256: sha256hex('rej-1') });
    const s = JSON.stringify(r.body); for (const leak of ['raw_bytes', 'tenant_id', 'centre_id', RAW_ASTM.toString('base64').slice(0, 20), PLANT.barcode]) expect(s, leak).not.toContain(leak);
    expect(w.asserted).toEqual([{ permission: READ }]);
  });
  it('filters (agent_id, reason, cursor, limit) reach the repo; next cursor surfaced; other tenants dropped', async () => {
    const w = world({ rejections: [rejectionRow(1)], nextCursor: 'nxt' });
    const r = await rejections(w, { agentId: AGENT_A1, reason: 'instruments.device_mismatch', cursor: 'C', limit: 10 });
    expect(w.callsOf('listRejections')[0]!.tenantId).toBe(TENANT_A); expect(w.callsOf('listRejections')[0]!.args[0]).toEqual({ receivedAtFrom: FROM, receivedAtTo: TO, agentId: AGENT_A1, reason: 'instruments.device_mismatch', cursor: 'C', limit: 10 });
    expect(r.body.page).toEqual({ limit: 10, next_cursor: 'nxt' });
    const x = world({}); x.repo.listRejections = async () => ({ rows: [rejectionRow(1), rejectionRow(2, { tenant_id: TENANT_B })] });
    expect((await rejections(x)).body.data).toHaveLength(1);
  });
  it.each([
    ['missing from', { receivedAtFrom: undefined }], ['missing to', { receivedAtTo: undefined }], ['from after to', { receivedAtFrom: TO, receivedAtTo: FROM }], ['span 32 days', { receivedAtTo: new Date(Date.parse(FROM) + 32 * DAY).toISOString() }],
    ['unknown reason', { reason: 'instruments.other' }], ['agent not a uuid', { agentId: 'x' }], ['limit 201', { limit: 201 }],
  ])('400 common.validation_failed: %s', async (_n, over) => {
    const w = world({ rejections: [rejectionRow(1)] });
    expect(code(await failure(rejections(w, over)))).toBe('common.validation_failed'); expect(w.callsOf('listRejections')).toEqual([]);
  });
  it('bad cursor -> common.invalid_cursor; no read permission -> auth.forbidden with the repo untouched', async () => {
    expect(code(await failure(rejections(world({}), { cursor: '' })))).toBe('common.invalid_cursor');
    const w = world({ rejections: [rejectionRow(1)] }, { roles: () => { throw forbidden(); } });
    expect(code(await failure(rejections(w)))).toBe('auth.forbidden'); expect(w.calls).toEqual([]);
  });
});

describe('fail closed without an authenticated context / authorisation port', () => {
  it.each([['listInstrumentMessages', { receivedAtFrom: FROM, receivedAtTo: TO }], ['searchInstrumentMessages', { body: { sample_barcode: 'AB1' } }], ['getInstrumentMessage', { instrumentMessageId: M1 }],
    ['getInstrumentMessageRaw', { instrumentMessageId: M1 }], ['listMessageRejections', { receivedAtFrom: FROM, receivedAtTo: TO }]])('%s: no tenant/actor -> auth.unauthenticated; no IdentityPort -> common.internal; repo untouched, nothing logged to access_log', async (op, input) => {
    const w = world(detailSeed());
    expect(code(await failure(w.svc[op]({ ...w.ctx, tenantId: undefined }, input)))).toBe('auth.unauthenticated');
    expect(code(await failure(w.svc[op]({ ...w.ctx, actor: undefined }, input)))).toBe('auth.unauthenticated');
    expect(code(await failure(w.svc[op]({ ...w.ctx, ports: {} }, input)))).toBe('common.internal');
    expect(w.calls).toEqual([]); expect(w.accessRows()).toEqual([]);
  });
});
