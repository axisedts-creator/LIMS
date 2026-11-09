// Read queries for the registers B24-B27 and the export row count / insert / enqueue for B28 (BL-T15). SELECT + INSERT only; every statement names tenant_id and binds every value.
// Keyset = (time, id) at millisecond precision (same convention as ledger.repo pageLedger). The row-count filters are the ones export_render reads with (worker tasks/export_render.ts).
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;
type Row = Record<string, unknown>;
interface Range { tenantId: string; fiscalYearBs?: string; issuedAtFrom?: string; issuedAtTo?: string; centreId?: string; afterTime?: string; afterId?: string; afterKey?: string; afterFy?: string; limit: number }

/** Builds `AND ...` conditions on the alias columns; `time` is the timestamptz column the range and keyset use. */
function where(p: unknown[], a: Range, time: string, alias: string, fy: boolean): string {
  const add = (v: unknown) => { p.push(v); return '$' + p.length; };
  let w = `${alias}.tenant_id = $1`;
  if (fy && a.fiscalYearBs !== undefined) w += ` AND ${alias}.fiscal_year_bs = ${add(a.fiscalYearBs)}`;
  if (a.issuedAtFrom !== undefined) w += ` AND ${time} >= ${add(a.issuedAtFrom)}::timestamptz`;
  if (a.issuedAtTo !== undefined) w += ` AND ${time} <= ${add(a.issuedAtTo)}::timestamptz`;
  if (a.centreId !== undefined) w += ` AND ${alias}.centre_id = ${add(a.centreId)}`;
  if (a.afterTime !== undefined && a.afterId !== undefined) w += ` AND (date_trunc('milliseconds', ${time}), ${alias}.id) > (${add(a.afterTime)}::timestamptz, ${add(a.afterId)}::uuid)`;
  return w;
}

export async function listSalesRegister(tx: Q, a: Range): Promise<Row[]> {
  const p: unknown[] = [a.tenantId];
  const w = where(p, a, 'i.issued_at', 'i', true);
  p.push(a.limit);
  return (await tx.query(
    'SELECT i.id, i.invoice_seq, i.invoice_no, i.issued_at, i.invoice_date_bs, i.buyer_name, i.buyer_pan, i.exempt_paisa, i.taxable_paisa, i.vat_paisa, i.other_tax_paisa, i.net_paisa, i.status ' +
    'FROM billing.invoices i WHERE ' + w + " ORDER BY date_trunc('milliseconds', i.issued_at), i.id LIMIT $" + p.length, p)).rows;
}

export async function listCancelledInvoices(tx: Q, a: Range): Promise<Row[]> {
  const p: unknown[] = [a.tenantId];
  const w = where(p, a, 'i.cancelled_at', 'i', true) + " AND i.status = 'cancelled'";
  p.push(a.limit);
  return (await tx.query(
    'SELECT i.id, i.invoice_seq, i.invoice_no, i.cancelled_at, i.buyer_name, i.buyer_pan, i.net_paisa, i.cancel_reason_code, c.credit_note_no ' +
    'FROM billing.invoices i LEFT JOIN billing.credit_notes c ON c.tenant_id = i.tenant_id AND c.id = i.credit_note_id WHERE ' + w +
    " ORDER BY date_trunc('milliseconds', i.cancelled_at), i.id LIMIT $" + p.length, p)).rows;
}

export async function listCreditNoteRegister(tx: Q, a: Range): Promise<Row[]> {
  const p: unknown[] = [a.tenantId];
  const { afterTime: _t, afterId, afterKey, afterFy, ...range } = a;   // keyset is (fiscal_year_bs, credit_note_seq, id), not time: 02-TRD §5.2 "ordered by credit_note_seq"
  let w = where(p, range, 'c.issued_at', 'c', true);
  if (afterKey !== undefined && afterFy !== undefined && afterId !== undefined) {
    const at = (v: unknown) => { p.push(v); return '$' + p.length; };
    w += ` AND (c.fiscal_year_bs, c.credit_note_seq, c.id) > (${at(afterFy)}, ${at(afterKey)}::integer, ${at(afterId)}::uuid)`;
  }
  p.push(a.limit);
  return (await tx.query(
    'SELECT c.id, c.fiscal_year_bs, c.credit_note_seq, c.credit_note_no, c.issued_at, c.credit_note_date_bs, c.kind, c.invoice_no, c.buyer_name, c.buyer_pan, c.reason_code, ' +
    'c.exempt_paisa, c.taxable_paisa, c.vat_paisa, c.other_tax_paisa, c.net_paisa FROM billing.credit_notes c WHERE ' + w +
    ' ORDER BY c.fiscal_year_bs, c.credit_note_seq, c.id LIMIT $' + p.length, p)).rows;
}

/** Newest first. `details` is deliberately not selected (non-PHI by contract, but it is never part of the trail DTO). */
export async function listAuditTrail(tx: Q, a: { tenantId: string; actorMembershipId?: string; action?: string; occurredAtFrom?: string; occurredAtTo?: string; afterTime?: string; afterId?: string; limit: number }): Promise<Row[]> {
  const p: unknown[] = [a.tenantId];
  const add = (v: unknown) => { p.push(v); return '$' + p.length; };
  let w = 'l.tenant_id = $1';
  if (a.actorMembershipId !== undefined) w += ` AND l.actor_membership_id = ${add(a.actorMembershipId)}`;
  if (a.action !== undefined) w += ` AND l.action = ${add(a.action)}`;
  if (a.occurredAtFrom !== undefined) w += ` AND l.occurred_at >= ${add(a.occurredAtFrom)}::timestamptz`;
  if (a.occurredAtTo !== undefined) w += ` AND l.occurred_at <= ${add(a.occurredAtTo)}::timestamptz`;
  if (a.afterTime !== undefined && a.afterId !== undefined) w += ` AND (date_trunc('milliseconds', l.occurred_at), l.id) < (${add(a.afterTime)}::timestamptz, ${add(a.afterId)}::uuid)`;
  p.push(a.limit);
  return (await tx.query(
    'SELECT l.id, l.action, l.document_kind, l.document_id, l.document_no, l.actor_id, l.actor_membership_id, l.actor_type, l.occurred_at FROM billing.activity_log l WHERE ' + w +
    " ORDER BY date_trunc('milliseconds', l.occurred_at) DESC, l.id DESC LIMIT $" + p.length, p)).rows;
}

export interface ExportFilters { fiscal_year_bs?: string; from?: string; to?: string; centre_id?: string; actor_membership_id?: string }

/** Rows the export of `kind` would contain: the same predicates the render reads with. `from`/`to` are UTC instants here (the service normalises dates). */
export async function countExportRows(tx: Q, a: { tenantId: string; kind: string; filters: ExportFilters }): Promise<number> {
  const f = a.filters;
  const p: unknown[] = [a.tenantId];
  const add = (v: unknown) => { p.push(v); return '$' + p.length; };
  let sql: string, w = 't.tenant_id = $1';
  const range = (col: string) => { if (f.from !== undefined) w += ` AND ${col} >= ${add(f.from)}::timestamptz`; if (f.to !== undefined) w += ` AND ${col} <= ${add(f.to)}::timestamptz`; };
  const centre = () => { if (f.centre_id !== undefined) w += ` AND t.centre_id = ${add(f.centre_id)}`; };
  const fy = () => { if (f.fiscal_year_bs !== undefined) w += ` AND t.fiscal_year_bs = ${add(f.fiscal_year_bs)}`; };
  switch (a.kind) {
    case 'sales_register': case 'invoice_documents': fy(); centre(); range('t.issued_at'); sql = 'billing.invoices t'; break;
    case 'cancelled_invoices': fy(); centre(); range('t.cancelled_at'); w += " AND t.status = 'cancelled'"; sql = 'billing.invoices t'; break;
    case 'credit_notes': fy(); centre(); range('t.issued_at'); sql = 'billing.credit_notes t'; break;
    case 'audit_trail': range('t.occurred_at'); if (f.actor_membership_id !== undefined) w += ` AND t.actor_membership_id = ${add(f.actor_membership_id)}`; sql = 'billing.activity_log t'; break;
    case 'daily_cash': centre(); range('t.created_at'); w += " AND t.entry_kind IN ('payment', 'reversal', 'refund')"; sql = 'billing.ledger_entries t'; break;
    default: throw new Error('unknown export kind');
  }
  const { rows } = await tx.query('SELECT count(*)::int AS count FROM ' + sql + ' WHERE ' + w, p);
  return Number(rows[0]?.['count'] ?? 0);
}

/** `row` = snake_case billing.export_jobs columns (status queued). Returns the stored row. */
export async function insertExportJob(tx: Q, row: Record<string, unknown>): Promise<Row> {
  const { rows } = await tx.query(
    `INSERT INTO billing.export_jobs (id, tenant_id, kind, format, filters, status, requested_by_membership_id, created_at, created_by, updated_at, updated_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'queued', $6, $7::timestamptz, $8, $9::timestamptz, $10) RETURNING *`,
    [row['id'], row['tenant_id'], row['kind'], row['format'], JSON.stringify(row['filters'] ?? {}), row['requested_by_membership_id'], row['created_at'], row['created_by'], row['updated_at'], row['updated_by']]);
  return rows[0]!;
}

/** TRD §9 outbox: job billing.export_render {tenant_id, export_id}, in the creating transaction. */
export async function enqueueExportRender(tx: Q, a: { tenantId: string; exportId: string }): Promise<void> {
  await tx.query('SELECT app.enqueue_job($1, $2::jsonb, $3)', ['billing.export_render', JSON.stringify({ tenant_id: a.tenantId, export_id: a.exportId }), `export:${a.exportId}`]);
}
