// P1 listPartnerPriceList reads (02-TRD §5.2): the partner's own partners.price_list_items + sync header. Every read binds tenant_id AND partner_id
// (partner from the token membership, never a request value) on top of RLS (US-11.4, 07-SECURITY partner finance data). q is data: prefix on code or name
// via starts_with(lower(..), lower($n)), so %, _ and \ are literal.
import { LimsError } from '../../../core/errors.js';
import { decodeCursor, encodeCursor, isoDate, isoUtc, money, parseLimit } from '../mappers/projection.dto.js';

type Q = { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> };
export interface PriceListQuery { kind?: unknown; source?: unknown; q?: unknown; sort?: unknown; cursor?: unknown; limit?: unknown }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) throw new LimsError('common.validation_failed');
  return v as T;
};

export async function listPriceList(tx: Q, tenantId: string, partnerId: string, query: PriceListQuery) {
  const kind = oneOf(query.kind, ['test', 'panel'] as const);
  const source = oneOf(query.source, ['partner', 'standard'] as const);
  const sort = oneOf(query.sort, ['code', 'name'] as const) ?? 'code';
  const q = typeof query.q === 'string' ? query.q : query.q === undefined ? '' : (() => { throw new LimsError('common.validation_failed'); })();
  if (q.length > 64) throw new LimsError('common.validation_failed');
  const limit = parseLimit(query.limit);
  const cur = decodeCursor(query.cursor, 'p', ['s', 'a', 'o']);
  if (cur && (cur['s'] !== sort || !UUID.test(cur['o']!))) throw new LimsError('common.invalid_cursor');

  const values: unknown[] = [tenantId, partnerId];
  const bind = (v: unknown) => `$${values.push(v)}`;
  const where = ['tenant_id = $1', 'partner_id = $2'];
  if (kind) where.push(`kind = ${bind(kind)}`);
  if (source) where.push(`source = ${bind(source)}`);
  if (q) { const p = bind(q); where.push(`(starts_with(lower(code), lower(${p})) OR starts_with(lower(name), lower(${p})))`); }
  if (cur) where.push(`(${sort}, orderable_id) > (${bind(cur['a'])}, ${bind(cur['o'])})`); // sort is whitelisted above
  const limitP = bind(limit + 1);
  const items = await tx.query(
    'SELECT orderable_id, kind, code, name, department_name, unit_price_paisa, source, price_list_version, effective_from, effective_to '
    + `FROM partners.price_list_items WHERE ${where.join(' AND ')} ORDER BY ${sort}, orderable_id LIMIT ${limitP}`, values);
  const sync = await tx.query('SELECT price_list_version, synced_at FROM partners.price_list_syncs WHERE tenant_id = $1 AND partner_id = $2', [tenantId, partnerId]);

  const more = items.rows.length > limit;
  const rows = items.rows.slice(0, limit);
  const last = rows.at(-1);
  const s = sync.rows[0];
  return {
    data: rows.map((r) => ({
      orderable_id: r.orderable_id, kind: r.kind, code: r.code, name: r.name,
      ...(r.department_name != null ? { department_name: r.department_name } : {}),
      unit_price: money(r.unit_price_paisa), source: r.source, price_list_version: r.price_list_version,
      effective_from: isoDate(r.effective_from),
      ...(r.effective_to != null ? { effective_to: isoDate(r.effective_to) } : {}),
    })),
    page: { limit, ...(more && last ? { next_cursor: encodeCursor({ t: 'p', s: sort, a: String(last[sort]), o: last.orderable_id }) } : {}) },
    ...(s?.price_list_version != null ? { price_list_version: s.price_list_version } : {}),
    ...(s?.synced_at != null ? { synced_at: isoUtc(s.synced_at) } : {}),
  };
}
