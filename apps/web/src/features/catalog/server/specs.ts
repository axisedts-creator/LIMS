import 'server-only';
// Field specs for SCR-09…12 (04-UI-UX §4; contracts/openapi/catalog.yaml). Create-only fields (`code`, `panel_kind`, `party_code`,
// `doctor_code`) are absent from the PATCH specs so they can never be sent; server-owned fields (is_verified, source, merged_into_id,
// tenant_id, version, quick_add) are in no spec at all.
import { COMMENT_CODE_RE, EMAIL_RE, PANEL_CODE_RE, PARTY_CODE_RE, PHONE_RE } from './types';
import { bool, exactCode, int, list, oneOf, pick, str, upperCode, uuid, bad, type V } from './shared';

const email: V = (v) => {
  if (typeof v !== 'string' || v.length > 254 || !EMAIL_RE.test(v)) throw bad();
  return v;
};
const phone = exactCode(PHONE_RE);

const member: V = (v) => pick(v, { kind: oneOf('test', 'panel'), orderable_id: uuid, sort_order: int(0, 9999) }, ['kind', 'orderable_id', 'sort_order']);
/** 1–100 members (AC-07.4). */
export const members: V = (v) => {
  const r = list(100, member)(v) as unknown[];
  if (r.length < 1) throw bad();
  return r;
};

export const PANEL = {
  create: { code: upperCode(PANEL_CODE_RE), name: str(1, 200), panel_kind: oneOf('clinical', 'package'), sex_restriction: oneOf('male', 'female'), department_id: uuid, members },
  required: ['code', 'name', 'panel_kind', 'members'],
  patch: { name: str(1, 200), sex_restriction: oneOf('male', 'female'), department_id: uuid, is_active: bool, unset: list(2, oneOf('sex_restriction', 'department_id')) },
} as const;

export const COMMENT_CODE = {
  create: { code: upperCode(COMMENT_CODE_RE), department_id: uuid, text: str(1, 2000) },
  required: ['code', 'text'],
  patch: { text: str(1, 2000), is_active: bool },
} as const;

const docFields = { qualification: str(0, 120), registration_council: str(0, 20), registration_no: str(0, 30), phone_e164: phone, email, notes: str(0, 500) };
export const DOCTOR = {
  create: { doctor_code: upperCode(PARTY_CODE_RE), display_name: str(1, 120), ...docFields },
  required: ['display_name'],
  patch: { display_name: str(1, 120), ...docFields, is_active: bool, unset: list(6, oneOf('qualification', 'registration_council', 'registration_no', 'phone_e164', 'email', 'notes')) },
} as const;

const KINDS = ['hospital', 'company', 'clinic', 'partner_lab', 'insurer', 'other'] as const;
const partyFields = { name: str(1, 160), kind: oneOf(...KINDS), allows_credit: bool, pan: str(0, 20), contact_phone_e164: phone, contact_email: email, billing_address: str(0, 500) };
export const CREDIT_PARTY = {
  create: { party_code: upperCode(PARTY_CODE_RE), ...partyFields },
  required: ['name', 'kind'],
  patch: { ...partyFields, is_active: bool, unset: list(4, oneOf('pan', 'contact_phone_e164', 'contact_email', 'billing_address')) },
} as const;
