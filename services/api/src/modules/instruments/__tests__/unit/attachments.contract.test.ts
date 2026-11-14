// C7 API-T11 — contract probes for E06 submitAttachment / E37 downloadInstrumentAttachment against contracts/openapi/instruments.yaml (02-TRD §7.2; 07-SECURITY S-08, S-11).
// Spec-level (they check the contract + the closed schemas, not the service); behaviour is in attachments.service.test.ts.
import { describe, expect, it } from 'vitest';
import { AjvCompiler } from '@fastify/ajv-compiler';
import { AJV_OPTIONS } from '../../../../core/openapi.js';
import { operation, responseViolations, spec } from '../agents.contract.js';
import { metadata, pdfBytes, idN } from '../attachments.helpers.js';

const factory = AjvCompiler() as unknown as (ext: object, o: { customOptions: object }) => (c: { schema: object }) => (v: unknown) => boolean;
const compile = factory({}, { customOptions: { ...AJV_OPTIONS, coerceTypes: false, strict: false } });
const metaSchema = () => ({ components: spec.components, ...operation('submitAttachment').op.requestBody.content['multipart/form-data'].schema.properties.metadata });
const metaValid = (v: unknown) => (compile({ schema: metaSchema() as object }) as (x: unknown) => boolean)(v);

describe('E06 / E37 route table (TRD §7.2)', () => {
  it('E06: POST /v1/instruments/agent/attachments, instruments.ingest.submit, deviceToken, Idempotency-Key required, ingest tier, x-upload = pdf/png/jpeg only', () => {
    const o = operation('submitAttachment');
    expect([o.method, o.path]).toEqual(['post', '/v1/instruments/agent/attachments']); expect(o.op['x-permission']).toBe('instruments.ingest.submit'); expect(o.op.security).toEqual([{ deviceToken: [] }]);
    expect(o.op['x-idempotency']).toBe('required'); expect(o.op['x-rate-limit-tier']).toBe('ingest'); expect([...o.op['x-upload']].sort()).toEqual(['application/pdf', 'image/jpeg', 'image/png']);
    expect(Object.keys(o.op.requestBody.content)).toEqual(['multipart/form-data']);
  });
  it('E06 declares 413 + 415 + the instrument errors, and answers 413/415 responses', () => {
    const o = operation('submitAttachment');
    expect(o.op['x-error-codes']).toEqual(expect.arrayContaining(['common.payload_too_large', 'common.unsupported_media_type', 'instruments.instrument_unknown', 'instruments.device_mismatch', 'instruments.capability_not_supported']));
    expect(Object.keys(o.op.responses)).toEqual(expect.arrayContaining(['202', '413', '415', '404', '403']));
  });
  it('E37: GET /v1/instruments/messages/{instrument_message_id}/attachment/content, instruments.message.read, bearerJwt, no idempotency, 422 common.upload_quarantined and 404 declared', () => {
    const o = operation('downloadInstrumentAttachment');
    expect([o.method, o.path]).toEqual(['get', '/v1/instruments/messages/{instrument_message_id}/attachment/content']); expect(o.op['x-permission']).toBe('instruments.message.read');
    expect(o.op.security).toEqual([{ bearerJwt: [] }]); expect(o.op['x-idempotency']).toBe('none'); expect(o.op['x-error-codes']).toEqual(expect.arrayContaining(['common.not_found', 'common.upload_quarantined']));
    expect(Object.keys(o.op.responses)).toEqual(expect.arrayContaining(['200', '404', '422']));
  });
  it('E37 200 declares Content-Disposition, X-Content-Type-Options=nosniff, Cache-Control=no-store, Content-Length and only pdf/png/jpeg bodies — and NO Location header (A13 P-2)', () => {
    const r = operation('downloadInstrumentAttachment').op.responses['200'];
    expect(Object.keys(r.headers).sort()).toEqual(['Cache-Control', 'Content-Disposition', 'Content-Length', 'X-Content-Type-Options']);
    expect(r.headers['X-Content-Type-Options'].schema.enum).toEqual(['nosniff']); expect(r.headers['Cache-Control'].schema.enum).toEqual(['no-store']);
    expect(Object.keys(r.content).sort()).toEqual(['application/pdf', 'image/jpeg', 'image/png']);
  });
  it('no operation of the instruments contract returns a URL-ish field (A13 P-2): no `url`, `signed_url`, `download_url`, `object_path` or `bucket` property in any response schema', () => {
    const bad = /^(url|signed_url|download_url|object_path|bucket|storage_url|href)$/i;
    const hits: string[] = [];
    for (const [path, item] of Object.entries<any>(spec.paths)) for (const m of ['get', 'post', 'put', 'patch', 'delete']) for (const [st, resp] of Object.entries<any>(item?.[m]?.responses ?? {})) {
      const walk = (s: any, seen = new Set<any>()): void => {
        if (!s || typeof s !== 'object' || seen.has(s)) return; seen.add(s);
        for (const [k, v] of Object.entries<any>(s.properties ?? {})) { if (bad.test(k)) hits.push(`${m} ${path} ${st}: ${k}`); walk(v, seen); }
        for (const k of ['items', 'additionalProperties']) walk(s[k], seen); for (const k of ['allOf', 'oneOf', 'anyOf']) for (const x of s[k] ?? []) walk(x, seen);
      };
      for (const c of Object.values<any>(resp?.content ?? {})) walk(c.schema);
    }
    expect(hits).toEqual([]);
  });
});

describe('E06 closed schemas (what the core pipeline enforces before the service runs)', () => {
  const f = pdfBytes();
  it('the fixture metadata is valid', () => { expect(metaValid(metadata(f))).toBe(true); });
  it.each([
    ['upper-case file_sha256', { file_sha256: 'A'.repeat(64) }], ['63-char file_sha256', { file_sha256: 'a'.repeat(63) }], ['file_name 256 chars', { file_name: 'a'.repeat(252) + '.pdf' }],
    ['empty file_name', { file_name: '' }], ['barcode 41 chars', { barcode: 'B'.repeat(41) }], ['file_size 15 MB + 1', { file_size: 15 * 1024 * 1024 + 1 }], ['file_size 0', { file_size: 0 }],
    ['unknown extra field', { surprise: 1 }], ['non-v7 agent_message_id', { agent_message_id: '00000000-0000-4000-8000-000000000001' }], ['clock_offset_ms as string', { clock_offset_ms: '5' }],
  ])('metadata with %s is rejected', (_n, over) => { expect(metaValid(metadata(f, over))).toBe(false); });
  it('metadata without barcode is valid (barcode optional); without file_mtime_agent is not', () => {
    const { barcode: _b, ...noBarcode } = metadata(f); expect(metaValid(noBarcode)).toBe(true);
    const { file_mtime_agent: _m, ...noMtime } = metadata(f); expect(metaValid(noMtime)).toBe(false);
  });
  it('202 body: accepted/duplicate x pending/clean/quarantined/failed valid; anything else (extra url field, other outcome/state) invalid', () => {
    const ok = { outcome: 'accepted', instrument_message_id: idN(0xf001), attachment_id: idN(0xe001), scan_state: 'pending' };
    for (const outcome of ['accepted', 'duplicate']) for (const scan_state of ['pending', 'clean', 'quarantined', 'failed']) expect(responseViolations('submitAttachment', '202', { ...ok, outcome, scan_state })).toEqual([]);
    for (const bad of [{ ...ok, url: 'https://storage.invalid/x' }, { ...ok, object_path: 'x' }, { ...ok, outcome: 'rejected' }, { ...ok, scan_state: 'infected' }, { outcome: 'accepted' }]) expect(responseViolations('submitAttachment', '202', bad)).not.toEqual([]);
  });
});
