// T0D-03 — SQLSTATE -> ErrorCode mapping (02-TRD §6.4 table). AC-0D-3.2, REQ-SEC-026, REQ-SEC-045.
// Expected API (core/db/sqlstate.ts):
//   mapDbError(err: unknown, deps?: { log?: {info,warn,error}, metrics?: { inc(name: string): void } }) -> Error & { code: string; statusCode: number }
//   Non-database errors (no pg-style string `code`, or an already registered `<module>.<name>` code) are returned unchanged (same object).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { REPO_ROOT } from '../../module.js';
import { mapDbError } from '../sqlstate.js';
import { pgError, recorder } from './helpers.js';

const registry = new Map<string, number>(
  (parse(readFileSync(join(REPO_ROOT, 'contracts', 'errors.yaml'), 'utf8')) as Array<{ code: string; http: number }>).map((e) => [e.code, e.http]),
);

const TABLE: Array<[string, Record<string, unknown>, string, number]> = [
  ['P0001 immutable_row', { code: 'P0001', message: 'immutable_row' }, 'common.immutable_record', 409],
  ['42501 RLS WITH CHECK', { code: '42501', message: 'new row violates row-level security policy for table "samples"' }, 'common.not_found', 404],
  ['23503 FK violation', { code: '23503', message: 'insert violates foreign key constraint "samples_patient_fk"' }, 'common.not_found', 404],
  ['23505 unique violation', { code: '23505', message: 'duplicate key', constraint: 'samples_barcode_uq' }, 'common.internal', 500],
  ['23514 check violation', { code: '23514', message: 'violates check constraint "qty_positive"' }, 'common.validation_failed', 400],
  ['40001 serialization failure', { code: '40001' }, 'common.dependency_unavailable', 503],
  ['40P01 deadlock', { code: '40P01' }, 'common.dependency_unavailable', 503],
  ['55P03 lock timeout', { code: '55P03' }, 'common.dependency_unavailable', 503],
  ['57014 statement timeout', { code: '57014' }, 'common.dependency_unavailable', 503],
  ['connection refused', { code: 'ECONNREFUSED' }, 'common.dependency_unavailable', 503],
  ['connection reset', { code: 'ECONNRESET' }, 'common.dependency_unavailable', 503],
  ['08006 connection failure', { code: '08006' }, 'common.dependency_unavailable', 503],
];

describe('SQLSTATE mapping table (02-TRD §6.4)', () => {
  it.each(TABLE)('%s -> %s %i', (_n, raw, code, status) => {
    const e = mapDbError(pgError(String(raw.code), String(raw.message ?? 'x'), raw as any));
    expect(e.code).toBe(code);
    expect(e.statusCode).toBe(status);
  });

  it('every mapped code exists in contracts/errors.yaml with the same HTTP status', () => {
    for (const [, , code, status] of TABLE) expect(registry.get(code), code).toBe(status);
  });

  it('AC-0D-3.2: P0001/immutable_row -> 409 common.immutable_record; 42501 -> 404; 23503 -> 404', () => {
    expect(mapDbError(pgError('P0001', 'immutable_row'))).toMatchObject({ code: 'common.immutable_record', statusCode: 409 });
    expect(mapDbError(pgError('42501'))).toMatchObject({ code: 'common.not_found', statusCode: 404 });
    expect(mapDbError(pgError('23503'))).toMatchObject({ code: 'common.not_found', statusCode: 404 });
  });

  it('P0001 with any other message is NOT an immutable_record (a different RAISE EXCEPTION)', () => {
    const e = mapDbError(pgError('P0001', 'something else raised this'));
    expect(e.code).not.toBe('common.immutable_record');
    expect(e.statusCode).not.toBe(409);
  });

  it('42501 and 23503 are indistinguishable on the wire (no existence oracle, REQ-SEC-026)', () => {
    const a = mapDbError(pgError('42501', 'rls'));
    const b = mapDbError(pgError('23503', 'fk'));
    expect([a.code, a.statusCode]).toEqual([b.code, b.statusCode]);
  });

  it('mapped errors never carry the DB message, constraint, table, or detail (no schema/row leak)', () => {
    const raw = pgError('23503', 'insert on table "patients" violates foreign key constraint "samples_patient_fk"', {
      constraint: 'samples_patient_fk', table: 'patients', detail: 'Key (patient_id)=(0190a000-0000-7000-8000-00000000dead) is not present',
    });
    const e = mapDbError(raw);
    const wire = JSON.stringify({ ...e, message: e.message, stack: undefined });
    for (const secret of ['patients', 'samples_patient_fk', 'patient_id', 'dead', 'foreign key']) expect(wire).not.toContain(secret);
  });

  it('42501 increments lims_rls_denied_total (REQ-SEC-045); other codes do not', () => {
    const r = recorder();
    mapDbError(pgError('42501'), r);
    expect(r.metrics.counts.get('lims_rls_denied_total')).toBe(1);
    mapDbError(pgError('23503'), r);
    mapDbError(pgError('P0001', 'immutable_row'), r);
    expect(r.metrics.counts.get('lims_rls_denied_total')).toBe(1);
  });

  it('23505 not re-mapped logs unmapped_unique_violation with the constraint', () => {
    const r = recorder();
    const e = mapDbError(pgError('23505', 'duplicate key value violates unique constraint "samples_barcode_uq"', { constraint: 'samples_barcode_uq' }), r);
    expect(e).toMatchObject({ code: 'common.internal', statusCode: 500 });
    const hit = r.calls.find((c) => JSON.stringify(c).includes('unmapped_unique_violation'));
    expect(hit, 'no unmapped_unique_violation log').toBeDefined();
    expect(JSON.stringify(hit)).toContain('samples_barcode_uq');
    expect(e.message).not.toContain('samples_barcode_uq'); // the constraint goes to the log, not the response
  });

  it('a module can catch the raw error and re-map first: already-registered module codes pass through unchanged', () => {
    const own = Object.assign(new Error('billing.counter_busy'), { code: 'billing.counter_busy', statusCode: 409 });
    expect(mapDbError(own)).toBe(own);
  });

  it('non-database errors pass through as the same object', () => {
    const plain = new TypeError('bug in handler');
    expect(mapDbError(plain)).toBe(plain);
  });

  it('an unlisted SQLSTATE becomes a 500 common.internal without leaking the DB message', () => {
    // [CONV] fail closed: 02-TRD §6.4 lists no default row; anything unlisted must not reach the client as-is.
    const e = mapDbError(pgError('XX000', 'internal error at "lab.results" index scan'));
    expect(e).toMatchObject({ code: 'common.internal', statusCode: 500 });
    expect(e.message).not.toContain('lab.results');
  });

  it('same input, same output: mapping keeps no state between calls', () => {
    const a = mapDbError(pgError('40001'));
    mapDbError(pgError('23505', 'dup', { constraint: 'c' }));
    const b = mapDbError(pgError('40001'));
    expect([a.code, a.statusCode]).toEqual([b.code, b.statusCode]);
  });
});
