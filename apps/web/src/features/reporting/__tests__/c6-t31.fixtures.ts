// C6-T31 shared synthetic fixtures (shapes copied from contracts/openapi/reporting.yaml). Synthetic data only (CLAUDE.md).
export const ORIGIN = 'http://api.test';
export const U = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;
export const REPORT = U(1), ORDER = U(2), CENTRE = U(3), V1 = U(11), V2 = U(12), V3 = U(13), NARR = U(21), ITEM = U(31), FILE = U(41), DLV = U(51), TPL = U(61);

export const READ = ['reporting.report.read'];
export const RELEASE = [...READ, 'reporting.report.release', 'reporting.report.print'];
export const BULK = [...READ, 'reporting.report.release', 'reporting.report.bulk_release'];
export const ADMIN = [...RELEASE, ...BULK, 'reporting.report.regenerate', 'reporting.token.revoke', 'billing.release.override', 'reporting.delivery.read', 'reporting.delivery.resend', 'lab.specimen.read'];

export const summary = (o: Record<string, unknown> = {}) => ({
  id: REPORT, order_id: ORDER, family: 'laboratory', centre_id: CENTRE, state: 'open', display_status: 'ready_to_release', registration_no: 'R2611050001',
  patient_display_name: 'Synthetic P.', centre_code: 'SYN-A1', referrer_name: 'Synthetic Referrer', items_total: 9, items_ready: 7, latest_version_no: 2,
  registered_at: '2026-11-05T04:15:00.000Z', updated_at: '2026-11-05T05:15:00.000Z', version: 4, ...o,
});
export const vsum = (o: Record<string, unknown> = {}) => ({ id: V2, version_no: 2, status: 'rendered', report_kind: 'final', completeness: 'complete', page_count: 3, pdf_bytes: 120000, rendered_at: '2026-11-05T05:00:00.000Z', version: 7, ...o });
export const detail = (o: Record<string, unknown> = {}) => ({
  ...summary(),
  items: [
    { order_item_id: ITEM, test_names: ['Complete blood count'], item_kind: 'test', requires_lab: true, requires_narrative: false, requires_outsourced: false, lab_ready: true, narrative_ready: false, outsourced_ready: false, item_status: 'active' },
    { order_item_id: U(32), test_names: ['Chest X-ray'], item_kind: 'test', requires_lab: false, requires_narrative: true, requires_outsourced: false, lab_ready: false, narrative_ready: false, outsourced_ready: false, item_status: 'active' },
  ],
  versions: [vsum()],
  deliveries_summary: { queued: 0, sent: 1, delivered: 2, read: 0, failed: 1, suppressed: 0 },
  ...o,
});
export const alert = (o: Record<string, unknown> = {}) => ({
  critical_event_id: U(71), report_id: REPORT, order_id: ORDER, registration_no: 'R2611050001', centre_id: CENTRE, alerted_at: '2026-11-10T03:00:00.000Z',
  recipients: [{ recipient_kind: 'referrer', status: 'delivered' }, { recipient_kind: 'staff', status: 'suppressed' }], ...o,
});
export const delivery = (o: Record<string, unknown> = {}) => ({
  id: DLV, channel: 'whatsapp', purpose: 'report_ready', recipient_kind: 'patient', status: 'failed', attempt_no: 2, destination_masked: '98••••••12', report_id: REPORT,
  report_version_no: 2, failure_code: 'no_consent', queued_at: '2026-11-05T05:00:00.000Z', failed_at: '2026-11-05T05:01:00.000Z', ...o,
});
export const outsourced = (o: Record<string, unknown> = {}) => ({ order_item_id: ITEM, report_id: REPORT, registration_no: 'R2611050001', test_names: ['Synthetic send-out test'], registered_at: '2026-11-05T04:15:00.000Z', latest_file_state: 'ready', ...o });
export const inputFile = (o: Record<string, unknown> = {}) => ({ id: FILE, kind: 'outsourced_pdf', order_item_id: ITEM, state: 'ready', original_filename: 'synthetic-external.pdf', size_bytes: 52000, page_count: 2, external_lab_name: 'Synthetic External Lab', version: 3, ...o });
export const narrative = (o: Record<string, unknown> = {}) => ({
  id: NARR, order_item_id: ITEM, test_id: U(33), test_name: 'Chest X-ray', template_kind: 'xray', status: 'draft',
  current_version: { version_no: 1, status: 'draft', sections: [{ key: 'findings', heading: 'Findings', html: '<p>Synthetic findings.</p>' }, { key: 'impression', heading: 'Impression', html: '' }], images: [] },
  history: [{ version_no: 1, status: 'draft' }], version: 5, ...o,
});
export const narrativeTemplate = (o: Record<string, unknown> = {}) => ({ id: U(34), code: 'XRAY_CHEST', name: 'Chest X-ray', kind: 'xray', sections: [{ key: 'findings', heading: 'Findings', required: true, default_html: '<p>Default findings.</p>' }, { key: 'impression', heading: 'Impression', required: true }], is_active: true, version: 1, ...o });
export const templateConfig = () => ({
  page: { size: 'A4', margin_mm: { top: 35, bottom: 40, left: 12, right: 12 } },
  letterhead: { header_asset: 'branding', footer_asset: 'branding', plain_reserve_top_mm: 35, plain_reserve_bottom_mm: 30 },
  header_fields: ['name', 'age_gender', 'reg_no'], results: { show_method_line: true, show_units_column: true, group_by_package: true, page_break_before_department: false, show_department_approved_by: true },
  signatories: { mode: 'approvers', max: 2, show_signature_images: true, label_registration: 'NMC No.' }, qr: { enabled: true, size_mm: 22, caption: 'Scan to verify' },
  watermark: { text: '', opacity: 0.08 }, disclaimers: ['Authorized signatory nominated by Lab Director.'], fonts: { base_pt: 9 }, narrative: {},
});
export const templateDetail = (o: Record<string, unknown> = {}) => ({ id: TPL, family: 'laboratory', name: 'Synthetic lab template', current_version_no: 1, draft_version_no: 2, is_active: true, version: 3, versions: [{ version_no: 1, status: 'published', published_at: '2026-11-01T00:00:00.000Z' }, { version_no: 2, status: 'draft' }], draft: { config: templateConfig(), version: 4 }, ...o });
export const msgTemplate = (o: Record<string, unknown> = {}) => ({
  code: 'REPORT_READY', purpose: 'report_ready', channels: ['whatsapp', 'sms', 'email'], params: [{ name: 'lab_name', kind: 'text', max_length: 80 }, { name: 'patient_first_name', kind: 'text', max_length: 40 }],
  texts: [
    { channel: 'sms', language: 'en', body_text: 'Your report from {lab_name} is ready.', approval_status: 'not_required', is_active: true, version: 2 },
    { channel: 'whatsapp', language: 'en', body_text: 'Hello {patient_first_name}, your report is ready.', provider_template_name: 'report_ready_v1', provider_template_language: 'en', provider_variable_order: ['patient_first_name'], approval_status: 'submitted', is_active: false, version: 1 },
  ], ...o,
});
export const channelAccount = (o: Record<string, unknown> = {}) => ({ id: U(81), channel: 'sms', provider_kind: 'sms_sparrow', sender_id: 'SYNLAB', secret_ref: 'sms/sparrow-token', callback_url_configured: true, is_active: true, version: 2, ...o });
export const settings = (o: Record<string, unknown> = {}) => ({
  auto_release: 'when_eligible', narrative_report_mode: 'separate', patient_mobile_channel_order: ['whatsapp', 'sms'], patient_email_enabled: true, referrer_delivery_enabled: true,
  referrer_channels: ['sms'], centre_delivery_enabled: false, whatsapp_fallback_minutes: 30, critical_alert_referrer_enabled: true, bulk_release_max: 100, print_critical_label: false,
  link_reissue_max_per_day: 2, dues_link_enabled: true, portal_payment_gateways: [], version: 6, ...o,
});
export const centreContact = (o: Record<string, unknown> = {}) => ({ id: U(91), centre_id: CENTRE, channel: 'sms', address_masked: '98••••••34', label: 'Front desk', is_active: true, version: 1, ...o });
export const problem = (status: number, code: string, extra: Record<string, unknown> = {}) => ({ type: `urn:lims:error:${code}`, title: code, status, code, ...extra });
export const page = <T,>(data: T[], next?: string) => ({ data, page: { limit: 50, ...(next ? { next_cursor: next } : {}) } });
