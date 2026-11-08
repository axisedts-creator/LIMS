// BL-T09 repository unit tests with a fake tx (no DB). Fails now: insertPrintLog / markCreditNotePrinted / listCreditNoteLines do not exist.
// ASSUMED API (same style as repo.unit.test.ts; every fn takes the request `tx` first, bound SQL only, snake_case rows):
//   printLog.repo.ts   : insertPrintLog(tx, row) -> Promise<void>   ONE `INSERT INTO billing.print_log (...) VALUES (...)`; row = { id, tenant_id, centre_id?, document_kind, document_id,
//                        document_no, print_no, is_copy, reason_code?, printed_at, created_by } (05-SCHEMA print_log); every value bound; missing optional -> NULL.
//   creditNotes.repo.ts: markCreditNotePrinted(tx, { tenantId, creditNoteId, userId }) -> Promise<number | undefined>
//                        ONE `UPDATE billing.credit_notes SET print_count = print_count + 1, last_printed_at = ... WHERE tenant_id = $ AND id = $ ... RETURNING print_count` (row lock; new count)
//                        listCreditNoteLines(tx, { tenantId, creditNoteId }) -> Promise<Row[]>  one bound SELECT from billing.credit_note_lines ORDER BY line_no
// A concurrent insert of the same (tenant, kind, document, print_no) raises 23505 print_log__tenant_id_doc_print__uq: the repo does not swallow it (the service never retries with the same number).
import { describe, expect, it } from 'vitest';
import { listCreditNoteLines, markCreditNotePrinted } from '../creditNotes.repo.js';
import { insertPrintLog } from '../printLog.repo.js';

const TENANT = '01a1a98a-ac40-7000-8000-00000000a001', CN = '0190c400-0000-7000-8000-0000000000c1', INV = '0190c400-0000-7000-8000-000000000041';
const USER = '01a1b34e-1000-7eee-9d29-d7ca59a102b5', CENTRE = '01a1a98a-ac40-7000-8000-00000000a201', ID = '0190c400-0000-7000-8000-0000000000d1';
const fakeTx = (rows: unknown[] = [], fail?: unknown) => {
  const calls: { text: string; values?: unknown[] }[] = [];
  return { calls, tx: { async query(text: string, values?: unknown[]) { calls.push({ text, values }); if (fail) throw fail; return { rows }; } } };
};
const pgErr = (code: string, message: string, detail?: string) => Object.assign(new Error(message), { code, detail });
const logRow = (over: Record<string, unknown> = {}) => ({ id: ID, tenant_id: TENANT, centre_id: CENTRE, document_kind: 'invoice', document_id: INV, document_no: '083/84-000001', print_no: 2, is_copy: true,
  reason_code: 'printer_fault', printed_at: '2026-11-08T06:00:00.000Z', created_by: USER, ...over });

describe('printLog.repo insertPrintLog', () => {
  it('one bound INSERT INTO billing.print_log; every column value is a bound parameter; no UPDATE/DELETE', async () => {
    const { tx, calls } = fakeTx();
    await insertPrintLog(tx as never, logRow());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toMatch(/^\s*INSERT\s+INTO\s+billing\.print_log\b/i);
    expect(calls[0]!.text).not.toMatch(/\bUPDATE\b|\bDELETE\b|2026-11-08|083\/84|printer_fault/i);
    expect(calls[0]!.values).toEqual(expect.arrayContaining([ID, TENANT, CENTRE, 'invoice', INV, '083/84-000001', 2, true, 'printer_fault', '2026-11-08T06:00:00.000Z', USER]));
    for (const c of ['id', 'tenant_id', 'centre_id', 'document_kind', 'document_id', 'document_no', 'print_no', 'is_copy', 'reason_code', 'printed_at', 'created_by']) expect(calls[0]!.text).toContain(c);
  });
  it('optional centre_id / reason_code absent -> NULL (not the string "undefined")', async () => {
    const { tx, calls } = fakeTx();
    const row: Record<string, unknown> = logRow({ print_no: 1, is_copy: false });
    delete row['centre_id']; delete row['reason_code'];
    await insertPrintLog(tx as never, row);
    expect(calls[0]!.values).not.toContain(undefined);
    expect(calls[0]!.values!.filter((v) => v === null)).toHaveLength(2);
  });
  it('hostile document_no / reason_code stay in the bound values, the SQL text is identical', async () => {
    const a = fakeTx(), b = fakeTx();
    await insertPrintLog(a.tx as never, logRow());
    await insertPrintLog(b.tx as never, logRow({ document_no: "x'); DROP TABLE billing.print_log;--", reason_code: "' OR '1'='1" }));
    expect(b.calls[0]!.text).toBe(a.calls[0]!.text);
    expect(b.calls[0]!.values).toEqual(expect.arrayContaining(["x'); DROP TABLE billing.print_log;--", "' OR '1'='1"]));
  });
  it('a duplicate (tenant, kind, document, print_no) -> 23505 propagates unchanged', async () => {
    const e = pgErr('23505', 'duplicate key value violates unique constraint "print_log__tenant_id_doc_print__uq"');
    await expect(insertPrintLog(fakeTx([], e).tx as never, logRow())).rejects.toBe(e);
  });
});

describe('creditNotes.repo markCreditNotePrinted / listCreditNoteLines', () => {
  it('markCreditNotePrinted: one bound UPDATE billing.credit_notes ... print_count = print_count + 1 ... RETURNING print_count; returns the new count', async () => {
    const { tx, calls } = fakeTx([{ print_count: 3 }]);
    expect(await markCreditNotePrinted(tx as never, { tenantId: TENANT, creditNoteId: CN, userId: USER })).toBe(3);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toMatch(/UPDATE\s+billing\.credit_notes\s+SET[\s\S]*\bprint_count\s*=\s*print_count\s*\+\s*1\b[\s\S]*\bWHERE\b[\s\S]*\btenant_id\s*=\s*\$\d[\s\S]*\bRETURNING\b[\s\S]*\bprint_count\b/i);
    expect(calls[0]!.text).not.toMatch(/\b(net_paisa|gross_paisa|vat_paisa|credit_note_no|buyer_name|reason_code)\s*=/i);
    expect(calls[0]!.values).toEqual(expect.arrayContaining([TENANT, CN, USER]));
  });
  it('markCreditNotePrinted on an unknown credit note (or another tenant\'s) -> undefined', async () => {
    expect(await markCreditNotePrinted(fakeTx([]).tx as never, { tenantId: TENANT, creditNoteId: CN, userId: USER })).toBeUndefined();
  });
  it('markCreditNotePrinted: other DB errors pass through unchanged', async () => {
    for (const e of [pgErr('40001', 'serialization'), pgErr('55P03', 'lock_not_available'), new Error('boom')]) {
      await expect(markCreditNotePrinted(fakeTx([], e).tx as never, { tenantId: TENANT, creditNoteId: CN, userId: USER })).rejects.toBe(e);
    }
  });
  it('listCreditNoteLines: one bound SELECT from billing.credit_note_lines for the tenant + credit note, ordered by line_no', async () => {
    const { tx, calls } = fakeTx([{ line_no: 1 }, { line_no: 2 }]);
    expect(await listCreditNoteLines(tx as never, { tenantId: TENANT, creditNoteId: CN })).toEqual([{ line_no: 1 }, { line_no: 2 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toMatch(/\bSELECT\b[\s\S]*\bFROM\s+billing\.credit_note_lines\b[\s\S]*\bORDER\s+BY\s+line_no\b/i);
    expect(calls[0]!.values).toEqual(expect.arrayContaining([TENANT, CN]));
  });
});
