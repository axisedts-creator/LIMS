// T1 getEngagementSettings, T2 updateEngagementSettings, T3a/T3b coded sets (02-TRD §5, §10.2; 05-SCHEMA §2.1; US-EN-20.1/20.2).
// Tenant and actor come from ctx only. Error details/messages are fixed text: no submitted value is echoed (REQ-SEC-080).
// Range/rule failures -> 422 engagement.setting_out_of_range (they mirror the DDL CHECKs, which map to the same code on pg 23514/23503).
import { LimsError, type FieldError } from '../../../core/errors.js';
import { isCodedSetName, listCodedSet as defaultListCodedSet, type CodedSetName } from '../repository/codedsets.repo.js';
import * as defaultRepo from '../repository/settings.repo.js';

export interface SettingsCtx {
  readonly tenantId: string;
  readonly actor: { readonly type: string; readonly id: string };
  readonly tx: unknown;
}
export type SettingsRepo = typeof defaultRepo;

/** DDL defaults (05-SCHEMA §2.1) served while no row exists. Single source for T1 and the E1 app config. */
export const DEFAULT_SETTINGS = Object.freeze({
  app_enabled: false, bookings_enabled: false, home_collection_enabled: false, queue_enabled: false, reminders_enabled: false, memberships_enabled: false,
  enquiries_enabled: false, smart_report_in_app: false, show_partner_orders: false, auto_no_show: true, auto_follow_up_reminders: false,
  allowed_phone_prefixes: Object.freeze(['+977']), otp_daily_cap: 2000, min_app_version_android: '0.0.0', min_app_version_ios: '0.0.0', app_gateways: Object.freeze([]),
  max_profiles_per_account: 8, max_accounts_per_patient: 3, link_code_ttl_hours: 72, dormant_after_days: 180, minor_age_years: 18, booking_horizon_days: 14,
  booking_min_lead_minutes: 120, booking_cancel_cutoff_minutes: 60, no_show_grace_minutes: 120, max_active_bookings_per_profile: 2,
  max_bookings_created_per_account_day: 3, max_orderables_per_booking: 20, booking_reminder_hours_before: 24, follow_up_reminder_lead_days: 3,
  queue_display_history_count: 5,
});

const BOOLS = ['app_enabled', 'bookings_enabled', 'home_collection_enabled', 'queue_enabled', 'reminders_enabled', 'memberships_enabled', 'enquiries_enabled',
  'smart_report_in_app', 'show_partner_orders', 'auto_no_show', 'auto_follow_up_reminders'] as const;
const INT_RANGES: ReadonlyArray<readonly [string, number, number]> = [
  ['otp_daily_cap', 100, 20000], ['max_profiles_per_account', 1, 10], ['max_accounts_per_patient', 1, 5], ['link_code_ttl_hours', 1, 168],
  ['dormant_after_days', 30, 730], ['minor_age_years', 14, 21], ['booking_horizon_days', 1, 60], ['booking_min_lead_minutes', 0, 2880],
  ['booking_cancel_cutoff_minutes', 0, 2880], ['no_show_grace_minutes', 15, 1440], ['max_active_bookings_per_profile', 1, 5],
  ['max_bookings_created_per_account_day', 1, 10], ['max_orderables_per_booking', 1, 50], ['booking_reminder_hours_before', 1, 72],
  ['follow_up_reminder_lead_days', 0, 30], ['queue_display_history_count', 1, 10],
];
const TEXT_MAX: ReadonlyArray<readonly [string, number]> = [['support_phone', 40], ['app_consent_text', 4000], ['app_consent_text_version', 32], ['smart_report_disclaimer_text', 1000]];
const REQUIRED = [...BOOLS, 'allowed_phone_prefixes', 'min_app_version_android', 'min_app_version_ios', 'app_gateways', ...INT_RANGES.map((r) => r[0])];
const ALLOWED = new Set<string>([...REQUIRED, 'home_collection_centre_id', ...TEXT_MAX.map((t) => t[0])]);
const PREFIX = /^\+[1-9][0-9]{0,3}$/;
const VERSION = /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,4}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GATEWAYS = ['esewa', 'khalti'];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fe = (path: string, code: string, message: string): FieldError => ({ path, code, message });
const invalid = (path: string, code = 'common.field_invalid', message = 'Field invalid'): never => {
  throw new LimsError('common.validation_failed', undefined, [fe(path, code, message)]);
};
const outOfRange = (path: string): never => {
  throw new LimsError('engagement.setting_out_of_range', 'Setting out of allowed range', [fe(path, 'common.field_invalid', 'Out of allowed range')]);
};

function scope(ctx: SettingsCtx): { tx: any; tenantId: string; userId: string } {
  if (typeof ctx?.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
  return { tx: ctx.tx, tenantId: ctx.tenantId, userId: ctx.actor.id };
}

/** Shape (400) first, then the rules that mirror the DDL CHECKs (422). Returns the column values to store. */
function parseInput(body: unknown): Record<string, unknown> {
  if (!isObj(body)) return invalid('/');
  for (const k of Object.keys(body)) if (!ALLOWED.has(k)) invalid(`/${k.slice(0, 64)}`, 'common.unknown_field', 'Unknown field'); // mass assignment (REQ-SEC-080)
  for (const k of REQUIRED) if (body[k] === undefined) invalid(`/${k}`, 'common.field_required', 'Field required');
  for (const k of BOOLS) if (typeof body[k] !== 'boolean') invalid(`/${k}`);
  for (const [k] of INT_RANGES) if (!Number.isSafeInteger(body[k])) invalid(`/${k}`);
  for (const k of ['min_app_version_android', 'min_app_version_ios']) if (typeof body[k] !== 'string') invalid(`/${k}`);
  for (const k of ['allowed_phone_prefixes', 'app_gateways']) if (!Array.isArray(body[k]) || (body[k] as unknown[]).some((x) => typeof x !== 'string')) invalid(`/${k}`);
  for (const [k] of TEXT_MAX) if (body[k] !== undefined && typeof body[k] !== 'string') invalid(`/${k}`);
  const centre = body['home_collection_centre_id'];
  if (centre !== undefined && (typeof centre !== 'string' || !UUID.test(centre))) invalid('/home_collection_centre_id');

  for (const [k, lo, hi] of INT_RANGES) if ((body[k] as number) < lo || (body[k] as number) > hi) outOfRange(`/${k}`);
  const prefixes = body['allowed_phone_prefixes'] as string[];
  if (prefixes.length < 1 || prefixes.length > 5 || prefixes.some((p) => !PREFIX.test(p))) outOfRange('/allowed_phone_prefixes');
  if ((body['app_gateways'] as string[]).some((g) => !GATEWAYS.includes(g))) outOfRange('/app_gateways');
  for (const k of ['min_app_version_android', 'min_app_version_ios']) if (!VERSION.test(body[k] as string)) outOfRange(`/${k}`);
  for (const [k, max] of TEXT_MAX) if (typeof body[k] === 'string' && (body[k] as string).length > max) outOfRange(`/${k}`);
  if (body['app_consent_text_version'] === '') outOfRange('/app_consent_text_version');
  if ((body['app_consent_text'] === undefined) !== (body['app_consent_text_version'] === undefined)) outOfRange('/app_consent_text_version'); // settings__texts__ck pairs them
  if (body['home_collection_enabled'] === true && centre === undefined) outOfRange('/home_collection_centre_id'); // settings__hc_centre__ck
  return body;
}

/** If-Match arrives as the raw header '"<version>"' (02-CV §4.2): absent -> 428, malformed -> 400. */
export function parseIfMatch(headers: unknown): number {
  const h = isObj(headers) ? headers['if-match'] : undefined;
  if (h === undefined) throw new LimsError('common.precondition_required');
  const m = typeof h === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(h) : null;
  const n = m ? Number(m[1]) : 0;
  if (n < 1 || n > 2147483647) return invalid('/If-Match'); // version is a Postgres integer: bounded so an oversized value is a 400, not a 22003
  return n;
}

/** Row -> EngagementSettings: only schema fields; NULL columns are omitted (the schema types are not nullable). */
function toBody(row: Record<string, any>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ALLOWED) if (row[k] !== null && row[k] !== undefined) out[k] = row[k];
  out['version'] = row['version'];
  return out;
}

export function createSettingsService(deps: { repo?: SettingsRepo; listCodedSet?: typeof defaultListCodedSet } = {}) {
  const repo = deps.repo ?? defaultRepo;
  const listSet = deps.listCodedSet ?? defaultListCodedSet;

  return {
    /** Row absent -> defaults, version 1; a read never writes. */
    async getSettings(ctx: SettingsCtx) {
      const { tx, tenantId } = scope(ctx);
      const row = await repo.getEngagementSettings(tx, { tenantId });
      return row ? toBody(row) : { ...DEFAULT_SETTINGS, version: 1 };
    },

    async updateSettings(ctx: SettingsCtx, input: { headers: unknown; body: unknown }) {
      const { tx, tenantId, userId } = scope(ctx);
      const expectedVersion = parseIfMatch(input.headers);
      const values = parseInput(input.body);
      try {
        // Lazy row: INSERT … ON CONFLICT DO NOTHING, so losing the race re-reads the winner.
        const current = (await repo.getEngagementSettings(tx, { tenantId }))
          ?? (await repo.insertDefaultEngagementSettings(tx, { tenantId, userId }))
          ?? (await repo.getEngagementSettings(tx, { tenantId }));
        if (!current) throw new LimsError('common.internal');
        if (current['version'] !== expectedVersion) throw new LimsError('common.version_conflict');
        // Consent text change needs a new version (US-EN-20.2; DB trigger consent_version_required is the backstop).
        if (values['app_consent_text'] !== (current['app_consent_text'] ?? undefined)
          && values['app_consent_text_version'] === (current['app_consent_text_version'] ?? undefined)) outOfRange('/app_consent_text_version');
        const row = await repo.updateEngagementSettings(tx, { tenantId, userId, expectedVersion, values });
        if (!row) throw new LimsError('common.version_conflict');
        return toBody(row);
      } catch (e) {
        const code = (e as { code?: unknown } | null)?.code;
        if (!(e instanceof LimsError) && (code === '23514' || code === '23503')) // check / FK (centre) violation that slipped past the rules above
          return outOfRange(code === '23503' ? '/home_collection_centre_id' : '/');
        throw e;
      }
    },

    /** `allowed` = the sets this surface may read; the name never reaches SQL unless it is in that closed list. */
    async listCodedSet(ctx: SettingsCtx, input: { setName: unknown; allowed: readonly CodedSetName[] }) {
      const { tx, tenantId } = scope(ctx);
      const n = input.setName;
      if (!isCodedSetName(n) || !input.allowed.includes(n)) return invalid('/set_name');
      const rows = await listSet(tx, { tenantId, setName: n });
      return { data: rows.filter((r) => r['is_active'] !== false).map((r) => ({ code: r['code'] as string, display: r['display'] as string, sort_order: r['sort_order'] as number })) };
    },
  };
}
export type SettingsService = ReturnType<typeof createSettingsService>;