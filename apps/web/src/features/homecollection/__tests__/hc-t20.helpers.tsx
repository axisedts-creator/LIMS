// HC-T20 shared test helpers (tester-owned; not a test file). Re-uses the HC-T18 helpers; adds handover / device / settings fixtures.
// Synthetic data only: tenant "Synthetic Lab Alpha", centres HC-A1 / HC-A2, "Test Phlebo 01", barcodes HCT2000nn.
import { U } from './hc-t18.helpers';

export * from './hc-t18.helpers';

// ---- permissions (CR-C17-008) ----
export const P_RECEIVE = ['homecollection.handover.receive'];
export const P_DEVICE = ['homecollection.device.manage'];
export const P_SETTINGS = ['homecollection.settings.manage'];

// ---- handovers (TRD §5.2 HandoverSummaryDto / HandoverDetailDto) ----
export const HV_ITEMS = [
  { specimen_id: U(8101), visit_id: U(8201), barcode: 'HCT200001', specimen_type_code: 'serum' },
  { specimen_id: U(8102), visit_id: U(8202), barcode: 'HCT200002', specimen_type_code: 'edta_blood' },
  { specimen_id: U(8103), visit_id: U(8203), barcode: 'HCT200003', specimen_type_code: 'urine' },
];
export const summary = (n: number, o: Record<string, unknown> = {}) => ({
  id: U(8000 + n), version: 2, status: 'pending', from: { membership_id: U(5001), display_name: 'Test Phlebo 01' }, to_centre_id: U(1),
  handed_over_at: '2026-11-14T03:00:00.000Z', item_count: 3, ...o,
});
export const detail = (n: number, o: Record<string, unknown> = {}) => ({ ...summary(n), items: HV_ITEMS.map((i) => ({ ...i })), ...o });
export const HV1 = summary(1);
export const HV2 = summary(2, { status: 'confirmed', received_count: 3, from: { membership_id: U(5002), display_name: 'Test Phlebo 02' }, handed_over_at: '2026-11-13T05:00:00.000Z' });
export const HV3 = summary(3, { status: 'discrepancy', received_count: 2, handed_over_at: '2026-11-12T05:00:00.000Z' });

// ---- devices (TRD §5.2 DeviceDto) ----
export const dev = (n: number, o: Record<string, unknown> = {}) => ({
  id: U(9000 + n), version: 3, membership_id: U(5000 + n), display_name: `Test Phlebo ${String(n).padStart(2, '0')}`, platform: 'android', os_version: '15', app_version: '1.12.0',
  model: `Synthetic Phone ${n}`, status: 'active', registered_at: '2026-11-01T04:00:00.000Z', last_seen_at: '2026-11-14T03:00:00.000Z', last_snapshot_at: '2026-11-14T02:00:00.000Z',
  last_push_at: '2026-11-14T03:30:00.000Z', max_device_seq_received: 17, ...o,
});
export const D1 = dev(1);
export const D2 = dev(2, { status: 'signed_off', app_version: '1.9.0' }); // 1.9.0 < 1.10.0 numerically (a string compare gets this wrong)
export const D3 = dev(3, { status: 'wipe_requested', wipe_requested_at: '2026-11-14T01:00:00.000Z', platform: 'ios' });
export const D4 = dev(4, { status: 'wiped', wiped_at: '2026-11-13T01:00:00.000Z' });
export const DEVICES = [D1, D2, D3, D4];
export const WIPE_REASONS = [
  { code: 'lost', display: 'Lost', requires_text: false, is_active: true },
  { code: 'stolen', display: 'Stolen', requires_text: false, is_active: true },
  { code: 'retired', display: 'Retired', requires_text: false, is_active: true },
  { code: 'reassigned', display: 'Reassigned', requires_text: false, is_active: true },
  { code: 'other', display: 'Other', requires_text: true, is_active: true },
];

// ---- settings (TRD §11.2 + version) ----
export const SETTINGS = {
  version: 7, min_app_version: '1.10.0', sync_interval_seconds: 300, offline_purge_hours: 16, capture_gps: false, gps_retention_days: 90, map_handoff_enabled: true,
  manual_barcode_entry_allowed: true, second_identifier: 'phone', collection_consent_text_version: 'hc-consent-v1', collection_consent_text: 'Synthetic consent text for tests only.',
  payment_methods: [
    { code: 'cash', display: 'Cash', requires_reference: false },
    { code: 'fonepay_qr', display: 'Fonepay QR', requires_reference: true },
    { code: 'esewa', display: 'eSewa', requires_reference: false },
    { code: 'khalti', display: 'Khalti', requires_reference: false },
  ],
  handover_confirmation_required: true, handover_overdue_hours: 4, max_visits_per_route: 40, notify_phlebotomist_on_assign: false, notify_patient_on_assign: false, clock_tolerance_seconds: 600,
};
export const SETTINGS_KEYS = Object.keys(SETTINGS).filter((k) => k !== 'version').sort();
