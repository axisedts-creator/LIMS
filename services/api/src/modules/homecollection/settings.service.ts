// HC-T04 H18 getHomecollectionSettings / H19 updateHomecollectionSettings / H20 listHomecollectionReasons (02-TRD §5, §11.2; 08 A17 P-22, A19 D-128/D-129/D-130).
// settings.manage is privileged (CR-C17-008): IdentityPort.assertRole enforces aal2 on every call, BEFORE any version/body check. Nothing of the body is logged.
// SQL lives in repository/*.repo.ts only. Settings row is created lazily (insertSettingsIfAbsent = INSERT ... ON CONFLICT (tenant_id) DO NOTHING); a read with no row returns the defaults.
import { LimsError, type FieldError } from '../../core/errors.js';
import { uuidv7 } from '../../../../../packages/shared-ts/src/uuidv7/index.js';
import { toReasonDto, toSettingsDto } from './mappers/settings.mapper.js';
import { HOMECOLLECTION_PERMISSIONS } from './permissions.js';
import { listReasonsBySet } from './repository/reasons.repo.js';
import { getSettings, insertSettingsIfAbsent, updateSettings } from './repository/settings.repo.js';

const [PERM_VISIT_READ, , , , PERM_SETTINGS_MANAGE] = HOMECOLLECTION_PERMISSIONS;   // 'homecollection.visit.read', 'homecollection.settings.manage'
type Obj = Record<string, any>;
type Result = { status: number; body: unknown };
interface Ctx {
  readonly tenantId: string; readonly tx: { query(t: string, v?: unknown[]): Promise<{ rows: any[] }> }; readonly actor: { readonly id: string };
  readonly ports: { readonly IdentityPort: { assertRole(ctx: unknown, r: { permission: string }): Promise<void> } };
}

const REASON_SETS = ['visit_cancel_reasons', 'unassign_reasons', 'visit_fail_reasons', 'specimen_not_collected_reasons', 'revisit_reasons', 'review_reasons', 'flag_resolutions', 'wipe_reasons'];
const SEED_PAYMENT_CODES = ['cash', 'card', 'esewa', 'khalti', 'fonepay_qr', 'bank_transfer'];   // C4 global seed set (D-128)
const SETTING_FIELDS = ['min_app_version', 'sync_interval_seconds', 'offline_purge_hours', 'capture_gps', 'gps_retention_days', 'map_handoff_enabled', 'manual_barcode_entry_allowed',
  'second_identifier', 'collection_consent_text_version', 'collection_consent_text', 'payment_methods', 'handover_confirmation_required', 'handover_overdue_hours', 'max_visits_per_route',
  'notify_phlebotomist_on_assign', 'notify_patient_on_assign', 'clock_tolerance_seconds'];

/** TRD §11.2 defaults (a lazily created row and a read with no row). */
const defaults = (): Obj => ({
  min_app_version: '1.0.0', sync_interval_seconds: 300, offline_purge_hours: 16, capture_gps: false, gps_retention_days: 90, map_handoff_enabled: true,
  manual_barcode_entry_allowed: true, second_identifier: 'phone', collection_consent_text_version: 'hc-consent-v1',
  collection_consent_text: 'Synthetic placeholder consent text: I agree to give a blood sample. The tenant must replace this before go-live.',
  payment_methods: [{ code: 'cash', display: 'Cash', requires_reference: false }, { code: 'fonepay_qr', display: 'Fonepay QR', requires_reference: true },
    { code: 'esewa', display: 'eSewa', requires_reference: false }, { code: 'khalti', display: 'Khalti', requires_reference: false }],
  handover_confirmation_required: true, handover_overdue_hours: 4, max_visits_per_route: 40, notify_phlebotomist_on_assign: false, notify_patient_on_assign: false,
  clock_tolerance_seconds: 600, version: 1,
});

export { defaults as settingsDefaults };   // HC-T10: A1 creates the row lazily with the same defaults

function ctxOf(c: unknown): Ctx {
  const x = c as Partial<Ctx> | null;
  if (typeof x?.tenantId !== 'string' || !x.tx || typeof x.actor?.id !== 'string' || !x.ports?.IdentityPort) throw new LimsError('auth.unauthenticated');   // fail closed
  return x as Ctx;
}

// ---- validation (fixed messages: no submitted value is ever echoed) ----
const bad = (...paths: string[]): LimsError => new LimsError('common.validation_failed', undefined,
  paths.map((path): FieldError => ({ path, code: 'common.field_invalid', message: 'Field invalid' })));
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const noExtra = (v: Obj, allowed: readonly string[], path: string): void => {
  for (const k of Object.keys(v)) if (!allowed.includes(k)) throw new LimsError('common.validation_failed', undefined, [{ path: `${path}/${k}`, code: 'common.unknown_field', message: 'Unknown field' }]);
};
const MIN_APP_VERSION = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/;

function expectedVersion(headers: unknown): number {
  const h = isObj(headers) ? headers['if-match'] : undefined;
  if (h === undefined) throw new LimsError('common.precondition_required');
  const m = typeof h === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(h) : null;
  if (!m || Number(m[1]) > 2147483647) throw bad('/headers/if-match');
  return Number(m[1]);
}

/** Whole-object PUT: every field required; a value the DB CHECKs would refuse is a 400 here (never a 500). */
function parseSettings(body: unknown): Obj {
  if (!isObj(body)) throw bad('');
  noExtra(body, SETTING_FIELDS, '');
  const int = (k: string, min: number, max: number): number => { const v = body[k]; if (!Number.isInteger(v) || v < min || v > max) throw bad(`/${k}`); return v; };
  const flag = (k: string): boolean => { const v = body[k]; if (typeof v !== 'boolean') throw bad(`/${k}`); return v; };
  const str = (k: string, min: number, max: number): string => { const v = body[k]; if (typeof v !== 'string' || v.includes('\u0000') || [...v].length < min || [...v].length > max) throw bad(`/${k}`); return v; };

  const minApp = str('min_app_version', 5, 20);
  if (!MIN_APP_VERSION.test(minApp)) throw bad('/min_app_version');
  const second = str('second_identifier', 1, 10);
  if (second !== 'phone') throw bad('/second_identifier');   // 'birth_date' rejected until CR-C17-003 merges (TRD §5 H19)
  const notifyPatient = flag('notify_patient_on_assign');
  if (notifyPatient) throw bad('/notify_patient_on_assign');   // D-129: until CR-C17-014 merges

  const pm = body['payment_methods'];
  if (!Array.isArray(pm) || pm.length < 1 || pm.length > 10) throw bad('/payment_methods');
  const payment_methods = pm.map((m, i) => {
    const p = `/payment_methods/${i}`;
    if (!isObj(m)) throw bad(p);
    noExtra(m, ['code', 'display', 'requires_reference'], p);
    if (typeof m['code'] !== 'string' || !SEED_PAYMENT_CODES.includes(m['code'])) throw bad(`${p}/code`);   // D-128
    if (typeof m['display'] !== 'string' || m['display'].includes('\u0000') || [...m['display']].length < 1 || [...m['display']].length > 40) throw bad(`${p}/display`);
    if (typeof m['requires_reference'] !== 'boolean') throw bad(`${p}/requires_reference`);
    return { code: m['code'], display: m['display'], requires_reference: m['requires_reference'] };
  });

  return {
    min_app_version: minApp, sync_interval_seconds: int('sync_interval_seconds', 60, 900), offline_purge_hours: int('offline_purge_hours', 4, 24), capture_gps: flag('capture_gps'),
    gps_retention_days: int('gps_retention_days', 7, 365), map_handoff_enabled: flag('map_handoff_enabled'), manual_barcode_entry_allowed: flag('manual_barcode_entry_allowed'),
    second_identifier: second, collection_consent_text_version: str('collection_consent_text_version', 1, 40), collection_consent_text: str('collection_consent_text', 1, 2000),
    payment_methods, handover_confirmation_required: flag('handover_confirmation_required'), handover_overdue_hours: int('handover_overdue_hours', 1, 24),
    max_visits_per_route: int('max_visits_per_route', 1, 60), notify_phlebotomist_on_assign: flag('notify_phlebotomist_on_assign'), notify_patient_on_assign: notifyPatient,
    clock_tolerance_seconds: int('clock_tolerance_seconds', 60, 3600),
  };
}

export async function getHomecollectionSettings(hctx: unknown): Promise<Result> {
  const c = ctxOf(hctx);
  await c.ports.IdentityPort.assertRole(c, { permission: PERM_SETTINGS_MANAGE });
  const row = await getSettings(c.tx, c.tenantId);
  return { status: 200, body: toSettingsDto(row ?? defaults()) };   // no row: defaults, not persisted by a read (P-22)
}

export async function updateHomecollectionSettings(hctx: unknown, headers: unknown, body: unknown): Promise<Result> {
  const c = ctxOf(hctx);
  await c.ports.IdentityPort.assertRole(c, { permission: PERM_SETTINGS_MANAGE });
  const version = expectedVersion(headers);
  const patch = parseSettings(body);
  let cur = await getSettings(c.tx, c.tenantId);
  if (Number(cur?.['version'] ?? 1) !== version) throw new LimsError('common.version_conflict');   // checked before the lazy create: a failed PUT creates no row
  if (!cur) {
    const d = defaults();
    cur = (await insertSettingsIfAbsent(c.tx, c.tenantId, { ...d, id: uuidv7() })) ?? (await getSettings(c.tx, c.tenantId));   // null = lost the create race
    if (!cur) throw new LimsError('common.internal');
    if (Number(cur['version']) !== version) throw new LimsError('common.version_conflict');
  }
  const row = await updateSettings(c.tx, c.tenantId, String(cur['id']), version, patch);
  if (!row) throw new LimsError('common.version_conflict');   // another writer moved the version under us
  return { status: 200, body: toSettingsDto(row) };
}

export async function listHomecollectionReasons(hctx: unknown, query: unknown): Promise<Result> {
  const c = ctxOf(hctx);
  await c.ports.IdentityPort.assertRole(c, { permission: PERM_VISIT_READ });
  const set = isObj(query) ? query['set'] : undefined;
  if (typeof set !== 'string' || !REASON_SETS.includes(set)) throw bad('/set');
  return { status: 200, body: { data: (await listReasonsBySet(c.tx, set)).map(toReasonDto) } };   // global seeds only (D-130)
}
