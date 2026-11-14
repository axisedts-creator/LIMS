// C6-T15 — row -> API shape for R1-R5 (02-TRD §6.2 field allowlists). Whitelist by construction: only the keys named here ever leave; null/undefined are omitted (02-CV §4).
type Row = Record<string, any>;
const iso = (v: unknown): string | undefined => (v == null ? undefined : new Date(v as string | Date).toISOString());
const num = (v: unknown): number | undefined => (v == null ? undefined : Number(v));
const put = (o: Row, k: string, v: unknown) => { if (v !== undefined && v !== null) o[k] = v; };

export type DisplayStatus = 'awaiting_content' | 'assembling' | 'rendering' | 'render_failed' | 'held' | 'ready_to_release' | 'released' | 'cancelled';

/** 03-APP-FLOW §1: first match wins; only the LATEST version counts. `versions` = this report's non-discarded version rows. */
export function displayStatus(r: Row, versions: Row[]): { status: DisplayStatus; heldBasis?: string } {
  if (r['state'] === 'cancelled') return { status: 'cancelled' };
  const lv = versions.find((v) => v['version_no'] === r['latest_version_no']);
  switch (lv?.['status']) {
    case 'render_failed': return { status: 'render_failed' };
    case 'rendering': return { status: 'rendering' };
    case 'rendered': return lv['held_basis'] ? { status: 'held', heldBasis: lv['held_basis'] } : { status: 'ready_to_release' };
    case 'released': return { status: 'released' };
    default: return { status: r['needs_assembly'] ? 'assembling' : 'awaiting_content' };
  }
}

const ready = (i: Row) => (!i['requires_lab'] || i['lab_ready']) && (!i['requires_narrative'] || i['narrative_ready']) && (!i['requires_outsourced'] || i['outsourced_ready']);

export function toSummary(r: Row, versions: Row[], items: Row[]): Row {
  const ds = displayStatus(r, versions); const active = items.filter((i) => i['item_status'] === 'active');
  const o: Row = { id: r['id'], order_id: r['order_id'], family: r['family'], centre_id: r['centre_id'], state: r['state'], display_status: ds.status };
  put(o, 'registration_no', r['registration_no']); put(o, 'patient_display_name', r['patient_display_name']); put(o, 'centre_code', r['centre_code']); put(o, 'referrer_name', r['referrer_name']);
  o['items_total'] = active.length; o['items_ready'] = active.filter(ready).length;
  put(o, 'latest_version_no', r['latest_version_no']); put(o, 'released_version_no', r['released_version_no']); put(o, 'held_basis', ds.heldBasis);
  put(o, 'balance_due_paisa', num(r['billing_balance_due_paisa']));
  put(o, 'registered_at', iso(r['registered_at'])); put(o, 'first_released_at', iso(r['first_released_at'])); put(o, 'updated_at', iso(r['updated_at'])); o['version'] = r['version'];
  return o;
}

export function toVersionSummary(v: Row): Row {
  const o: Row = { id: v['id'], version_no: v['version_no'], status: v['status'], report_kind: v['report_kind'], completeness: v['completeness'] };
  put(o, 'page_count', v['page_count']); put(o, 'pdf_bytes', num(v['pdf_bytes'])); put(o, 'rendered_at', iso(v['rendered_at'])); put(o, 'released_at', iso(v['released_at']));
  put(o, 'release_basis', v['release_basis']); put(o, 'audiences', v['audiences']); put(o, 'supersedes_version_no', v['supersedes_version_no']); put(o, 'superseded_at', iso(v['superseded_at']));
  put(o, 'held_basis', v['held_basis']); put(o, 'held_checked_at', iso(v['held_checked_at'])); put(o, 'last_render_error_code', v['last_render_error_code']); o['version'] = v['version'];
  return o;
}

/** [CONV] test_names[] needs the catalogue port, which R3 must not call (snapshot columns, review fix #6): returned empty, as O6 does. */
export const toItem = (i: Row): Row => ({
  order_item_id: i['order_item_id'], test_names: [] as string[], item_kind: i['orderable_kind'], requires_lab: !!i['requires_lab'], requires_narrative: !!i['requires_narrative'],
  requires_outsourced: !!i['requires_outsourced'], lab_ready: !!i['lab_ready'], narrative_ready: !!i['narrative_ready'], outsourced_ready: !!i['outsourced_ready'], item_status: i['item_status'],
});

export function toDetail(r: Row, versions: Row[], items: Row[], deliveryStatuses: Row[]): Row {
  const counts = { queued: 0, sent: 0, delivered: 0, read: 0, failed: 0, suppressed: 0 } as Record<string, number>;
  for (const d of deliveryStatuses) if (d['status'] in counts) counts[d['status']]!++;
  const o = toSummary(r, versions, items);
  o['items'] = items.map(toItem); o['versions'] = versions.map(toVersionSummary); o['deliveries_summary'] = counts; put(o, 'review_flag', r['review_flag']);
  return o;
}
