// settings.service.ensure (02-TRD §12.1 Bootstrap; 08 A17 D-56, P-22): the first ensure for a tenant fixes activated_at.
// INSERT ... ON CONFLICT (tenant_id) DO NOTHING, then read the row (race-safe: no check-then-insert), then ensure sync_state from THAT row's activated_at.
// Tenant and actor are explicit: the Tx facade carries neither. Runs in the caller's transaction; DB errors propagate.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError, isLimsError } from '../../../core/errors.js';
import { getSettings, insertSettingsDefaults, insertSyncState, listGlobalCodes, listTenantCodes, updateSettings, upsertTenantCode, type SettingsTx } from '../repository/settings.repo.js';
import { Errs, isObj } from './setup.validate.js';

export interface QualitySettings {
  readonly id: string;
  readonly tenantId: string;
  readonly tatAlertsEnabled: boolean;
  readonly tatWarnPct: number;
  readonly tatEscalatePct: number;
  readonly tatOrphanCloseHours: number;
  readonly targetMinPoints: number;
  readonly simMinDays: number;
  readonly simMinDecisions: number;
  readonly reprocessWindowDays: number;
  readonly defaultPlanParams: Record<string, unknown>;
  readonly activatedAt: Date | string;
  readonly isActive: boolean;
  readonly version: number;
}

const toSettings = (r: Record<string, any>): QualitySettings => ({
  id: r['id'], tenantId: r['tenant_id'], tatAlertsEnabled: r['tat_alerts_enabled'], tatWarnPct: r['tat_warn_pct'], tatEscalatePct: r['tat_escalate_pct'],
  tatOrphanCloseHours: r['tat_orphan_close_hours'], targetMinPoints: r['target_min_points'], simMinDays: r['sim_min_days'],
  simMinDecisions: r['sim_min_decisions'], reprocessWindowDays: r['reprocess_window_days'], defaultPlanParams: r['default_plan_params'],
  activatedAt: r['activated_at'], isActive: r['is_active'], version: r['version'],
});

// ---------------------------------------------------------------------------------------------------- #51-#54 (02-TRD §5.8, §12.1; REQ-SEC-024/040/080/081)
type Row = Record<string, any>;
export interface SettingsCtx {
  tenantId: string; tx: SettingsTx; actor: { id: string };
  ports: { IdentityPort: { assertRole(ctx: unknown, r: { permission: string }): Promise<void>; getTenantSettings(ctx: unknown, q: { keys: string[] }): Promise<Row> } };
}
type Out = { status: 200; body: Row; version?: number };

const READ = 'quality.qc_run.read', MANAGE = 'quality.config.manage';
const SETS = ['corrective_actions', 'exclusion_reasons'] as const;
const CODE_RE = /^[a-z][a-z0-9_]{1,63}$/;
const MEAN_RULES = ['8x', '10x', '12x', '6x', '9x'];
const RANGES: Array<[string, number, number]> = [['tat_warn_pct', 50, 99], ['tat_escalate_pct', 101, 1000], ['tat_orphan_close_hours', 1, 720], ['target_min_points', 2, 500],
  ['sim_min_days', 1, 90], ['sim_min_decisions', 10, 100000], ['reprocess_window_days', 1, 30]];
const PLAN_PARAMS: Record<string, (v: unknown) => boolean> = {
  mean_rule: (v) => typeof v === 'string' && MEAN_RULES.includes(v),
  two_two_s_across_runs: (v) => typeof v === 'boolean', count_rules_across_materials: (v) => typeof v === 'boolean', exclude_rejected_runs_from_history: (v) => typeof v === 'boolean',
  run_window_minutes: (v) => Number.isInteger(v) && (v as number) >= 5 && (v as number) <= 240,
  qc_validity_hours: (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 168,
  hold_lookback_hours: (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 168,
};

const inRange = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const iso = (v: unknown): string => new Date(v as string | Date).toISOString();

/** LimsErrors pass; anything else (driver, missing row) is common.internal without its text. */
function fail(err: any): never {
  if (isLimsError(err) || (typeof err?.code === 'string' && /^[a-z]+\.[a-z_]+$/.test(err.code))) throw err;
  throw new LimsError('common.internal');
}
const assert = (c: SettingsCtx, permission: string) => c.ports.IdentityPort.assertRole(c, { permission });

/** Closed object: unknown keys -> unknown_field at `${at}/${key}`. */
function closed(e: Errs, v: unknown, allowed: readonly string[], at: string): Row | undefined {
  if (!isObj(v)) { e.add(at || '/'); return undefined; }
  for (const k of Object.keys(v)) if (!allowed.includes(k)) e.add(`${at}/${k}`, 'common.unknown_field');
  return v;
}

function settingsPatch(body: unknown): Row {
  const e = new Errs(), o = closed(e, body, ['tat_alerts_enabled', ...RANGES.map((r) => r[0]), 'default_plan_params'], '');
  const patch: Row = {};
  if (o) {
    if (o['tat_alerts_enabled'] === undefined) e.add('/tat_alerts_enabled', 'common.field_required');
    else if (typeof o['tat_alerts_enabled'] !== 'boolean') e.add('/tat_alerts_enabled'); else patch['tat_alerts_enabled'] = o['tat_alerts_enabled'];
    for (const [k, lo, hi] of RANGES) {
      if (o[k] === undefined) e.add(`/${k}`, 'common.field_required');
      else if (!inRange(o[k], lo, hi)) e.add(`/${k}`); else patch[k] = o[k];
    }
    const p = o['default_plan_params'];
    if (p === undefined) e.add('/default_plan_params', 'common.field_required');
    else {
      const po = closed(e, p, Object.keys(PLAN_PARAMS), '/default_plan_params');
      if (po) { for (const k of Object.keys(po)) if (k in PLAN_PARAMS && !PLAN_PARAMS[k]!(po[k])) e.add(`/default_plan_params/${k}`); patch['default_plan_params'] = po; }
    }
  }
  e.done();
  return patch;
}

function setOf(setName: unknown): string {
  if (typeof setName !== 'string' || !(SETS as readonly string[]).includes(setName)) { const e = new Errs(); e.add('/set_name'); e.done(); }
  return setName as string;
}

function codeBody(setName: unknown, code: unknown, body: unknown) {
  const e = new Errs();
  if (typeof setName !== 'string' || !(SETS as readonly string[]).includes(setName)) e.add('/set_name');
  if (code === undefined) e.add('/code', 'common.field_required'); else if (typeof code !== 'string' || !CODE_RE.test(code)) e.add('/code');
  const o = closed(e, body, ['display', 'sort_order', 'is_active'], '');
  let display: string | undefined, sortOrder: number | undefined, isActive: boolean | undefined;
  if (o) {
    if (o['display'] === undefined) e.add('/display', 'common.field_required');
    else if (typeof o['display'] !== 'string' || [...o['display']].length < 1 || [...o['display']].length > 120) e.add('/display'); else display = o['display'];
    if (o['sort_order'] === undefined) e.add('/sort_order', 'common.field_required');
    else if (!inRange(o['sort_order'], 0, 999)) e.add('/sort_order'); else sortOrder = o['sort_order'];
    if (o['is_active'] === undefined) e.add('/is_active', 'common.field_required');
    else if (typeof o['is_active'] !== 'boolean') e.add('/is_active'); else isActive = o['is_active'];
  }
  e.done();
  return { setName: setName as string, code: code as string, display: display!, sortOrder: sortOrder!, isActive: isActive! };
}

async function settingsDto(c: SettingsCtx, r: Row): Promise<Out> {
  // westgard_mode / auto_verification_enabled belong to C2 (read-only here); nothing stored -> §12.1 defaults.
  const s = await c.ports.IdentityPort.getTenantSettings(c, { keys: ['westgardMode', 'autoVerificationEnabled'] });
  return {
    status: 200, version: r['version'],
    body: {
      version: r['version'], tat_alerts_enabled: r['tat_alerts_enabled'], tat_warn_pct: r['tat_warn_pct'], tat_escalate_pct: r['tat_escalate_pct'],
      tat_orphan_close_hours: r['tat_orphan_close_hours'], target_min_points: r['target_min_points'], sim_min_days: r['sim_min_days'], sim_min_decisions: r['sim_min_decisions'],
      reprocess_window_days: r['reprocess_window_days'], default_plan_params: r['default_plan_params'], activated_at: iso(r['activated_at']),
      ...(r['updated_at'] == null ? {} : { updated_at: iso(r['updated_at']) }),
      westgard_mode: s?.['westgardMode'] === 'modern' ? 'modern' : 'classic', auto_verification_enabled: s?.['autoVerificationEnabled'] === true,
    },
  };
}

const codeDto = (r: Row, source: 'global' | 'tenant') => ({ code: r['code'], display: r['display'], sort_order: r['sort_order'], is_active: r['is_active'], source });

export function createSettingsService() {
  const ensureRow = async (tx: SettingsTx, who: { tenantId: string; actorId: string }): Promise<Row> => {
    await insertSettingsDefaults(tx, { id: uuidv7(), tenantId: who.tenantId, actorId: who.actorId });
    const row = await getSettings(tx, who.tenantId);
    if (!row) throw new Error('quality.settings row missing after ensure'); // RLS / tenant FK problem: never fabricate defaults
    await insertSyncState(tx, { id: uuidv7(), tenantId: who.tenantId, activatedAt: row['activated_at'] });
    return row;
  };
  const ensure = async (tx: SettingsTx, who: { tenantId: string; actorId: string }): Promise<QualitySettings> => toSettings(await ensureRow(tx, who));
  const ensured = (c: SettingsCtx) => ensureRow(c.tx, { tenantId: c.tenantId, actorId: c.actor.id });

  return {
    ensure,

    async getQualitySettings(c: SettingsCtx, _in: unknown): Promise<Out> {
      await assert(c, READ);
      try { return await settingsDto(c, await ensured(c)); } catch (err) { return fail(err); }
    },

    async updateQualitySettings(c: SettingsCtx, input: { expectedVersion?: number; body: unknown }): Promise<Out> {
      await assert(c, MANAGE);
      const patch = settingsPatch(input.body);
      if (input.expectedVersion === undefined) throw new LimsError('common.precondition_required');
      try {
        await ensured(c);
        const row = await updateSettings(c.tx, c.tenantId, input.expectedVersion, patch, c.actor.id);
        if (!row) throw new LimsError('common.version_conflict');
        return await settingsDto(c, row);
      } catch (err) { return fail(err); }
    },

    async listQualityCodedSet(c: SettingsCtx, input: { setName: unknown }): Promise<Out> {
      await assert(c, READ);
      const set = setOf(input.setName);
      try {
        const own = (await listTenantCodes(c.tx, c.tenantId, set)).map((r) => codeDto(r, 'tenant'));
        const taken = new Set(own.map((r) => r.code));   // a tenant row shadows the global row with the same code (05-SCHEMA §2)
        const global = (await listGlobalCodes(c.tx, set)).filter((r) => !taken.has(r['code'])).map((r) => codeDto(r, 'global'));
        const data = [...own, ...global].sort((a, b) => a.sort_order - b.sort_order || cmp(a.code, b.code)).slice(0, 500);
        return { status: 200, body: { data } };
      } catch (err) { return fail(err); }
    },

    async upsertQualityCode(c: SettingsCtx, input: { setName: unknown; code: unknown; body: unknown }): Promise<Out> {
      await assert(c, MANAGE);
      const v = codeBody(input.setName, input.code, input.body);
      try {
        const r = await upsertTenantCode(c.tx, c.tenantId, v.setName, { id: uuidv7(), code: v.code, display: v.display, sortOrder: v.sortOrder, isActive: v.isActive, actorId: c.actor.id });
        return { status: 200, body: codeDto(r, 'tenant') };
      } catch (err) { return fail(err); }
    },
  };
}
