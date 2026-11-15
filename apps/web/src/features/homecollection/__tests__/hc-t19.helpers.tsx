// HC-T19 shared fixtures (tester-owned; not a test file). Re-uses the HC-T18 helpers. No vi.mock here: every test file declares its own mocks.
// Synthetic data only: "Test Patient 0042", "Test Phlebo 01", phone +9779800000042 (a made-up number that must never leak outside H21).
import { HttpResponse } from 'msw';
import { API, CENTRE, DATE, U, problem } from './hc-t18.helpers';

export * from './hc-t18.helpers';
export const PHONE = '+9779800000042';
export const VISIT_ID = U(1042);
export const ORDER_ID = U(6042);
export const PERMS_REVIEW = ['homecollection.visit.read', 'homecollection.visit.assign', 'lab.specimen.label_print'];

const reasons = (rows: [string, string, boolean?][]) => rows.map(([code, display, requires_text]) => ({ code, display, requires_text: !!requires_text, is_active: true }));
/** H20 sets the visit page needs (05-SCHEMA §2). */
export const CODES19 = {
  review_reasons: reasons([
    ['confirmed_with_phlebotomist', 'Confirmed with phlebotomist'], ['order_still_valid', 'Order still valid'], ['specimen_destroyed', 'Tube destroyed'],
    ['duplicate_draw', 'Duplicate draw'], ['wrong_patient', 'Wrong patient'], ['other', 'Other', true],
  ]),
  flag_resolutions: reasons([['handled', 'Handled'], ['not_needed', 'Not needed'], ['escalated', 'Escalated'], ['other', 'Other', true]]),
  visit_cancel_reasons: reasons([['patient_cancelled', 'Patient cancelled'], ['duplicate', 'Duplicate visit'], ['other', 'Other', true]]),
  unassign_reasons: reasons([['phlebotomist_unavailable', 'Phlebotomist unavailable'], ['other', 'Other', true]]),
  revisit_reasons: reasons([['failed_visit', 'Failed visit'], ['partial_collection', 'Partial collection'], ['patient_request', 'Patient request'], ['other', 'Other', true]]),
};
export const reasonsFor = (set: string | null) => HttpResponse.json({ data: (CODES19 as Record<string, unknown>)[set ?? ''] ?? [] });

// ---- VisitDetailDto (TRD §5.3) — an `assigned` booking visit with 3 tubes: one applied, one on hold (mutation_superseded), one on hold (barcode_mismatch) ----
export const COL_HELD = {
  id: U(8001), version: 2, visit_id: VISIT_ID, specimen_id: U(9001), client_mutation_id: U(7001), status: 'held', hold_code: 'mutation_superseded', scan_method: 'camera',
  barcode_verified: true, collected_at: '2026-11-14T03:10:00.000Z', collected_by: { membership_id: U(5001), display_name: 'Test Phlebo 01' },
};
export const COL_MISMATCH = { ...COL_HELD, id: U(8002), specimen_id: U(9002), client_mutation_id: U(7002), hold_code: 'barcode_mismatch', scan_method: 'typed', barcode_verified: false };
export const COL_APPLIED = { ...COL_HELD, id: U(8003), specimen_id: U(9003), client_mutation_id: U(7003), status: 'applied', scan_method: 'scanner', hold_code: undefined };
export const detail = (o: Record<string, unknown> = {}) => ({
  id: VISIT_ID, version: 5, kind: 'booking', status: 'assigned', centre_id: CENTRE, branch_id: U(2), order_id: ORDER_ID, patient_id: U(3042), patient_display_name: 'Test Patient 0042',
  window_start: '2026-11-14T03:00:00.000Z', window_end: '2026-11-14T03:30:00.000Z', route_id: U(4001), route_date: DATE, route_sequence: 2,
  phlebotomist: { membership_id: U(5001), display_name: 'Test Phlebo 01' }, open_flag_kinds: ['held_collection'], specimens_summary: { expected: 3, collected: 1, held: 2, received: 0, rejected: 0 },
  address: { address_text: 'Ward 5, Baneshwor (synthetic)', landmark: 'Near the synthetic temple', latitude: '27.693400', longitude: '85.341200' },
  note_for_phlebotomist: 'Ring the bell twice', registration_no: 'REG-0042',
  specimens: [
    { specimen_id: U(9001), specimen_type_code: 'serum', container_code: 'red_top', status: 'ordered', collected_at: '2026-11-14T03:10:00.000Z', collection_status: 'held', scan_method: 'camera', barcode_verified: true },
    { specimen_id: U(9002), specimen_type_code: 'edta_blood', container_code: 'lavender_top', status: 'ordered', collected_at: '2026-11-14T03:11:00.000Z', collection_status: 'held', scan_method: 'typed', barcode_verified: false },
    { specimen_id: U(9003), specimen_type_code: 'urine', container_code: 'cup', status: 'collected', collected_at: '2026-11-14T03:12:00.000Z', collection_status: 'applied', scan_method: 'scanner', barcode_verified: true },
  ],
  collections: [COL_HELD, COL_MISMATCH, COL_APPLIED],
  flags: [
    { id: U(8101), version: 1, kind: 'held_collection', status: 'open', created_at: '2026-11-14T03:20:00.000Z', detail_code: 'mutation_superseded' },
    { id: U(8102), version: 3, kind: 'address_missing', status: 'resolved', created_at: '2026-11-13T05:00:00.000Z', resolved_at: '2026-11-13T06:00:00.000Z', resolution_code: 'handled', resolved_by_display: 'Test Dispatcher 07' },
  ],
  assignments: [{ membership_id: U(5001), display_name: 'Test Phlebo 01', route_date: DATE, assigned_at: '2026-11-13T07:00:00.000Z', assigned_by_display: 'Test Dispatcher 07' }],
  transitions: [
    { to: 'unassigned', at: '2026-11-13T04:00:00.000Z', actor_display: 'System' },
    { from: 'unassigned', to: 'assigned', at: '2026-11-13T07:00:00.000Z', actor_display: 'Test Dispatcher 07' },
  ],
  payments: [{ client_mutation_id: U(7100), method_code: 'cash', amount: { amount_paisa: 120000, currency: 'NPR' }, captured_at: '2026-11-14T03:15:00.000Z', outcome: 'applied' }],
  ...o,
});
export const url = (suffix = '') => `${API}/visits/${VISIT_ID}${suffix}`;
export { problem };
