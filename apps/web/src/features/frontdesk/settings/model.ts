// Front desk settings model (C4 02-TRD §11.2, F24 FrontdeskSettings). Pure helpers, no I/O. LD-255 (ADMINPAGE-FD-1).
// The API stores percentages as basis points (1 bp = 0.01 %); the screen shows percent. Integer maths only: 1250 bp <-> "12.5", never a float.

export interface FrontdeskSettings {
  discount_self_limit_bp: number;
  discount_self_limit_paisa: number;
  discount_absolute_max_bp: number;
  require_referrer: boolean;
  consent_text_version: string;
  registration_sms_enabled: boolean;
  label_autoprint: boolean;
  buyer_pan_pattern: string;
  patient_search_min_chars: number;
  version: number;
}
/** Body of updateFrontdeskSettings: the 9 fields; `version` is server-set and travels in If-Match. */
export type FrontdeskSettingsBody = Omit<FrontdeskSettings, 'version'>;

export const FIELD_LABEL = {
  discount_self_limit_bp: 'Discount self-limit (%)',
  discount_self_limit_paisa: 'Discount self-limit (NPR)',
  discount_absolute_max_bp: 'Absolute max %',
  require_referrer: 'Require referrer',
  consent_text_version: 'Consent text version',
  registration_sms_enabled: 'Registration SMS',
  label_autoprint: 'Label auto-print',
  buyer_pan_pattern: 'Buyer PAN pattern',
  patient_search_min_chars: 'Search min chars',
} as const satisfies Record<keyof FrontdeskSettingsBody, string>;

/** 1250 -> "12.5", 500 -> "5", 1 -> "0.01". */
export function bpToPercent(bp: number): string {
  const whole = Math.floor(bp / 100);
  const frac = String(bp % 100).padStart(2, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

/** "12.5" -> 1250. Undefined when the text is not a percent with at most 2 decimals between 0 and 100. */
export function percentToBp(text: string): number | undefined {
  const m = /^(\d{1,3})(?:\.(\d{0,2}))?$/.exec(text.trim());
  if (!m) return undefined;
  const bp = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return bp <= 10000 ? bp : undefined;
}

/** A buyer PAN pattern must compile as a regular expression (the API validates it the same way); max 200 characters (schema). */
export function panPatternError(pattern: string): string | undefined {
  if (pattern.length > 200) return `${FIELD_LABEL.buyer_pan_pattern} can be at most 200 characters.`;
  try {
    new RegExp(pattern);
    return undefined;
  } catch {
    return `${FIELD_LABEL.buyer_pan_pattern} is not a valid pattern. Check the brackets and escapes.`;
  }
}

export const SELF_ABOVE_MAX = `${FIELD_LABEL.discount_self_limit_bp} cannot be above ${FIELD_LABEL.discount_absolute_max_bp}.`;
