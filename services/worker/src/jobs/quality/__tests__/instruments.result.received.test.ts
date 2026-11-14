// C9 T-13 — consumer instruments.result.received.v1 -> quality.qc_activity (02-TRD §10.2; PRD AC-09.5; 07-SECURITY REQ-SEC-024/098, S-15, S-17). No database: a recording tx.
// SEAM (writer matches or disputes): `../consumers/instruments.result.received.v1.ts` exports `handle: ConsumerHandler`.
//   (1) tenant guard: event.tenant_id must equal ctx.tenantId, else throw BEFORE any query (REQ-SEC-024).
//   (2) reads ONLY event.payload.{ instrument_id, analyte_id, mapping_status, received_at } (07-SECURITY "reads ids/codes/timestamps only"; the envelope is not copied anywhere).
//   (3) no-op WITHOUT a query unless mapping_status === 'mapped' and analyte_id is present.
//   (4) otherwise exactly ONE statement on ctx.tx, parameterised (tenant, instrument_id, analyte_id, received_at as values): an upsert into quality.qc_activity for the ACTIVE plan of (tenant, instrument, analyte)
//       (INSERT ... SELECT ... FROM quality.qc_plans WHERE tenant_id = $ AND instrument_id = $ AND analyte_id = $ AND status = 'active' -> no plan = no row), ON CONFLICT (tenant_id, plan_id) DO UPDATE with
//       last_patient_result_at = greatest(existing, received_at) and patient_results_since_last_qc + 1 only when received_at is later than last_qc_run_at (CASE WHEN ...), guarded by qc_activity.tenant_id = $.
//   (5) a malformed instrument_id / analyte_id / received_at (not a uuid / not an ISO-UTC instant) throws before any query (retry, dead letter); a query failure rejects.
// Fails now: "Cannot find module ../consumers/instruments.result.received.v1.js".
import { describe, expect, it } from 'vitest';
import { handle as resultReceived } from '../consumers/instruments.result.received.v1.js';

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const NOW = '2026-11-14T10:00:00.000Z';
const RECEIVED = '2026-11-14T09:59:58.123Z';
const u = (n: number) => `0190c60b-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const BARCODE = 'SENTINEL-BARCODE-SYN-77421';
const VALUE = '987.654';

function jobCtx(tenant: string | undefined, over: { queryFails?: boolean } = {}) {
  const queries: Array<{ text: string; values: unknown[] }> = []; const logs: unknown[] = [];
  const ctx: any = {
    tenantId: tenant, actor: { type: 'system', id: SYS }, requestId: u(8), now: () => NOW, attempt: 1, maxAttempts: 10, jobId: '1',
    tx: { async query(text: string, values: unknown[] = []) { queries.push({ text, values }); if (over.queryFails) throw new Error('db down'); return { rows: [] }; } },
    log: { info: (...a: unknown[]) => logs.push(a), warn: (...a: unknown[]) => logs.push(a), error: (...a: unknown[]) => logs.push(a), child() { return this; } },
  };
  return { ctx, queries, logs };
}
const envelope = (tenant: string | undefined, payload: Record<string, unknown> = {}) => ({
  event_id: u(9), event_type: 'instruments.result.received.v1', tenant_id: tenant, producer: 'instruments', occurred_at: '2026-11-14T09:59:59.000Z', request_id: u(8), idempotency_key: 'instruments.result.received.v1:k1',
  aggregate: { type: 'instrument_message', id: u(1), seq: 1 },
  payload: { instrument_message_id: u(1), instrument_id: u(2), agent_id: u(5), centre_id: u(3), protocol: 'astm', sample_barcode: BARCODE, record_kind: 'quantitative', instrument_analyte_code: 'GLU', mapping_status: 'mapped',
    analyte_id: u(4), test_id: u(6), value_raw: VALUE, value_numeric: VALUE, unit_raw: 'mmol/L', instrument_flags: ['H'], received_at: RECEIVED, is_rerun: false, ...payload },
});
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const failure = (p: Promise<unknown>) => p.then(() => undefined, (e) => e);

describe('instruments.result.received.v1 consumer: mapped patient result -> one qc_activity upsert (AC-09.5)', () => {
  it('runs exactly ONE statement: tenant, instrument, analyte and received_at as bound values, none interpolated into the SQL text', async () => {
    const { ctx, queries } = jobCtx(A); await resultReceived(envelope(A), ctx);
    expect(queries).toHaveLength(1);
    const q = queries[0]!; expect(q.values).toEqual(expect.arrayContaining([A, u(2), u(4), RECEIVED]));
    for (const lit of [A, u(2), u(4), RECEIVED, '2026-11-14']) expect(q.text, lit).not.toContain(lit);
  });
  it('the statement upserts quality.qc_activity for the ACTIVE plan of the pair only (no plan -> no row), tenant-scoped on every table', async () => {
    const { ctx, queries } = jobCtx(A); await resultReceived(envelope(A), ctx); const s = norm(queries[0]!.text);
    expect(s).toMatch(/INSERT INTO quality\.qc_activity\b/); expect(s).toMatch(/FROM quality\.qc_plans\b/);
    expect(s).toMatch(/tenant_id\s*=\s*\$\d/); expect(s).toMatch(/instrument_id\s*=\s*\$\d/); expect(s).toMatch(/analyte_id\s*=\s*\$\d/); expect(s).toMatch(/status\s*=\s*'active'/);
    expect(s).toMatch(/ON CONFLICT \(tenant_id, plan_id\) DO UPDATE/); expect(s).toMatch(/qc_activity\.tenant_id\s*=\s*\$\d/);
  });
  it('last_patient_result_at = greatest(existing, received_at); the counter grows by one only when received_at is later than last_qc_run_at (CASE WHEN ... last_qc_run_at ...)', async () => {
    const { ctx, queries } = jobCtx(A); await resultReceived(envelope(A), ctx); const s = norm(queries[0]!.text);
    expect(s).toMatch(/last_patient_result_at\s*=\s*greatest\(/i); expect(s).toMatch(/patient_results_since_last_qc\s*=[^,]*\+\s*1/); expect(s).toMatch(/CASE\s+WHEN/i); expect(s).toMatch(/last_qc_run_at/);
  });
  it('writes quality.qc_activity only: no other write, no DELETE, no table of another module, never lab.* / instruments.* base tables', async () => {
    const { ctx, queries } = jobCtx(A); await resultReceived(envelope(A), ctx); const s = norm(queries[0]!.text);
    expect(s).not.toMatch(/\b(DELETE|TRUNCATE|DROP)\b/i); expect([...s.matchAll(/\bINSERT INTO\s+([a-z_.]+)/gi)].map((m) => m[1])).toEqual(['quality.qc_activity']); expect(s.replace(/DO UPDATE SET/gi, '')).not.toMatch(/\bUPDATE\b/i);
    for (const m of s.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)\.([a-z_]+)/gi)) expect(m[1], s).toBe('quality');
  });
  it('a failing statement rejects (retry, then dead letter); a duplicate delivery just repeats the same single statement (the inbox dedupes event ids before the handler)', async () => {
    const f = jobCtx(A, { queryFails: true }); expect(await failure(Promise.resolve(resultReceived(envelope(A), f.ctx)))).toBeInstanceOf(Error);
    const { ctx, queries } = jobCtx(A); await resultReceived(envelope(A), ctx); await resultReceived(envelope(A), ctx);
    expect(queries).toHaveLength(2); expect(queries[1]).toEqual(queries[0]);
  });
});

describe('instruments.result.received.v1 consumer: events that must not count', () => {
  it.each([
    ['unmapped', { mapping_status: 'unmapped' }], ['no mapping_status', { mapping_status: undefined }], ['analyte_id null', { analyte_id: null }], ['analyte_id absent', { analyte_id: undefined }], ['analyte_id empty', { analyte_id: '' }],
  ])('%s: a no-op WITHOUT any query', async (_n, over) => {
    const { ctx, queries } = jobCtx(A); await resultReceived(envelope(A, over), ctx); expect(queries).toEqual([]);
  });
});

describe('instruments.result.received.v1 consumer: tenancy, hostile input, PHI (REQ-SEC-024, REQ-SEC-098, S-15, S-17)', () => {
  it('REQ-SEC-024: an event of another tenant, an event without tenant, or a job without tenant is refused before any query', async () => {
    for (const [event, tenant] of [[envelope(B), A], [envelope(undefined), A], [envelope(A), undefined], [null, A], [undefined, A]] as const) {
      const { ctx, queries } = jobCtx(tenant as string | undefined); expect(await failure(Promise.resolve(resultReceived(event as never, ctx))), JSON.stringify(event)?.slice(0, 60)).toBeInstanceOf(Error); expect(queries).toEqual([]);
    }
  });
  it('a tenant id smuggled inside the payload is ignored: the statement binds the JOB tenant only', async () => {
    const { ctx, queries } = jobCtx(A); await resultReceived(envelope(A, { tenant_id: B }), ctx); expect(queries[0]!.values).toContain(A); expect(queries[0]!.values).not.toContain(B);
  });
  it.each([
    ['instrument_id', { instrument_id: "x'; DROP TABLE quality.qc_activity;--" }], ['instrument_id empty', { instrument_id: '' }], ['instrument_id missing', { instrument_id: undefined }],
    ['analyte_id not a uuid', { analyte_id: "1' OR '1'='1" }], ['received_at garbage', { received_at: 'yesterday' }], ['received_at missing', { received_at: undefined }], ['received_at with offset', { received_at: '2026-11-14T15:45:58.123+05:45' }],
  ])('malformed %s: rejects before any query (never interpolated, never half-applied)', async (_n, over) => {
    const { ctx, queries } = jobCtx(A); expect(await failure(Promise.resolve(resultReceived(envelope(A, over as any), ctx)))).toBeInstanceOf(Error); expect(queries).toEqual([]);
  });
  it('S-15: nothing of the payload but the four allowed fields reaches a statement value or a log line: no sample_barcode, no value, no flags, no unit, no message id; unknown extra fields are ignored', async () => {
    const { ctx, queries, logs } = jobCtx(A); await resultReceived(envelope(A, { brand_new_field: { x: 1 }, patient_note: 'SENTINEL-PHI-Sita-Karki' }), ctx);
    const text = JSON.stringify([queries, logs]);
    for (const leak of [BARCODE, VALUE, 'SENTINEL-PHI-Sita-Karki', 'mmol/L', '"H"', u(1), u(3), u(5), u(6), 'brand_new_field']) expect(text, leak).not.toContain(leak);
  });
  it('S-17: a failing statement leaves no PHI in the thrown error or the logs either', async () => {
    const { ctx, logs } = jobCtx(A, { queryFails: true }); const e: any = await failure(Promise.resolve(resultReceived(envelope(A), ctx)));
    expect(JSON.stringify({ m: e?.message, s: e?.stack, logs })).not.toMatch(new RegExp(`${BARCODE}|${VALUE.replace('.', '\\.')}`));
  });
});
