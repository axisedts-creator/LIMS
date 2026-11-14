// C9 T-24 settings rules (contracts/openapi/quality.yaml: updateQualitySettings #52, upsertQualityCode #54). One source for the form limits and the server-action re-check.
import type { QualitySettings } from '../types';

export const MANAGE_CONFIG = 'quality.config.manage';

/** Inclusive [min, max] of each integer setting. */
export const RANGES = {
  tat_warn_pct: [50, 99],
  tat_escalate_pct: [101, 1000],
  tat_orphan_close_hours: [1, 720],
  target_min_points: [2, 500],
  sim_min_days: [1, 90],
  sim_min_decisions: [10, 100000],
  reprocess_window_days: [1, 30],
} as const;
export type NumKey = keyof typeof RANGES;
export const NUM_KEYS = Object.keys(RANGES) as NumKey[];

/** #52 requires all nine mutable keys; read-only fields (version, westgard_mode, updated_*) are never sent. */
export type SettingsBody = Record<NumKey, number> & { tat_alerts_enabled: boolean; default_plan_params: Record<string, unknown> };

export const settingsBody = (s: QualitySettings): SettingsBody => ({
  tat_alerts_enabled: s.tat_alerts_enabled, tat_warn_pct: s.tat_warn_pct, tat_escalate_pct: s.tat_escalate_pct, tat_orphan_close_hours: s.tat_orphan_close_hours, target_min_points: s.target_min_points,
  sim_min_days: s.sim_min_days, sim_min_decisions: s.sim_min_decisions, reprocess_window_days: s.reprocess_window_days, default_plan_params: s.default_plan_params,
});

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export function settingsValid(b: unknown): b is SettingsBody {
  if (!isObject(b) || typeof b['tat_alerts_enabled'] !== 'boolean' || !isObject(b['default_plan_params'])) return false;
  return NUM_KEYS.every((k) => {
    const v = b[k];
    return typeof v === 'number' && Number.isInteger(v) && v >= RANGES[k][0] && v <= RANGES[k][1];
  });
}

export const CODED_SETS = [{ id: 'corrective_actions', title: 'Corrective actions' }, { id: 'exclusion_reasons', title: 'Exclusion reasons' }] as const;
export type CodedSetName = (typeof CODED_SETS)[number]['id'];
export const isCodedSet = (v: unknown): v is CodedSetName => CODED_SETS.some((s) => s.id === v);

export interface CodeInput { display: string; sort_order: number; is_active: boolean }
export const codeValid = (c: unknown): c is CodeInput =>
  isObject(c) && typeof c['display'] === 'string' && c['display'].trim().length >= 1 && c['display'].length <= 120
  && typeof c['sort_order'] === 'number' && Number.isInteger(c['sort_order']) && c['sort_order'] >= 0 && c['sort_order'] <= 999 && typeof c['is_active'] === 'boolean';
