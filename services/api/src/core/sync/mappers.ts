// T0B-SYNC-1 (LD-322): row -> response mappers and request guards of the offline sync operations (contracts/openapi/core.yaml,
// schemas SyncDevice, NumberBlock). Responses carry only schema keys (never tenant_id, version, created_by).
import { LimsError, type FieldError } from '../errors.js';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const APP_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;
/** core.yaml IsoDateTime: UTC instant, optional fraction of up to 6 digits. */
export const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
export const PLATFORMS: readonly string[] = ['web', 'android', 'ios'];
export const DEVICE_STATUSES: readonly string[] = ['active', 'revoked', 'wipe_requested'];
/** Design section 4 (LD-322 decision 1): only these two series are ever issued in blocks. */
export const SERIES: readonly string[] = ['lab_code', 'patient_id'];

export const invalid = (path: string, code = 'common.field_invalid'): LimsError =>
  new LimsError('common.validation_failed', undefined, [{ path, code, message: 'invalid value' } satisfies FieldError]);

/** Plain object with only the allowed keys, else common.validation_failed (additionalProperties: false). */
export function objectWith(v: unknown, allowed: readonly string[], where = ''): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw invalid(where || '/', 'common.field_required');
  for (const k of Object.keys(v)) if (!allowed.includes(k)) throw invalid(`${where}/${k}`, 'common.unknown_field');
  return v as Record<string, unknown>;
}
export const uuidOf = (v: unknown, path: string): string => {
  if (typeof v !== 'string' || !UUID.test(v)) throw invalid(path, v === undefined ? 'common.field_required' : 'common.field_invalid');
  return v.toLowerCase();
};

const iso = (v: unknown): string | undefined => (v == null ? undefined : (v instanceof Date ? v : new Date(String(v))).toISOString());
const int = (v: unknown): number | undefined => (v == null ? undefined : Number(v));
const put = (o: Record<string, unknown>, k: string, v: unknown) => { if (v !== undefined) o[k] = v; };

export function toSyncDevice(r: any): Record<string, unknown> {
  const o: Record<string, unknown> = {
    id: r.id, user_id: r.user_id, device_label: r.device_label, platform: r.platform, app_version: r.app_version, status: r.status,
    first_seen_at: iso(r.first_seen_at), last_seen_at: iso(r.last_seen_at),
  };
  put(o, 'last_sync_at', iso(r.last_sync_at));
  put(o, 'wipe_requested_at', iso(r.wipe_requested_at));
  put(o, 'wipe_acked_at', iso(r.wipe_acked_at));
  put(o, 'last_clock_skew_ms', int(r.last_clock_skew_ms));
  o.offline_retention_days = Number(r.offline_retention_days);
  o.created_at = iso(r.created_at);
  o.updated_at = iso(r.updated_at);
  return o;
}

export function toNumberBlock(r: any): Record<string, unknown> {
  const o: Record<string, unknown> = { id: r.id, device_id: r.device_id, series: r.series };
  put(o, 'centre_id', r.centre_id ?? undefined);
  o.from_value = Number(r.from_value);
  o.to_value = Number(r.to_value);
  o.issued_at = iso(r.issued_at);
  put(o, 'exhausted_at', iso(r.exhausted_at));
  o.skipped_count = Number(r.skipped_count);
  return o;
}
