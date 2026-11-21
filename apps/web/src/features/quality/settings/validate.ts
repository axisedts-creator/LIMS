// C9 T-24 settings rules (contracts/openapi/quality.yaml: updateQualitySettings #52, upsertQualityCode #54). One source for the form limits and the server-action re-check.
import { PLAN_WINDOWS, planWindowErrors } from '../forms/validate';
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

/** QcPlanParamsDefaults (contracts/openapi/quality.yaml): every key optional, additionalProperties: false. No N here, so all five n-x rules are offered. */
export const MEAN_RULES = ['8x', '10x', '12x', '6x', '9x'] as const;
export const PLAN_FLAGS = ['two_two_s_across_runs', 'count_rules_across_materials', 'exclude_rejected_runs_from_history'] as const;
const PLAN_KEYS = new Set<string>(['mean_rule', ...PLAN_FLAGS, ...Object.keys(PLAN_WINDOWS)]);
export function planDefaultsValid(p: unknown): p is Record<string, unknown> {
  if (!isObject(p) || Object.keys(p).some((k) => !PLAN_KEYS.has(k))) return false;
  if (p['mean_rule'] !== undefined && !(MEAN_RULES as readonly unknown[]).includes(p['mean_rule'])) return false;
  if (PLAN_FLAGS.some((k) => p[k] !== undefined && typeof p[k] !== 'boolean')) return false;
  return Object.keys(planWindowErrors(p)).length === 0; // same limits as the plan form (forms/validate.ts)
}

export function settingsValid(b: unknown): b is SettingsBody {
  if (!isObject(b) || typeof b['tat_alerts_enabled'] !== 'boolean' || !planDefaultsValid(b['default_plan_params'])) return false;
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
