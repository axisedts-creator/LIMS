// BL-T03 repository unit tests with a fake tx (no DB). Fails now: ../counters.repo.js and ../invoices.repo.js do not exist.
// ASSUMED API (spec gives no signatures; same approach as BL-T02). Every function takes the request `tx` first, runs bound SQL, returns snake_case rows/values:
//   counters.repo : bumpCounter(tx, { tenantId, series, fiscalYearBs }) -> Promise<number | undefined>
//       ONE statement `UPDATE billing.fiscal_counters SET last_no = last_no + 1 … WHERE tenant_id=$1 AND series=$2 AND fiscal_year_bs=$3 … RETURNING last_no`,
//       values [tenantId, series, fiscalYearBs] (plus nothing interpolated); returns the new last_no, undefined when no counter row matched.
//   invoices.repo : getInvoice(tx, { tenantId, invoiceId }) -> Promise<Row | undefined>  (one SELECT … FROM billing.invoices, bound ids, first row)
//                   markInvoicePrinted(tx, { tenantId, invoiceId, userId }) -> Promise<number | undefined>
//       UPDATE billing.invoices SET print_count = print_count + 1, last_printed_at …; returns the new print_count.
//   Error contract (05-SCHEMA §5 "API mapping", 02-CV §5.7): a write on billing.invoices/credit_notes/ledger_entries that raises SQLSTATE P0001 `immutable_row`
//   (DETAIL = 'billing.<table>') is re-thrown by the repo as an Error with code `billing.invoice_immutable`, statusCode 409; any other error passes through unchanged
//   (core mapDbError then maps P0001 elsewhere to common.immutable_record).
import { describe, expect, it } from 'vitest';
import { bumpCounter } from '../counters.repo.js';
import { getInvoice, markInvoicePrinted } from '../invoices.repo.js';

const TENANT = '01a1a98a-ac40-7000-8000-00000000a001', INV = '0190c400-0000-7000-8000-000000000041', USER = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const fakeTx = (rows: unknown[] = [], fail?: unknown) => {
  const calls: { text: string; values?: unknown[] }[] = [];
  return { calls, tx: { async query(text: string, values?: unknown[]) { calls.push({ text, values }); if (fail) throw fail; return { rows }; } } };
};
const pgErr = (code: string, message: string, detail?: string) => Object.assign(new Error(message), { code, detail });
const ctr = { tenantId: TENANT, series: 'INV', fiscalYearBs: '2083/84' };

describe('counters.repo bumpCounter (gapless guard: last_no = old + 1 only)', () => {
  it('runs exactly one bound UPDATE … last_no = last_no + 1 … RETURNING last_no', async () => {
    const { tx, calls } = fakeTx([{ last_no: 7 }]);
    expect(await bumpCounter(tx as never, ctr)).toBe(7);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toMatch(/UPDATE\s+billing\.fiscal_counters\s+SET[\s\S]*\blast_no\s*=\s*last_no\s*\+\s*1\b[\s\S]*\bRETURNING\b[\s\S]*\blast_no\b/i);
    expect(calls[0]!.text).not.toMatch(/\bDELETE\b|\blast_no\s*=\s*\$/i);
    expect(calls[0]!.values).toEqual(expect.arrayContaining([TENANT, 'INV', '2083/84']));
  });
  it('returns undefined when no counter row matched (never invents a number)', async () => {
    expect(await bumpCounter(fakeTx([]).tx as never, ctr)).toBeUndefined();
  });
  it('hostile series / year stay in the bound values, the SQL text is identical', async () => {
    const a = fakeTx([]), b = fakeTx([]);
    await bumpCounter(a.tx as never, ctr);
    await bumpCounter(b.tx as never, { tenantId: TENANT, series: "INV'; DROP TABLE billing.invoices;--", fiscalYearBs: "x' OR '1'='1" });
    expect(b.calls[0]!.text).toBe(a.calls[0]!.text);
    expect(b.calls[0]!.values).toEqual(expect.arrayContaining(["INV'; DROP TABLE billing.invoices;--", "x' OR '1'='1"]));
  });
  it('a refused guard (P0001 immutable_row on fiscal_counters) propagates raw, not as billing.invoice_immutable', async () => {
    const e = pgErr('P0001', 'immutable_row', 'billing.fiscal_counters');
    await expect(bumpCounter(fakeTx([], e).tx as never, ctr)).rejects.toBe(e);
  });
});

describe('invoices.repo', () => {
  it('getInvoice: one bound SELECT from billing.invoices, first row or undefined', async () => {
    const { tx, calls } = fakeTx([{ id: INV }, { id: 'other' }]);
    expect(await getInvoice(tx as never, { tenantId: TENANT, invoiceId: INV })).toEqual({ id: INV });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toMatch(/\bSELECT\b[\s\S]*\bFROM\s+billing\.invoices\b/i);
    expect(calls[0]!.values).toEqual(expect.arrayContaining([TENANT, INV]));
    expect(await getInvoice(fakeTx([]).tx as never, { tenantId: TENANT, invoiceId: INV })).toBeUndefined();
  });
  it('markInvoicePrinted: print_count = print_count + 1 only, returns the new count', async () => {
    const { tx, calls } = fakeTx([{ print_count: 2 }]);
    expect(await markInvoicePrinted(tx as never, { tenantId: TENANT, invoiceId: INV, userId: USER })).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toMatch(/UPDATE\s+billing\.invoices\s+SET[\s\S]*\bprint_count\s*=\s*print_count\s*\+\s*1\b/i);
    expect(calls[0]!.text).not.toMatch(/\b(net_paisa|gross_paisa|vat_paisa|invoice_no|buyer_name)\s*=/i);
    expect(calls[0]!.values).toEqual(expect.arrayContaining([TENANT, INV]));
  });
  it('markInvoicePrinted: also bumps version (03-APP-FLOW §2.10 step 2) so optimistic concurrency notices a print', async () => {
    const { tx, calls } = fakeTx([{ print_count: 2 }]);
    await markInvoicePrinted(tx as never, { tenantId: TENANT, invoiceId: INV, userId: USER });
    expect(calls[0]!.text).toMatch(/\bversion\s*=\s*version\s*\+\s*1\b/i);
  });
  it('markInvoicePrinted on an unknown invoice -> undefined', async () => {
    expect(await markInvoicePrinted(fakeTx([]).tx as never, { tenantId: TENANT, invoiceId: INV, userId: USER })).toBeUndefined();
  });
  it('US-BL-02.1: P0001 immutable_row on billing.invoices -> 409 billing.invoice_immutable', async () => {
    const e = pgErr('P0001', 'immutable_row', 'billing.invoices');
    await expect(markInvoicePrinted(fakeTx([], e).tx as never, { tenantId: TENANT, invoiceId: INV, userId: USER }))
      .rejects.toMatchObject({ code: 'billing.invoice_immutable', statusCode: 409 });
  });
  it('the remapped error leaks nothing from the DB (REQ-SEC-026)', async () => {
    const e = pgErr('P0001', 'immutable_row', 'billing.invoices');
    const r = await markInvoicePrinted(fakeTx([], e).tx as never, { tenantId: TENANT, invoiceId: INV, userId: USER }).catch((x: Error) => x);
    expect(JSON.stringify({ m: (r as Error).message, ...(r as object) })).not.toMatch(/billing\.invoices|fiscal_counters|detail/i);
  });
  it('other errors pass through unchanged (no blanket remap)', async () => {
    for (const e of [pgErr('23505', 'dup'), pgErr('40001', 'serialization'), pgErr('P0001', 'chronology_violation', 'billing.invoices'), new Error('boom')]) {
      await expect(markInvoicePrinted(fakeTx([], e).tx as never, { tenantId: TENANT, invoiceId: INV, userId: USER })).rejects.toBe(e);
    }
  });
});
