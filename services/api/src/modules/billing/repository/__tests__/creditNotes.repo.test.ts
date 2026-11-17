// BL-T10 repository unit tests with a fake tx (no DB): creditNoteTasks.repo.ts and creditNotes.repo.ts. 05-SCHEMA credit_note_tasks / credit_notes / credit_note_lines, §5 grants
// (credit_note_lines: SELECT+INSERT only; credit_note_tasks: SELECT/INSERT/UPDATE; no DELETE anywhere), 07-SECURITY A11 (tenant filter on every statement), REQ-SEC-057.
// Fails now: the repo files only have getCreditNoteTask (resp. nothing) — the named functions below do not exist.
// ASSUMED API (same approach as BL-T03 repo.unit.test.ts; writer: object via a dispute if wrong). Every function takes the request `tx` first, runs bound SQL, returns snake_case rows:
//   creditNoteTasks.repo : listOpenCreditNoteTasks(tx,{tenantId,invoiceId}) -> rows           SELECT … FROM billing.credit_note_tasks WHERE tenant_id AND invoice_id AND status = 'open'
//                          resolveCreditNoteTasks(tx,{tenantId,taskIds,creditNoteId,userId,resolvedAt}) -> resolved rows
//                              ONE UPDATE … SET status='resolved', resolved_by_credit_note_id, resolved_by, resolved_at, version = version + 1, updated_* … WHERE tenant_id AND id = ANY(bound array) AND status = 'open' RETURNING *
//                              (empty taskIds -> no statement, []); a row that is not open is never touched
//                          listCreditNoteTasks(tx,{tenantId,status,limit}) -> rows            (B35: SELECT … WHERE tenant_id AND status bound, ORDER BY created_at, id, LIMIT bound)
//   creditNotes.repo     : insertCreditNote(tx,row) -> row            INSERT INTO billing.credit_notes (listed columns) VALUES ($…) RETURNING *; absent = NULL
//                          insertCreditNoteLines(tx,rows[]) -> void   INSERT INTO billing.credit_note_lines …; no UPDATE/DELETE on that table
//                          listCreditNoteLinesByInvoice(tx,{tenantId,invoiceId}) -> rows   joins billing.credit_notes; tenant bound on BOTH tables
import { describe, expect, it } from 'vitest';
import { insertCreditNote, insertCreditNoteLines, listCreditNoteLinesByInvoice } from '../creditNotes.repo.js';
import { getCreditNoteTask, listCreditNoteTasks, listOpenCreditNoteTasks, resolveCreditNoteTasks } from '../creditNoteTasks.repo.js';

const TENANT = '01a1a98a-ac40-7000-8000-00000000a001', INV = '0190c400-0000-7000-8000-000000000041', USER = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const T1 = '0190c400-0000-7000-8000-000000000051', T2 = '0190c400-0000-7000-8000-000000000052', CN = '0190c400-0000-7000-8000-000000000061';
const fakeTx = (rows: unknown[] = [], fail?: unknown) => {
  const calls: { text: string; values?: unknown[] }[] = [];
  return { calls, tx: { async query(text: string, values?: unknown[]) { calls.push({ text, values }); if (fail) throw fail; return { rows }; } } };
};
const flat = (v: unknown[] | undefined) => (v ?? []).flatMap((x) => (Array.isArray(x) ? x : [x]));

describe('creditNoteTasks.repo', () => {
  it('getCreditNoteTask (exists): tenant + id bound', async () => {
    const { tx, calls } = fakeTx([{ id: T1 }]);
    expect(await getCreditNoteTask(tx as never, { tenantId: TENANT, taskId: T1 })).toEqual({ id: T1 });
    expect(calls[0]!.values).toEqual([TENANT, T1]);
  });
  it('listOpenCreditNoteTasks: one bound SELECT on billing.credit_note_tasks, tenant + invoice, only status open', async () => {
    const { tx, calls } = fakeTx([{ id: T1 }, { id: T2 }]);
    expect(await listOpenCreditNoteTasks(tx as never, { tenantId: TENANT, invoiceId: INV })).toEqual([{ id: T1 }, { id: T2 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toMatch(/\bSELECT\b[\s\S]*\bFROM\s+billing\.credit_note_tasks\b/i);
    expect(calls[0]!.text).toMatch(/\btenant_id\s*=\s*\$1\b/i);
    expect(calls[0]!.text).toMatch(/\bstatus\s*=\s*'open'|\bstatus\s*=\s*\$\d/i);
    expect(flat(calls[0]!.values)).toEqual(expect.arrayContaining([TENANT, INV]));
  });
  it('resolveCreditNoteTasks: ONE UPDATE … status resolved … WHERE tenant AND id = ANY(bound ids) AND status open RETURNING; returns the resolved rows', async () => {
    const { tx, calls } = fakeTx([{ id: T1, status: 'resolved' }]);
    const out = await resolveCreditNoteTasks(tx as never, { tenantId: TENANT, taskIds: [T1, T2], creditNoteId: CN, userId: USER, resolvedAt: '2026-11-08T06:00:02.000Z' });
    expect(out).toEqual([{ id: T1, status: 'resolved' }]);
    expect(calls).toHaveLength(1);
    const q = calls[0]!.text;
    expect(q).toMatch(/UPDATE\s+billing\.credit_note_tasks\s+SET[\s\S]*\bstatus\s*=\s*'resolved'|UPDATE\s+billing\.credit_note_tasks\s+SET[\s\S]*\bstatus\s*=\s*\$\d/i);
    expect(q).toMatch(/\bresolved_by_credit_note_id\s*=/i); expect(q).toMatch(/\bresolved_by\s*=/i); expect(q).toMatch(/\bresolved_at\s*=/i); expect(q).toMatch(/\bversion\s*=\s*version\s*\+\s*1\b/i);
    expect(q).toMatch(/\bWHERE\b[\s\S]*\btenant_id\s*=\s*\$\d[\s\S]*\bid\s*=\s*ANY\s*\(\s*\$\d/i);
    expect(q).toMatch(/\bstatus\s*=\s*'open'/i);                       // an already resolved task is never rewritten
    expect(q).toMatch(/\bRETURNING\b/i);
    expect(q).not.toMatch(/\bDELETE\b/i);
    expect(flat(calls[0]!.values)).toEqual(expect.arrayContaining([TENANT, T1, T2, CN, USER]));
  });
  it('resolveCreditNoteTasks only writes status/resolved_*/version/updated_* (never the invoice, order or line columns of the task)', async () => {
    const { tx, calls } = fakeTx([]);
    await resolveCreditNoteTasks(tx as never, { tenantId: TENANT, taskIds: [T1], creditNoteId: CN, userId: USER, resolvedAt: '2026-11-08T06:00:02.000Z' });
    const set = /\bSET\b([\s\S]*?)\bWHERE\b/i.exec(calls[0]!.text)![1]!;
    const cols = [...set.matchAll(/\b([a-z_]+)\s*=/gi)].map((m) => m[1]!.toLowerCase());
    for (const c of cols) expect(['status', 'resolved_by_credit_note_id', 'resolved_by', 'resolved_at', 'version', 'updated_at', 'updated_by'], c).toContain(c);
  });
  it('resolveCreditNoteTasks with no ids runs nothing and returns []', async () => {
    const { tx, calls } = fakeTx([{ id: T1 }]);
    expect(await resolveCreditNoteTasks(tx as never, { tenantId: TENANT, taskIds: [], creditNoteId: CN, userId: USER, resolvedAt: 'x' })).toEqual([]);
    expect(calls).toHaveLength(0);
  });
  it('hostile ids / status stay in bound values; the SQL text is identical for any input', async () => {
    const evil = "x'; DROP TABLE billing.credit_note_tasks;--";
    const a = fakeTx([]), b = fakeTx([]);
    await resolveCreditNoteTasks(a.tx as never, { tenantId: TENANT, taskIds: [T1], creditNoteId: CN, userId: USER, resolvedAt: '2026-11-08T06:00:02.000Z' });
    await resolveCreditNoteTasks(b.tx as never, { tenantId: TENANT, taskIds: [evil], creditNoteId: CN, userId: USER, resolvedAt: '2026-11-08T06:00:02.000Z' });
    expect(b.calls[0]!.text).toBe(a.calls[0]!.text);
    expect(flat(b.calls[0]!.values)).toContain(evil);
    const c = fakeTx([]), d = fakeTx([]);
    await listCreditNoteTasks(c.tx as never, { tenantId: TENANT, status: 'open', limit: 50 });
    await listCreditNoteTasks(d.tx as never, { tenantId: TENANT, status: evil, limit: 50 });
    expect(d.calls[0]!.text).toBe(c.calls[0]!.text);
    expect(flat(d.calls[0]!.values)).toContain(evil);
  });
  it('listCreditNoteTasks (B35): tenant bound, status bound, stable ORDER BY created_at, id, LIMIT bound; a DB error is not swallowed', async () => {
    const { tx, calls } = fakeTx([{ id: T1 }]);
    expect(await listCreditNoteTasks(tx as never, { tenantId: TENANT, status: 'open', limit: 50 })).toEqual([{ id: T1 }]);
    const q = calls[0]!.text;
    expect(q).toMatch(/\bFROM\s+billing\.credit_note_tasks\b/i); expect(q).toMatch(/\btenant_id\s*=\s*\$\d/i); expect(q).toMatch(/\bstatus\s*=\s*\$\d/i);
    expect(q).toMatch(/\bORDER\s+BY\b[\s\S]*\bcreated_at\b[\s\S]*\bid\b/i); expect(q).toMatch(/\bLIMIT\s+\$\d/i);
    const boom = new Error('db down');
    await expect(listCreditNoteTasks(fakeTx([], boom).tx as never, { tenantId: TENANT, status: 'open', limit: 50 })).rejects.toBe(boom);
  });
});

const note = {
  id: CN, tenant_id: TENANT, branch_id: INV, centre_id: INV, series: 'CN', fiscal_year_bs: '2083/84', credit_note_seq: 1, credit_note_no: 'CN-083/84-000001', kind: 'cancellation', invoice_id: INV,
  invoice_no: '083/84-000001', invoice_fiscal_year_bs: '2083/84', order_id: INV, buyer_name: "Synthetic'; DROP TABLE x;--", issued_at: '2026-11-08T06:00:02.000Z', credit_note_date_bs: '2083-07-22',
  reason_code: 'billing_error', gross_paisa: 1, discount_paisa: 0, exempt_paisa: 0, taxable_paisa: 1, vat_paisa: 0, other_tax_paisa: 0, net_paisa: 1, cbms_state: 'pending', created_by: USER, updated_by: USER,
};
describe('creditNotes.repo', () => {
  it('insertCreditNote: ONE INSERT INTO billing.credit_notes … RETURNING *, every given value bound (hostile text stays a value), no created_at/version/is_active override', async () => {
    const { tx, calls } = fakeTx([{ id: CN }]);
    expect(await insertCreditNote(tx as never, note)).toEqual({ id: CN });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toMatch(/^\s*INSERT\s+INTO\s+billing\.credit_notes\s*\(/i); expect(calls[0]!.text).toMatch(/\bRETURNING\b/i);
    for (const c of ['credit_note_no', 'credit_note_seq', 'kind', 'invoice_id', 'net_paisa', 'cbms_state', 'tenant_id']) expect(calls[0]!.text, c).toContain(c);
    expect(calls[0]!.text).not.toContain('DROP TABLE');
    expect(calls[0]!.values).toEqual(expect.arrayContaining([TENANT, 'CN-083/84-000001', "Synthetic'; DROP TABLE x;--", 'cancellation', INV]));
    expect(calls[0]!.text).not.toMatch(/\b(created_at|updated_at|version)\b/i);
  });
  it('insertCreditNote: a unique violation (second cancellation note / duplicate number) and a chronology_violation P0001 propagate to the caller (the service rolls back)', async () => {
    const dup = Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'credit_notes__tenant_id_invoice_cancellation__p_uq' });
    await expect(insertCreditNote(fakeTx([], dup).tx as never, note)).rejects.toMatchObject({ code: '23505' });
    const chrono = Object.assign(new Error('chronology_violation'), { code: 'P0001', detail: 'billing.credit_notes' });
    await expect(insertCreditNote(fakeTx([], chrono).tx as never, note)).rejects.toBeDefined();
  });
  it('insertCreditNoteLines: only INSERT INTO billing.credit_note_lines (append-only table: no UPDATE/DELETE), every row\'s values bound, nothing for an empty list', async () => {
    const rows = [1, 2].map((n) => ({ id: `0190c400-0000-7000-8000-00000000007${n}`, tenant_id: TENANT, credit_note_id: CN, invoice_line_id: `0190c400-0000-7000-8000-00000000008${n}`, centre_id: INV,
      gross_paisa: n, discount_paisa: 0, exempt_paisa: 0, taxable_paisa: n, vat_paisa: 0, other_tax_paisa: 0, net_paisa: n, created_by: USER }));
    const { tx, calls } = fakeTx([]);
    await insertCreditNoteLines(tx as never, rows);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) { expect(c.text).toMatch(/^\s*INSERT\s+INTO\s+billing\.credit_note_lines\b/i); expect(c.text).not.toMatch(/\b(UPDATE|DELETE)\b/i); }
    const all = calls.flatMap((c) => flat(c.values));
    for (const r of rows) expect(all).toEqual(expect.arrayContaining([r.id, r.invoice_line_id]));
    const e = fakeTx([]);
    await insertCreditNoteLines(e.tx as never, []);
    expect(e.calls).toHaveLength(0);
  });
  it('listCreditNoteLinesByInvoice: SELECT joined to billing.credit_notes, tenant bound and applied to BOTH tables, invoice bound', async () => {
    const { tx, calls } = fakeTx([{ invoice_line_id: INV }]);
    expect(await listCreditNoteLinesByInvoice(tx as never, { tenantId: TENANT, invoiceId: INV })).toEqual([{ invoice_line_id: INV }]);
    const q = calls[0]!.text;
    expect(q).toMatch(/\bFROM\s+billing\.credit_note_lines\b/i); expect(q).toMatch(/\bbilling\.credit_notes\b/i);
    expect((q.match(/\btenant_id\s*=\s*\$1\b/gi) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(flat(calls[0]!.values)).toEqual(expect.arrayContaining([TENANT, INV]));
  });
});
