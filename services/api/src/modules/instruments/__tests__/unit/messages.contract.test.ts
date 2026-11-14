// C7 API-T12 — contract probes / spec lint for E33-E36, E42 against contracts/openapi/instruments.yaml (02-TRD §7.3, 07-SECURITY AB10, REQ-SEC-098, S-06). Spec-level: they pass today and guard the contract.
import { describe, expect, it } from 'vitest';
import { operation, propertyNames, responseViolations, spec } from '../agents.contract.js';
import { rejectionRow, summaryRow } from '../messages.helpers.js';

const HTTP = ['get', 'put', 'post', 'delete', 'patch'];
const OPS: Array<[string, string, string]> = [
  ['listInstrumentMessages', 'get', '/v1/instruments/messages'], ['searchInstrumentMessages', 'post', '/v1/instruments/messages/search'],
  ['getInstrumentMessage', 'get', '/v1/instruments/messages/{instrument_message_id}'], ['getInstrumentMessageRaw', 'get', '/v1/instruments/messages/{instrument_message_id}/raw'],
  ['listMessageRejections', 'get', '/v1/instruments/rejections'],
];

describe('route table (TRD §7.3)', () => {
  it.each(OPS)('%s: %s %s, instruments.message.read, bearerJwt, no idempotency, general tier', (id, method, path) => {
    const o = operation(id); expect([o.method, o.path]).toEqual([method, path]);
    expect(o.op['x-permission']).toBe('instruments.message.read'); expect(o.op.security).toEqual([{ bearerJwt: [] }]); expect(o.op['x-idempotency']).toBe('none'); expect(o.op['x-rate-limit-tier']).toBe('general');
  });
  it('E33/E42 require received_at_from + received_at_to; E33 filters match the TRD', () => {
    for (const id of ['listInstrumentMessages', 'listMessageRejections']) {
      const req = operation(id).op.parameters.filter((p: any) => p.required).map((p: any) => p.name); expect(req).toEqual(expect.arrayContaining(['received_at_from', 'received_at_to']));
    }
    const names = operation('listInstrumentMessages').op.parameters.map((p: any) => p.name ?? String(p.$ref).split('/').pop().toLowerCase());   // cursor/limit are $ref'd common parameters
    expect(names).toEqual(expect.arrayContaining(['instrument_id', 'agent_id', 'centre_id', 'message_kind', 'latest_outcome', 'has_unmapped', 'has_qc', 'sort', 'cursor', 'limit']));
  });
  it('E36 declares exactly { raw_base64, raw_text_escaped, raw_sha256, size_bytes }', () => {
    const s = operation('getInstrumentMessageRaw').op.responses['200'].content['application/json'].schema; expect(Object.keys(s.properties).sort()).toEqual(['raw_base64', 'raw_sha256', 'raw_text_escaped', 'size_bytes']);
  });
});

describe('barcode never in a URL (REQ-SEC-098) — spec lint over the WHOLE instruments contract', () => {
  it('no path template, query/path/header parameter or cursor contains `barcode`', () => {
    const hits: string[] = [];
    for (const [path, item] of Object.entries<any>(spec.paths)) {
      if (/barcode/i.test(path)) hits.push(`path ${path}`);
      for (const m of HTTP) for (const p of item?.[m]?.parameters ?? []) if (/barcode/i.test(p?.name ?? '') || /barcode/i.test(JSON.stringify(p?.schema ?? {}))) hits.push(`${m} ${path} param ${p?.name}`);
    }
    expect(hits).toEqual([]);
  });
  it('E34 is a POST with the barcode as a JSON body field (^[A-Z0-9]{1,40}$), additionalProperties:false, and has NO parameters', () => {
    const o = operation('searchInstrumentMessages'); expect(o.method).toBe('post'); expect(o.op.parameters ?? []).toEqual([]);
    const s = o.op.requestBody.content['application/json'].schema; expect(s.additionalProperties).toBe(false); expect(s.required).toEqual(['sample_barcode']); expect(s.properties.sample_barcode.pattern).toBe('^[A-Z0-9]{1,40}$');
  });
  it('no GET/DELETE operation of the contract takes a request body', () => {
    const hits: string[] = []; for (const [path, item] of Object.entries<any>(spec.paths)) for (const m of ['get', 'delete']) if (item?.[m]?.requestBody) hits.push(`${m} ${path}`); expect(hits).toEqual([]);
  });
});

describe('no barcode / raw in list DTOs (07-SECURITY §5, S-06)', () => {
  it('MessageSummary, E33 and E34 response schemas have no barcode property', () => {
    for (const id of ['listInstrumentMessages', 'searchInstrumentMessages']) expect(propertyNames(operation(id).op.responses['200'].content['application/json'].schema).filter((n) => /barcode/i.test(n)), id).toEqual([]);
  });
  it('E33/E34/E35/E42 response schemas have no raw_* byte property (only E36 serialises raw)', () => {
    for (const id of ['listInstrumentMessages', 'searchInstrumentMessages', 'getInstrumentMessage', 'listMessageRejections']) expect(propertyNames(operation(id).op.responses['200'].content['application/json'].schema).filter((n) => /^raw_(base64|bytes|text_escaped)$/.test(n)), id).toEqual([]);
  });
  it('MessageRejection is closed: a raw_bytes field is invalid', () => {
    const ok = { id: rejectionRow(1)['id'], received_at: rejectionRow(1)['received_at'], agent_id: rejectionRow(1)['agent_id'], claimed_instrument_id: rejectionRow(1)['claimed_instrument_id'], agent_message_id: rejectionRow(1)['agent_message_id'], reason_code: 'instruments.instrument_unknown', size_bytes: 1, raw_sha256: 'a'.repeat(64) };
    expect(responseViolations('listMessageRejections', '200', { data: [ok], page: { limit: 50 } })).toEqual([]);
    expect(responseViolations('listMessageRejections', '200', { data: [{ ...ok, raw_bytes: 'AAAA' }], page: { limit: 50 } })).not.toEqual([]);
  });
  it('a MessageSummary carrying sample_barcode is invalid', () => {
    const r = summaryRow(1); const ok = { id: r['id'], instrument_id: r['instrument_id'], instrument_code: r['instrument_code'], agent_id: r['agent_id'], centre_id: r['centre_id'], protocol: 'astm', message_kind: 'data', received_at: r['received_at'], size_bytes: 1, latest_run: r['latest_run'] };
    expect(responseViolations('searchInstrumentMessages', '200', { data: [ok] })).toEqual([]);
    expect(responseViolations('searchInstrumentMessages', '200', { data: [{ ...ok, sample_barcode: 'E2600000042' }] })).not.toEqual([]);
  });
});
