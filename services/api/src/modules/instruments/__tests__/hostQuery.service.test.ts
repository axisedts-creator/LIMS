// C7 API-T10 — E05 submitHostQuery (02-TRD §6.6; 01-PRD AC-10.1–10.5, AC-10.7; 07-SECURITY REQ-SEC-072, S-01, S-02, S-08). Fakes: in-memory world (T09), LabPort, outbound CatalogPort, a `verified` host-query driver.
// Seams are documented in hostQuery.helpers.ts. Synthetic data only.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { rejection } from './agents.helpers.js';
import {
  AN, BARCODE, BARCODE_2, BARCODE_3, INS, TEST, bytes, defaultInstruments, expectedReply, hqBody, hqSetup, queryBytes, sha256hex, type HqOpts,
} from './hostQuery.helpers.js';
import { createHostQueryService } from '../service/hostQuery.service.js';

const run = (s: ReturnType<typeof hqSetup>, body: Record<string, unknown>) =>
  createHostQueryService({ repo: s.repo, getDriver: s.driver.getDriver }).submitHostQuery(s.ctx, { body });
const setup = (o: HqOpts = {}) => hqSetup(o);
const FULL = 'found:GLU,NA';                     // BARCODE: glu -> GLU, na -> NA, k unmapped -> skipped

describe('AC-10.1 / AC-10.3 — live instrument, verified driver, capability on', () => {
  it('asks LabPort under the device ctx, maps each analyte OUTBOUND, hands the driver the answers and returns its reply bytes', async () => {
    const s = setup();
    const r = await run(s, hqBody({ n: 1 }));
    expect(r.status).toBe(200);
    expect(s.lab.calls).toHaveLength(1);
    expect(s.lab.calls[0]!.input).toEqual({ instrumentId: INS(1), barcode: BARCODE });
    expect(s.lab.calls[0]!.ctx.actor).toMatchObject({ type: 'device' });                   // C5 restricts to the device's centre from this ctx
    expect(s.catalog.calls.map((c) => c.input)).toEqual([
      { instrumentId: INS(1), direction: 'outbound', analyteId: AN.glu }, { instrumentId: INS(1), direction: 'outbound', analyteId: AN.na }, { instrumentId: INS(1), direction: 'outbound', analyteId: AN.k },
    ]);
    expect(s.driver.calls.build).toHaveLength(1);
    expect(s.driver.calls.build[0]!.answers).toEqual([{ barcode: BARCODE, status: 'found', priority: 'urgent', sex: 'female', ageDays: 9000,
      tests: [{ testId: TEST.glu, analyteId: AN.glu, instrumentCode: 'GLU' }, { testId: TEST.elec, analyteId: AN.na, instrumentCode: 'NA' }] }]);
    expect((r.body as any).reply_messages).toEqual([{ raw_base64: expectedReply(FULL) }]);                    // AC-10.3: the driver's bytes, untouched
    expect((r.body as any).answer_summary).toEqual([{ index: 0, status: 'found', test_count: 2 }]);
    expect(Object.keys(r.body as object).sort()).toEqual(['answer_summary', 'instrument_message_id', 'reply_messages', 'server_time']);
  });

  it('returns several reply messages in the driver order (AC-10.3: the agent frames and sends each)', async () => {
    const s = setup({ driver: { replyMessages: 3 } });
    const r = await run(s, hqBody());
    expect((r.body as any).reply_messages).toEqual([0, 1, 2].map((i) => ({ raw_base64: expectedReply(FULL, i) })));
  });

  it('archives the query: messages (host_query, sha256 key, raw bytes), a live run, one host_query record per barcode with status + test count in detail', async () => {
    const s = setup(); const body = hqBody({ n: 2 }); const raw = queryBytes(BARCODE);
    const r = await run(s, body);
    expect(s.world.messages).toHaveLength(1);
    expect(s.world.messages[0]).toMatchObject({ instrument_id: INS(1), agent_id: s.world.deviceAgent, agent_message_id: body['agent_message_id'], message_kind: 'host_query', message_key: sha256hex(raw), message_key_kind: 'sha256' });
    expect(Buffer.from(s.world.messages[0]!['raw_bytes']).equals(raw)).toBe(true);
    expect((r.body as any).instrument_message_id).toBe(s.world.messages[0]!['id']);
    expect(s.world.runs).toHaveLength(1);
    expect(s.world.runs[0]).toMatchObject({ message_id: s.world.messages[0]!['id'], run_no: 1, kind: 'live', outcome: 'parsed', host_query_records: 1, patient_records: 0, emitted_events: 0, actor_type: 'device' });
    expect(s.world.records).toHaveLength(1);
    expect(s.world.records[0]).toMatchObject({ record_class: 'host_query', emit_status: 'not_applicable', run_id: s.world.runs[0]!['id'], detail: { status: 'found', test_count: 2 } });
    expect(s.world.events).toHaveLength(0);                                                 // a host query publishes nothing
  });

  it('answers every barcode of one query, in order, one LabPort call and one record each', async () => {
    const s = setup({ lab: { [BARCODE]: { tests: [{ testId: TEST.glu, analyteIds: [AN.glu] }] }, [BARCODE_2]: { error: 'lab.specimen_not_found' }, [BARCODE_3]: { error: 'lab.specimen_not_receivable' } } });
    const r = await run(s, hqBody({ raw: queryBytes(BARCODE, BARCODE_2, BARCODE_3) }));
    expect(s.lab.calls.map((c) => c.input['barcode'])).toEqual([BARCODE, BARCODE_2, BARCODE_3]);
    expect((r.body as any).answer_summary).toEqual([{ index: 0, status: 'found', test_count: 1 }, { index: 1, status: 'not_found', test_count: 0 }, { index: 2, status: 'not_receivable', test_count: 0 }]);
    expect(s.world.records.map((x) => x['detail'])).toEqual([{ status: 'found', test_count: 1 }, { status: 'not_found', test_count: 0 }, { status: 'not_receivable', test_count: 0 }]);
    expect(s.world.runs[0]).toMatchObject({ host_query_records: 3 });
  });
});

describe('AC-10.2 — answer statuses', () => {
  it('lab.specimen_not_found -> status not_found; the driver still builds the "no order" reply', async () => {
    const s = setup({ lab: {} });
    const r = await run(s, hqBody());
    expect(s.driver.calls.build[0]!.answers).toEqual([{ barcode: BARCODE, status: 'not_found', tests: [] }]);
    expect((r.body as any).answer_summary).toEqual([{ index: 0, status: 'not_found', test_count: 0 }]);
    expect((r.body as any).reply_messages).toEqual([{ raw_base64: expectedReply('not_found:') }]);
    expect(s.catalog.calls).toHaveLength(0);
  });
  it('lab.specimen_not_receivable -> status not_receivable', async () => {
    const s = setup({ lab: { [BARCODE]: { error: 'lab.specimen_not_receivable' } } });
    const r = await run(s, hqBody());
    expect((r.body as any).answer_summary).toEqual([{ index: 0, status: 'not_receivable', test_count: 0 }]);
    expect(s.driver.calls.build[0]!.answers[0]).toMatchObject({ barcode: BARCODE, status: 'not_receivable', tests: [] });
  });
  it('found tests but no outbound map for any analyte -> no_mapped_tests', async () => {
    const s = setup({ catalog: {} });
    const r = await run(s, hqBody());
    expect((r.body as any).answer_summary).toEqual([{ index: 0, status: 'no_mapped_tests', test_count: 0 }]);
    expect(s.driver.calls.build[0]!.answers[0]).toMatchObject({ status: 'no_mapped_tests', tests: [] });
  });
  it('some analytes unmapped -> they are skipped, the mapped ones are returned (status found)', async () => {
    const s = setup({ lab: { [BARCODE]: { tests: [{ testId: TEST.elec, analyteIds: [AN.k, AN.na] }] } } });
    const r = await run(s, hqBody());
    expect(s.driver.calls.build[0]!.answers[0]!.tests).toEqual([{ testId: TEST.elec, analyteId: AN.na, instrumentCode: 'NA' }]);
    expect((r.body as any).answer_summary).toEqual([{ index: 0, status: 'found', test_count: 1 }]);
  });
  it('any OTHER LabPort failure is not swallowed into a status: the request fails, no reply is built', async () => {
    const s = setup({ lab: { [BARCODE]: { error: 'common.internal' } } });
    const e = await rejection(run(s, hqBody()));
    expect(e).toBeDefined();
    expect(s.driver.calls.build).toHaveLength(0);
  });
  it('a barcode count above 50 -> instruments.message_malformed; no LabPort call', async () => {
    const s = setup();
    const many = Array.from({ length: 51 }, (_v, i) => `E26${String(i).padStart(8, '0')}`);
    const e = await rejection(run(s, hqBody({ raw: queryBytes(...many) })));
    expect(e?.code).toBe('instruments.message_malformed'); expect(s.lab.calls).toHaveLength(0);
  });
  it('exactly 50 barcodes are answered', async () => {
    const s = setup({ lab: {} });
    const fifty = Array.from({ length: 50 }, (_v, i) => `E26${String(i).padStart(8, '0')}`);
    const r = await run(s, hqBody({ raw: queryBytes(...fifty) }));
    expect((r.body as any).answer_summary).toHaveLength(50); expect(s.lab.calls).toHaveLength(50);
  });
  it('bytes the driver cannot parse -> instruments.message_malformed (422), no LabPort call', async () => {
    const s = setup();
    const e = await rejection(run(s, hqBody({ raw: bytes('BAD-QUERY') })));
    expect(e?.code).toBe('instruments.message_malformed'); expect(s.lab.calls).toHaveLength(0); expect(s.driver.calls.build).toHaveLength(0);
  });
  it('the driver refuses to build a reply (sketch driver) -> instruments.driver_not_available is surfaced as is', async () => {
    const s = setup({ driver: { buildThrows: Object.assign(new Error('x'), { code: 'instruments.driver_not_available' }) } });
    const e = await rejection(run(s, hqBody()));
    expect(e?.code).toBe('instruments.driver_not_available');
  });
});

describe('AC-10.4 — capability gate', () => {
  const gated: Array<[string, HqOpts]> = [
    ['instrument.cap_host_query = false', { instruments: defaultInstruments().map((i, k) => (k === 0 ? { ...i, cap_host_query: false } : i)) }],
    ['driver capabilities.hostQuery = false', { driver: { hostQuery: false } }],
    ['driver status generic (not verified)', { driver: { status: 'generic' } }],
    ['driver status sketch_blocked', { driver: { status: 'sketch_blocked' } }],
    ['instrument state commissioning', { instruments: defaultInstruments().map((i, k) => (k === 0 ? { ...i, state: 'commissioning' } : i)) }],
    ['instrument state suspended', { instruments: defaultInstruments().map((i, k) => (k === 0 ? { ...i, state: 'suspended' } : i)) }],
  ];
  it.each(gated)('%s -> 422 instruments.capability_not_supported; archived with run outcome rejected_capability; committed; nothing asked of C5', async (_n, o) => {
    const s = setup(o); const body = hqBody({ n: 3 });
    const e = await rejection(run(s, body));
    expect(e?.code).toBe('instruments.capability_not_supported');
    expect(s.commitOnError).toHaveBeenCalledTimes(1);                                       // the archive row must survive the 4xx
    expect(s.world.messages).toHaveLength(1);
    expect(s.world.messages[0]).toMatchObject({ message_kind: 'host_query', agent_message_id: body['agent_message_id'], raw_sha256: body['raw_sha256'] });
    expect(s.world.runs).toHaveLength(1);
    expect(s.world.runs[0]).toMatchObject({ outcome: 'rejected_capability', kind: 'live', run_no: 1, message_id: s.world.messages[0]!['id'] });
    expect(s.lab.calls).toHaveLength(0); expect(s.catalog.calls).toHaveLength(0); expect(s.driver.calls.build).toHaveLength(0); expect(s.world.events).toHaveLength(0);
  });
  it('the gate runs before the driver parses anything (hostile bytes are archived, never interpreted)', async () => {
    const s = setup({ driver: { hostQuery: false } });
    const e = await rejection(run(s, hqBody({ raw: bytes('BAD-QUERY') })));
    expect(e?.code).toBe('instruments.capability_not_supported');
    expect(s.driver.calls.parse).toBe(0);
  });
  it('a retry of a gated query (same agent_message_id) is a duplicate: no second archive row', async () => {
    const s = setup({ driver: { hostQuery: false } }); const body = hqBody({ n: 4 });
    await rejection(run(s, body)); const e = await rejection(run(s, body));
    expect(e?.code).toBe('instruments.capability_not_supported');
    expect(s.world.messages).toHaveLength(1); expect(s.world.duplicates).toHaveLength(1);
  });
});

describe('steps 1-3 of §6.4 (shared) — instrument visibility and binding', () => {
  it('instrument of another centre (invisible under RLS) -> instruments.instrument_unknown + message_rejections row, committed; no LabPort call', async () => {
    const s = setup(); const e = await rejection(run(s, hqBody({ instrument: INS(3) })));
    expect(e?.code).toBe('instruments.instrument_unknown');
    expect(s.commitOnError).toHaveBeenCalled(); expect(s.world.rejections).toHaveLength(1);
    expect(s.world.rejections[0]).toMatchObject({ reason_code: 'instruments.instrument_unknown', agent_id: s.world.deviceAgent });
    expect(s.world.messages).toHaveLength(0); expect(s.lab.calls).toHaveLength(0);
  });
  it('instrument of another tenant -> instruments.instrument_unknown (S-01)', async () => {
    const s = setup(); const e = await rejection(run(s, hqBody({ instrument: INS(8) })));
    expect(e?.code).toBe('instruments.instrument_unknown'); expect(s.lab.calls).toHaveLength(0);
  });
  it('unknown id -> instruments.instrument_unknown', async () => {
    const s = setup(); const e = await rejection(run(s, hqBody({ instrument: INS(99) })));
    expect(e?.code).toBe('instruments.instrument_unknown');
  });
  it('same centre but bound to another agent -> 403 instruments.device_mismatch + rejection row (S-02)', async () => {
    const s = setup(); const e = await rejection(run(s, hqBody({ instrument: INS(4) })));
    expect(e?.code).toBe('instruments.device_mismatch');
    expect(s.commitOnError).toHaveBeenCalled(); expect(s.world.rejections[0]).toMatchObject({ reason_code: 'instruments.device_mismatch' });
    expect(s.world.messages).toHaveLength(0); expect(s.lab.calls).toHaveLength(0);
  });
  it('draft instrument -> instruments.instrument_unknown', async () => {
    const s = setup(); const e = await rejection(run(s, hqBody({ instrument: INS(5) })));
    expect(e?.code).toBe('instruments.instrument_unknown');
  });
});

describe('AC-10.7 — dedupe (agent key, sha256_repeat, MSH-10)', () => {
  it('same agent_message_id again: no second messages row; a message_duplicates row (agent_message_id); the reply is rebuilt from the stored message', async () => {
    const s = setup(); const body = hqBody({ n: 10 });
    const first = await run(s, body);
    const before = s.world.callsOf('insertMessage').length;
    const again = await run(s, body);
    expect(s.world.callsOf('insertMessage')).toHaveLength(before);
    expect(s.world.messages).toHaveLength(1);
    expect(s.world.duplicates).toHaveLength(1);
    expect(s.world.duplicates[0]).toMatchObject({ reason: 'agent_message_id', original_message_id: s.world.messages[0]!['id'], agent_message_id: body['agent_message_id'], instrument_id: INS(1), agent_id: s.world.deviceAgent });
    expect((again.body as any).instrument_message_id).toBe((first.body as any).instrument_message_id);
    expect((again.body as any).reply_messages).toEqual((first.body as any).reply_messages);
    expect((again.body as any).answer_summary).toEqual((first.body as any).answer_summary);
    expect(s.lab.calls).toHaveLength(2);                                                    // C5's pick-up is idempotent: asked again to rebuild
    expect(s.world.runs).toHaveLength(1);                                                   // no second processing run for the same archived message
  });
  it('the reply is rebuilt against the STORED bytes, not the retry body', async () => {
    const s = setup({ lab: { [BARCODE]: { tests: [{ testId: TEST.glu, analyteIds: [AN.glu] }] } } }); const body = hqBody({ n: 11 });
    await run(s, body);
    const again = await run(s, { ...body, raw_base64: queryBytes(BARCODE_2).toString('base64'), raw_sha256: sha256hex(queryBytes(BARCODE_2)) });
    expect(s.lab.calls.map((c) => c.input['barcode'])).toEqual([BARCODE, BARCODE]);
    expect((again.body as any).answer_summary).toEqual([{ index: 0, status: 'found', test_count: 1 }]);
  });
  it('byte-identical ASTM query under a NEW agent_message_id: archived as a new message, key = sha256 || ":" || agent_message_id, kind sha256_repeat — no unique violation', async () => {
    const s = setup(); const raw = queryBytes(BARCODE);
    const a = hqBody({ n: 20, raw }); const b = hqBody({ n: 21, raw });
    const r1 = await run(s, a); const r2 = await run(s, b);
    expect(s.world.messages).toHaveLength(2);
    expect(s.world.messages[0]).toMatchObject({ message_key: sha256hex(raw), message_key_kind: 'sha256' });
    expect(s.world.messages[1]).toMatchObject({ message_key: `${sha256hex(raw)}:${b['agent_message_id']}`, message_key_kind: 'sha256_repeat', agent_message_id: b['agent_message_id'] });
    expect((s.world.messages[1]!['message_key'] as string).length).toBeLessThanOrEqual(220);
    expect(s.world.duplicates).toHaveLength(0);
    expect((r2.body as any).instrument_message_id).not.toBe((r1.body as any).instrument_message_id);
    expect(s.world.runs).toHaveLength(2); expect((r2.body as any).reply_messages).toEqual((r1.body as any).reply_messages);
  });
  it('a third identical re-query is again a new message (sha256_repeat), not a collision with the second', async () => {
    const s = setup(); const raw = queryBytes(BARCODE);
    for (const n of [30, 31, 32]) await run(s, hqBody({ n, raw }));
    expect(s.world.messages.map((m) => m['message_key_kind'])).toEqual(['sha256', 'sha256_repeat', 'sha256_repeat']);
    expect(new Set(s.world.messages.map((m) => m['message_key'])).size).toBe(3);
  });
  describe('HL7 (MSH-10 as message key)', () => {
    const hl7 = (o: HqOpts = {}) => setup({ ...o, driver: { protocol: 'hl7v2', controlId: 'QRY0001', ...(o.driver ?? {}) } });
    const body = (n: number, raw: Buffer) => hqBody({ n, raw, instrument: INS(2), protocol: 'hl7v2' });
    it('first query: message_key = MSH-10, kind msh10', async () => {
      const s = hl7(); await run(s, body(40, queryBytes(BARCODE)));
      expect(s.world.messages[0]).toMatchObject({ message_key: 'QRY0001', message_key_kind: 'msh10', message_control_id: 'QRY0001' });
    });
    it('same MSH-10 + same raw_sha256 under a new agent id: normal re-query -> sha256_repeat with key raw_sha256 || ":" || agent_message_id', async () => {
      const s = hl7(); const raw = queryBytes(BARCODE);
      await run(s, body(41, raw)); const b = body(42, raw); await run(s, b);
      expect(s.world.messages).toHaveLength(2);
      expect(s.world.messages[1]).toMatchObject({ message_key: `${sha256hex(raw)}:${b['agent_message_id']}`, message_key_kind: 'sha256_repeat' });
      expect(s.world.duplicates).toHaveLength(0);
    });
    it('same MSH-10 with different bytes: D-12 -> message_key = MSH-10 || ":" || left(raw_sha256,16), kind msh10_reused, warning control_id_reused', async () => {
      const s = hl7(); await run(s, body(43, queryBytes(BARCODE)));
      const raw2 = queryBytes(BARCODE_2); await run(s, body(44, raw2));
      expect(s.world.messages[1]).toMatchObject({ message_key: `QRY0001:${sha256hex(raw2).slice(0, 16)}`, message_key_kind: 'msh10_reused' });
      expect(s.world.messages[1]!['warnings']).toContain('control_id_reused');
    });
  });
  it('the Idempotency-Key is REQUIRED on E05 in the contract (08 A13 P-8); the core replays identical retries before this code runs', () => {
    const yaml = readFileSync(new URL('../../../../../../contracts/openapi/instruments.yaml', import.meta.url), 'utf8');
    const i = yaml.indexOf('operationId: submitHostQuery'); const j = yaml.indexOf('operationId:', i + 10);
    const block = yaml.slice(i, j < 0 ? undefined : j);
    expect(block).toMatch(/x-idempotency: required/); expect(block).toMatch(/IdempotencyKey/);
  });
});

describe('security — minimal disclosure, no PHI in logs, device scope (REQ-SEC-072, 02-CV §9.2, S-08)', () => {
  it('answer_summary and the response body carry no barcode', async () => {
    const s = setup(); const r = await run(s, hqBody());
    expect(JSON.stringify(r.body)).not.toContain(BARCODE);
    for (const a of (r.body as any).answer_summary) expect(Object.keys(a).sort()).toEqual(['index', 'status', 'test_count']);
  });
  it('no log line, metric or persisted warning contains the barcode (success, not_found and failure paths)', async () => {
    const ok = setup(); await run(ok, hqBody());
    const nf = setup({ lab: {} }); await run(nf, hqBody());
    const bad = setup({ lab: { [BARCODE]: { error: 'common.internal' } } }); await rejection(run(bad, hqBody()));
    const gate = setup({ driver: { hostQuery: false } }); await rejection(run(gate, hqBody()));
    for (const s of [ok, nf, bad, gate]) {
      expect(s.logText()).not.toContain(BARCODE);
      expect(JSON.stringify(s.world.records.map((r) => r['warnings']))).not.toContain(BARCODE);
      expect(JSON.stringify(s.world.runs.map((r) => [r['error_code'], r['error_reason']]))).not.toContain(BARCODE);
    }
  });
  it('catalog is only ever asked OUTBOUND (analyte -> instrument code)', async () => {
    const s = setup(); await run(s, hqBody());
    expect(s.catalog.calls.length).toBeGreaterThan(0);
    expect(s.catalog.calls.every((c) => c.input['direction'] === 'outbound')).toBe(true);
  });
  it('rows are written only for the device tenant, with explicit tenant ids on every repo call', async () => {
    const s = setup(); await run(s, hqBody());
    expect(s.world.calls.length).toBeGreaterThan(0);
    expect(s.world.calls.every((c) => c.tenantId === s.ctx.tenantId)).toBe(true);
  });
  it('hostile input never yields an unhandled crash: wrong sha256 / invalid UTF-8 / empty bytes either answer or fail with a LimsError code, never reach C5 with garbage', async () => {
    const s = setup();
    const e1 = await rejection(run(s, hqBody({ raw: Buffer.from([0xff, 0xfe, 0x00, 0x51, 0x3a]) })));
    expect(e1?.code).toMatch(/^(instruments|common)\./);
    const e2 = await rejection(run(s, { ...hqBody(), raw_base64: '' }));
    expect(e2?.code).toMatch(/^(instruments|common)\./);
    expect(s.lab.calls).toHaveLength(0);
  });
});
