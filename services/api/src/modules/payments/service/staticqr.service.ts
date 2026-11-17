// PG-T16 — static-QR worksheet, operations P17-P19 (02-TRD §5 rows P17-P19, §6.8; 05-SCHEMA payments.static_qr_reconciliations; AC-PG-12.2, AC-PG-12.3).
// System figures come only from billing.v_pub_payment_collection (CR-C15-009), re-read inside the saving transaction; the client sends only the bank-statement figure
// (REQ-SEC-046). The worksheet never writes the ledger, calls a port or writes an access-log row (row audit trigger only, D-112).
import { LimsError } from '../../../core/errors.js';
// [CONV] relative import until @lims/shared-ts is a services/api dependency (same as reconciliation.service.ts).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { guardActor, invalid, iso, strict, uuid, type Ctx, type Row } from '../repository/shared.js';
import { dateText, decodeCursor, isDate, moneyDto, page, pageLimit } from './reconciliation.service.js';

const FONEPAY_QR = 'fonepay_qr';                      // C4 seed payment_method_code
const KIND = 'static_qr';
const SORT = '-business_date,-id';
const NOTE_MAX = 1000, REF_MAX = 100;

const date = (v: unknown, path: string): string => (isDate(v) ? v : invalid(path));
const dto = (r: Row) => ({
  id: r['id'], business_date: dateText(r['business_date']), ...(r['centre_id'] != null ? { centre_id: r['centre_id'] } : {}),
  system_entries: Number(r['system_entries']), system_total: moneyDto(r['system_total_paisa']), statement_total: moneyDto(r['statement_total_paisa']), difference: moneyDto(r['difference_paisa']),
  statement_reference: r['statement_reference'], status: r['status'], ...(r['note'] != null ? { note: r['note'] } : {}),
  reconciled_by: r['reconciled_by'], created_at: iso(r['created_at']),
});

/** system figures of one day (and centre) from the C4 view; SUM() arrives as a string from node-pg */
async function systemFigures(ctx: Ctx, businessDate: string, centreId: string | undefined): Promise<{ entries: number; totalPaisa: number }> {
  const res = await ctx.tx.query(
    `SELECT COALESCE(SUM(entries), 0) AS entries, COALESCE(SUM(net_collected_paisa), 0) AS total FROM billing.v_pub_payment_collection
     WHERE tenant_id = $1 AND business_date = $2 AND payment_method_code = '${FONEPAY_QR}'${centreId ? ' AND centre_id = $3' : ''}`,
    centreId ? [ctx.tenantId, businessDate, centreId] : [ctx.tenantId, businessDate]);
  return { entries: Number(res.rows[0]?.['entries'] ?? 0), totalPaisa: Number(res.rows[0]?.['total'] ?? 0) };
}

export function createStaticQrService(deps: { newId?: () => string } = {}) {
  const newId = (): string => deps.newId?.() ?? uuidv7();

  async function listStaticQrReconciliations(ctx: Ctx, query?: unknown) {
    guardActor(ctx);
    const q = strict(query ?? {}, ['business_date_from', 'business_date_to', 'centre_id', 'cursor', 'limit']);
    const from = q['business_date_from'] === undefined ? undefined : date(q['business_date_from'], 'business_date_from');
    const to = q['business_date_to'] === undefined ? undefined : date(q['business_date_to'], 'business_date_to');
    const centre = q['centre_id'] === undefined ? undefined : uuid(q['centre_id'], 'centre_id');
    const limit = pageLimit(q['limit']);
    const after = q['cursor'] === undefined ? undefined : decodeCursor(q['cursor'], KIND, SORT, ['string', 'string']);
    const where = ['tenant_id = $1']; const values: unknown[] = [ctx.tenantId];
    for (const [v, cond] of [[from, 'business_date >= '], [to, 'business_date <= '], [centre, 'centre_id = ']] as const) {
      if (v !== undefined) { values.push(v); where.push(`${cond}$${values.length}`); }
    }
    // ponytail: whole filtered set read, keyset applied in JS (one worksheet per date/centre keeps it small); push the cursor into SQL if a tenant outgrows it.
    const res = await ctx.tx.query(`SELECT * FROM payments.static_qr_reconciliations WHERE ${where.join(' AND ')} ORDER BY business_date DESC, id DESC`, values);
    const { items, next } = page(res.rows, (r) => [dateText(r['business_date']), String(r['id'])], [-1, -1], after, limit, KIND, SORT);
    return { data: items.map(dto), page: { limit, ...(next ? { next_cursor: next } : {}) } };
  }

  async function previewStaticQrReconciliation(ctx: Ctx, query: unknown) {
    guardActor(ctx);
    const q = strict(query, ['business_date', 'centre_id']);
    const businessDate = date(q['business_date'], 'business_date');
    const centreId = q['centre_id'] === undefined ? undefined : uuid(q['centre_id'], 'centre_id');
    const s = await systemFigures(ctx, businessDate, centreId);
    return { business_date: businessDate, ...(centreId ? { centre_id: centreId } : {}), system_entries: s.entries, system_total: moneyDto(s.totalPaisa) };
  }

  async function createStaticQrReconciliation(ctx: Ctx, body: unknown) {
    guardActor(ctx);
    const b = strict(body, ['business_date', 'centre_id', 'statement_total_paisa', 'statement_reference', 'note']);
    const businessDate = date(b['business_date'], 'business_date');
    const centreId = b['centre_id'] === undefined ? undefined : uuid(b['centre_id'], 'centre_id');
    const statement = b['statement_total_paisa'];
    if (typeof statement !== 'number' || !Number.isSafeInteger(statement) || statement < 0) invalid('statement_total_paisa');
    const ref = b['statement_reference'];
    if (typeof ref !== 'string' || ref.length < 1 || ref.length > REF_MAX) invalid('statement_reference');
    const rawNote = b['note'];
    if (rawNote !== undefined && rawNote !== null && (typeof rawNote !== 'string' || rawNote.length > NOTE_MAX)) invalid('note');
    const note = typeof rawNote === 'string' && rawNote.trim() !== '' ? rawNote.trim() : null;   // whitespace-only = no note

    const sys = await systemFigures(ctx, businessDate, centreId);           // re-read now, never trusted from an earlier preview
    const matched = statement === sys.totalPaisa;
    if (!matched && note === null) invalid('note');                         // difference <> 0 needs a note
    const by = (ctx.actor as { membershipId?: string }).membershipId ?? ctx.actor.id;
    let res;
    try {
      // difference_paisa is GENERATED; ON CONFLICT DO NOTHING lets the two partial unique indexes decide "already reconciled" without a raw 23505.
      res = await ctx.tx.query(
        `INSERT INTO payments.static_qr_reconciliations (id, tenant_id, business_date, centre_id, system_entries, system_total_paisa, statement_total_paisa, statement_reference, status, note, reconciled_by, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $11) ON CONFLICT DO NOTHING RETURNING *`,
        [newId(), ctx.tenantId, businessDate, centreId ?? null, sys.entries, sys.totalPaisa, statement, ref, matched ? 'matched' : 'accepted_with_difference', note, by]);
    } catch (e) {
      if ((e as { code?: string })?.code === '23503') return invalid('centre_id');   // unknown / foreign centre (composite FK), not a raw database error
      throw e;
    }
    if (!res.rows[0]) throw new LimsError('payments.static_qr_already_reconciled');
    return dto(res.rows[0]);
  }

  return { listStaticQrReconciliations, previewStaticQrReconciliation, createStaticQrReconciliation };
}
