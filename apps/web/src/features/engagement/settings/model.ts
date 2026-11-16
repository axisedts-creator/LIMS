// Engagement settings model (C16 W12, TRD §5 T1/T2: EngagementSettings / EngagementSettingsInput in contracts/openapi/engagement.yaml). Pure helpers, no I/O.
// LD-255 (ADMINPAGE-ENG-1): the administrator controls booking, reminder and membership settings. `version` is server-set and travels in If-Match, never in the body.

export interface EngagementSettingsBody {
  app_enabled: boolean;
  bookings_enabled: boolean;
  home_collection_enabled: boolean;
  queue_enabled: boolean;
  reminders_enabled: boolean;
  memberships_enabled: boolean;
  enquiries_enabled: boolean;
  smart_report_in_app: boolean;
  show_partner_orders: boolean;
  auto_no_show: boolean;
  auto_follow_up_reminders: boolean;
  home_collection_centre_id?: string;
  allowed_phone_prefixes: string[];
  otp_daily_cap: number;
  min_app_version_android: string;
  min_app_version_ios: string;
  app_gateways: ('esewa' | 'khalti')[];
  support_phone?: string;
  app_consent_text?: string;
  app_consent_text_version?: string;
  max_profiles_per_account: number;
  max_accounts_per_patient: number;
  link_code_ttl_hours: number;
  dormant_after_days: number;
  minor_age_years: number;
  booking_horizon_days: number;
  booking_min_lead_minutes: number;
  booking_cancel_cutoff_minutes: number;
  no_show_grace_minutes: number;
  max_active_bookings_per_profile: number;
  max_bookings_created_per_account_day: number;
  max_orderables_per_booking: number;
  booking_reminder_hours_before: number;
  follow_up_reminder_lead_days: number;
  queue_display_history_count: number;
  smart_report_disclaimer_text?: string;
}
export type EngagementSettings = EngagementSettingsBody & { version: number };

export const SWITCHES = [
  ['app_enabled', 'App'], ['bookings_enabled', 'Bookings'], ['home_collection_enabled', 'Home collection'], ['queue_enabled', 'Queue'],
  ['reminders_enabled', 'Reminders'], ['memberships_enabled', 'Memberships'], ['enquiries_enabled', 'Enquiries'], ['smart_report_in_app', 'Smart summary in app'],
  ['show_partner_orders', 'Show partner orders'], ['auto_no_show', 'Auto no-show'], ['auto_follow_up_reminders', 'Auto follow-up reminders'],
] as const satisfies readonly (readonly [keyof EngagementSettingsBody, string])[];

/** Integer fields with the operation's min/max, grouped by W12 section (C16 04-UI-UX line 261). */
export type IntKey = {
  [K in keyof EngagementSettingsBody]-?: EngagementSettingsBody[K] extends number ? K : never;
}[keyof EngagementSettingsBody];
export const INTS: Record<'app' | 'booking' | 'reminder' | 'queue', readonly { key: IntKey; label: string; min: number; max: number; note?: string }[]> = {
  app: [
    { key: 'otp_daily_cap', label: 'OTP daily cap', min: 100, max: 20000 },
    { key: 'max_profiles_per_account', label: 'Max profiles per account', min: 1, max: 10 },
    { key: 'max_accounts_per_patient', label: 'Max accounts per patient', min: 1, max: 5 },
    { key: 'link_code_ttl_hours', label: 'Link code TTL (hours)', min: 1, max: 168 },
    { key: 'dormant_after_days', label: 'Dormant after (days)', min: 30, max: 730 },
    { key: 'minor_age_years', label: 'Minor age (years)', min: 14, max: 21, note: 'Confirm the legal age with your counsel.' },
  ],
  booking: [
    { key: 'booking_horizon_days', label: 'Booking horizon (days)', min: 1, max: 60 },
    { key: 'booking_min_lead_minutes', label: 'Booking minimum lead (minutes)', min: 0, max: 2880 },
    { key: 'booking_cancel_cutoff_minutes', label: 'Booking cancel cutoff (minutes)', min: 0, max: 2880 },
    { key: 'no_show_grace_minutes', label: 'No-show grace (minutes)', min: 15, max: 1440 },
    { key: 'max_active_bookings_per_profile', label: 'Max active bookings per profile', min: 1, max: 5 },
    { key: 'max_bookings_created_per_account_day', label: 'Max bookings created per account per day', min: 1, max: 10 },
    { key: 'max_orderables_per_booking', label: 'Max tests per booking', min: 1, max: 50 },
    { key: 'booking_reminder_hours_before', label: 'Booking reminder (hours before)', min: 1, max: 72 },
  ],
  reminder: [
    { key: 'follow_up_reminder_lead_days', label: 'Follow-up reminder lead (days)', min: 0, max: 30 },
  ],
  queue: [
    { key: 'queue_display_history_count', label: 'Queue display history (tokens)', min: 1, max: 10 },
  ],
};

export const LABEL = {
  allowed_phone_prefixes: 'Allowed phone prefixes',
  min_app_version_android: 'Minimum app version (Android)',
  min_app_version_ios: 'Minimum app version (iOS)',
  support_phone: 'Support phone',
  app_consent_text: 'Consent text',
  app_consent_text_version: 'Consent text version',
  smart_report_disclaimer_text: 'Smart summary disclaimer',
  home_collection_centre_id: 'Home collection centre',
  app_gateways: 'App payment gateways',
} as const;
export const GATEWAYS = [['esewa', 'eSewa'], ['khalti', 'Khalti']] as const;

export const PREFIX_ERROR = `${LABEL.allowed_phone_prefixes}: enter 1 to 5 prefixes separated by commas, each like +977 (a plus sign, then 1 to 4 digits not starting with 0).`;
export const VERSION_ERROR = (label: string) => `${label} must look like 1.2.3 (numbers separated by two dots).`;
export const CONSENT_VERSION_ERROR = `${LABEL.app_consent_text_version} must change when the ${LABEL.app_consent_text.toLowerCase()} changes.`;

/** "+977, +91" -> ["+977", "+91"]; undefined when empty, over 5, or an item is not `+` and 1-4 digits (first not 0). */
export function parsePrefixes(text: string): string[] | undefined {
  const items = text.split(',').map((x) => x.trim()).filter(Boolean);
  return items.length >= 1 && items.length <= 5 && items.every((x) => /^\+[1-9][0-9]{0,3}$/.test(x)) ? items : undefined;
}
export const VERSION_RE = /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,4}$/;
