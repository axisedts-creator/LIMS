// Engagement coded sets (05-SCHEMA §3 "coded sets"): global seeds engagement.g_cs_<set> plus tenant additions/overrides
// engagement.cs_<set>; the tenant row shadows the global row by code (02-CONVENTIONS §5.5), incl. is_active=false to hide it.
// tenant_id is bound explicitly on top of RLS (REQ-SEC-024). The table name comes from this closed map, never from input.
import type { Tx } from '../../../core/db/tx.js';

const shadowed = (set: string) =>
  `SELECT code, display, sort_order, is_active FROM engagement.cs_${set} WHERE tenant_id = $1 ` +
  `UNION ALL SELECT g.code, g.display, g.sort_order, g.is_active FROM engagement.g_cs_${set} g ` +
  `WHERE NOT EXISTS (SELECT 1 FROM engagement.cs_${set} t WHERE t.tenant_id = $1 AND t.code = g.code) ORDER BY sort_order, code`;

const SQL = {
  booking_cancel_reasons: shadowed('booking_cancel_reasons'),
  reminder_reasons: shadowed('reminder_reasons'),
  enquiry_categories: shadowed('enquiry_categories'),
} as const;
export type CodedSetName = keyof typeof SQL;
export const isCodedSetName = (v: unknown): v is CodedSetName => typeof v === 'string' && Object.hasOwn(SQL, v);

export async function listCodedSet(tx: Pick<Tx, 'query'>, a: { tenantId: string; setName: CodedSetName }): Promise<Array<Record<string, any>>> {
  const { rows } = await tx.query(SQL[a.setName], [a.tenantId]);
  return rows;
}
