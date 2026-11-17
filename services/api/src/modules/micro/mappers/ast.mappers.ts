// DB rows -> AstPanelDto (02-TRD §5.6 allowlist, REQ-SEC-081). Optional fields are omitted when NULL, never null (closed schema). Times are ISO UTC ms (02-CV §4.8).
type Row = Record<string, any>;
type Obj = Record<string, unknown>;

const iso = (v: unknown): string => new Date(v as string | number | Date).toISOString();

export function panelDto(p: Row, antibiotics: readonly Row[]): Obj {
  const out: Obj = { id: p['id'], version: p['version'], code: p['code'], version_no: p['version_no'], display: p['display'] };
  for (const k of ['organism_code', 'organism_group_code', 'specimen_site_code']) if (p[k] != null) out[k] = p[k];
  out['default_method'] = p['default_method'];
  if (p['superseded_at'] != null) out['superseded_at'] = iso(p['superseded_at']);
  out['is_active'] = p['is_active'];
  out['created_at'] = iso(p['created_at']);
  out['updated_at'] = iso(p['updated_at']);
  out['antibiotics'] = [...antibiotics].sort((a, b) => a['sort_order'] - b['sort_order']).map((a) => {
    const item: Obj = { antibiotic_code: a['antibiotic_code'], sort_order: a['sort_order'] };
    if (a['method'] != null) item['method'] = a['method'];
    item['is_reported_default'] = a['is_reported_default'];
    return item;
  });
  return out;
}
