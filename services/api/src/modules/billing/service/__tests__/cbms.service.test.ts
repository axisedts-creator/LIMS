// BL-T14 CBMS service (service/cbms.service.ts): submit (the body of job billing.cbms_sync), retry (B31), list (B30), backoff.
// PRD US-BL-13.1-13.4; 02-TRD §5.2 B30/B31, §9 (CbmsClient, outcomes, state per document, idempotencyKey `<kind>:<id>`, backoff min(2^attempts min, 6 h) [CONV]);
// 03-APP-FLOW §1.6; 05-SCHEMA cbms_submissions (UNIQUE tenant,kind,doc,attempt_no) + invoices/credit_notes cbms guards; 07-SECURITY item 7 (fiscal fields only, no test names).
// Fails now: ../cbms.service.js does not exist. ASSUMED API: see the header of t14.helpers.ts (writer: object via a dispute if wrong).
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { cbmsBackoffMs, createCbmsService } from '../cbms.service.js';
import { BASE, DOC, doc, errCode, KINDS, makeCbmsWorld, scriptedClient, SECRET, TENANT_A, TENANT_B, USER, type CbmsWorld, type Kind } from './t14.helpers.js';

const svcOf = (w: CbmsWorld, client: unknown) => createCbmsService({ repo: w.repo as never, client: client as never }) as any;
const submit = (w: CbmsWorld, client: unknown, kind: Kind = 'invoice', ctx = w.ctx()) => w.tx(() => svcOf(w, client).submit(ctx, { documentKind: kind, documentId: DOC[kind] }));
const MIN = 60_000, H = 60 * MIN;

describe('US-BL-13.1 the stub never marks a document synced', () => {
  for (const kind of KINDS) {
    it(`${kind}: stub_recorded -> one cbms_submissions row (client_mode stub), state stays pending, attempts 1, nothing synced`, async () => {
      const w = makeCbmsWorld(); w.put(doc(kind)); const client = scriptedClient(['stub_recorded'], 'stub');
      expect(await submit(w, client, kind)).toMatchObject({ submitted: true, outcome: 'stub_recorded', cbmsState: 'pending', attemptNo: 1 });
      expect(w.subsOf(kind)).toEqual([expect.objectContaining({ tenant_id: TENANT_A, document_id: DOC[kind], attempt_no: 1, client_mode: 'stub', outcome: 'stub_recorded', submitted_at: BASE, created_by: USER, external_ref: null })]);
      expect(w.get(kind)).toMatchObject({ cbms_state: 'pending', cbms_attempts: 1, cbms_last_attempt_at: BASE, cbms_synced_at: null, cbms_external_ref: null });
    });
  }
  it('submitting again and again with the stub only adds attempts 2, 3, 4 — never synced, never failed', async () => {
    const w = makeCbmsWorld(); w.put(doc('invoice')); const client = scriptedClient(['stub_recorded'], 'stub');
    for (let n = 1; n <= 4; n++) expect(await submit(w, client)).toMatchObject({ attemptNo: n, cbmsState: 'pending' });
    expect(w.subsOf('invoice').map((s) => s.attempt_no)).toEqual([1, 2, 3, 4]);
    expect(w.get('invoice')).toMatchObject({ cbms_state: 'pending', cbms_attempts: 4, cbms_synced_at: null });
  });
});

describe('US-BL-13.2 / TRD §9 each client outcome', () => {
  it('accepted (live client) -> synced, synced_at and external_ref stored on the document and on the submission; a synced document is never submitted again', async () => {
    const w = makeCbmsWorld(); w.put(doc('credit_note')); const client = scriptedClient(['accepted']);
    expect(await submit(w, client, 'credit_note')).toMatchObject({ submitted: true, outcome: 'accepted', cbmsState: 'synced', attemptNo: 1 });
    expect(w.get('credit_note')).toMatchObject({ cbms_state: 'synced', cbms_attempts: 1, cbms_synced_at: BASE, cbms_external_ref: 'EXT-0001' });
    expect(w.subsOf('credit_note')[0]).toMatchObject({ outcome: 'accepted', external_ref: 'EXT-0001', client_mode: 'live' });
    expect(await submit(w, client, 'credit_note')).toMatchObject({ submitted: false, reason: 'not_pending' });
    expect(client.calls).toHaveLength(1); expect(w.subsOf('credit_note')).toHaveLength(1);
  });
  it('rejected_permanent -> failed_permanent (finance review); it is not submitted again until B31 retry', async () => {
    const w = makeCbmsWorld(); w.put(doc('invoice')); const client = scriptedClient(['rejected_permanent']);
    expect(await submit(w, client)).toMatchObject({ outcome: 'rejected_permanent', cbmsState: 'failed_permanent' });
    expect(w.get('invoice')).toMatchObject({ cbms_state: 'failed_permanent', cbms_attempts: 1, cbms_synced_at: null });
    expect(await submit(w, client)).toMatchObject({ submitted: false, reason: 'not_pending' });
    expect(client.calls).toHaveLength(1);
  });
  it('retryable_error -> stays pending with attempts + 1, the task resolves (a throw would roll the attempt record back with the job transaction)', async () => {
    const w = makeCbmsWorld(); w.put(doc('invoice_cancellation')); const client = scriptedClient(['retryable_error']);
    expect(await submit(w, client, 'invoice_cancellation')).toMatchObject({ outcome: 'retryable_error', cbmsState: 'pending', attemptNo: 1 });
    expect(w.get('invoice_cancellation')).toMatchObject({ cbms_state: 'pending', cbms_attempts: 1, cbms_last_attempt_at: BASE });
    expect(w.subsOf('invoice_cancellation')[0]).toMatchObject({ outcome: 'retryable_error', raw_status_redacted: 'timeout' });
  });
  it('after 10 and more retryable failures the document is still pending and still submittable (the sweep never gives up); attempts keep counting', async () => {
    const w = makeCbmsWorld(); w.put(doc('invoice')); const client = scriptedClient(['retryable_error']);
    for (let n = 1; n <= 12; n++) await submit(w, client);
    expect(w.get('invoice')).toMatchObject({ cbms_state: 'pending', cbms_attempts: 12 });
    expect(w.subsOf('invoice').map((s) => s.attempt_no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
  it('a client that THROWS counts as retryable_error; the thrown message (may hold a secret) is stored nowhere', async () => {
    const w = makeCbmsWorld(); w.put(doc('invoice'));
    const client = scriptedClient([() => { throw new Error(`connect ECONNREFUSED ${SECRET}`); }]);
    expect(await submit(w, client)).toMatchObject({ outcome: 'retryable_error', cbmsState: 'pending', attemptNo: 1 });
    expect(JSON.stringify([w.x().subs, w.x().docs, w.db.events])).not.toContain(SECRET);
    expect(w.subsOf('invoice')[0]).toMatchObject({ outcome: 'retryable_error' });
  });
  it('attempt numbering continues from cbms_attempts (3 earlier attempts -> attempt_no 4)', async () => {
    const w = makeCbmsWorld(); w.put(doc('invoice', { cbms_attempts: 3 }));
    expect(await submit(w, scriptedClient(['stub_recorded'], 'stub'))).toMatchObject({ attemptNo: 4 });
    expect(w.get('invoice').cbms_attempts).toBe(4);
  });
  it('document missing or not pending -> { submitted:false }, the client is never called, nothing written', async () => {
    const w = makeCbmsWorld(); const client = scriptedClient(['accepted']);
    expect(await submit(w, client)).toMatchObject({ submitted: false, reason: 'not_found' });
    w.put(doc('invoice', { cbms_state: 'not_required' }));
    expect(await submit(w, client)).toMatchObject({ submitted: false, reason: 'not_pending' });
    expect(client.calls).toEqual([]); expect(w.x().subs).toEqual([]);
  });
  it('unknown document_kind -> common.validation_failed before any repo or client call', async () => {
    const w = makeCbmsWorld(); const client = scriptedClient(['accepted']);
    const e = await errCode(w.tx(() => svcOf(w, client).submit(w.ctx(), { documentKind: 'receipt', documentId: DOC.invoice })));
    expect(e).toBeInstanceOf(LimsError); expect(e.code).toBe('common.validation_failed');
    expect(client.calls).toEqual([]); expect(w.repoCalls).toEqual([]);
  });
  it('a failing bookkeeping write rolls the whole attempt back (no submission row without the state change)', async () => {
    const w = makeCbmsWorld(); w.put(doc('invoice'));
    (w.repo as any).recordCbmsAttempt = async () => { throw new Error('db down'); };
    await expect(submit(w, scriptedClient(['stub_recorded'], 'stub'))).rejects.toThrow('db down');
    expect(w.x().subs).toEqual([]); expect(w.get('invoice')).toMatchObject({ cbms_attempts: 0, cbms_state: 'pending' });
  });
});

describe('what the client receives (TRD §9; 07-SECURITY item 7)', () => {
  it('tenantId from ctx, idempotencyKey `<kind>:<id>` for every kind, exactly one call per submit', async () => {
    for (const kind of KINDS) {
      const w = makeCbmsWorld(); w.put(doc(kind)); const client = scriptedClient(['stub_recorded'], 'stub');
      await submit(w, client, kind);
      expect(client.calls).toHaveLength(1);
      expect(client.calls[0]).toMatchObject({ tenantId: TENANT_A, idempotencyKey: `${kind}:${DOC[kind]}` });
      expect(client.calls[0].document).toMatchObject({ kind, documentId: DOC[kind] });
    }
  });
  it('invoice projection: fiscal fields in paisa numbers, ISO UTC issue time, B.S. date, seller PAN, buyer name/PAN; no refInvoiceNo', async () => {
    const w = makeCbmsWorld(); w.put(doc('invoice')); const client = scriptedClient(['stub_recorded'], 'stub'); await submit(w, client);
    const d = client.calls[0].document;
    expect(d).toMatchObject({ kind: 'invoice', documentNo: '083/84-000001', fiscalYearBs: '2083/84', issuedAtUtc: '2026-11-08T05:00:00.000Z', dateBs: '2083-07-22',
      sellerPan: '999999999', buyerName: 'Synthetic Buyer One', buyerPan: '123456789',
      totals: { gross: 100000, discount: 0, exempt: 0, taxable: 100000, vat: 13000, otherTax: 0, net: 113000 } });
    expect(d.refInvoiceNo ?? null).toBeNull();
  });
  it('credit_note and invoice_cancellation carry refInvoiceNo (the original invoice number)', async () => {
    for (const kind of ['credit_note', 'invoice_cancellation'] as const) {
      const w = makeCbmsWorld(); w.put(doc(kind)); const client = scriptedClient(['stub_recorded'], 'stub'); await submit(w, client, kind);
      expect(client.calls[0].document.refInvoiceNo, kind).toBe('083/84-000001');
    }
  });
  it('NO test names, patient names or any column outside the CbmsDocument contract reach the client', async () => {
    const w = makeCbmsWorld(); w.put(doc('invoice')); const client = scriptedClient(['stub_recorded'], 'stub'); await submit(w, client);
    const d = client.calls[0].document;
    expect(Object.keys(d).sort()).toEqual(expect.arrayContaining(['kind', 'documentId', 'documentNo', 'fiscalYearBs', 'issuedAtUtc', 'dateBs', 'totals']));
    for (const k of Object.keys(d)) expect(['kind', 'documentId', 'documentNo', 'fiscalYearBs', 'issuedAtUtc', 'dateBs', 'sellerPan', 'buyerName', 'buyerPan', 'refInvoiceNo', 'totals']).toContain(k);
    expect(JSON.stringify(client.calls)).not.toMatch(/Synthetic Patient|Complete blood count/);
  });
});

describe('tenant isolation (REQ-SEC-024; RLS is the DB side)', () => {
  it("tenant B's job for tenant A's document id: not found, client never called, every repo call carries tenant B", async () => {
    const w = makeCbmsWorld(); w.put(doc('invoice')); const client = scriptedClient(['accepted']);
    expect(await submit(w, client, 'invoice', w.ctx({ tenantId: TENANT_B }))).toMatchObject({ submitted: false, reason: 'not_found' });
    expect(client.calls).toEqual([]); expect(w.get('invoice')).toMatchObject({ cbms_attempts: 0 });
    expect(w.repoCalls.length).toBeGreaterThan(0);
    for (const c of w.repoCalls) expect(c.args.tenantId, c.name).toBe(TENANT_B);
  });
});

describe('US-BL-13.2 B31 retry (failed_permanent -> pending)', () => {
  const retry = (w: CbmsWorld, kind: Kind = 'invoice', ctx = w.ctx(), id: string = DOC[kind]) => w.tx(() => svcOf(w, scriptedClient(['accepted'])).retry(ctx, { documentKind: kind, documentId: id }));
  for (const kind of KINDS) {
    it(`${kind}: failed_permanent -> { cbms_state: 'pending' }, attempts kept, ONE sync job cbms:${kind}:<id> enqueued`, async () => {
      const w = makeCbmsWorld(); w.put(doc(kind, { cbms_state: 'failed_permanent', cbms_attempts: 2 }));
      expect(await retry(w, kind)).toEqual({ cbms_state: 'pending' });
      expect(w.get(kind)).toMatchObject({ cbms_state: 'pending', cbms_attempts: 2 });
      expect(w.s.cbms).toEqual([{ tenantId: TENANT_A, documentKind: kind, documentId: DOC[kind] }]);
    });
  }
  // 03-APP-FLOW §2.17 "B31 re-queues failed_permanent"; retry of a pending / not_required document is spec-silent (nudge vs bulk enablement) and NOT tested.
  it('a synced document is refused with common.validation_failed (synced is terminal): no state change, no job', async () => {
    for (const state of ['synced']) {
      const w = makeCbmsWorld(); w.put(doc('invoice', { cbms_state: state }));
      expect((await errCode(retry(w))).code, state).toBe('common.validation_failed');
      expect(w.get('invoice').cbms_state).toBe(state); expect(w.s.cbms).toEqual([]);
    }
  });
  it('unknown id, another tenant\'s document, and an invoice_cancellation of an invoice that was never cancelled -> common.not_found, no job', async () => {
    const w = makeCbmsWorld(); w.put(doc('invoice', { cbms_state: 'failed_permanent' }));
    expect((await errCode(retry(w, 'invoice', w.ctx(), '01a1a98a-ac40-7000-8000-0000deadbeef'))).code).toBe('common.not_found');
    expect((await errCode(retry(w, 'invoice', w.ctx({ tenantId: TENANT_B })))).code).toBe('common.not_found');
    expect((await errCode(retry(w, 'invoice_cancellation'))).code).toBe('common.not_found');
    expect(w.s.cbms).toEqual([]); expect(w.get('invoice').cbms_state).toBe('failed_permanent');
  });
  it('unknown document_kind -> common.validation_failed', async () => {
    const w = makeCbmsWorld();
    expect((await errCode(w.tx(() => svcOf(w, scriptedClient(['accepted'])).retry(w.ctx(), { documentKind: 'payment', documentId: DOC.invoice })))).code).toBe('common.validation_failed');
  });
});

describe('B30 listDocuments', () => {
  const list = (w: CbmsWorld, input: Record<string, unknown> = {}, ctx = w.ctx()) => svcOf(w, scriptedClient(['accepted'])).listDocuments(ctx, input);
  it('rows have exactly the published CbmsDocumentRow shape (no tenant_id, no buyer, no totals), from this tenant only, with the last outcome', async () => {
    const w = makeCbmsWorld(); w.put(doc('invoice', { cbms_attempts: 1, cbms_last_attempt_at: BASE })); w.put(doc('credit_note', { tenant_id: TENANT_B }));
    w.x().subs.push({ tenant_id: TENANT_A, document_kind: 'invoice', document_id: DOC.invoice, attempt_no: 1, outcome: 'stub_recorded' });
    const out = await list(w, {});
    expect(out.data).toEqual([{ document_kind: 'invoice', document_id: DOC.invoice, document_no: '083/84-000001', cbms_state: 'pending', attempts: 1, last_attempt_at: BASE, last_outcome: 'stub_recorded' }]);
    for (const c of w.repoCalls) expect(c.args.tenantId).toBe(TENANT_A);
  });
  it('filters by state and document_kind; an unknown state or kind -> common.validation_failed', async () => {
    const w = makeCbmsWorld(); w.put(doc('invoice')); w.put(doc('credit_note', { cbms_state: 'failed_permanent' }));
    expect((await list(w, { state: 'failed_permanent' })).data.map((r: any) => r.document_kind)).toEqual(['credit_note']);
    expect((await list(w, { documentKind: 'invoice' })).data.map((r: any) => r.document_kind)).toEqual(['invoice']);
    expect((await errCode(list(w, { state: 'synchronised' }))).code).toBe('common.validation_failed');
    expect((await errCode(list(w, { documentKind: 'receipt' }))).code).toBe('common.validation_failed');
  });
});

describe('retry cadence (TRD §9 [CONV]: min(2^attempts minutes, 6 h))', () => {
  it('cbmsBackoffMs: 0->1 min, 1->2, 2->4, 5->32, 8->256, 9 and more -> capped at 6 h', () => {
    expect([0, 1, 2, 5, 8].map(cbmsBackoffMs)).toEqual([MIN, 2 * MIN, 4 * MIN, 32 * MIN, 256 * MIN]);
    for (const n of [9, 10, 20, 1000]) expect(cbmsBackoffMs(n), String(n)).toBe(6 * H);
  });
  it('monotone non-decreasing; a negative, fractional or NaN attempt count falls back to the first step (no NaN, no Infinity)', () => {
    let prev = 0; for (let n = 0; n < 40; n++) { const v = cbmsBackoffMs(n); expect(v).toBeGreaterThanOrEqual(prev); prev = v; }
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(Number.isFinite(cbmsBackoffMs(bad)), String(bad)).toBe(true);
    expect(cbmsBackoffMs(-1)).toBe(MIN);
  });
});
