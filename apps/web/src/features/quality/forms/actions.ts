'use server';
// C9 T-22 set-up server actions (forms): every write of the four set-up tabs plus the C7/C3 picker reads. The JWT stays on the server (REQ-SEC-068);
// a server action is a public endpoint, so each input is re-validated here with the same rules as the forms. POSTs carry an Idempotency-Key, changes to an existing row If-Match "<version>".
// Only ApiError becomes { ok:false, status, code }; anything else rethrows. LD-140 does not apply (no UI).
import 'server-only';
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { permissions } from '../server/quality.server';
import type { AnalyteOption, FieldIssue, Picked, PreviewPoint, SetupResult } from './types';
import {
  DAY, DECIMAL, ISO_UTC, KEY, LOT_NO, MAX_PERIOD_DAYS, PICK, UNIT, UUID, validateLot, validateMap, validateMaterial, validatePlanParams, type MapInput, type MaterialInput,
} from './validate';

const invalid = (): SetupResult<never> => ({ ok: false, status: 400, code: 'common.validation_failed' });
const forbidden = (): SetupResult<never> => ({ ok: false, status: 403, code: 'auth.forbidden' });
const str = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : undefined);

/** Field messages of a problem+json body, sanitised: JSON pointer + short text only. */
function issues(p: Record<string, unknown>): FieldIssue[] {
  if (!Array.isArray(p['errors'])) return [];
  return (p['errors'] as { pointer?: unknown; path?: unknown; message?: unknown }[]).slice(0, 20).flatMap((x) => {
    const pointer = String(x?.pointer ?? x?.path ?? '');
    const message = String(x?.message ?? '');
    return pointer.startsWith('/') && message ? [{ pointer: pointer.slice(0, 120), message: message.slice(0, 200) }] : [];
  });
}
async function call<T>(run: () => Promise<T>): Promise<SetupResult<T>> {
  try {
    return { ok: true, data: await run() };
  } catch (e) {
    if (e instanceof ApiError) {
      const errors = issues(e.problem);
      return { ok: false, status: e.status, code: e.problem.code, ...(errors.length ? { errors } : {}) };
    }
    throw e;
  }
}
const post = <T>(path: string, key: string, body: unknown, version?: number) =>
  serverFetch<T>(`/v1/quality/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key, ...(version !== undefined ? { 'if-match': `"${version}"` } : {}) },
    body: JSON.stringify(body),
  });
const okKey = (k: unknown): k is string => typeof k === 'string' && KEY.test(k);
const okId = (id: unknown): id is string => typeof id === 'string' && UUID.test(id);
const okVersion = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const okReason = (r: unknown): r is string => typeof r === 'string' && r.trim().length >= 1 && r.length <= 500;

// ---------------------------------------------------------------- materials (#2, #5, #8)
export async function createMaterialAction(input: MaterialInput, key: string): Promise<SetupResult<unknown>> {
  if (!okKey(key) || typeof input?.code !== 'string' || !Array.isArray(input.levels) || input.levels.some((l) => typeof l?.level_code !== 'string' || typeof l.display_name !== 'string')) return invalid();
  const manufacturer = str(input.manufacturer, 120)?.trim();
  const matrix = str(input.matrix, 60)?.trim();
  const v: MaterialInput = { ...input, name: String(input.name ?? '').trim(), ...(manufacturer ? { manufacturer } : {}), ...(matrix ? { matrix } : {}) };
  if (Object.keys(validateMaterial(v)).length) return invalid();
  return call(() => post('control-materials', key, {
    code: v.code, name: v.name, ...(manufacturer ? { manufacturer } : {}), ...(matrix ? { matrix } : {}),
    levels: v.levels.map((l) => ({ level_code: l.level_code, display_name: l.display_name.trim(), sort_order: l.sort_order })),
  }));
}
export async function addLotAction(levelId: string, input: { lot_no: string; expires_on: string }, key: string): Promise<SetupResult<unknown>> {
  if (!okKey(key) || !okId(levelId) || typeof input?.lot_no !== 'string' || !LOT_NO.test(input.lot_no) || Object.keys(validateLot({ lot_no: input.lot_no, expires_on: String(input.expires_on) }, '0000-00-00')).length) return invalid();
  return call(() => post(`control-levels/${levelId}/lots`, key, { lot_no: input.lot_no, expires_on: input.expires_on }));
}
export async function deactivateMaterialAction(id: string, version: number, key: string): Promise<SetupResult<unknown>> {
  return okKey(key) && okId(id) && okVersion(version) ? call(() => post(`control-materials/${id}/deactivate`, key, {}, version)) : invalid();
}

// ---------------------------------------------------------------- control-ID maps (#12, #13)
export async function createMapAction(input: MapInput, key: string): Promise<SetupResult<unknown>> {
  const lotRaw = input?.control_lot_raw ?? '';
  if (!okKey(key) || !okId(input?.instrument_id) || !okId(input?.lot_id) || typeof input?.control_id_raw !== 'string' || input.control_id_raw.trim() === '' || typeof lotRaw !== 'string') return invalid();
  if (Object.keys(validateMap({ instrument_id: input.instrument_id, control_id_raw: input.control_id_raw, control_lot_raw: lotRaw, lot_id: input.lot_id })).length) return invalid();
  // raw values are sent exactly as typed: they must equal what the analyser sends
  return call(() => post('control-id-maps', key, { instrument_id: input.instrument_id, control_id_raw: input.control_id_raw, ...(lotRaw ? { control_lot_raw: lotRaw } : {}), lot_id: input.lot_id }));
}
export async function deactivateMapAction(id: string, version: number, key: string): Promise<SetupResult<unknown>> {
  return okKey(key) && okId(id) && okVersion(version) ? call(() => post(`control-id-maps/${id}/deactivate`, key, {}, version)) : invalid();
}

// ---------------------------------------------------------------- plans (#15, #17, #18, #19)
interface ParamsIn {
  controls_per_run: number; composition: { level_id: string; count: number }[]; mean_rule: string; two_two_s_across_runs: boolean; count_rules_across_materials: boolean;
  exclude_rejected_runs_from_history: boolean; run_window_minutes: number; qc_validity_hours: number; hold_lookback_hours: number;
}
function cleanParams(p: ParamsIn): ParamsIn | undefined {
  if (!p || !Array.isArray(p.composition) || p.composition.some((c) => !okId(c?.level_id))) return undefined;
  if ([p.two_two_s_across_runs, p.count_rules_across_materials, p.exclude_rejected_runs_from_history].some((b) => typeof b !== 'boolean')) return undefined;
  if (Object.keys(validatePlanParams({ ...p, composition: p.composition })).length || typeof p.mean_rule !== 'string') return undefined;
  const { controls_per_run, mean_rule, two_two_s_across_runs, count_rules_across_materials, exclude_rejected_runs_from_history, run_window_minutes, qc_validity_hours, hold_lookback_hours } = p;
  return {
    controls_per_run, composition: p.composition.map((c) => ({ level_id: c.level_id, count: c.count })), mean_rule, two_two_s_across_runs, count_rules_across_materials, exclude_rejected_runs_from_history,
    run_window_minutes, qc_validity_hours, hold_lookback_hours,
  };
}
export async function createPlanAction(input: { instrument_id: string; test_id: string; analyte_id: string; params: ParamsIn }, key: string): Promise<SetupResult<{ warnings: string[] }>> {
  const params = cleanParams(input?.params);
  if (!okKey(key) || !okId(input?.instrument_id) || !okId(input?.test_id) || !okId(input?.analyte_id) || !params) return invalid();
  return call(async () => {
    const r = await post<{ warnings?: unknown }>('qc-plans', key, { instrument_id: input.instrument_id, test_id: input.test_id, analyte_id: input.analyte_id, params });
    return { warnings: Array.isArray(r?.warnings) ? r.warnings.filter((w): w is string => typeof w === 'string').slice(0, 10) : [] };
  });
}
export async function newPlanVersionAction(id: string, version: number, input: { params: ParamsIn; change_reason: string }, key: string): Promise<SetupResult<unknown>> {
  const params = cleanParams(input?.params);
  if (!okKey(key) || !okId(id) || !okVersion(version) || !params || !okReason(input?.change_reason)) return invalid();
  return call(() => post(`qc-plans/${id}/versions`, key, { params, change_reason: input.change_reason.trim() }, version));
}
export async function activatePlanAction(id: string, version: number, key: string): Promise<SetupResult<unknown>> {
  return okKey(key) && okId(id) && okVersion(version) ? call(() => post(`qc-plans/${id}/activate`, key, {}, version)) : invalid();
}
export async function deactivatePlanAction(id: string, version: number, reason: string, key: string): Promise<SetupResult<unknown>> {
  return okKey(key) && okId(id) && okVersion(version) && okReason(reason) ? call(() => post(`qc-plans/${id}/deactivate`, key, { reason: reason.trim() }, version)) : invalid();
}

// ---------------------------------------------------------------- targets (#21–#25)
export async function createTargetAction(input: { plan_id: string; lot_id: string; mean: string; sd: string; unit_code?: string; note?: string }, key: string): Promise<SetupResult<unknown>> {
  const note = str(input?.note, 500)?.trim();
  const unit = input?.unit_code;
  if (!okKey(key) || !okId(input?.plan_id) || !okId(input?.lot_id) || typeof input?.mean !== 'string' || !DECIMAL.test(input.mean) || typeof input?.sd !== 'string' || !DECIMAL.test(input.sd) || !/[1-9]/.test(input.sd)) return invalid();
  if (input.mean.length > 24 || input.sd.length > 24 || (unit !== undefined && !(typeof unit === 'string' && UNIT.test(unit))) || (input.note !== undefined && note === undefined)) return invalid();
  // numbers stay strings end to end (02-TRD §7.6); a manual target is always a manufacturer value (#21)
  return call(() => post('qc-targets', key, { plan_id: input.plan_id, lot_id: input.lot_id, mean: input.mean, sd: input.sd, ...(unit ? { unit_code: unit } : {}), source: 'manufacturer', ...(note ? { note } : {}) }));
}
export async function establishTargetAction(
  input: { plan_id: string; lot_id: string; observed_at_from: string; observed_at_to: string; exclude_observation_ids?: string[]; include_observation_ids?: string[] }, key: string,
): Promise<SetupResult<unknown>> {
  const ids = (l: unknown) => (l === undefined ? [] : Array.isArray(l) && l.length <= 2000 && l.every(okId) ? (l as string[]) : undefined);
  const exclude = ids(input?.exclude_observation_ids);
  const include = ids(input?.include_observation_ids);
  if (!okKey(key) || !okId(input?.plan_id) || !okId(input?.lot_id) || !ISO_UTC.test(String(input?.observed_at_from)) || !ISO_UTC.test(String(input?.observed_at_to)) || !exclude || !include) return invalid();
  const span = Date.parse(input.observed_at_to) - Date.parse(input.observed_at_from);
  if (!(span > 0) || span > MAX_PERIOD_DAYS * DAY || (exclude.length && include.length)) return invalid();
  return call(() => post('qc-targets/establish', key, {
    plan_id: input.plan_id, lot_id: input.lot_id, observed_at_from: input.observed_at_from, observed_at_to: input.observed_at_to,
    ...(exclude.length ? { exclude_observation_ids: exclude } : {}), ...(include.length ? { include_observation_ids: include } : {}),
  }));
}
export async function activateTargetAction(id: string, version: number, key: string): Promise<SetupResult<unknown>> {
  return okKey(key) && okId(id) && okVersion(version) ? call(() => post(`qc-targets/${id}/activate`, key, {}, version)) : invalid();
}
export async function retireTargetAction(id: string, version: number, reason: string, key: string): Promise<SetupResult<unknown>> {
  return okKey(key) && okId(id) && okVersion(version) && okReason(reason) ? call(() => post(`qc-targets/${id}/retire`, key, { reason: reason.trim() }, version)) : invalid();
}
export async function discardTargetAction(id: string, version: number, key: string): Promise<SetupResult<unknown>> {
  return okKey(key) && okId(id) && okVersion(version) ? call(() => post(`qc-targets/${id}/discard`, key, {}, version)) : invalid();
}

/** Accepted observations of a lot in a period, for the "establish from data" preview (read-only; at most 5 pages of 200). */
export async function previewObservationsAction(input: { plan_id: string; lot_id: string; observed_at_from: string; observed_at_to: string }): Promise<SetupResult<{ points: PreviewPoint[]; truncated: boolean }>> {
  if (!okId(input?.plan_id) || !okId(input?.lot_id) || !ISO_UTC.test(String(input?.observed_at_from)) || !ISO_UTC.test(String(input?.observed_at_to))) return invalid();
  const span = Date.parse(input.observed_at_to) - Date.parse(input.observed_at_from);
  if (!(span > 0) || span > MAX_PERIOD_DAYS * DAY) return invalid();
  return call(async () => {
    const points: PreviewPoint[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const q = new URLSearchParams({ plan_id: input.plan_id, lot_id: input.lot_id, observed_at_from: input.observed_at_from, observed_at_to: input.observed_at_to, status: 'assigned', limit: '200' });
      if (cursor) q.set('cursor', cursor);
      const r = await serverFetch<{ data?: { id: string; observed_at: string; value: string }[]; page?: { next_cursor?: string } }>(`/v1/quality/qc-observations?${q.toString()}`);
      for (const o of Array.isArray(r?.data) ? r.data : []) if (okId(o?.id) && typeof o.value === 'string' && DECIMAL.test(o.value.replace(/^-/, ''))) points.push({ id: o.id, observed_at: String(o.observed_at), value: o.value });
      cursor = r?.page?.next_cursor;
      if (!cursor) return { points, truncated: false };
    }
    return { points, truncated: true };
  });
}

// ---------------------------------------------------------------- C7 / C3 pickers (BFF: the browser never calls them; no request without the read permission)
const norm = (q: unknown) => (typeof q === 'string' ? q.trim().toLowerCase().slice(0, 80) : '');
export async function searchInstrumentsAction(query: string): Promise<SetupResult<Picked[]>> {
  if (!(await permissions()).includes(PICK.instruments)) return forbidden();
  const needle = norm(query);
  return call(async () => {
    const r = await serverFetch<{ data?: { id: string; instrument_code: string; display_name: string; state?: string }[] }>('/v1/instruments/instruments?limit=200&sort=instrument_code');
    return (Array.isArray(r?.data) ? r.data : [])
      .filter((i) => okId(i?.id) && i.state !== 'retired' && `${i.instrument_code} ${i.display_name}`.toLowerCase().includes(needle))
      .slice(0, 50).map((i) => ({ id: i.id, label: `${i.instrument_code} ${i.display_name}` }));
  });
}
export async function searchTestsAction(query: string): Promise<SetupResult<Picked[]>> {
  if (!(await permissions()).includes(PICK.tests)) return forbidden();
  const needle = norm(query);
  return call(async () => {
    const r = await serverFetch<{ data?: { id: string; kind?: string; code: string; name: string; is_active?: boolean }[] }>('/v1/catalog/tests?limit=200&sort=code');
    return (Array.isArray(r?.data) ? r.data : [])
      .filter((t) => okId(t?.id) && (t.kind === undefined || t.kind === 'test') && t.is_active !== false && `${t.code} ${t.name}`.toLowerCase().includes(needle))
      .slice(0, 50).map((t) => ({ id: t.id, label: `${t.code} — ${t.name}` }));
  });
}
/** Numeric analytes of one test (a QC plan needs numeric results only). */
export async function analytesOfTestAction(testId: string): Promise<SetupResult<AnalyteOption[]>> {
  if (!okId(testId)) return invalid();
  if (!(await permissions()).includes(PICK.tests)) return forbidden();
  return call(async () => {
    const r = await serverFetch<{ analytes?: { id: string; code: string; name: string; is_active?: boolean; current_version?: { result_type?: string } }[] }>(`/v1/catalog/tests/${testId}`);
    return (Array.isArray(r?.analytes) ? r.analytes : [])
      .filter((a) => okId(a?.id) && a.is_active !== false && a.current_version?.result_type === 'numeric')
      .map((a) => ({ id: a.id, label: `${a.code} — ${a.name}` }));
  });
}
