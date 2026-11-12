// Engagement coded sets (05-SCHEMA §3 "coded sets"): global tables engagement.g_cs_<set> (no tenant column, read-only seeds).
// The table name comes from this closed map, never from input.
import type { Tx } from '../../../core/db/tx.js';

const SQL = {
  booking_cancel_reasons: 'SELECT code, display, sort_order, is_active FROM engagement.g_cs_booking_cancel_reasons ORDER BY sort_order, code',
  reminder_reasons: 'SELECT code, display, sort_order, is_active FROM engagement.g_cs_reminder_reasons ORDER BY sort_order, code',
  enquiry_categories: 'SELECT code, display, sort_order, is_active FROM engagement.g_cs_enquiry_categories ORDER BY sort_order, code',
} as const;
export type CodedSetName = keyof typeof SQL;
export const isCodedSetName = (v: unknown): v is CodedSetName => typeof v === 'string' && Object.hasOwn(SQL, v);

export async function listCodedSet(tx: Pick<Tx, 'query'>, a: { setName: CodedSetName }): Promise<Array<Record<string, any>>> {
  const { rows } = await tx.query(SQL[a.setName], []);
  return rows;
}
