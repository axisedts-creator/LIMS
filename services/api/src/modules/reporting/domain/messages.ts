// C6 message domain (02-TRD §7.2 steps 3 and 5; 04-UI-UX §7; 07-SECURITY REQ-SEC-070). Pure functions: no I/O.
import { createHash } from 'node:crypto';
import { ROUTES } from '../../../../../../packages/shared-ts/src/routes/generated.js';

export type MessageChannel = 'sms' | 'whatsapp' | 'email';
export type SuppressedStatus = 'suppressed_no_consent' | 'suppressed_no_contact' | 'suppressed_channel_disabled';
export type SendStatus = 'queued' | SuppressedStatus;
export interface TemplateParam { readonly name: string; readonly kind: string; readonly max_length?: number }
export interface Origins { readonly portal?: string | undefined; readonly staffWeb?: string | undefined }

export const TEMPLATE_CODE_RE = /^[a-z_]+\.[a-z0-9_]{1,60}$/;            // g_message_templates__code__ck
export const E164_RE = /^\+[1-9][0-9]{7,14}$/;                             // 02-TRD §7.2 step 5 phone_otp; deliveries__e164__ck
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{1,200}$/;             // P-40 [CONV: same grammar as @lims/fakes]
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SHORT_TEXT_RE = /^[A-Za-z0-9 .,:/()-]*$/;                           // ≤ 40 (08 A4.3)
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const CONTROL_RE = /\p{Cc}/u;
// staff_web routes of contracts/routes.yaml, `{param}` → one path segment (08 A13 D-29).
const STAFF_ROUTES: readonly RegExp[] = Object.values(ROUTES as Record<string, { origin: string; path: string }>)
  .filter((r) => r.origin === 'staff_web')
  .map((r) => new RegExp(`^${r.path.split(/\{[a-z_]+\}/).map((s) => s.replace(/[.*+?^$()|[\]\\]/g, '\\$&')).join('[A-Za-z0-9_-]+')}$`));

/** The URL must be byte-identical to its parsed form: rejects userinfo, look-alike hosts, `..`, whitespace and other normalisation tricks. */
function parsed(v: string): URL | undefined {
  try { const u = new URL(v); return u.href === v && !u.username && !u.password ? u : undefined; } catch { return undefined; }
}
/** A canonical https `${origin}/r/<token>` URL (§7.2 `url` param; §7.4 access-slip portalUrl). Unset origin fails closed. */
export function portalReportUrlOk(v: string, origin: string | undefined): boolean {
  const u = origin ? parsed(v) : undefined;
  return !!u && u.protocol === 'https:' && u.origin === origin && v.startsWith(`${origin}/r/`) && v.length > origin.length + 3;
}
function portalUrlOk(v: string, origin: string | undefined): boolean {
  if (!origin) return false;
  if (v === origin) return true;                                           // OTP e-mails pass LIMS_ORIGIN_PORTAL (review fix #29)
  return portalReportUrlOk(v, origin);
}
function staffUrlOk(v: string, origin: string | undefined): boolean {
  const u = origin ? parsed(v) : undefined;
  return !!u && u.protocol === 'https:' && u.origin === origin && !v.includes('?') && !v.includes('#') && STAFF_ROUTES.some((re) => re.test(u.pathname));
}

/** One value against its declared kind; unknown kinds fail closed. `staffLink` = purpose scheduled_report_ready to a staff recipient. */
export function paramValueOk(p: TemplateParam, v: unknown, o: Origins, staffLink: boolean): boolean {
  if (typeof v !== 'string') return false;
  switch (p.kind) {
    case 'short_text': return v.length <= Math.min(p.max_length ?? 40, 40) && SHORT_TEXT_RE.test(v);
    case 'label_text': return v.length >= 1 && v.length <= 80 && !CONTROL_RE.test(v) && !/(:\/\/|www\.)/i.test(v);   // [C6-T39 / 08 A4.3] markup accepted + stored raw; HTML-escaped at render (send_delivery)
    case 'time_hhmm': return /^[0-2][0-9]:[0-5][0-9]$/.test(v);
    case 'otp_code': return /^[0-9]{6}$/.test(v);
    case 'minutes': return /^[0-9]{1,2}$/.test(v) && Number(v) >= 1 && Number(v) <= 60;
    case 'datetime': return ISO_RE.test(v) && !Number.isNaN(Date.parse(v));
    case 'phone': return /^\+?[0-9 ()-]{3,40}$/.test(v);
    case 'url': return portalUrlOk(v, o.portal);
    case 'staff_url': return staffLink && staffUrlOk(v, o.staffWeb);
    default: return false;
  }
}

/** Step 3: key set ⊆ declared (a subset is fine), every value passes its kind. Returns a fresh null-prototype-free copy or undefined. */
export function validateParams(declared: readonly TemplateParam[], params: unknown, o: Origins, staffLink: boolean): Record<string, string> | undefined {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return undefined;
  const byName = new Map(declared.map((p) => [p.name, p]));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    const p = byName.get(k);
    if (!p || !paramValueOk(p, v, o, staffLink)) return undefined;
    out[k] = v as string;
  }
  return out;
}

/** 02-TRD §7.2 step 5 consent rule (purpose otp: sms OR whatsapp consent is enough for an SMS OTP). */
export function hasConsent(c: { sms?: boolean; whatsapp?: boolean; email?: boolean } | undefined, channel: MessageChannel, purpose: string): boolean {
  if (!c) return false;
  if (purpose === 'otp' && channel === 'sms') return c.sms === true || c.whatsapp === true;
  return c[channel] === true;
}

export const FAILURE_OF: Record<SuppressedStatus, string> = {
  suppressed_no_consent: 'no_consent', suppressed_no_contact: 'no_contact', suppressed_channel_disabled: 'channel_disabled',
};
/** Replay: map a stored row back to the SendResult status (anything past `queued` was queued). */
export function statusOfRow(r: { status: string; failure_code: string | null }): SendStatus {
  if (r.status !== 'suppressed') return 'queued';
  const hit = (Object.entries(FAILURE_OF) as Array<[SuppressedStatus, string]>).find(([, f]) => f === r.failure_code);
  return hit?.[0] ?? 'suppressed_no_contact';
}

/** The templates' lab_name param is short_text (<= 40 of [A-Za-z0-9 .,:/()-]): strip, clip, never fail a send on a fancy name. */
export const labParam = (name: unknown): string => (typeof name === 'string' ? name.replace(/[^A-Za-z0-9 .,:/()-]/g, '').trim().slice(0, 40) : '') || 'Laboratory';

export const sha256 =(s: string): Buffer => createHash('sha256').update(s).digest();
/** ≤ 40 chars, never the full address (deliveries__dest__ck). */
export function maskAddress(a: string): string {
  const at = a.indexOf('@');
  if (at > 0) return `${a[0]}***${a.slice(at)}`.slice(0, 40);
  return `${a.slice(0, 4)}******${a.slice(-2)}`;
}
