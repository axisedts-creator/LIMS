// SCR-11 settings schema (02-TRD §7.4 InstrumentSettings). Pure and client-importable: the form validates with the same
// rules the BFF re-checks before any network call. Issues carry JSON Pointers like the API's errors[].
import { int, isObj, type Issue } from './transport';

export const SETTINGS_RANGES = {
  default_backlog_threshold: [10, 100000],
  backlog_max_oldest_pending_seconds: [60, 86400],
  clock_offset_warn_seconds: [30, 3600],
  agent_uploaded_retention_hours: [1, 72],
} as const;
export type SettingsNumKey = keyof typeof SETTINGS_RANGES;
export const HHMM_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const KEYS = [...Object.keys(SETTINGS_RANGES), 'update_window_from', 'update_window_to'] as const;

export function validateSettings(b: unknown): Issue[] {
  if (!isObj(b)) return [{ path: '', message: 'Fill in the settings.' }];
  const out: Issue[] = [];
  const get = (k: string) => (Object.hasOwn(b, k) ? b[k] : undefined);
  for (const [k, [min, max]] of Object.entries(SETTINGS_RANGES)) {
    if (!int(get(k), min, max)) out.push({ path: `/${k}`, message: `Enter a whole number from ${min} to ${max}.` }); // [CONV] text
  }
  const f = get('update_window_from');
  const t = get('update_window_to');
  for (const [k, v, other] of [['update_window_from', f, t], ['update_window_to', t, f]] as const) {
    if (v === undefined && other !== undefined) out.push({ path: `/${k}`, message: 'Fill in both times, or leave both empty.' });
    else if (v !== undefined && (typeof v !== 'string' || !HHMM_RE.test(v))) out.push({ path: `/${k}`, message: 'Use HH:MM, for example 01:00.' });
  }
  return out;
}

/** Only the documented mutable keys: `version`, retention or any unknown key is never forwarded. */
export const settingsBody = (b: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(KEYS.filter((k) => Object.hasOwn(b, k) && b[k] !== undefined).map((k) => [k, b[k]]));
