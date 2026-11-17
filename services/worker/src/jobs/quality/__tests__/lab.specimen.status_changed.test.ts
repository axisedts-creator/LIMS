// C9 T-19 — consumer lab.specimen.status_changed.v1 -> enqueue quality.tat_refresh_order (02-TRD §10.2, §10.3; 03-IC §3.7; 02-CV §11.4 duplicate + unknown-field tests; REQ-SEC-024, S-15). No database: a recording tx.
// SEAM: ../consumers/lab.specimen.status_changed.v1.ts exports `handle: ConsumerHandler`. Same enqueue statement as instruments.qc.received.v1 / core fanout:
//   `SELECT app.enqueue_job($1, $2::jsonb, $3, $4, $5)` with values [ 'quality.tat_refresh_order', JSON {"tenant_id": <JOB tenant>, "order_id"}, 'tat:<order_id>', now + 2 s (ISO), 5 ].
//   Enqueue ONLY when payload.to_status is one of received | rejected | recollection_ordered | ordered; any other (incl. unknown) status is a no-op (no query). The payload is otherwise not stored or logged
//   (patient_id, specimen ids, centre, parent/replaces ids never reach a statement, the job payload or a log). Tenant guard + payload shape errors throw a fixed-message Error BEFORE any query. A failing enqueue rejects.
// Fails now: "Cannot find module ../consumers/lab.specimen.status_changed.v1.js".
import { describe, expect, it } from 'vitest';
import { handle } from '../consumers/lab.specimen.status_changed.v1.js';

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const NOW = '2026-11-14T10:00:00.000Z';
const u = (n: number) => `0190c60b-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const ORDER = u(0xd1), PATIENT = u(0xd2), SPECIMEN = u(0xd3), CENTRE = u(0xd4);
function jobCtx(tenant: string | undefined, over: { queryFails?: boolean } = {}) {
  const queries: Array<{ text: string; values: unknown[] }> = []; const logs: unknown[] = [];
  const ctx: any = { tenantId: tenant, actor: { type: 'system', id: '01a1b34e-1000-7eee-9d29-d7ca59a102b5' }, requestId: u(8), now: () => NOW, attempt: 1, maxAttempts: 10, jobId: '1',
    tx: { async query(text: string, values: unknown[] = []) { queries.push({ text, values }); if (over.queryFails) throw new Error('db down'); return { rows: [] }; } },
    log: { info: (...a: unknown[]) => logs.push(a), warn: (...a: unknown[]) => logs.push(a), error: (...a: unknown[]) => logs.push(a), child() { return this; } } };
  return { ctx, queries, logs };
}
type P = Record<string, unknown>;
const payload = (o: P = {}): P => ({ specimen_id: SPECIMEN, order_id: ORDER, patient_id: PATIENT, centre_id: CENTRE, specimen_type_code: 'blood', from_status: 'collected', to_status: 'received', changed_at: '2026-11-14T09:59:00.000Z', ...o });
const envelope = (tenant: string | undefined, p: unknown = payload(), over: Record<string, unknown> = {}) => ({ event_id: u(9), event_type: 'lab.specimen.status_changed.v1', tenant_id: tenant, producer: 'lab', occurred_at: '2026-11-14T09:59:00.000Z',
  request_id: u(8), idempotency_key: `${SPECIMEN}:status:received:3`, aggregate: { type: 'specimen', id: SPECIMEN, seq: 3 }, payload: p, ...over });
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const failure = (p: Promise<unknown>) => p.then(() => undefined, (e) => e);
const call = (event: unknown, ctx: unknown) => Promise.resolve(handle(event as never, ctx as never));

describe('lab.specimen.status_changed.v1 consumer: enqueue tat_refresh_order (TRD §10.2)', () => {
  it.each(['received', 'rejected', 'recollection_ordered', 'ordered'])('to_status %s enqueues quality.tat_refresh_order once with job key tat:<order_id>, run_at = now + 2 s, max attempts 5', async (to_status) => {
    const { ctx, queries } = jobCtx(A); await call(envelope(A, payload({ to_status })), ctx);
    expect(queries).toHaveLength(1); expect(norm(queries[0]!.text)).toMatch(/^SELECT app\.enqueue_job\(\$1, \$2::jsonb, \$3, \$4, \$5\)$/);
    const [id, json, key, runAt, max] = queries[0]!.values as [string, string, string, string, number];
    expect(id).toBe('quality.tat_refresh_order'); expect(JSON.parse(json)).toEqual({ tenant_id: A, order_id: ORDER }); expect(key).toBe(`tat:${ORDER}`); expect(runAt).toBe('2026-11-14T10:00:02.000Z'); expect(max).toBe(5);
  });
  it.each(['collected', 'in_transit', 'accessioned', 'in_process', 'approved', 'reported', 'stored', 'discarded', 'brand_new_status', ''])('to_status %j is a no-op: no query at all (unknown values never throw)', async (to_status) => {
    const { ctx, queries } = jobCtx(A); await call(envelope(A, payload({ to_status })), ctx); expect(queries).toEqual([]);
  });
  it('a duplicate delivery repeats the identical statement (the inbox dedupes event ids; app.enqueue_job dedupes on the job key and never moves run_at)', async () => {
    const { ctx, queries } = jobCtx(A); await call(envelope(A), ctx); await call(envelope(A), ctx); expect(queries).toHaveLength(2); expect(queries[1]).toEqual(queries[0]);
  });
  it('a failing enqueue rejects (retry, then dead letter)', async () => {
    const { ctx } = jobCtx(A, { queryFails: true }); expect(await failure(call(envelope(A), ctx))).toBeInstanceOf(Error);
  });
});

describe('lab.specimen.status_changed.v1 consumer: tenancy, hostile input, minimisation', () => {
  it('REQ-SEC-024: an event of another tenant, without tenant, a job without tenant, or no event at all is refused before any query', async () => {
    for (const [event, tenant] of [[envelope(B), A], [envelope(undefined), A], [envelope(A), undefined], [null, A], [undefined, A]] as const) {
      const { ctx, queries } = jobCtx(tenant as string | undefined); expect(await failure(call(event, ctx)), JSON.stringify(event)?.slice(0, 50)).toBeInstanceOf(Error); expect(queries).toEqual([]);
    }
  });
  it('a tenant id smuggled inside the payload is ignored: the job payload carries the JOB tenant only', async () => {
    const { ctx, queries } = jobCtx(A); await call(envelope(A, payload({ tenant_id: B })), ctx); expect(JSON.stringify(queries)).not.toContain(B);
  });
  it.each([['order_id missing', { order_id: undefined }], ['order_id not a uuid', { order_id: "x'; DROP TABLE quality.tat_items;--" }], ['order_id empty', { order_id: '' }], ['order_id number', { order_id: 7 }], ['order_id null', { order_id: null }],
    ['to_status missing', { to_status: undefined }], ['to_status number', { to_status: 3 }], ['to_status null', { to_status: null }]])('malformed payload (%s): rejects with a fixed-message Error BEFORE any query', async (_n, over) => {
    const { ctx, queries } = jobCtx(A); const e: any = await failure(call(envelope(A, payload(over as P)), ctx)); expect(e).toBeInstanceOf(Error); expect(queries).toEqual([]); expect(String(e.message)).not.toMatch(/DROP TABLE/);
  });
  it('a payload that is not an object (or a deleted payload key) rejects before any query', async () => {
    for (const p of [null, 'x', 7, []] as const) { const { ctx, queries } = jobCtx(A); expect(await failure(call(envelope(A, p, { payload: p }), ctx))).toBeInstanceOf(Error); expect(queries).toEqual([]); }
    const ev: any = envelope(A); delete ev.payload; const { ctx, queries } = jobCtx(A); expect(await failure(call(ev, ctx))).toBeInstanceOf(Error); expect(queries).toEqual([]);
  });
  it('unknown extra fields and the optional ids change nothing; patient, specimen and centre ids never reach a statement value, the SQL text, the job payload or a log', async () => {
    const a = jobCtx(A), b = jobCtx(A); await call(envelope(A, payload()), a.ctx);
    await call(envelope(A, payload({ brand_new_field: { x: 1 }, patient_note: 'SENTINEL-PHI-Sita-Karki', processing_branch_id: u(0xd5), parent_specimen_id: u(0xd6), replaces_specimen_id: u(0xd7), order_item_ids: [u(0xd8)] })), b.ctx);
    expect(b.queries).toEqual(a.queries); const text = JSON.stringify([b.queries, b.logs]);
    for (const leak of [PATIENT, SPECIMEN, CENTRE, u(0xd5), u(0xd6), u(0xd7), u(0xd8), 'SENTINEL-PHI-Sita-Karki', 'brand_new_field']) expect(text, leak).not.toContain(leak);
  });
  it('nothing is interpolated into the SQL text', async () => {
    const { ctx, queries } = jobCtx(A); await call(envelope(A), ctx); for (const lit of [A, ORDER, 'tat:', 'quality.tat_refresh_order']) expect(queries[0]!.text, lit).not.toContain(lit);
  });
});
