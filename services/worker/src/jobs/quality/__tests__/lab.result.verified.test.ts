// C9 T-16 — consumer lab.result.verified.v1 -> quality.verification_log (02-TRD §10.2; 03-IC §3.9; 06-PLAN T-16 "verification_log consumer tolerates absent specimen_id/verified_by_membership_id", 08 A13 D-2;
// 07-SECURITY REQ-SEC-024/098, S-15, S-17). No database: a recording tx. The TAT stop logic of the same consumer is T-19 (not asserted here: only the FIRST statement is pinned).
// SEAM (writer matches or disputes): `../consumers/lab.result.verified.v1.ts` exports `handle: ConsumerHandler`.
//   (1) tenant guard: event.tenant_id must equal ctx.tenantId, else throw BEFORE any query (REQ-SEC-024).
//   (2) reads ONLY event.event_id and payload.{ result_id, result_version_no, order_id, order_item_id, test_id, analyte_id, mode, verified_at}; specimen_id, verified_by_membership_id, department_id, origin,
//       instrument_id, processing_branch_id are never read, stored or logged (03-IC §3.9 mode:auto events carry no membership and may carry no specimen_id — D-2).
//   (3) the FIRST statement is ONE parameterised `INSERT INTO quality.verification_log (...) ... ON CONFLICT (tenant_id, result_id, result_version_no) DO NOTHING`; values (any order): tenant (the JOB tenant),
//       result_id, result_version_no, order_id, order_item_id, test_id, analyte_id, mode, verified_at, event_id, created_by = ctx.actor.id (the system actor). The row id is generated in SQL (app.uuidv7()).
//   (4) malformed payload (uuid / positive integer result_version_no / mode manual|auto / ISO-UTC verified_at) throws a fixed-message Error BEFORE any query; a failing statement rejects.
// Fails now: "Cannot find module ../consumers/lab.result.verified.v1.js".
import { describe, expect, it } from 'vitest';
import { handle as resultVerified } from '../consumers/lab.result.verified.v1.js';

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const NOW = '2026-11-14T10:00:00.000Z';
const VERIFIED_AT = '2026-11-14T09:59:58.123Z';
const u = (n: number) => `0190c60b-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const MEMBERSHIP = u(0x5a), SPECIMEN = u(0x5b), BRANCH = u(0x5c), DEPT = u(0x5d), INSTR = u(0x5e);

function jobCtx(tenant: string | undefined, over: { queryFails?: boolean } = {}) {
  const queries: Array<{ text: string; values: unknown[] }> = []; const logs: unknown[] = [];
  const ctx: any = {
    tenantId: tenant, actor: { type: 'system', id: SYS }, requestId: u(8), now: () => NOW, attempt: 1, maxAttempts: 10, jobId: '1',
    tx: { async query(text: string, values: unknown[] = []) { queries.push({ text, values }); if (over.queryFails) throw new Error('db down'); return { rows: [] }; } },
    log: { info: (...a: unknown[]) => logs.push(a), warn: (...a: unknown[]) => logs.push(a), error: (...a: unknown[]) => logs.push(a), child() { return this; } },
  };
  return { ctx, queries, logs };
}
type P = Record<string, unknown>;
const manual = (o: P = {}): P => ({ result_id: u(1), result_version_no: 2, order_id: u(2), order_item_id: u(3), specimen_id: SPECIMEN, test_id: u(4), analyte_id: u(6), department_id: DEPT, instrument_id: INSTR,
  origin: 'instrument', mode: 'manual', verified_at: VERIFIED_AT, verified_by_membership_id: MEMBERSHIP, processing_branch_id: BRANCH, ...o });
/** mode:auto exactly as C5 emits it: no verified_by_membership_id, specimen_id absent (D-2). */
const auto = (o: P = {}): P => { const p = manual({ mode: 'auto', ...o }); delete p['verified_by_membership_id']; delete p['specimen_id']; return p; };
const envelope = (tenant: string | undefined, payload: P = manual(), over: Record<string, unknown> = {}) => ({
  event_id: u(9), event_type: 'lab.result.verified.v1', tenant_id: tenant, producer: 'lab', occurred_at: '2026-11-14T09:59:59.000Z', request_id: u(8), idempotency_key: `${u(1)}:verified:2:5`,
  aggregate: { type: 'result', id: u(1), seq: 5 }, payload, ...over,
});
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const failure = (p: Promise<unknown>) => p.then(() => undefined, (e) => e);
const FIELDS = ['result_id', 'result_version_no', 'order_id', 'order_item_id', 'test_id', 'analyte_id', 'mode', 'verified_at'];

describe('lab.result.verified.v1 consumer: one verification_log insert (TRD §10.2)', () => {
  it('the first statement is ONE parameterised INSERT INTO quality.verification_log ... ON CONFLICT (tenant_id, result_id, result_version_no) DO NOTHING', async () => {
    const { ctx, queries } = jobCtx(A); await resultVerified(envelope(A), ctx);
    expect(queries.length).toBeGreaterThanOrEqual(1); const s = norm(queries[0]!.text);
    expect(s).toMatch(/^INSERT INTO quality\.verification_log\b/i); expect(s).toMatch(/ON CONFLICT \(tenant_id, result_id, result_version_no\) DO NOTHING/i);
    for (const c of ['tenant_id', 'result_id', 'result_version_no', 'order_id', 'order_item_id', 'test_id', 'analyte_id', 'mode', 'verified_at', 'event_id', 'created_by']) expect(s, c).toMatch(new RegExp(`\\b${c}\\b`));
    expect(s).not.toMatch(/\b(UPDATE|DELETE|TRUNCATE|DROP)\b/i); expect([...s.matchAll(/\bINSERT INTO\s+([a-z_.]+)/gi)].map((m) => m[1])).toEqual(['quality.verification_log']);
  });
  it('binds the job tenant, the eight payload fields, the envelope event_id and the system actor as VALUES; nothing is interpolated into the SQL text', async () => {
    const { ctx, queries } = jobCtx(A); await resultVerified(envelope(A), ctx); const q = queries[0]!;
    expect(q.values).toEqual(expect.arrayContaining([A, u(1), 2, u(2), u(3), u(4), u(6), 'manual', VERIFIED_AT, u(9), SYS]));
    for (const lit of [A, u(1), u(2), u(3), u(4), u(6), u(9), SYS, VERIFIED_AT, 'manual', '2026-11-14']) expect(q.text, lit).not.toContain(lit);
  });
  it('a manual verification stores mode manual; an auto verification stores mode auto', async () => {
    const m = jobCtx(A); await resultVerified(envelope(A, manual()), m.ctx); expect(m.queries[0]!.values).toContain('manual');
    const a = jobCtx(A); await resultVerified(envelope(A, auto()), a.ctx); expect(a.queries[0]!.values).toContain('auto'); expect(a.queries[0]!.values).not.toContain('manual');
  });
  it('mode:auto with BOTH specimen_id and verified_by_membership_id absent is accepted (03-IC §3.9 if/then/else, 08 A13 D-2): it inserts exactly like a full event', async () => {
    const { ctx, queries } = jobCtx(A); await resultVerified(envelope(A, auto()), ctx);
    expect(queries.length).toBeGreaterThanOrEqual(1); expect(queries[0]!.values).toEqual(expect.arrayContaining([A, u(1), 2, u(2), u(3), u(4), u(6), 'auto', VERIFIED_AT, u(9), SYS]));
    expect(queries[0]!.values.includes(undefined)).toBe(false);
  });
  it.each([['specimen_id'], ['instrument_id'], ['processing_branch_id'], ['department_id'], ['origin'], ['verified_by_membership_id']])('the optional / unread field %s may be absent from a manual event', async (field) => {
    const p = manual(); delete p[field]; const { ctx, queries } = jobCtx(A); await resultVerified(envelope(A, p), ctx);
    expect(queries.length).toBeGreaterThanOrEqual(1);
  });
  it('a duplicate delivery repeats the identical statement (the inbox dedupes event ids before the handler; ON CONFLICT DO NOTHING makes the insert idempotent)', async () => {
    const { ctx, queries } = jobCtx(A); await resultVerified(envelope(A), ctx); await resultVerified(envelope(A), ctx);
    expect(queries[queries.length / 2]).toEqual(queries[0]); expect(queries.length % 2).toBe(0);
  });
  it('a failing statement rejects (retry, then dead letter)', async () => {
    const { ctx } = jobCtx(A, { queryFails: true }); expect(await failure(Promise.resolve(resultVerified(envelope(A), ctx)))).toBeInstanceOf(Error);
  });
});

describe('lab.result.verified.v1 consumer: tenancy and hostile input (REQ-SEC-024)', () => {
  it('an event of another tenant, without tenant, or a job without tenant, or no event at all, is refused before any query', async () => {
    for (const [event, tenant] of [[envelope(B), A], [envelope(undefined), A], [envelope(A), undefined], [null, A], [undefined, A]] as const) {
      const { ctx, queries } = jobCtx(tenant as string | undefined); expect(await failure(Promise.resolve(resultVerified(event as never, ctx))), JSON.stringify(event)?.slice(0, 60)).toBeInstanceOf(Error); expect(queries).toEqual([]);
    }
  });
  it('a tenant id smuggled inside the payload is ignored: statements bind the JOB tenant only', async () => {
    const { ctx, queries } = jobCtx(A); await resultVerified(envelope(A, manual({ tenant_id: B })), ctx);
    for (const q of queries) { expect(q.values).toContain(A); expect(q.values).not.toContain(B); }
  });
  it.each([
    ...FIELDS.filter((f) => f !== 'mode').map((f) => [`${f} missing`, { [f]: undefined }] as const),
    ['result_id not a uuid', { result_id: "x'; DROP TABLE quality.verification_log;--" }], ['order_id empty', { order_id: '' }], ['order_item_id number', { order_item_id: 7 }], ['test_id null', { test_id: null }],
    ['analyte_id injection', { analyte_id: "1' OR '1'='1" }], ['result_version_no 0', { result_version_no: 0 }], ['result_version_no negative', { result_version_no: -1 }], ['result_version_no fraction', { result_version_no: 1.5 }],
    ['result_version_no string', { result_version_no: '2' }], ['result_version_no huge', { result_version_no: 1e12 }], ['mode missing', { mode: undefined }], ['mode unknown', { mode: 'semi' }], ['mode injection', { mode: "auto'; --" }],
    ['verified_at garbage', { verified_at: 'yesterday' }], ['verified_at with offset', { verified_at: '2026-11-14T15:44:58.123+05:45' }],
  ])('malformed payload (%s): rejects with a fixed-message Error BEFORE any query (never interpolated, never half-applied)', async (_n, over) => {
    const { ctx, queries } = jobCtx(A); const e: any = await failure(Promise.resolve(resultVerified(envelope(A, manual(over as P)), ctx)));
    expect(e).toBeInstanceOf(Error); expect(queries).toEqual([]);
    expect(String(e.message)).not.toMatch(/DROP TABLE|OR '1'|yesterday|semi/);
  });
  it('a payload that is not an object rejects before any query', async () => {
    for (const payload of [null, undefined, 'x', 7, []] as const) {
      // ruling C9.T-16: explicit payload key in `over` (a default param would turn `undefined` into a valid manual() payload)
      const { ctx, queries } = jobCtx(A); expect(await failure(Promise.resolve(resultVerified(envelope(A, payload as never, { payload }) as never, ctx)))).toBeInstanceOf(Error); expect(queries).toEqual([]);
    }
  });
  it('an event whose payload key is deleted outright rejects before any query', async () => {
    const ev: any = envelope(A); delete ev.payload;
    const { ctx, queries } = jobCtx(A); expect(await failure(Promise.resolve(resultVerified(ev, ctx)))).toBeInstanceOf(Error); expect(queries).toEqual([]);
  });
});

describe('lab.result.verified.v1 consumer: PII / identity minimisation (S-15, S-17, REQ-SEC-098)', () => {
  it('specimen_id, verified_by_membership_id, department_id, instrument_id, processing_branch_id, origin and unknown extra fields never reach a statement value, the SQL text or a log line', async () => {
    const { ctx, queries, logs } = jobCtx(A);
    await resultVerified(envelope(A, manual({ brand_new_field: { x: 1 }, patient_note: 'SENTINEL-PHI-Sita-Karki' })), ctx);
    const text = JSON.stringify([queries, logs]);
    for (const leak of [MEMBERSHIP, SPECIMEN, DEPT, INSTR, BRANCH, 'SENTINEL-PHI-Sita-Karki', 'brand_new_field', '"instrument"']) expect(text, leak).not.toContain(leak);
  });
  it('only the eleven documented values are bound (tenant, 8 payload fields, event_id, actor) — a new payload field changes nothing', async () => {
    const a = jobCtx(A), b = jobCtx(A);
    await resultVerified(envelope(A, manual()), a.ctx); await resultVerified(envelope(A, manual({ brand_new_field: 'x', specimen_id: u(0x99) })), b.ctx);
    expect(b.queries[0]).toEqual(a.queries[0]); expect(a.queries[0]!.values).toHaveLength(11);
  });
  it('a failing statement leaves no payload value in the thrown error or the logs', async () => {
    const { ctx, logs } = jobCtx(A, { queryFails: true }); const e: any = await failure(Promise.resolve(resultVerified(envelope(A, manual({ analyte_id: u(0x77) })), ctx)));
    expect(JSON.stringify({ m: e?.message, s: e?.stack, logs })).not.toMatch(new RegExp(`${u(0x77)}|${MEMBERSHIP}|${SPECIMEN}`));
  });
});
