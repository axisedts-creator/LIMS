// TemplateConfig JSON Schema + validation (02-TRD §6.5: `additionalProperties: false` everywhere; 07-SECURITY A11: no URL fields,
// letterhead images are referenced only as `branding|none`). Pure: never mutates its input, never echoes a rejected value.
// The handler maps `{ ok: false }` to `reporting.template_invalid`. The renderer mirrors the shape in services/renderer/src/templates/contract.ts.

/** [CONV] keys of the 11 header fields (02-TRD §6.5 names the set, not the keys); same list as the renderer contract. */
export const HEADER_FIELD_KEYS = ['sample_collected_at', 'name', 'reg_no', 'age_gender', 'barcode_no', 'sample_coll_dt', 'reg_date', 'sample_rcv_dt',
  'reported_date', 'report_status', 'referred_by'] as const;
export type HeaderFieldKey = (typeof HEADER_FIELD_KEYS)[number];

export interface TemplateConfig {
  page: { size: 'A4' | 'Letter'; margin_mm: { top: number; bottom: number; left: number; right: number } };
  letterhead: { header_asset: 'branding' | 'none'; footer_asset: 'branding' | 'none'; plain_reserve_top_mm: number; plain_reserve_bottom_mm: number };
  header_fields?: HeaderFieldKey[];
  results: { show_method_line: boolean; show_units_column: boolean; group_by_package: boolean; page_break_before_department: boolean; show_department_approved_by: boolean };
  signatories: { mode: 'approvers' | 'nominated'; max: number; show_signature_images: boolean; label_registration?: string };
  qr: { enabled: boolean; size_mm: number; caption: string };
  watermark?: { text: string; opacity: number };
  disclaimers: string[];
  contact_strip_extra?: string;
  fonts: { base_pt: number };
  narrative: { show_images_grid_columns: number };
}

type Schema = {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';
  properties?: Record<string, Schema>; required?: string[]; additionalProperties?: false;
  items?: Schema; maxItems?: number; minItems?: number; uniqueItems?: boolean;
  enum?: readonly unknown[]; minLength?: number; maxLength?: number; minimum?: number; maximum?: number; default?: unknown;
};

const bool = (d?: boolean): Schema => ({ type: 'boolean', ...(d !== undefined ? { default: d } : {}) });
const int = (minimum: number, maximum: number, d?: number): Schema => ({ type: 'integer', minimum, maximum, ...(d !== undefined ? { default: d } : {}) });
const num = (minimum: number, maximum: number, d?: number): Schema => ({ type: 'number', minimum, maximum, ...(d !== undefined ? { default: d } : {}) });
const str = (maxLength: number, extra: Partial<Schema> = {}): Schema => ({ type: 'string', maxLength, ...extra });
const oneOf = (...e: string[]): Schema => ({ type: 'string', enum: e });
/** Closed object; every property without a default and not listed in `optional` is required. */
const obj = (properties: Record<string, Schema>, optional: string[] = []): Schema => ({
  type: 'object', additionalProperties: false, properties,
  required: Object.keys(properties).filter((k) => !optional.includes(k) && properties[k]!.default === undefined),
});

export const TEMPLATE_CONFIG_SCHEMA: Schema = obj({
  page: obj({ size: oneOf('A4', 'Letter'), margin_mm: obj({ top: num(5, 80), bottom: num(5, 80), left: num(5, 40), right: num(5, 40) }) }),
  letterhead: obj({ header_asset: oneOf('branding', 'none'), footer_asset: oneOf('branding', 'none'), plain_reserve_top_mm: num(0, 80), plain_reserve_bottom_mm: num(0, 80) }),
  header_fields: { type: 'array', items: { type: 'string', enum: HEADER_FIELD_KEYS }, minItems: 1, maxItems: HEADER_FIELD_KEYS.length, uniqueItems: true },
  results: obj({ show_method_line: bool(true), show_units_column: bool(), group_by_package: bool(true), page_break_before_department: bool(), show_department_approved_by: bool() }),
  // label_registration: kept for schema compatibility (TRD §6.5); LD-27 prints "<council> No." from the signatory profile, so templates ignore it.
  signatories: obj({ mode: oneOf('approvers', 'nominated'), max: int(1, 4, 2), show_signature_images: bool(), label_registration: str(20) }, ['label_registration']),
  qr: obj({ enabled: bool(), size_mm: num(15, 35), caption: str(60, { default: 'Scan to verify' }) }),
  watermark: obj({ text: str(40, { minLength: 1 }), opacity: num(0.05, 0.3) }),
  disclaimers: { type: 'array', items: str(200), maxItems: 5 },
  contact_strip_extra: str(300),
  fonts: obj({ base_pt: num(7, 11, 9) }),
  narrative: obj({ show_images_grid_columns: int(1, 3) }),
}, ['header_fields', 'watermark', 'contact_strip_extra']);

export const DEFAULT_TEMPLATE_CONFIG: TemplateConfig = {
  page: { size: 'A4', margin_mm: { top: 25, bottom: 25, left: 10, right: 10 } },
  letterhead: { header_asset: 'branding', footer_asset: 'branding', plain_reserve_top_mm: 30, plain_reserve_bottom_mm: 20 },
  header_fields: [...HEADER_FIELD_KEYS],
  results: { show_method_line: true, show_units_column: true, group_by_package: true, page_break_before_department: false, show_department_approved_by: true },
  signatories: { mode: 'approvers', max: 2, show_signature_images: true },
  qr: { enabled: true, size_mm: 22, caption: 'Scan to verify' },
  disclaimers: [],
  fonts: { base_pt: 9 },
  narrative: { show_images_grid_columns: 2 },
};

export type ValidationError = { path: string; message: string };
export type ValidationResult = { ok: true; config: TemplateConfig } | { ok: false; errors: ValidationError[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validates against TEMPLATE_CONFIG_SCHEMA and returns a fresh copy with defaults filled. Messages never contain the value. */
function check(s: Schema, v: unknown, path: string, errors: ValidationError[]): unknown {
  const err = (message: string) => {
    errors.push({ path: path || '/', message });
    return undefined;
  };
  switch (s.type) {
    case 'object': {
      if (!isObj(v)) return err('must be an object');
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v)) if (!Object.hasOwn(s.properties!, k)) errors.push({ path: `${path}/${k.slice(0, 64)}`, message: 'additional property not allowed' });
      for (const [k, ps] of Object.entries(s.properties!)) {
        const p = `${path}/${k}`;
        if (Object.hasOwn(v, k)) out[k] = check(ps, v[k], p, errors);
        else if (ps.default !== undefined) out[k] = structuredClone(ps.default);
        else if (s.required?.includes(k)) errors.push({ path: p, message: 'is required' });
      }
      return out;
    }
    case 'array': {
      if (!Array.isArray(v)) return err('must be an array');
      if (s.maxItems !== undefined && v.length > s.maxItems) err(`must have at most ${s.maxItems} items`);
      if (s.minItems !== undefined && v.length < s.minItems) err(`must have at least ${s.minItems} items`);
      if (s.uniqueItems && new Set(v).size !== v.length) err('items must be unique');
      return v.map((x, i) => check(s.items!, x, `${path}/${i}`, errors));
    }
    case 'string':
      if (typeof v !== 'string') return err('must be a string');
      if (s.enum && !s.enum.includes(v)) return err(`must be one of ${s.enum.join(', ')}`);
      if (s.maxLength !== undefined && [...v].length > s.maxLength) return err(`must be at most ${s.maxLength} characters`);
      if (s.minLength !== undefined && [...v].length < s.minLength) return err(`must be at least ${s.minLength} characters`);
      return v;
    case 'number':
    case 'integer':
      if (typeof v !== 'number' || !Number.isFinite(v)) return err('must be a number');
      if (s.type === 'integer' && !Number.isInteger(v)) return err('must be an integer');
      if ((s.minimum !== undefined && v < s.minimum) || (s.maximum !== undefined && v > s.maximum)) return err(`must be between ${s.minimum} and ${s.maximum}`);
      return v;
    case 'boolean':
      return typeof v === 'boolean' ? v : err('must be a boolean');
  }
}

export function validateTemplateConfig(input: unknown): ValidationResult {
  const errors: ValidationError[] = [];
  const config = check(TEMPLATE_CONFIG_SCHEMA, input, '', errors) as TemplateConfig;
  return errors.length ? { ok: false, errors } : { ok: true, config };
}
