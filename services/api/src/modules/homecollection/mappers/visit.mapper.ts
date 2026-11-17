// Row -> wire mappers for H1 (VisitSummaryDto), H2 (VisitDetailDto + CollectionDto / VisitFlagDto) and H10 / H12 (RouteDto / eligible phlebotomist).
// Only contract fields leave (no tenant_id, audit columns, barcodes, mutation ids, payloads). Optional fields are omitted, never null (02-CV §4). No phone here: H21 only.
type Obj = Record<string, any>;

export const NO_NAME = '—';   // §2.1: a name the ports could not give

const pad = (n: number): string => String(n).padStart(2, '0');
export const iso = (v: unknown): string | undefined => (v == null ? undefined : new Date(v as string | number | Date).toISOString());
/** `date` columns arrive as a local-midnight Date from pg (or as text when the query casts it). */
export const dateOnly = (v: unknown): string | undefined => {
  if (v == null) return undefined;
  if (v instanceof Date) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  return String(v).slice(0, 10);
};
const put = (k: string, v: unknown): Obj => (v === undefined || v === null || v === '' ? {} : { [k]: v });
const name = (s: string | undefined): string => ([...(s ?? '')].slice(0, 200).join('') || NO_NAME);
const dec = (v: unknown): string | undefined => (v == null ? undefined : String(v));

export interface Names { readonly staff: ReadonlyMap<string, string>; readonly users: ReadonlyMap<string, string> }
export const staffRef = (names: Names, membershipId: string): { membership_id: string; display_name: string } =>
  ({ membership_id: membershipId, display_name: name(names.staff.get(membershipId)) });
const userName = (names: Names, userId: unknown): string => (typeof userId === 'string' ? name(names.users.get(userId)) : NO_NAME);

export interface SummaryOpts { readonly patientName?: string | undefined;readonly showAreaHint: boolean; readonly names: Names }

/** `r` = visits row + open_flag_kinds, sp_* counters, last_device_ack_at (visitQueries.repo / detail loader). */
export function toVisitSummaryDto(r: Obj, o: SummaryOpts): Obj {
  const route = dateOnly(r['route_date_text'] ?? r['route_date']);
  const hint = typeof r['address_text'] === 'string' ? [...r['address_text']].slice(0, 60).join('') : '';
  return {
    id: r['id'], version: Number(r['version']), kind: r['kind'], status: r['status'], ...put('outcome', r['outcome']),
    centre_id: r['centre_id'], branch_id: r['branch_id'], ...put('order_id', r['order_id']), patient_id: r['patient_id'], patient_display_name: name(o.patientName),
    ...put('window_start', iso(r['window_start'])), ...put('window_end', iso(r['window_end'])),
    ...put('route_id', r['route_id']), ...put('route_date', route), ...put('route_sequence', r['route_sequence'] == null ? undefined : Number(r['route_sequence'])),
    ...(r['assigned_membership_id'] ? { phlebotomist: staffRef(o.names, r['assigned_membership_id']) } : {}),
    ...(o.showAreaHint ? put('area_hint', hint) : {}),
    open_flag_kinds: [...(r['open_flag_kinds'] ?? [])],
    specimens_summary: { expected: Number(r['sp_expected'] ?? 0), collected: Number(r['sp_collected'] ?? 0), held: Number(r['sp_held'] ?? 0), received: Number(r['sp_received'] ?? 0), rejected: Number(r['sp_rejected'] ?? 0) },
    ...put('last_device_ack_at', iso(r['last_device_ack_at'])),
  };
}

export const toFlagDto = (f: Obj, names: Names): Obj => ({
  id: f['id'], version: Number(f['version']), kind: f['kind'], status: f['status'], created_at: iso(f['created_at']),
  ...put('detail_code', f['detail_code']), ...put('resolved_at', iso(f['resolved_at'])), ...put('resolution_code', f['resolution_code']),
  ...(f['resolved_by'] ? { resolved_by_display: userName(names, f['resolved_by']) } : {}),
});

export const toCollectionDto = (c: Obj, names: Names): Obj => ({
  id: c['id'], version: Number(c['version']), visit_id: c['visit_id'], specimen_id: c['specimen_id'], client_mutation_id: c['client_mutation_id'], status: c['status'],
  ...put('hold_code', c['hold_code']), scan_method: c['scan_method'], barcode_verified: c['barcode_verified'] === true, collected_at: iso(c['collected_at']),
  collected_by: staffRef(names, c['collected_by_membership_id']),
  ...(c['review_decision'] ? { review: { decision: c['review_decision'], reason_code: c['review_reason_code'], ...put('reason_text', c['review_reason_text']),
    by_display: userName(names, c['reviewed_by']), at: iso(c['reviewed_at']) } } : {}),
});

export interface DetailParts {
  readonly flags: readonly Obj[]; readonly assignments: readonly Obj[]; readonly transitions: readonly Obj[]; readonly specimens: readonly Obj[]; readonly collections: readonly Obj[];
  readonly registrationNo?: string; readonly balance?: { balanceDue: { amountPaisa: number; currency: string }; asOf: unknown };
  readonly showPii: boolean;
}

/** `r` as for the summary (counters derived by the caller from the same child rows). Address / note / registration_no / balance only when `showPii` (REQ-SEC-081). */
export function toVisitDetailDto(r: Obj, o: SummaryOpts, d: DetailParts): Obj {
  const lat = dec(r['latitude']), lon = dec(r['longitude']);
  const address = d.showPii && typeof r['address_text'] === 'string' && r['address_text']
    ? { address_text: r['address_text'], ...put('landmark', r['landmark']), ...(lat !== undefined && lon !== undefined ? { latitude: lat, longitude: lon } : {}) } : undefined;
  const lastColl = (specimenId: string): Obj | undefined => [...d.collections].reverse().find((c) => c['specimen_id'] === specimenId);
  return {
    ...toVisitSummaryDto(r, o),
    ...put('booking_id', r['booking_id']), ...put('parent_visit_id', r['parent_visit_id']),
    ...(d.showPii ? put('registration_no', d.registrationNo) : {}), ...(address ? { address } : {}),
    ...(d.showPii ? put('note_for_phlebotomist', r['note_for_phlebotomist']) : {}),
    ...put('status_reason_code', r['status_reason_code']), ...put('status_reason_text', r['status_reason_text']),
    ...put('assigned_at', iso(r['assigned_at'])), ...put('arrived_at', iso(r['arrived_at'])), ...put('completed_at', iso(r['completed_at'])), ...put('cancelled_at', iso(r['cancelled_at'])),
    specimens: d.specimens.filter((s) => s['is_active'] !== false).map((s) => {
      const c = lastColl(s['specimen_id']);
      return { specimen_id: s['specimen_id'], specimen_type_code: s['specimen_type_code'], ...put('container_code', s['container_code']), status: s['status'],
        ...(c ? { collected_at: iso(c['collected_at']), collection_status: c['status'], scan_method: c['scan_method'], barcode_verified: c['barcode_verified'] === true } : {}) };
    }),
    collections: d.collections.map((c) => toCollectionDto(c, o.names)),
    flags: d.flags.map((f) => toFlagDto(f, o.names)),
    assignments: d.assignments.filter((a) => a['action'] === 'assign' || a['action'] === 'reassign').map((a) => ({
      membership_id: a['membership_id'], display_name: name(o.names.staff.get(a['membership_id'])), route_date: dateOnly(a['route_date']), assigned_at: iso(a['created_at']),
      assigned_by_display: userName(o.names, a['created_by']) })),
    transitions: d.transitions.map((t) => ({ ...put('from', t['from_status']), to: t['to_status'], at: iso(t['at']), actor_display: userName(o.names, t['created_by']), ...put('reason_code', t['reason_code']) })),
    payments: [],   // ponytail: payments are written by the sync mutations (later task); the board shows none until then
    ...(d.showPii && d.balance ? { balance: { balance_due: { amount_paisa: Number(d.balance.balanceDue.amountPaisa), currency: d.balance.balanceDue.currency }, as_of: iso(d.balance.asOf) } } : {}),
  };
}

/** `r` = routes row + visit_ids (active, in route order) + completed_visits (listRoutesOfDay). */
export const toRouteDto = (r: Obj, names: Names): Obj => ({
  id: r['id'], version: Number(r['version']), centre_id: r['centre_id'], route_date: dateOnly(r['route_date_text'] ?? r['route_date']),
  phlebotomist: staffRef(names, r['phlebotomist_membership_id']), visit_ids_in_order: [...r['visit_ids']], active_visits: r['visit_ids'].length, completed_visits: Number(r['completed_visits']),
  ...put('last_snapshot_at', iso(r['last_snapshot_at'])), ...put('last_ack_at', iso(r['last_ack_at'])),
});

export const toEligibleDto = (m: { membershipId: string; displayName: string }, load: { routeId?: string; active: number; full: boolean }): Obj => ({
  membership_id: m.membershipId, display_name: name(m.displayName), ...put('route_id', load.routeId), active_visits: load.active, route_full: load.full,
});
