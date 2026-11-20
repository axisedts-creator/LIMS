// Print profiles and signer profiles (T0B-PRINTCFG-1; LD-316, LD-319(1); contract reporting.yaml PrintProfileInput / SignatoryProfileInput, T0C-PRINTCFG-1).
// Pure: no db, no I/O. Bodies are the snake_case contract shapes; the same rules as the contract patterns and the DB CHECKs, so a direct handler call is as strict as the pipeline.
import { LimsError, type FieldError } from '../../../core/errors.js';

export const DOCUMENT_KINDS = ['report', 'invoice', 'credit_note'] as const;
export const RECIPIENT_TYPES = ['patient', 'doctor', 'franchise', 'laboratory', 'other'] as const;
export const PAPER_MODES = ['letterhead_image', 'typed_header_footer', 'preprinted_paper', 'plain'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
export type RecipientType = (typeof RECIPIENT_TYPES)[number];
export type PaperMode = (typeof PAPER_MODES)[number];

export interface PrintProfileInput {
  branch_id?: string; document_kind: DocumentKind; recipient_type?: RecipientType; paper_mode: PaperMode;
  header_text: string; footer_text: string; reserve_top_mm: number; reserve_bottom_mm: number;
  show_logo: boolean; show_seller_pan: boolean; grayscale: boolean; font_size_pt: number; is_active: boolean;
}
export interface SignatoryProfileInput { display_name: string; title?: string; registration_no?: string; signature_asset_id?: string; is_active: boolean }
/** A stored row (snake_case, as read from reporting.print_profile). */
export interface PrintProfileRow { document_kind: string; branch_id?: string | null; recipient_type?: string | null; is_active: boolean; [k: string]: unknown }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// LD-316: plain text, at most 8 lines of at most 120 characters (code points, like char_length), no < or >, no control character except the newline.
const TEXT = /^[^<>\u0000-\u001f\u007f]{0,120}(?:\n[^<>\u0000-\u001f\u007f]{0,120}){0,7}$/u;
const NAME = (max: number, min: number) => new RegExp(`^[^<>\\u0000-\\u001f\\u007f]{${min},${max}}$`, 'u');

const fail = (path: string, code = 'common.field_invalid', message = 'Field invalid'): never => {
  throw new LimsError('common.validation_failed', undefined, [{ path, code, message } satisfies FieldError]);
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function onlyKeys(o: Record<string, unknown>, allowed: readonly string[]) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`/${k.slice(0, 64)}`, 'common.unknown_field', 'Unknown field');
}
const oneOf = <T extends string>(v: unknown, list: readonly T[], path: string): T => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : fail(path));
const int = (v: unknown, d: number, lo: number, hi: number, path: string): number => {
  const n = v === undefined ? d : v;
  return Number.isInteger(n) && (n as number) >= lo && (n as number) <= hi ? (n as number) : fail(path);
};
const bool = (v: unknown, d: boolean, path: string): boolean => (v === undefined ? d : typeof v === 'boolean' ? v : fail(path));
const text = (v: unknown, path: string, re = TEXT): string => {
  const t = v === undefined ? '' : v;
  return typeof t === 'string' && re.test(t) ? t : fail(path);
};

const PROFILE_KEYS = ['branch_id', 'document_kind', 'recipient_type', 'paper_mode', 'header_text', 'footer_text', 'reserve_top_mm', 'reserve_bottom_mm',
  'show_logo', 'show_seller_pan', 'grayscale', 'font_size_pt', 'is_active'] as const;
// PrintProfilePreviewRequest: no key, no id of any kind (synthetic sample data only).
const PREVIEW_KEYS = PROFILE_KEYS.filter((k) => k !== 'branch_id' && k !== 'is_active');

function profile(body: unknown, allowed: readonly string[]): PrintProfileInput {
  if (!isObj(body)) return fail('/');
  onlyKeys(body, allowed);
  if (body['document_kind'] === undefined) fail('/document_kind', 'common.field_required', 'Field required');
  if (body['paper_mode'] === undefined) fail('/paper_mode', 'common.field_required', 'Field required');
  const out: PrintProfileInput = {
    document_kind: oneOf(body['document_kind'], DOCUMENT_KINDS, '/document_kind'), paper_mode: oneOf(body['paper_mode'], PAPER_MODES, '/paper_mode'),
    header_text: text(body['header_text'], '/header_text'), footer_text: text(body['footer_text'], '/footer_text'),
    reserve_top_mm: int(body['reserve_top_mm'], 0, 0, 80, '/reserve_top_mm'), reserve_bottom_mm: int(body['reserve_bottom_mm'], 0, 0, 60, '/reserve_bottom_mm'),
    show_logo: bool(body['show_logo'], false, '/show_logo'), show_seller_pan: bool(body['show_seller_pan'], true, '/show_seller_pan'),
    grayscale: bool(body['grayscale'], false, '/grayscale'), font_size_pt: int(body['font_size_pt'], 10, 8, 12, '/font_size_pt'),
    is_active: bool(body['is_active'], true, '/is_active'),
  };
  if (body['branch_id'] !== undefined) out.branch_id = typeof body['branch_id'] === 'string' && UUID.test(body['branch_id']) ? body['branch_id'].toLowerCase() : fail('/branch_id');
  if (body['recipient_type'] !== undefined) out.recipient_type = oneOf(body['recipient_type'], RECIPIENT_TYPES, '/recipient_type');
  return out;
}

/** upsertPrintProfile body: contract defaults filled; throws common.validation_failed. */
export const validatePrintProfileInput = (body: unknown): PrintProfileInput => profile(body, PROFILE_KEYS);
/** previewPrintProfile body: the same rules, no branch_id / is_active, never an id (patient, order, invoice, report). */
export const validatePreviewInput = (body: unknown): Omit<PrintProfileInput, 'branch_id' | 'is_active'> => {
  const { is_active: _a, branch_id: _b, ...rest } = profile(body, PREVIEW_KEYS);
  return rest;
};

/** upsertSignatoryProfile body. */
export function validateSignatoryProfileInput(body: unknown): SignatoryProfileInput {
  if (!isObj(body)) return fail('/');
  onlyKeys(body, ['display_name', 'title', 'registration_no', 'signature_asset_id', 'is_active']);
  if (body['display_name'] === undefined) fail('/display_name', 'common.field_required', 'Field required');
  const out: SignatoryProfileInput = { display_name: text(body['display_name'], '/display_name', NAME(120, 1)), is_active: bool(body['is_active'], true, '/is_active') };
  if (body['title'] !== undefined) out.title = text(body['title'], '/title', NAME(120, 0));
  if (body['registration_no'] !== undefined) out.registration_no = text(body['registration_no'], '/registration_no', NAME(60, 0));
  if (body['signature_asset_id'] !== undefined) {
    out.signature_asset_id = typeof body['signature_asset_id'] === 'string' && UUID.test(body['signature_asset_id']) ? body['signature_asset_id'].toLowerCase() : fail('/signature_asset_id');
  }
  return out;
}

/** The profile row for a print (done_when 3): active rows of the kind; (branch, recipient) > (branch, all) > (lab, recipient) > (lab, all). */
export function resolvePrintProfile<R extends PrintProfileRow>(rows: readonly R[], q: { documentKind: DocumentKind; branchId?: string; recipientType?: RecipientType }): R | undefined {
  const live = rows.filter((r) => r.is_active === true && r.document_kind === q.documentKind);
  const branch = q.branchId?.toLowerCase();
  const find = (b: string | undefined, rt: string | undefined) =>
    live.find((r) => (r.branch_id ?? undefined)?.toLowerCase() === b && (r.recipient_type ?? undefined) === rt);
  const order: Array<[string | undefined, string | undefined]> = [];
  if (branch !== undefined) { if (q.recipientType) order.push([branch, q.recipientType]); order.push([branch, undefined]); }
  if (q.recipientType) order.push([undefined, q.recipientType]);
  order.push([undefined, undefined]);
  for (const [b, rt] of order) { const r = find(b, rt); if (r) return r; }
  return undefined;
}

const IMAGE_MIME = ['image/png', 'image/jpeg'];
/** A signature image must be a PNG or JPEG of the caller's tenant; unknown / other tenant / other type -> common.validation_failed. */
export function assertImageAsset(meta: { tenantId: string; mimeType: string } | undefined, tenantId: string): void {
  if (!meta || meta.tenantId !== tenantId || !IMAGE_MIME.includes(meta.mimeType)) fail('/signature_asset_id');
}
