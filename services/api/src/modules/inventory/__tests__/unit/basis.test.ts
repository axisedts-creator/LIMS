// C12.T-02 — domain/basis.ts: basis_key builders (02-TRD §8.1 table, §8.5; 05-SCHEMA consumption_facts.basis_key; PRD AC-12.4, AC-12.2).
// Expected interface (domain/basis.ts), all return the key string, all throw .code 'common.validation_failed' on a malformed argument:
//   testBasisKey(orderItemId, testId)            'test:<order_item_id>:<test_id>'
//   analyteBasisKey(resultId)                    'analyte:<result_id>'
//   rerunBasisKey(instrumentMessageId, testId)   'rerun:<instrument_message_id>:<test_id>'
//   calibrationBasisKey(idempotencyKey)          'cal:<sha256_hex(idempotency_key)>'
//   qcBasisKey(idempotencyKey)                   'qc:<sha256_hex(idempotency_key)>'
//   manualBasisKey(uuid)                         'manual:<uuid>'
//   fixedBasisKey(ruleId, businessDate)          'fixed:<rule_id>:<YYYY-MM-DD>'
// 05-SCHEMA: basis_key ≤ 200 chars, contains only UUIDs, kinds, dates and a SHA-256 hex digest (never a raw idempotency key).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { analyteBasisKey, calibrationBasisKey, fixedBasisKey, manualBasisKey, qcBasisKey, rerunBasisKey, testBasisKey } from '../../domain/basis.js';
import { codeOf } from './helpers.js';

const VALIDATION = 'common.validation_failed';
const U1 = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';
const U2 = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c';
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('§8.1 basis key shapes', () => {
  it('test', () => expect(testBasisKey(U1, U2)).toBe(`test:${U1}:${U2}`));
  it('analyte', () => expect(analyteBasisKey(U1)).toBe(`analyte:${U1}`));
  it('rerun', () => expect(rerunBasisKey(U1, U2)).toBe(`rerun:${U1}:${U2}`));
  it('calibration: sha256 hex of the idempotency key', () => {
    expect(calibrationBasisKey('idem-key-1')).toBe(`cal:${sha('idem-key-1')}`);
    expect(calibrationBasisKey('idem-key-1')).toMatch(/^cal:[0-9a-f]{64}$/);
  });
  it('qc: sha256 hex of the idempotency key', () => {
    expect(qcBasisKey('idem-key-1')).toBe(`qc:${sha('idem-key-1')}`);
    expect(qcBasisKey('idem-key-1')).toMatch(/^qc:[0-9a-f]{64}$/);
  });
  it('manual: manual:<uuid>', () => expect(manualBasisKey(U1)).toBe(`manual:${U1}`));
  it('fixed (cron): fixed:<rule_id>:<D>', () => expect(fixedBasisKey(U1, '2026-11-12')).toBe(`fixed:${U1}:2026-11-12`));
});

describe('dedupe properties (AC-12.4: same event twice → same key → one fact)', () => {
  it('deterministic', () => {
    expect(testBasisKey(U1, U2)).toBe(testBasisKey(U1, U2));
    expect(calibrationBasisKey('k')).toBe(calibrationBasisKey('k'));
  });
  it('argument order matters (test/order-item swap gives a different key)', () => {
    expect(testBasisKey(U1, U2)).not.toBe(testBasisKey(U2, U1));
  });
  it('kinds never collide for the same ids (test vs rerun) nor for the same idempotency key (cal vs qc)', () => {
    expect(testBasisKey(U1, U2)).not.toBe(rerunBasisKey(U1, U2));
    expect(calibrationBasisKey('k')).not.toBe(qcBasisKey('k'));
  });
  it('different idempotency keys → different digests; the digest hides the raw key', () => {
    expect(qcBasisKey('a')).not.toBe(qcBasisKey('b'));
    expect(qcBasisKey('secret-idempotency-key')).not.toContain('secret');
  });
  it('same rule on two business dates → two keys (one fixed fact per rule per day)', () => {
    expect(fixedBasisKey(U1, '2026-11-12')).not.toBe(fixedBasisKey(U1, '2026-11-13'));
  });
  it('every key fits the DB limit (≤ 200 chars), also for a 1 KiB idempotency key', () => {
    const long = 'x'.repeat(1024);
    for (const k of [testBasisKey(U1, U2), analyteBasisKey(U1), rerunBasisKey(U1, U2), calibrationBasisKey(long), qcBasisKey(long), manualBasisKey(U1), fixedBasisKey(U1, '2026-11-12')]) {
      expect(k.length).toBeGreaterThanOrEqual(1);
      expect(k.length).toBeLessThanOrEqual(200);
    }
  });
});

describe('malformed arguments are rejected (keys contain only UUIDs, kinds, dates and a digest)', () => {
  const BAD_UUIDS = ['', 'not-a-uuid', `${U1}:${U2}`, `${U1}\n`, ` ${U1}`, U1.slice(1), `${U1}0`, "0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2';", '0190a1b2c3d47e5f8a6b7c8d9e0f1a2b'];
  it.each(BAD_UUIDS.map((u) => [JSON.stringify(u), u]))('rejects id %s', (_l, u) => {
    expect(codeOf(() => testBasisKey(u, U2))).toBe(VALIDATION);
    expect(codeOf(() => testBasisKey(U1, u))).toBe(VALIDATION);
    expect(codeOf(() => analyteBasisKey(u))).toBe(VALIDATION);
    expect(codeOf(() => rerunBasisKey(u, U2))).toBe(VALIDATION);
    expect(codeOf(() => rerunBasisKey(U1, u))).toBe(VALIDATION);
    expect(codeOf(() => manualBasisKey(u))).toBe(VALIDATION);
    expect(codeOf(() => fixedBasisKey(u, '2026-11-12'))).toBe(VALIDATION);
  });
  it.each([[undefined], [null], [123], [{}]])('rejects non-string id %j', (u) => {
    expect(codeOf(() => analyteBasisKey(u as never))).toBe(VALIDATION);
  });
  it.each([[''], [undefined], [null], [5]])('rejects idempotency key %j', (k) => {
    expect(codeOf(() => calibrationBasisKey(k as never))).toBe(VALIDATION);
    expect(codeOf(() => qcBasisKey(k as never))).toBe(VALIDATION);
  });
  it.each([['2026-13-01'], ['2026-02-30'], ['26-11-12'], ['2026-11-12T00:00:00Z'], ['2026-11-12\n'], [''], ['tomorrow']])('rejects business date %j', (d) => {
    expect(codeOf(() => fixedBasisKey(U1, d))).toBe(VALIDATION);
  });
});
