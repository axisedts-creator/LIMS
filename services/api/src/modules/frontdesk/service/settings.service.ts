// FD-T15 F24 get/updateFrontdeskSettings + F25 listFrontdeskCodes (02-TRD §5 F24/F25, §11.2; 05-SCHEMA §3 settings CHECKs; 07-SECURITY §6.4, REQ-SEC-062/067).
// settings.manage is privileged: IdentityPort.assertRole enforces aal2 on every call. Nothing of the body is logged (the pan pattern is a setting value, not log material).
import { LimsError } from '../../../core/errors.js';
import { getSettings, listCodedSet, SETTING_FIELDS, updateSettings } from '../repository/settings.repo.js';
import { FRONTDESK_PERMISSIONS as P } from '../permissions.js';
import { bad, expectedVersion, isObj, patientCtx, strict, type PatientCtx, type Result } from './patient.service.js';

const CODED_SETS = ['order_cancel_reasons', 'item_removal_reasons', 'discount_reasons', 'duplicate_override_reasons', 'anonymise_reasons', 'flag_resolutions'];
type Obj = Record<string, any>;

const settingsDto = (r: Obj) => ({
  discount_self_limit_bp: Number(r['discount_self_limit_bp']), discount_self_limit_paisa: Number(r['discount_self_limit_paisa']), discount_absolute_max_bp: Number(r['discount_absolute_max_bp']),
  require_referrer: r['require_referrer'] === true, consent_text_version: String(r['consent_text_version']), registration_sms_enabled: r['registration_sms_enabled'] === true,
  label_autoprint: r['label_autoprint'] === true, buyer_pan_pattern: String(r['buyer_pan_pattern']), patient_search_min_chars: Number(r['patient_search_min_chars']), version: Number(r['version']),
});

export async function getFrontdeskSettings(hctx: unknown): Promise<Result> {
  const c = patientCtx(hctx);
  await c.ports.IdentityPort.assertRole(c, { permission: P.settingsManage });
  const row = await getSettings(c.tx, c.tenantId);
  if (!row) throw new LimsError('common.internal');   // onboarding seeds the row (02-TRD §11)
  return { status: 200, body: settingsDto(row) };
}

/** Whole-object PUT: every field required, a value the DB CHECKs would refuse is a 400 here (never a 500). `version` is server-set and ignored. */
function parseSettings(body: unknown): Obj {
  const b = strict(body, [...SETTING_FIELDS, 'version']);
  const int = (k: string, min: number, max: number): number => { const v = b[k]; if (!Number.isInteger(v) || v < min || v > max) throw bad(`/${k}`); return v; };
  const flag = (k: string): boolean => { if (typeof b[k] !== 'boolean') throw bad(`/${k}`); return b[k]; };
  const str = (k: string, min: number, max: number): string => { const v = b[k]; if (typeof v !== 'string' || v.includes('\u0000') || [...v].length < min || [...v].length > max) throw bad(`/${k}`); return v; };
  const out: Obj = {
    discount_self_limit_bp: int('discount_self_limit_bp', 0, 10000), discount_self_limit_paisa: int('discount_self_limit_paisa', 0, Number.MAX_SAFE_INTEGER),
    discount_absolute_max_bp: int('discount_absolute_max_bp', 0, 10000), require_referrer: flag('require_referrer'), consent_text_version: str('consent_text_version', 1, 32),
    registration_sms_enabled: flag('registration_sms_enabled'), label_autoprint: flag('label_autoprint'), buyer_pan_pattern: str('buyer_pan_pattern', 0, 200),
    patient_search_min_chars: int('patient_search_min_chars', 2, 10),   // DB CHECK 2..10 (contract allows 1..100)
  };
  if (out['discount_self_limit_bp'] > out['discount_absolute_max_bp']) throw bad('/discount_self_limit_bp', '/discount_absolute_max_bp');
  try { new RegExp(out['buyer_pan_pattern']); } catch { throw bad('/buyer_pan_pattern'); }   // registration compiles it per request
  return out;
}

export async function updateFrontdeskSettings(hctx: unknown, headers: unknown, body: unknown): Promise<Result> {
  const c: PatientCtx = patientCtx(hctx);
  await c.ports.IdentityPort.assertRole(c, { permission: P.settingsManage });
  const version = expectedVersion(headers);
  const v = parseSettings(body);
  const cur = await getSettings(c.tx, c.tenantId);
  if (!cur) throw new LimsError('common.internal');
  if (Number(cur['version']) !== version) throw new LimsError('common.version_conflict');
  const row = await updateSettings(c.tx, c.tenantId, version, v);
  if (!row) throw new LimsError('common.version_conflict');   // lost the race on the row lock: the version moved under us
  return { status: 200, body: settingsDto(row) };
}

export async function listFrontdeskCodes(hctx: unknown, params: unknown): Promise<Result> {
  const c = patientCtx(hctx);
  await c.ports.IdentityPort.assertRole(c, { permission: P.orderRead });
  const name = isObj(params) ? params['set_name'] : undefined;
  if (typeof name !== 'string' || !CODED_SETS.includes(name)) throw bad('/set_name');
  return { status: 200, body: { data: (await listCodedSet(c.tx, c.tenantId, name)).map((r) => ({ code: r['code'], display: r['display'], sort_order: Number(r['sort_order']) })) } };
}
