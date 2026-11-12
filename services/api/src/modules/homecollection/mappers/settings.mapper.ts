// Row -> wire mappers for H18/H19 (SettingsDto) and H20 (reason item). Only contract fields leave: no id / tenant_id / audit columns.
type Obj = Record<string, any>;

export const SETTING_KEYS = ['min_app_version', 'sync_interval_seconds', 'offline_purge_hours', 'capture_gps', 'gps_retention_days', 'map_handoff_enabled',
  'manual_barcode_entry_allowed', 'second_identifier', 'collection_consent_text_version', 'collection_consent_text', 'payment_methods',
  'handover_confirmation_required', 'handover_overdue_hours', 'max_visits_per_route', 'notify_phlebotomist_on_assign', 'notify_patient_on_assign',
  'clock_tolerance_seconds'] as const;

export const toSettingsDto = (r: Obj) => ({
  version: Number(r['version']),
  min_app_version: String(r['min_app_version']),
  sync_interval_seconds: Number(r['sync_interval_seconds']),
  offline_purge_hours: Number(r['offline_purge_hours']),
  capture_gps: r['capture_gps'] === true,
  gps_retention_days: Number(r['gps_retention_days']),
  map_handoff_enabled: r['map_handoff_enabled'] === true,
  manual_barcode_entry_allowed: r['manual_barcode_entry_allowed'] === true,
  second_identifier: String(r['second_identifier']),
  collection_consent_text_version: String(r['collection_consent_text_version']),
  collection_consent_text: String(r['collection_consent_text']),
  payment_methods: (r['payment_methods'] as Obj[]).map((m) => ({ code: String(m['code']), display: String(m['display']), requires_reference: m['requires_reference'] === true })),
  handover_confirmation_required: r['handover_confirmation_required'] === true,
  handover_overdue_hours: Number(r['handover_overdue_hours']),
  max_visits_per_route: Number(r['max_visits_per_route']),
  notify_phlebotomist_on_assign: r['notify_phlebotomist_on_assign'] === true,
  notify_patient_on_assign: r['notify_patient_on_assign'] === true,
  clock_tolerance_seconds: Number(r['clock_tolerance_seconds']),
});

export const toReasonDto = (r: Obj) => ({ code: String(r['code']), display: String(r['display']), requires_text: r['requires_text'] === true, is_active: r['is_active'] === true });
