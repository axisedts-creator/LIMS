// C13 T04 — manifest line validation (03-APP-FLOW §4.1 M5/M8, §2.6; 02-TRD §5.1 field limits; US-04.2/3/4/8).
// Pure: collects ALL issues, never throws on bad input, never echoes a submitted value (07-SECURITY: no PHI in errors).
// [CONV] issue = { path: JSON pointer (snake_case wire names), code }. Submit-time duplicate partner_sample_ref is taken from ctx.otherSampleRefs
// only (the DB unique index is the authority at M5 time); validateManifestForSubmit does not cross-check lines against each other.

export interface LineIssue { readonly path: string; readonly code: string }

export interface LineContext {
  readonly today: string; // YYYY-MM-DD in the tenant timezone
  readonly now: Date;
  readonly offeredOrderableIds: ReadonlySet<string>;
  readonly referrers: ReadonlyMap<string, { readonly isActive: boolean }>; // this partner's referrers only
  readonly otherSampleRefs: ReadonlySet<string>;
  readonly adding: boolean;
  readonly lineCountBefore: number;
  readonly maxLines: number;
}

const INVALID = 'common.validation_failed';
const MANIFEST_INVALID = 'partners.manifest_invalid';
const NOT_OFFERED = 'partners.orderable_not_offered';
const NOT_FOUND = 'common.not_found';

const SEX = new Set(['male', 'female', 'other', 'unknown']);
const PRIORITY = new Set(['routine', 'urgent']);
const PHONE = /^\+[1-9][0-9]{7,14}$/;
const SAMPLE_REF = /^[A-Za-z0-9_./-]{1,40}$/;
const ISO_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const ISO_INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?(Z|[+-][0-9]{2}:[0-9]{2})$/;
const CONSENT_KEYS = [['sms', 'sms'], ['whatsapp', 'whatsapp'], ['email', 'email'], ['shareWithReferrer', 'share_with_referrer']] as const;
const SLACK_MS = 5 * 60 * 1000; // A13 P-1

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const present = (v: unknown): boolean => v !== undefined && v !== null;

function isRealDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function validateLine(input: unknown, ctx: LineContext): LineIssue[] {
  const out: LineIssue[] = [];
  const add = (path: string, code: string = INVALID): void => { out.push({ path, code }); };
  const l = isObj(input) ? input : {};
  if (!isObj(input)) add('');

  if (ctx.adding && ctx.lineCountBefore >= ctx.maxLines) add('/lines', MANIFEST_INVALID); // US-04.8

  // partner_sample_ref
  const ref = l.partnerSampleRef;
  if (present(ref)) {
    if (typeof ref !== 'string' || !SAMPLE_REF.test(ref)) add('/partner_sample_ref');
    else if (ctx.otherSampleRefs.has(ref)) add('/partner_sample_ref', MANIFEST_INVALID);
  }

  // patient
  const p = l.patient;
  if (!isObj(p)) add('/patient');
  else {
    if (typeof p.fullName !== 'string' || p.fullName.length < 1 || p.fullName.length > 120) add('/patient/full_name');
    if (typeof p.sex !== 'string' || !SEX.has(p.sex)) add('/patient/sex');
    const hasBirth = present(p.birthOn);
    const hasAge = present(p.ageYears);
    if (hasBirth === hasAge) add('/patient'); // exactly one of birth_on / age_years
    if (hasAge && (typeof p.ageYears !== 'number' || !Number.isInteger(p.ageYears) || p.ageYears < 0 || p.ageYears > 130)) add('/patient/age_years');
    if (hasBirth && (typeof p.birthOn !== 'string' || !ISO_DATE.test(p.birthOn) || p.birthOn < '1900-01-01' || p.birthOn > ctx.today || !isRealDate(p.birthOn)))
      add('/patient/birth_on');
    if (present(p.phoneE164) && (typeof p.phoneE164 !== 'string' || !PHONE.test(p.phoneE164))) add('/patient/phone_e164');
  }

  // consents: all four attestations, booleans
  const c = l.consents;
  if (!isObj(c)) add('/consents');
  else for (const [key, wire] of CONSENT_KEYS) if (typeof c[key] !== 'boolean') add(`/consents/${wire}`);

  // orderables (US-04.3)
  const ids = l.orderableIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 30) add('/orderable_ids');
  if (Array.isArray(ids)) {
    if (new Set(ids).size !== ids.length) add('/orderable_ids');
    ids.forEach((id, i) => {
      if (typeof id !== 'string') add(`/orderable_ids/${i}`);
      else if (!ctx.offeredOrderableIds.has(id)) add(`/orderable_ids/${i}`, NOT_OFFERED);
    });
  }

  if (typeof l.priority !== 'string' || !PRIORITY.has(l.priority)) add('/priority');

  // referrer: this partner's only; unknown = not_found (never reveal another partner's), inactive cannot be chosen (§2.6)
  if (present(l.referrerId)) {
    if (typeof l.referrerId !== 'string') add('/referrer_id');
    else {
      const r = ctx.referrers.get(l.referrerId);
      if (r === undefined) add('/referrer_id', NOT_FOUND);
      else if (!r.isActive) add('/referrer_id', MANIFEST_INVALID);
    }
  }

  if (present(l.clinicalNote) && (typeof l.clinicalNote !== 'string' || l.clinicalNote.length > 300)) add('/clinical_note');

  if (present(l.collectedAt)) {
    const t = typeof l.collectedAt === 'string' && ISO_INSTANT.test(l.collectedAt) ? Date.parse(l.collectedAt) : Number.NaN;
    if (Number.isNaN(t) || t > ctx.now.getTime() + SLACK_MS) add('/collected_at');
  }
  return out;
}

/** M8: >=1 line, <= maxLines, every line valid; reports every line at once with /lines/<index>/… pointers. */
export function validateManifestForSubmit(lines: readonly unknown[], ctx: LineContext): LineIssue[] {
  const list = Array.isArray(lines) ? lines : [];
  const out: LineIssue[] = [];
  if (list.length === 0 || list.length > ctx.maxLines) out.push({ path: '/lines', code: MANIFEST_INVALID });
  const lineCtx: LineContext = { ...ctx, adding: false }; // the limit is checked once above, not per line
  list.forEach((line, i) => {
    for (const issue of validateLine(line, lineCtx)) out.push({ path: `/lines/${i}${issue.path}`, code: issue.code });
  });
  return out;
}
