// DTO allowlists of 02-TRD §5.10 for #1-#13: only listed fields leave; no tenant_id / created_by / updated_* / unknown columns; no null on the wire (absent optional = key omitted).
type Row = Record<string, any>;

const iso = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString();
const day = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);
const opt = (k: string, v: unknown): Row => (v === null || v === undefined ? {} : { [k]: v });

export const lotDto = (r: Row, today: string): Row => ({
  id: r['id'], version: r['version'], level_id: r['level_id'], material_id: r['material_id'], lot_no: r['lot_no'],
  expires_on: day(r['expires_on']), is_expired: day(r['expires_on']) < today, is_active: r['is_active'],
});

export const levelDto = (r: Row, lots?: Row[], today?: string): Row => ({
  id: r['id'], version: r['version'], material_id: r['material_id'], level_code: r['level_code'], display_name: r['display_name'], sort_order: r['sort_order'], is_active: r['is_active'],
  ...(lots && today ? { lots: lots.map((l) => lotDto(l, today)) } : {}),
});

const addDays = (d: string, n: number): string => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** lots_expiring_30d: active lots with expires_on in [today, today+30] on the tenant's business date. */
export const expiring30d = (lots: Row[], today: string): number => {
  if (!lots.length) return 0;
  const to = addDays(today, 30);
  return lots.filter((l) => l['is_active'] && day(l['expires_on']) >= today && day(l['expires_on']) <= to).length;
};

/** `withLots` = nest each level's lots (get / update); otherwise levels carry no `lots` key. */
export function materialDto(m: Row, levels: Row[], lots: Row[], today: string, withLots: boolean): Row {
  const byLevel = [...levels].sort((a, b) => a['sort_order'] - b['sort_order'] || String(a['id']).localeCompare(String(b['id'])));
  return {
    id: m['id'], version: m['version'], code: m['code'], name: m['name'], ...opt('manufacturer', m['manufacturer']), ...opt('matrix', m['matrix']),
    is_active: m['is_active'],
    levels: byLevel.map((l) => levelDto(l, withLots ? lots.filter((x) => x['level_id'] === l['id']) : undefined, today)),
    lots_expiring_30d: expiring30d(lots, today), created_at: iso(m['created_at']),
  };
}

export const idMapDto = (r: Row, label?: { instrument_code: string; display_name: string }): Row => ({
  id: r['id'], version: r['version'], instrument_id: r['instrument_id'],
  ...(label ? { instrument_label: `${label.display_name} (${label.instrument_code})` } : {}),
  control_id_raw: r['control_id_raw'], ...opt('control_lot_raw', r['control_lot_raw']), lot_id: r['lot_id'], is_active: r['is_active'],
});
