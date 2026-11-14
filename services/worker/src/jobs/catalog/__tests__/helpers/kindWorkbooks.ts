// T-25 (C3) test helper: synthetic workbooks for the kinds catalog_master / referrers / credit_parties (02-TRD §8.2).
// catalog_master is derived from the C0 starter workbook packages/test-fixtures/catalog/starter_catalog_master.xlsx (CR-C3-007): read with the T-21 XlsxReader,
// edited as plain rows, rewritten with the T-21 XlsxWriter (hidden `_meta`, every text cell neutralised by the writer). Synthetic data only.
import { readFileSync } from 'node:fs';
import { readXlsx } from '../../xlsx/XlsxReader.js';
import { writeXlsx } from '../../xlsx/XlsxWriter.js';

export type Rows = unknown[][];
export type Book = Record<string, Rows>;       // sheet name -> rows (row 0 = header); insertion order = sheet order

const STARTER_URL = new URL('../../../../../../../packages/test-fixtures/catalog/starter_catalog_master.xlsx', import.meta.url);
export const starterBytes = (): Uint8Array => new Uint8Array(readFileSync(STARTER_URL));

export async function starterBook(): Promise<Book> {
  const out: Book = {};
  for (const s of await readXlsx(starterBytes())) out[s.name] = s.rows.map((r) => [...r]);
  return out;
}
export async function toXlsx(book: Book): Promise<Uint8Array> {
  return writeXlsx(Object.entries(book).map(([name, rows]) => ({ name, rows, hidden: name === '_meta' })));
}
/** The starter workbook, optionally edited by `edit(book)`; with no edit the C0 file's own bytes. */
export async function masterXlsx(edit?: (b: Book) => void): Promise<Uint8Array> {
  if (!edit) return starterBytes();
  const b = await starterBook();
  edit(b);
  return toXlsx(b);
}

const col = (rows: Rows, name: string) => rows[0]!.indexOf(name);
/** Row (by first-column code) of a sheet, mutable. */
export function rowOf(b: Book, sheet: string, code: string, keyCol = 0): unknown[] {
  const r = b[sheet]!.slice(1).find((x) => x[keyCol] === code);
  if (!r) throw new Error(`fixture: no ${code} in ${sheet}`);
  return r;
}
export function setCell(b: Book, sheet: string, code: string, column: string, value: unknown, keyCol = 0): void {
  rowOf(b, sheet, code, keyCol)[col(b[sheet]!, column)] = value;
}
/** Appends a row given as {column: value} (missing columns blank). */
export function addRow(b: Book, sheet: string, cells: Record<string, unknown>): void {
  const h = b[sheet]![0] as string[];
  b[sheet]!.push(h.map((c) => cells[c] ?? null));
}

// ------------------------------------------------------------------------------------------------ referrers / credit_parties
export const DOCTOR_HEADER = ['doctor_code', 'display_name', 'qualification', 'registration_council', 'registration_no', 'phone_e164', 'email', 'is_verified'];
export const PARTY_HEADER = ['party_code', 'name', 'kind', 'allows_credit', 'pan', 'contact_phone_e164', 'contact_email', 'billing_address'];
const meta = (kind: string): Rows => [['key', 'value'], ['template_kind', kind], ['template_version', 1], ['tenant_catalog_revision', ''], ['exported_at', '']];

export async function referrersXlsx(rows: Rows, o: { header?: string[]; meta?: Rows | false; sheet?: string } = {}): Promise<Uint8Array> {
  const b: Book = { Instructions: [['instructions'], ['Synthetic referrers template']], Doctors: [o.header ?? DOCTOR_HEADER, ...rows] };
  if (o.sheet) { b[o.sheet] = b['Doctors']!; delete b['Doctors']; }
  if (o.meta !== false) b['_meta'] = o.meta ?? meta('referrers');
  return toXlsx(b);
}
export async function creditPartiesXlsx(rows: Rows, o: { header?: string[]; meta?: Rows | false; sheet?: string } = {}): Promise<Uint8Array> {
  const b: Book = { Instructions: [['instructions'], ['Synthetic credit parties template']], CreditParties: [o.header ?? PARTY_HEADER, ...rows] };
  if (o.sheet) { b[o.sheet] = b['CreditParties']!; delete b['CreditParties']; }
  if (o.meta !== false) b['_meta'] = o.meta ?? meta('credit_parties');
  return toXlsx(b);
}
/** doctor row in DOCTOR_HEADER order */
export const doc = (code: unknown, name: unknown, o: { qual?: unknown; council?: unknown; regNo?: unknown; phone?: unknown; email?: unknown; verified?: unknown } = {}): Rows[number] =>
  [code, name, o.qual ?? null, o.council ?? null, o.regNo ?? null, o.phone ?? null, o.email ?? null, o.verified ?? null];
/** credit party row in PARTY_HEADER order */
export const party = (code: unknown, name: unknown, kind: unknown, o: { credit?: unknown; pan?: unknown; phone?: unknown; email?: unknown; address?: unknown } = {}): Rows[number] =>
  [code, name, kind, o.credit ?? null, o.pan ?? null, o.phone ?? null, o.email ?? null, o.address ?? null];
