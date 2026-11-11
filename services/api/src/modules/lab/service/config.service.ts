// T-29 configuration service: #47 getLabSettings, #48 updateLabSettings, #49-#52 delta-check rules (versioned, AC-12.4), #53 listLabCodedSet, #54 upsertLabCode
// (02-TRD §5.8 rows 47-54, §9.1; 05-SCHEMA lab_settings / delta_check_rules / cs_* + g_cs_*; 07-SECURITY REQ-SEC-013/024/062/067, S-15, P-01/P-03/P-10).
// Runs in the request tx (ctx.tx, RLS). Tenant + actor come from ctx only. Permission = IdentityPort.assertRole of the operation's x-permission; `auth.mfa_required` passes through.
// Missing lab_settings row = the §9.1 defaults at version 1 (a PUT with If-Match "1" creates it). A rule's DTO `id` = its row id; `rule_id` (the chain) = the id of version 1.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../core/errors.js';
import type { DeltaRule } from '../domain/delta.js';
import type { RepoCtx, Row } from '../repository/base.repo.js';
import { getTenantCode, insertCodedSetEntry, listCodedSet, updateCodedSetEntry, type CodedSet } from '../repository/codedSets.repo.js';
import { getDeltaRule, getEffectiveDeltaRuleRow, insertDeltaRule, listDeltaRules, updateDeltaRule } from '../repository/deltaRules.repo.js';
import { getLabSettings as getSettingsRow, insertLabSettings, updateLabSettings as updateSettingsRow } from '../repository/labSettings.repo.js';
import { bad, isObj, ISO_MS, repoCtx, role, specimenCtx, strict, uuidParam, type Obj, type Result } from './specimen.service.js';

const P = { settingsRead: 'lab.worklist.read', ruleRead: 'lab.result.read', setRead: 'lab.specimen.read', manage: 'lab.config.manage' } as const;
const MAX_VERSION = 2147483647;
const present = (v: unknown): boolean => v !== undefined && v !== null;

/** [CONV] If-Match "<n>" as specimen.service: missing -> 428, malformed -> 400 /headers/if-match. */
function ifMatch(headers: unknown): number | undefined {
  const h = isObj(headers) ? headers['if-match'] : undefined;
  if (h === undefined) return undefined;
  const m = typeof h === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(h) : null;
  if (!m || Number(m[1]) > MAX_VERSION) throw bad('/headers/if-match');
  return Number(m[1]);
}
const requireIfMatch = (headers: unknown): number => {
  const v = ifMatch(headers);
  if (v === undefined) throw new LimsError('common.precondition_required');
  return v;
};
/** A unique-index hit (lost race / one-active-rule-per-analyte) is a 409, never a 500; every other error is rethrown. The request tx rolls back. */
const clash = (e: unknown): never => {
  if ((e as { code?: unknown } | null)?.code === '23505') throw new LimsError('common.version_conflict');
  throw e;
};

// ====================================================================== #47 / #48 lab settings ======================================================================
const DEFAULTS: Obj = { version: 1, label_width_mm: 50, label_height_mm: 25, label_copies_default: 1, label_renderer: 'html_svg', host_query_requires_received: true,
  ingest_auto_receive: false, critical_notification_blocks_approval: true, recollection_default: true, delta_check_enabled: true, history_days: 730 };
const SETTING_KEYS = Object.keys(DEFAULTS).filter((k) => k !== 'version');
const INT_RANGE: Record<string, [number, number]> = { label_width_mm: [20, 100], label_height_mm: [10, 60], label_copies_default: [1, 5], history_days: [30, 3650] };
const BOOLS = ['host_query_requires_received', 'ingest_auto_receive', 'critical_notification_blocks_approval', 'recollection_default', 'delta_check_enabled'];

const settingsDto = (row: Obj): Obj => Object.fromEntries(['version', ...SETTING_KEYS].map((k) => [k, row[k]]));

export async function getLabSettings(c: unknown): Promise<Result> {
  const ctx = specimenCtx(c);
  await role(ctx, P.settingsRead);
  const row = await getSettingsRow(repoCtx(ctx));
  return { status: 200, body: settingsDto(row ?? DEFAULTS) };
}

export async function updateLabSettings(c: unknown, headers: unknown, body: unknown): Promise<Result> {
  const ctx = specimenCtx(c);
  await role(ctx, P.manage);
  const expected = requireIfMatch(headers);
  const b = strict(body, SETTING_KEYS);
  const patch: Row = {};
  for (const k of SETTING_KEYS) {
    const v = b[k], r = INT_RANGE[k];
    if (r ? !(Number.isInteger(v) && v >= r[0] && v <= r[1]) : BOOLS.includes(k) ? typeof v !== 'boolean' : v !== 'html_svg') throw bad(`/${k}`);
    patch[k] = v;
  }
  const rc = repoCtx(ctx);
  const existing = await getSettingsRow(rc);
  let row: Row;
  if (existing) row = await updateSettingsRow(rc, expected, patch);
  else {
    if (expected !== 1) throw new LimsError('common.version_conflict');
    try { row = await insertLabSettings(rc, patch); } catch (e) { return clash(e); }
  }
  return { status: 200, body: settingsDto(row) };
}

// ====================================================================== #49-#52 delta-check rules ======================================================================
const ruleDto = (r: Obj): Obj => {
  const d: Obj = { id: r['id'], version: r['version'], analyte_id: r['analyte_id'], rule_version: r['rule_version'], window_seconds: r['window_seconds'], unit_code: r['unit_code'],
    effective_from: r['effective_from'].toISOString(), is_active: r['is_active'] };
  if (present(r['abs_threshold'])) d['abs_threshold'] = String(r['abs_threshold']);
  if (present(r['pct_threshold'])) d['pct_threshold'] = String(r['pct_threshold']);
  if (present(r['effective_to'])) d['effective_to'] = r['effective_to'].toISOString();
  return d;
};

const DECIMAL = /^-?[0-9]+(\.[0-9]+)?$/;
const absOk = (s: string): boolean => !s.startsWith('-') && /[1-9]/.test(s);                                // > 0, exact (no float)
const pctOk = (s: string): boolean => {                                                                     // 0 < s <= 1000, exact
  if (s.startsWith('-')) return false;
  const [i = '', f = ''] = s.split('.');
  const n = BigInt(i);
  return (n < 1000n || (n === 1000n && /^0*$/.test(f))) && (n > 0n || /[1-9]/.test(f));
};
const decimal = (v: unknown, path: string, ok: (s: string) => boolean): string | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length > 40 || !DECIMAL.test(v) || !ok(v)) throw bad(path);
  return v;
};

interface RuleInput { analyteId?: string; windowSeconds: number; abs?: string; pct?: string; unitCode: string; effectiveFrom?: Date }
/** Body of #50 (with analyte_id) / #51 (without). Thresholds: ≥1, abs > 0, 0 < pct ≤ 1000 — checked here so a CHECK violation is never the first line of defence. */
function parseRule(body: unknown, withAnalyte: boolean): RuleInput {
  const b = strict(body, ['window_seconds', 'abs_threshold', 'pct_threshold', 'unit_code', 'effective_from', ...(withAnalyte ? ['analyte_id'] : [])]);
  const out: RuleInput = { windowSeconds: 0, unitCode: '' };
  if (withAnalyte) {
    if (typeof b['analyte_id'] !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(b['analyte_id'])) throw bad('/analyte_id');
    out.analyteId = b['analyte_id'].toLowerCase();
  }
  const w = b['window_seconds'];
  if (!Number.isInteger(w) || w < 3600 || w > 31_536_000) throw bad('/window_seconds');
  out.windowSeconds = w;
  const abs = decimal(b['abs_threshold'], '/abs_threshold', absOk), pct = decimal(b['pct_threshold'], '/pct_threshold', pctOk);
  const u = b['unit_code'];
  if (typeof u !== 'string' || u.length < 1 || u.length > 100 || u.includes('\u0000') || u.trim() === '') throw bad('/unit_code');
  out.unitCode = u;
  if (b['effective_from'] !== undefined) {
    const ms = typeof b['effective_from'] === 'string' && ISO_MS.test(b['effective_from']) ? Date.parse(b['effective_from']) : NaN;
    if (!Number.isFinite(ms)) throw bad('/effective_from');
    out.effectiveFrom = new Date(ms);
  }
  if (abs === undefined && pct === undefined) throw bad('/abs_threshold');
  if (abs !== undefined) out.abs = abs;
  if (pct !== undefined) out.pct = pct;
  return out;
}
const ruleCols = (i: RuleInput): Row => ({ unit_code: i.unitCode, window_seconds: i.windowSeconds, ...(i.abs === undefined ? {} : { abs_threshold: i.abs }), ...(i.pct === undefined ? {} : { pct_threshold: i.pct }) });

/** The delta rule IN FORCE at `at` (AC-12.4): active, effective_from <= at < effective_to. T-12/T-14 delta wiring must use this, not getActiveDeltaRule (deltaRules.repo.ts:29), so that a future-dated version is not applied early (AC-12.4). */
export async function getEffectiveDeltaRule(rc: RepoCtx, analyteId: string, at: Date): Promise<DeltaRule | undefined> {
  const r = await getEffectiveDeltaRuleRow(rc, analyteId, at);
  if (!r) return undefined;
  return { ruleId: r['rule_id'], ruleVersion: r['rule_version'], windowSeconds: r['window_seconds'],
    ...(present(r['abs_threshold']) ? { absThreshold: String(r['abs_threshold']) } : {}), ...(present(r['pct_threshold']) ? { pctThreshold: String(r['pct_threshold']) } : {}) };
}

export async function listRules(c: unknown, query: unknown): Promise<Result> {
  const ctx = specimenCtx(c);
  await role(ctx, P.ruleRead);
  const q = isObj(query) ? query : {};
  const f: { analyteId?: string; isActive?: boolean } = {};
  if (q['analyte_id'] !== undefined) {
    if (typeof q['analyte_id'] !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q['analyte_id'])) throw bad('/analyte_id');
    f.analyteId = q['analyte_id'].toLowerCase();
  }
  if (q['is_active'] !== undefined) {
    const a = q['is_active'];
    if (a !== true && a !== false && a !== 'true' && a !== 'false') throw bad('/is_active');
    f.isActive = a === true || a === 'true';
  }
  return { status: 200, body: { data: (await listDeltaRules(repoCtx(ctx), f)).map(ruleDto) } };
}

export async function createRule(c: unknown, body: unknown): Promise<Result> {
  const ctx = specimenCtx(c);
  await role(ctx, P.manage);
  const i = parseRule(body, true);
  const id = uuidv7();
  try {
    const row = await insertDeltaRule(repoCtx(ctx), { id, rule_id: id, rule_version: 1, analyte_id: i.analyteId, ...ruleCols(i), effective_from: i.effectiveFrom ?? ctx.now() });
    return { status: 201, body: ruleDto(row) };
  } catch (e) { return clash(e); }                                                                           // second active rule for the analyte (partial unique index)
}

/** Version n+1 of the chain of `{rule_id}` (a row id of the CURRENT version): the previous row ends where the new one begins; its numbers are never rewritten. */
export async function versionRule(c: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const ctx = specimenCtx(c);
  await role(ctx, P.manage);
  const expected = requireIfMatch(headers);
  const id = uuidParam(params, 'rule_id');
  const rc = repoCtx(ctx);
  const prev = await getDeltaRule(rc, id);
  if (!prev) throw new LimsError('common.not_found');   // P-01 (T-32): a foreign / unknown rule is 404 before the body is judged
  const i = parseRule(body, false);
  if (prev['version'] !== expected || prev['effective_to'] != null) throw new LimsError('common.version_conflict');   // stale, or already superseded
  const from = i.effectiveFrom ?? ctx.now();
  if (from.getTime() <= prev['effective_from'].getTime()) throw bad('/effective_from');
  try {
    await updateDeltaRule(rc, id, expected, { effective_to: from });                                           // row lock + version check: one racing writer wins
    const row = await insertDeltaRule(rc, { id: uuidv7(), rule_id: prev['rule_id'], rule_version: prev['rule_version'] + 1, analyte_id: prev['analyte_id'], ...ruleCols(i), effective_from: from });
    return { status: 201, body: ruleDto(row) };
  } catch (e) { return clash(e); }
}

export async function deactivateRule(c: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const ctx = specimenCtx(c);
  await role(ctx, P.manage);
  const expected = requireIfMatch(headers);
  strict(body, []);
  const row = await updateDeltaRule(repoCtx(ctx), uuidParam(params, 'rule_id'), expected, { is_active: false });
  return { status: 200, body: ruleDto(row) };
}

// ====================================================================== #53 / #54 coded sets ======================================================================
const SETS: readonly CodedSet[] = ['rejection_reasons', 'return_reasons', 'amendment_reasons', 'exception_discard_reasons'];
const setName = (params: unknown): CodedSet => {
  const v = isObj(params) ? params['set_name'] : undefined;
  if (typeof v !== 'string' || !SETS.includes(v as CodedSet)) throw bad('/set_name');
  return v as CodedSet;
};
const codeDto = (r: Obj, source: 'global' | 'tenant'): Obj => ({ code: r['code'], display: r['display'], sort_order: r['sort_order'], is_active: r['is_active'], source });

export async function listCodes(c: unknown, params: unknown): Promise<Result> {
  const ctx = specimenCtx(c);
  await role(ctx, P.setRead);
  const rows = await listCodedSet(repoCtx(ctx), setName(params));
  return { status: 200, body: { data: rows.map((r) => codeDto(r, r['scope'])) } };
}

export async function upsertCode(c: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const ctx = specimenCtx(c);
  await role(ctx, P.manage);
  const set = setName(params);
  const code = isObj(params) ? params['code'] : undefined;
  if (typeof code !== 'string' || !/^[a-z0-9_]{1,64}$/.test(code)) throw bad('/code');
  const expected = ifMatch(headers);
  const b = strict(body, ['display', 'sort_order', 'is_active']);
  const { display, sort_order: sort, is_active: active } = b;
  if (typeof display !== 'string' || display.length < 1 || display.length > 120 || display.includes('\u0000') || display.trim() === '') throw bad('/display');
  if (!Number.isInteger(sort) || sort < 0 || sort > 10_000) throw bad('/sort_order');
  if (typeof active !== 'boolean') throw bad('/is_active');
  const rc = repoCtx(ctx);
  const existing = await getTenantCode(rc, set, code);
  if (existing) {
    if (expected === undefined) throw new LimsError('common.precondition_required');
    return { status: 200, body: codeDto(await updateCodedSetEntry(rc, set, existing['id'], expected, { display, sort_order: sort, is_active: active }), 'tenant') };
  }
  if (expected !== undefined) throw new LimsError('common.version_conflict');                                  // an If-Match for a row that does not exist
  try {                                                                                                      // a tenant row also overrides (shadows) a global code; the global row is never written
    return { status: 200, body: codeDto(await insertCodedSetEntry(rc, set, { id: uuidv7(), code, display, sort_order: sort, is_active: active }), 'tenant') };
  } catch (e) { return clash(e); }
}
