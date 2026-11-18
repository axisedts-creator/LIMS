// T0D-CONTENT-1 (LD-313): portal content types (contracts/openapi/engagement.yaml PortalContent, ProfileImage) and the form checks shared by
// the screen (hints) and the server actions (re-checked before the API, which checks again). No React here.
import { t } from '@/core/i18n/messages';
import { MARKDOWN_MAX_CHARS, validateMarkdown } from './safeMarkdown';

export type ContentKind = 'news' | 'banner' | 'offer' | 'contact';
export type ProfileKind = 'doctor' | 'centre' | 'staff';
export const CONTENT_KINDS: readonly ContentKind[] = ['news', 'banner', 'offer', 'contact'];
export const PROFILE_KINDS: readonly ProfileKind[] = ['doctor', 'centre', 'staff'];

export interface PortalContent {
  id: string; kind: ContentKind; title: string; body?: string; image_attachment_id?: string; link_url?: string;
  starts_on?: string; ends_on?: string; sort_order: number; is_active: boolean; published_at?: string;
  created_by?: string; created_at?: string; updated_at?: string; version: number;
}
export interface ProfileImage { profile_kind: ProfileKind; profile_id: string; image_attachment_id: string; is_active: boolean; updated_at?: string; profile_name?: string }
export interface ProfileHit { id: string; name: string }

/** Create and update bodies: only these fields ever reach the API (PortalContentCreate / PortalContentUpdate, additionalProperties false). */
export interface ContentFields { kind?: ContentKind; title?: string; body?: string; image_attachment_id?: string; link_url?: string; starts_on?: string; ends_on?: string; is_active?: boolean }

export type ActionResult<T = unknown> = { ok: true; data: T } | { ok: false; status: number; code: string };

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
export const HTTPS_RE = /^https:\/\/[^\s<>"]+$/;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
export const TITLE_MAX = 200;
export const LINK_MAX = 2048;
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024; // uploadBrandingAsset: PNG/JPEG up to 2 MB
export const IMAGE_TYPES = ['image/png', 'image/jpeg'] as const;

export const titleError = (v: string) => (!v.trim() ? t('engagement.content.error.title_required') : /[<>]/.test(v) || v.length > TITLE_MAX ? t('engagement.content.error.title_chars') : undefined);
export const linkError = (v: string) => (v && (!HTTPS_RE.test(v) || v.length > LINK_MAX) ? t('engagement.content.error.link_https') : undefined);
export const emailError = (v: string) => (v && !EMAIL_RE.test(v) ? t('engagement.content.error.email') : undefined);
export const plainError = (v: string) => (/[<>]/.test(v) ? t('engagement.content.error.no_tags') : undefined);
export const windowError = (s?: string, e?: string) => (s && e && e < s ? t('engagement.content.error.ends_before') : undefined);

const MD_REASON: Record<string, string> = {
  'raw HTML': 'engagement.content.md.html', image: 'engagement.content.md.image', 'link not https': 'engagement.content.md.link', 'bad link': 'engagement.content.md.link',
  'reference definition': 'engagement.content.md.reference', 'numeric character reference': 'engagement.content.md.charref', 'control character': 'engagement.content.md.control',
  'too long': 'engagement.content.md.too_long',
};
/** The visible message for a body the shared validator refuses (LD-313 d), or undefined when it is allowed. */
export function bodyError(src: string): string | undefined {
  if (src.length > MARKDOWN_MAX_CHARS) return t('engagement.content.md.too_long');
  const r = validateMarkdown(src);
  return r.ok ? undefined : t(MD_REASON[r.reason] ?? 'engagement.content.md.html');
}

/** Problem code -> visible text (never the raw problem). */
export function failText(r: { status: number; code: string }): string {
  if (r.status === 409 || r.code === 'common.version_conflict') return t('engagement.content.fail.conflict');
  if (r.status === 404) return t('engagement.content.fail.not_found');
  if (r.status === 403) return t('engagement.content.fail.forbidden');
  if (r.status === 400 || r.status === 422) return t('engagement.content.fail.invalid');
  return t('engagement.content.fail.other');
}

// Contact Us (the contract has no contact fields): ONE item of kind contact, body = "Label: value" lines, link_url = the map link [CONV].
export interface ContactFields { address: string; phones: string; email: string; hours: string; map: string }
const LINE = { address: 'Address', phones: 'Phones', email: 'Email', hours: 'Hours' } as const;
export function parseContact(item?: PortalContent): ContactFields {
  const out: ContactFields = { address: '', phones: '', email: '', hours: '', map: item?.link_url ?? '' };
  for (const line of (item?.body ?? '').split('\n')) {
    for (const [k, label] of Object.entries(LINE) as [keyof typeof LINE, string][]) if (line.startsWith(`${label}:`)) out[k] = line.slice(label.length + 1).trim();
  }
  return out;
}
export const contactBody = (c: ContactFields) => (Object.entries(LINE) as [keyof typeof LINE, string][]).filter(([k]) => c[k].trim()).map(([k, label]) => `${label}: ${c[k].trim()}`).join('\n');
