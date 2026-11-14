// C13.T16 shared fixtures (tester-owned; NOT a test file). Synthetic data only. DTO shapes follow contracts/openapi/partners.yaml (PartnerAdminSummary, PartnerAdmin,
// InboundManifestSummary, InboundManifest, ManifestLine, PickupRequestAdmin, ReferrerMapping, PartnerUser, PartnerSettings).
export const ORIGIN = 'http://api.test';
export const U = (n: number) => `01a1a98a-c130-7000-8000-${String(n).padStart(12, '0')}`;
export const PARTNER = U(1), PARTNER_B = U(2), MANIFEST = U(3), CENTRE = U(4), BRANCH = U(5), CREDIT = U(6), ORDER = U(7), PATIENT = U(8), DOCTOR = U(9), PICKUP = U(10), REFERRER = U(11);
export const LINE = { A: U(21), B: U(22), C: U(23), D: U(24) } as const;
export const PERM = {
  read: 'partners.partner.read', manage: 'partners.partner.manage', receive: 'partners.manifest.receive', pickup: 'partners.pickup.manage', map: 'partners.referrer.map', patientRead: 'frontdesk.patient.read',
} as const;
export const ADMIN_PERMS = [PERM.read, PERM.manage, PERM.receive, PERM.pickup, PERM.map, PERM.patientRead];
export const RECEIVER_PERMS = [PERM.receive, PERM.patientRead];

export const partnerSummary = (o: Record<string, unknown> = {}) => ({
  id: PARTNER, partner_code: 'SYN-LAB-01', name: 'Synthetic Partner Lab', status: 'active',
  credit_party: { id: CREDIT, party_code: 'CP00001', name: 'Synthetic Credit Party' },
  receiving_centre: { id: CENTRE, code: 'C000000001', name: 'Synthetic Receiving Centre' },
  active_users: 3, open_manifests: 2, ...o,
});
export const partner = (o: Record<string, unknown> = {}) => ({
  ...partnerSummary(), receiving_branch_id: BRANCH, conversion_mode: 'on_receipt', contact_email: 'ops@partner.invalid', contact_phone_e164: '+97715550100', address_text: 'Synthetic Street 1',
  created_at: '2026-10-01T04:00:00.000Z', version: 4, projection_status: { price_list_synced_at: '2026-11-13T03:00:00.000Z', statements_synced_at: '2026-11-13T02:00:00.000Z' }, ...o,
});
export const partnerUser = (n: number, o: Record<string, unknown> = {}) => ({
  id: U(60 + n), display_name: `Synthetic User ${n}`, email_masked: `u${n}***@partner.invalid`, partner_role: 'partner_member', status: 'active', mfa_enrolled: true, last_login_at: '2026-11-12T05:00:00.000Z', version: 2, ...o,
});

export const line = (id: string, n: number, o: Record<string, unknown> = {}) => ({
  id, line_no: n, state: 'submitted', partner_sample_ref: `REF-00${n}`,
  patient: { full_name: `Synthetic Patient ${'ABCD'[n - 1]}`, sex: n % 2 ? 'female' : 'male', age_years: 30 + n },
  consents: { sms: true, whatsapp: false, email: false, share_with_referrer: false, consent_text_version: 'v1' },
  orderables: [{ orderable_id: U(70 + n), kind: 'test', code: `T${n}`, name: `Synthetic Test ${n}` }],
  priority: n === 2 ? 'urgent' : 'routine', collected_at: '2026-11-12T03:00:00.000Z', clinical_note: `Synthetic clinical note ${n}`, version: 10 + n, ...o,
});
export const manifest = (o: Record<string, unknown> = {}) => ({
  id: MANIFEST, manifest_no: 'MF26000001', state: 'submitted', line_count: 4, lines_converted: 0, lines_failed: 0,
  receiving_centre: { id: CENTRE, name: 'Synthetic Receiving Centre' }, submitted_at: '2026-11-12T06:00:00.000Z', created_at: '2026-11-12T05:00:00.000Z', version: 3,
  notes: 'Synthetic box note for the lab', collected_on: '2026-11-12',
  lines: [line(LINE.A, 1), line(LINE.B, 2), line(LINE.C, 3), line(LINE.D, 4)],
  partner: { id: PARTNER, partner_code: 'SYN-LAB-01', name: 'Synthetic Partner Lab' }, ...o,
});
export const manifestSummary = (o: Record<string, unknown> = {}) => {
  const { lines: _l, notes: _n, collected_on: _c, ...s } = manifest() as Record<string, unknown>;
  return { ...s, ...o };
};
export const pickup = (o: Record<string, unknown> = {}) => ({
  id: PICKUP, state: 'requested', window_start: '2026-11-14T04:00:00.000Z', window_end: '2026-11-14T08:00:00.000Z', packages_count: 2, contact_name: 'Synthetic Rider Contact', contact_phone_e164: '+97715550111',
  manifests: [{ id: MANIFEST, manifest_no: 'MF26000001' }], created_at: '2026-11-13T03:00:00.000Z', version: 5,
  partner: { id: PARTNER, partner_code: 'SYN-LAB-01', name: 'Synthetic Partner Lab', address_text: 'Synthetic Street 1', contact_phone_e164: '+97715550100' }, ...o,
});
export const referrer = (o: Record<string, unknown> = {}) => ({
  id: REFERRER, display_name: 'Dr Synthetic Referrer', qualification: 'MBBS', registration_council: 'NMC', registration_no: 'SYN-12345', is_active: true, mapping_state: 'unmapped', samples_this_month: 30, version: 6,
  partner: { id: PARTNER, name: 'Synthetic Partner Lab' }, ...o,
});
export const settings = (o: Record<string, unknown> = {}) => ({
  default_conversion_mode: 'on_receipt', include_default_price_list: true, require_mapped_referrer: false, access_slip_enabled: false, max_lines_per_manifest: 200, draft_ttl_days: 14, pickup_max_days_ahead: 7,
  report_download_daily_cap_per_user: 500, consent_text_version: 'v1', consent_statement: 'Synthetic consent statement.', ...o,
});
export const patientHit = (o: Record<string, unknown> = {}) => ({
  id: PATIENT, patient_code: 'P-000321', full_name: 'Synthetic Existing Patient', sex: 'female', age_display: '31 Years', phone_masked: '98xxxxxx42', last_visit_at: '2026-10-01T04:00:00.000Z', is_anonymised: false, ...o,
});
export const doctorHit = (o: Record<string, unknown> = {}) => ({ id: DOCTOR, display_name: 'Dr Catalogue Match', ...o });
export const page = <T>(data: T[]) => ({ data, page: { limit: 50 } });
