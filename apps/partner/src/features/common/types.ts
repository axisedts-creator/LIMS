// C13.T19 DTO shapes the screens read (02-TRD §5.1 partner-facing allowlists). Only the fields the screens use.
export interface Money { amount_paisa: number; currency: string }
export interface Me {
  partner: { id: string; partner_code: string; name: string };
  user: { partner_user_id: string; display_name: string; partner_role: 'partner_admin' | 'partner_member'; mfa_enrolled: boolean };
  tenant: { display_name: string; calendar_display?: string; timezone?: string };
  permissions: string[];
  features: { access_slip_enabled: boolean; conversion_mode: 'on_receipt' | 'on_submit'; include_default_price_list?: boolean };
}
export interface Patient { full_name: string; sex?: string; age_years?: number; birth_on?: string; phone_e164?: string }
export interface OrderableRef { orderable_id?: string; kind?: string; code: string; name?: string }
export interface ManifestSummary {
  id: string; manifest_no: string; state: string; line_count: number; lines_converted?: number; lines_failed?: number;
  receiving_centre?: { id: string; name: string }; submitted_at?: string | null; received_at?: string | null; pickup_request_id?: string | null; created_at?: string; version?: number;
}
export interface ManifestLine {
  id: string; line_no: number; state: string; partner_sample_ref?: string; patient: Patient;
  consents?: { sms: boolean; whatsapp: boolean; email: boolean; share_with_referrer: boolean };
  orderables: OrderableRef[]; priority: string; referrer?: { id: string; display_name: string } | null; collected_at?: string; clinical_note?: string;
  order?: { order_id: string; registration_no: string } | null; version?: number;
}
export interface Manifest extends ManifestSummary { notes?: string; collected_on?: string; lines: ManifestLine[] }
export interface PartnerOrder {
  order_id: string; registration_no: string; manifest?: { id: string; manifest_no: string }; partner_sample_ref?: string; patient: Patient; priority?: string;
  tracking_status: string; referrer?: { display_name: string } | null; registered_at?: string; last_event_at?: string; report_count?: number; has_new_report?: boolean;
}
export interface Specimen {
  specimen_id: string; specimen_type_code?: string; specimen_type_display?: string; status: string; collected_at?: string; in_transit_at?: string; received_at?: string;
  rejected_at?: string; rejection_reason_code?: string; rejection_reason_display?: string; replaces_specimen_id?: string;
}
export interface PartnerReport {
  report_id: string; version_no: number; order_id: string; registration_no: string; patient: { full_name: string }; kind: string; status: string;
  released_at?: string; panel_names?: string[]; is_new?: boolean;
}
export interface PartnerOrderDetail extends PartnerOrder { orderables?: OrderableRef[]; specimens?: Specimen[]; reports?: PartnerReport[] }
export interface PickupRequest {
  id: string; state: string; window_start?: string; window_end?: string; packages_count?: number; manifests?: { id: string; manifest_no: string }[];
  scheduled_start?: string; scheduled_end?: string; assignee_text?: string; created_at?: string; version?: number; contact_name?: string; notes?: string;
}
export interface PriceListItem {
  orderable_id: string; kind: string; code: string; name: string; department_name?: string; unit_price: Money; source: string; effective_from?: string;
}
export interface StatementMonth {
  period_month: string; fiscal_year_bs: string; invoiced: Money; paid: Money; credited: Money; closing_balance: Money; synced_at?: string;
}
export interface PartnerReferrer {
  id: string; display_name: string; qualification?: string; registration_council?: string; registration_no?: string; is_active: boolean; mapping_state: string; samples_this_month?: number; version?: number;
}
export interface PartnerUser {
  id: string; display_name: string; email_masked: string; partner_role: string; status: string; mfa_enrolled: boolean; last_login_at?: string; version?: number;
}
