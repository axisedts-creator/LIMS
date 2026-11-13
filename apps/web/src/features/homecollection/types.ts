// Plain-JSON shapes the dispatch board needs (02-TRD §5.1 VisitSummaryDto / RouteDto, H12 rows, H20 coded values).
// Rebuilt from an allow-list in server/read.server.ts, so nothing else the API sends reaches a client component.
export interface PersonRef { membership_id: string; display_name: string }
export interface SpecimensSummary { expected: number; collected: number; held: number; received: number; rejected: number }
/** Optional stored address; only present when the caller (visit page, HC-T19) has the detail DTO. */
export interface VisitAddress { address_text?: string; landmark?: string; latitude?: string; longitude?: string }

export interface VisitDto {
  id: string;
  version: number;
  kind: string;
  status: string;
  centre_id: string;
  patient_display_name: string;
  open_flag_kinds: string[];
  specimens_summary: SpecimensSummary;
  window_start?: string;
  window_end?: string;
  area_hint?: string;
  route_id?: string;
  route_date?: string;
  route_sequence?: number;
  phlebotomist?: PersonRef;
  order_id?: string;
  address?: VisitAddress;
  note_for_phlebotomist?: string;
}

export interface RouteDto {
  id: string;
  version: number;
  centre_id: string;
  route_date: string;
  phlebotomist: PersonRef;
  visit_ids_in_order: string[];
  active_visits: number;
  completed_visits: number;
  last_ack_at?: string;
}

/** H5 body as the browser sends it to the server action (re-validated in write.server.ts). */
export interface ScheduleBody {
  window_start: string;
  window_end: string;
  address: { address_text: string; landmark?: string; latitude?: string; longitude?: string };
  note_for_phlebotomist?: string;
  unset?: readonly string[];
}
export interface PhlebotomistOption { membership_id: string; display_name: string; active_visits: number; route_full: boolean }
export interface CodedValue { code: string; display: string; requires_text: boolean; is_active: boolean }
export interface BoardCodes { visit_cancel_reasons: readonly CodedValue[]; unassign_reasons: readonly CodedValue[] }
export interface Centre { id: string; name: string }
export interface BoardFilter { status: readonly string[]; kind?: string; has_open_flags?: boolean }
