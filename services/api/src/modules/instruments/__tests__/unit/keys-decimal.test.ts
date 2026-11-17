// API-T02 — 02-TRD §6.5 keys (03-IC §3.14/§3.15, 04 N10); decimal.ts (DecimalString ^-?[0-9]{1,12}(\.[0-9]{1,6})?$).
// Expected API:
//   keys.ts     resultKey({instrumentId, sampleBarcode, instrumentAnalyteCode, instrumentResultTime?}): string
//               qcKey({instrumentId, controlIdRaw, instrumentAnalyteCode, instrumentResultTime?, rawSha256}): string
//               calibrationKey({instrumentId, instrumentAnalyteCode, instrumentResultTime?, rawSha256}): string
//               resultKeySha256(key: string): string   (hex SHA-256 of the UTF-8 key)
//               messageKey(src): { key: string; kind: 'msh10'|'msh10_reused'|'sha256'|'sha256_repeat' }, src one of
//                 {source:'hl7v2', msh10?, rawSha256, reused?} | {source:'astm', rawSha256}
//                 | {source:'file_drop', fileSha256} | {source:'host_query_repeat', rawSha256, agentMessageId}
//   decimal.ts  toDecimalString(valueRaw: string): string | undefined
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { calibrationKey, messageKey, qcKey, resultKey, resultKeySha256 } from '../../domain/keys.js';
import { toDecimalString } from '../../domain/decimal.js';

const SHA = 'ab'.repeat(32);
const T = '2026-11-07T08:45:05.000Z';

describe('result / QC / calibration keys', () => {
  it('result key formula', () => {
    expect(resultKey({ instrumentId: 'I1', sampleBarcode: 'B123', instrumentAnalyteCode: 'WBC', instrumentResultTime: T })).toBe(
      `I1:B123:WBC:${T}`,
    );
  });
  it("result key without result time uses 'none'", () => {
    expect(resultKey({ instrumentId: 'I1', sampleBarcode: 'B123', instrumentAnalyteCode: 'WBC' })).toBe('I1:B123:WBC:none');
  });
  it('QC key formula; falls back to raw_sha256', () => {
    expect(qcKey({ instrumentId: 'I1', controlIdRaw: 'QC-L1', instrumentAnalyteCode: 'WBC', instrumentResultTime: T, rawSha256: SHA })).toBe(
      `I1:qc:QC-L1:WBC:${T}`,
    );
    expect(qcKey({ instrumentId: 'I1', controlIdRaw: 'QC-L1', instrumentAnalyteCode: 'WBC', rawSha256: SHA })).toBe(
      `I1:qc:QC-L1:WBC:${SHA}`,
    );
  });
  it('calibration key formula; falls back to sha256(raw)', () => {
    expect(calibrationKey({ instrumentId: 'I1', instrumentAnalyteCode: 'WBC', instrumentResultTime: T, rawSha256: SHA })).toBe(
      `I1:cal:WBC:${T}`,
    );
    expect(calibrationKey({ instrumentId: 'I1', instrumentAnalyteCode: 'WBC', rawSha256: SHA })).toBe(`I1:cal:WBC:${SHA}`);
  });
  it('different instruments / analytes / times never collide', () => {
    const a = resultKey({ instrumentId: 'I1', sampleBarcode: 'B', instrumentAnalyteCode: 'X', instrumentResultTime: T });
    expect(resultKey({ instrumentId: 'I2', sampleBarcode: 'B', instrumentAnalyteCode: 'X', instrumentResultTime: T })).not.toBe(a);
    expect(resultKey({ instrumentId: 'I1', sampleBarcode: 'B', instrumentAnalyteCode: 'Y', instrumentResultTime: T })).not.toBe(a);
    expect(resultKey({ instrumentId: 'I1', sampleBarcode: 'B', instrumentAnalyteCode: 'X' })).not.toBe(a);
  });
  it('result_key_sha256 = hex SHA-256 of the key; it does not leak the barcode (02-CV §9.2)', () => {
    const k = resultKey({ instrumentId: 'I1', sampleBarcode: 'B123', instrumentAnalyteCode: 'WBC', instrumentResultTime: T });
    const h = resultKeySha256(k);
    expect(h).toBe(createHash('sha256').update(k, 'utf8').digest('hex'));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain('B123');
  });
});

describe('message key', () => {
  it('HL7 uses MSH-10', () =>
    expect(messageKey({ source: 'hl7v2', msh10: 'CTRL42', rawSha256: SHA })).toEqual({ key: 'CTRL42', kind: 'msh10' }));
  it('HL7 control id reused with a different payload (D-12): MSH-10 || ":" || left(sha,16)', () => {
    expect(messageKey({ source: 'hl7v2', msh10: 'CTRL42', rawSha256: SHA, reused: true })).toEqual({
      key: `CTRL42:${SHA.slice(0, 16)}`,
      kind: 'msh10_reused',
    });
  });
  it('unparseable HL7 (no MSH-10) falls back to raw_sha256', () => {
    expect(messageKey({ source: 'hl7v2', rawSha256: SHA })).toEqual({ key: SHA, kind: 'sha256' });
  });
  it('ASTM uses raw_sha256', () => expect(messageKey({ source: 'astm', rawSha256: SHA })).toEqual({ key: SHA, kind: 'sha256' }));
  it("file drop uses the FILE's sha256", () => {
    expect(messageKey({ source: 'file_drop', fileSha256: 'cd'.repeat(32) })).toEqual({ key: 'cd'.repeat(32), kind: 'sha256' });
  });
  it('byte-identical host query under a new agent id: raw_sha256 || ":" || agent_message_id', () => {
    expect(messageKey({ source: 'host_query_repeat', rawSha256: SHA, agentMessageId: 'AM1' })).toEqual({
      key: `${SHA}:AM1`,
      kind: 'sha256_repeat',
    });
  });
  it('sha-based keys stay within the 220-char column', () => {
    const k = messageKey({ source: 'host_query_repeat', rawSha256: SHA, agentMessageId: '0198f3a2-7b1c-7d4e-9a3b-1c2d3e4f5a6b' });
    expect(k.key.length).toBeLessThanOrEqual(220);
  });
});

describe('toDecimalString (value_raw -> DecimalString | undefined)', () => {
  it.each([
    ['5', '5'],
    ['5.4', '5.4'],
    ['-0.5', '-0.5'],
    ['0', '0'],
    ['0012.50', '0012.50'],
    ['123456789012', '123456789012'],
    ['1.123456', '1.123456'],
    [' 5.4 ', '5.4'],
    ['5.4\n', '5.4'],
    ['\t-7\r\n', '-7'],
  ])('accepts %j -> %j (reported decimals preserved)', (raw, out) => expect(toDecimalString(raw)).toBe(out));
  it.each([
    '', ' ', '1234567890123', '1.1234567', '1e5', '1E-3', '<5', '>10', '+5', '.5', '5.', '1,5', '5 mg', 'NaN', 'Infinity',
    '--5', '5.4.3', '5\n6', '٥', '５', '0x10', '1_000', '-', '5.4abc',
  ])('rejects %j', (raw) => expect(toDecimalString(raw)).toBeUndefined());
  it('keeps trailing zeros (no float round-trip)', () => expect(toDecimalString('0.10')).toBe('0.10'));
});
