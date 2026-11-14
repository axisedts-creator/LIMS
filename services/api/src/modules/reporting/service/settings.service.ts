// reporting settings service: S1-S7 + R17 (02-TRD §6.5, §10.2; 05-SCHEMA §2.13, §6, §8; 07-SECURITY REQ-SEC-002/024/080).
// Tenant and actor come from ctx only. Bodies are the OpenAPI snake_case shapes. Raw FK/RLS SQLSTATEs (23503/42501) pass through to
// core's mapDbError (-> common.not_found). Error messages never carry input values.
import { LimsError, type FieldError } from '../../../core/errors.js';
// [CONV] relative import until @lims/shared-ts is a services/api dependency (same as core/errors.ts).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import * as repo from '../repository/settings.repo.js';

export interface SettingsCtx {
  readonly tenantId: string;
  readonly actor: { readonly type: string; readonly id: string; readonly membershipId?: string };
  readonly tx: unknown;
}
export interface SettingsDeps {
  readonly core: { membershipPermissions(ctx: any, input: { membershipId: string }): Promise<readonly string[]> };
  readonly newId?: () => string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const E164 = /^\+[1-9][0-9]{7,14}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const CHANNELS = ['whatsapp', 'sms', 'email'];
const CODE_SETS = ['regeneration_reasons', 'token_revoke_reasons', 'outsourced_withdraw_reasons', 'narrative_amend_reasons'];
const SIGNATORY_PERMS = ['lab.result.approve', 'reporting.narrative.sign'];
const CODES_MAX = 200;

const fail = (path: string, code = 'common.field_invalid', message = 'Field invalid'): never => {
  throw new LimsError('common.validation_failed', undefined, [{ path, code, message } satisfies FieldError]);
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function onlyKeys(o: Record<string, unknown>, allowed: readonly string[]) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`/${k.slice(0, 64)}`, 'common.unknown_field', 'Unknown field');
}
const has = (o: Record<string, unknown>, k: string) => o[k] !== undefined;
function enumArray(v: unknown, path: string, allowed: readonly string[], min: number, max: number): string[] {
  if (!Array.isArray(v) || v.length < min || v.length > max || new Set(v).size !== v.length || !v.every((x) => typeof x === 'string' && allowed.includes(x))) fail(path);
  return [...(v as string[])];
}
function int(v: unknown, path: string, min: number, max: number) { if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) fail(path); }
function bool(v: unknown, path: string) { if (typeof v !== 'boolean') fail(path); }
function uuidList(v: unknown, path: string, max: number): string[] {
  if (!Array.isArray(v)) return fail(path, 'common.field_required', 'Field required');
  if (v.length > max || new Set(v).size !== v.length || !v.every((x) => typeof x === 'string' && UUID.test(x))) fail(path);
  return [...(v as string[])];
}
function version(v: unknown): number {
  if (v === undefined || v === null) throw new LimsError('common.precondition_required');
  // version is a Postgres `integer`: bound to int32 so oversized If-Match is 400, not 22003 -> 500.
  if (!Number.isSafeInteger(v) || (v as number) < 1 || (v as number) > 2147483647) fail('/If-Match');
  return v as number;
}

const SETTINGS_RULES: Record<string, (v: unknown, p: string) => void> = {
  auto_release: (v, p) => { if (v !== 'when_eligible' && v !== 'manual') fail(p); },
  narrative_report_mode: (v, p) => { if (v !== 'separate' && v !== 'combined') fail(p); },
  patient_mobile_channel_order: (v, p) => enumArray(v, p, ['whatsapp', 'sms'], 1, 2),
  patient_email_enabled: bool, referrer_delivery_enabled: bool, centre_delivery_enabled: bool,
  critical_alert_referrer_enabled: bool, print_critical_label: bool, dues_link_enabled: bool,
  referrer_channels: (v, p) => enumArray(v, p, CHANNELS, 0, 3),
  whatsapp_fallback_minutes: (v, p) => int(v, p, 5, 240),
  bulk_release_max: (v, p) => int(v, p, 1, 200),
  link_reissue_max_per_day: (v, p) => int(v, p, 0, 5),
  portal_payment_gateways: (v, p) => enumArray(v, p, ['esewa', 'khalti'], 0, 2),   // Fonepay BLOCKED B8
};

function scope(ctx: SettingsCtx): { tx: repo.Tx; tenantId: string; actorId: string } {
  if (typeof ctx?.tenantId !== 'string' || !UUID.test(ctx.tenantId) || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
  return { tx: ctx.tx as repo.Tx, tenantId: ctx.tenantId, actorId: ctx.actor.id };
}
const settingsBody = (r: any) => Object.fromEntries([...repo.SETTINGS_PATCH_COLUMNS, 'version'].map((c) => [c, r[c]]));
function mask(channel: string, address: string): string {
  if (channel === 'email') {
    const at = address.lastIndexOf('@');
    return `${address.slice(0, 1)}***@${address.slice(at + 1).slice(-35)}`;
  }
  return `${'*'.repeat(Math.max(address.length - 4, 4))}${address.slice(-4)}`.slice(-40);
}
const contactBody = (r: any) => ({
  id: r.id, centre_id: r.centre_id, channel: r.channel, address_masked: mask(r.channel, String(r.address ?? '')),
  label: r.label ?? '', is_active: r.is_active, version: r.version,
});

export function createSettingsService(deps: SettingsDeps) {
  const newId = deps.newId ?? uuidv7;

  async function ensureSettings(tx: repo.Tx, tenantId: string, actorId: string) {
    const found = await repo.findSettings(tx, tenantId);
    if (found) return found;
    await repo.insertDefaultSettings(tx, newId(), tenantId, actorId);   // ON CONFLICT DO NOTHING: losing a race is fine
    const row = await repo.findSettings(tx, tenantId);
    if (!row) throw new LimsError('common.internal');
    return row;
  }

  return {
    async getSettings(ctx: SettingsCtx) {
      const { tx, tenantId, actorId } = scope(ctx);
      return settingsBody(await ensureSettings(tx, tenantId, actorId));
    },

    async updateSettings(ctx: SettingsCtx, input: { expectedVersion: unknown; patch: unknown }) {
      const { tx, tenantId, actorId } = scope(ctx);
      const v = version(input?.expectedVersion);
      const patch = input?.patch;
      if (!isObj(patch)) return fail('/');
      // [CONV] default_template_id_* are in the OpenAPI patch but have no 05-SCHEMA column: rejected until CR-C6-021 resolves (.orchestra/cr/C6-T03.md).
      onlyKeys(patch, Object.keys(SETTINGS_RULES));
      for (const [k, val] of Object.entries(patch)) SETTINGS_RULES[k]!(val, `/${k}`);
      await ensureSettings(tx, tenantId, actorId);
      const row = await repo.updateSettings(tx, tenantId, v, patch as repo.SettingsPatch, actorId);
      if (!row) throw new LimsError('common.version_conflict');
      return settingsBody(row);
    },

    async listCentreContacts(ctx: SettingsCtx, input: { centreId?: unknown } = {}) {
      const { tx, tenantId } = scope(ctx);
      const centreId = input?.centreId;
      if (centreId !== undefined && (typeof centreId !== 'string' || !UUID.test(centreId))) fail('/centre_id');
      const rows = await repo.listCentreContacts(tx, tenantId, (centreId as string | undefined) ?? null);
      return { data: rows.map(contactBody) };
    },

    async createCentreContact(ctx: SettingsCtx, input: unknown) {
      const { tx, tenantId, actorId } = scope(ctx);
      if (!isObj(input)) return fail('/');
      onlyKeys(input, ['centre_id', 'channel', 'address', 'label']);
      for (const k of ['centre_id', 'channel', 'address', 'label']) if (!has(input, k)) fail(`/${k}`, 'common.field_required', 'Field required');
      const { centre_id, channel, address, label } = input;
      if (typeof centre_id !== 'string' || !UUID.test(centre_id)) fail('/centre_id');
      if (typeof channel !== 'string' || !CHANNELS.includes(channel)) fail('/channel');
      if (typeof address !== 'string' || address.length > 254) fail('/address');
      if (channel === 'email' ? !EMAIL.test(address as string) : !E164.test(address as string)) fail('/address');
      if (typeof label !== 'string' || label.length > 80) fail('/label');
      const row = await repo.insertCentreContact(tx, {
        id: newId(), tenantId, centreId: centre_id as string, channel: channel as string, address: address as string, label: label as string, actorId,
      });
      return contactBody(row);
    },

    async updateCentreContact(ctx: SettingsCtx, input: { centreContactId: unknown; expectedVersion: unknown; patch: unknown }) {
      const { tx, tenantId, actorId } = scope(ctx);
      const patch = input?.patch;
      if (!isObj(patch)) return fail('/');
      onlyKeys(patch, ['label', 'is_active']);
      if (has(patch, 'label') && (typeof patch['label'] !== 'string' || (patch['label'] as string).length > 80)) fail('/label');
      if (has(patch, 'is_active')) bool(patch['is_active'], '/is_active');
      const v = version(input?.expectedVersion);
      const id = input?.centreContactId;
      if (typeof id !== 'string' || !UUID.test(id)) throw new LimsError('common.not_found');
      const row = await repo.updateCentreContact(tx, tenantId, id, v, patch as { label?: string; is_active?: boolean }, actorId);
      if (row) return contactBody(row);
      throw new LimsError((await repo.centreContactVersion(tx, tenantId, id)) === undefined ? 'common.not_found' : 'common.version_conflict');
    },

    async replaceStaffAssignments(ctx: SettingsCtx, input: unknown) {
      const { tx, tenantId, actorId } = scope(ctx);
      if (!isObj(input)) return fail('/');
      onlyKeys(input, ['nominated_signatories', 'critical_alert_recipients']);
      const lists: Record<repo.Assignment, string[]> = {
        nominated_signatory: uuidList(input['nominated_signatories'], '/nominated_signatories', 4),
        critical_alert_recipient: uuidList(input['critical_alert_recipients'], '/critical_alert_recipients', 20),
      };
      // All permission checks before any write (atomic from the caller's view).
      for (const [i, membershipId] of lists.nominated_signatory.entries()) {
        const perms = await deps.core.membershipPermissions(ctx, { membershipId });
        if (!perms.some((p) => SIGNATORY_PERMS.includes(p))) fail(`/nominated_signatories/${i}`);
      }
      for (const assignment of ['nominated_signatory', 'critical_alert_recipient'] as const) {
        const wanted = lists[assignment];
        const existing = await repo.listStaffAssignments(tx, tenantId, assignment);
        for (const e of existing) if (e.is_active !== false && !wanted.includes(e.membership_id)) await repo.deactivateStaffAssignment(tx, tenantId, assignment, e.membership_id, actorId);
        for (const [sortOrder, membershipId] of wanted.entries()) {
          const e = existing.find((x) => x.membership_id === membershipId);
          if (e && e.is_active !== false && e.sort_order === sortOrder) continue;   // unchanged: untouched
          await repo.upsertStaffAssignment(tx, { id: newId(), tenantId, membershipId, assignment, sortOrder, actorId });
        }
      }
      return { nominated_signatories: lists.nominated_signatory, critical_alert_recipients: lists.critical_alert_recipient };
    },

    async upsertReferrerPreference(ctx: SettingsCtx, input: { referrerId: unknown; disabledChannels: unknown }) {
      const { tx, tenantId, actorId } = scope(ctx);
      const referrerId = input?.referrerId;
      if (typeof referrerId !== 'string' || !UUID.test(referrerId)) fail('/referrer_id');
      const disabledChannels = enumArray(input?.disabledChannels, '/disabled_channels', CHANNELS, 0, 3);
      const row = await repo.upsertReferrerPreference(tx, { id: newId(), tenantId, referrerId: referrerId as string, disabledChannels, actorId });
      return { referrer_id: row.referrer_id, disabled_channels: [...row.disabled_channels] };
    },

    async listCodes(ctx: SettingsCtx, input: { setName: unknown }) {
      const { tx, tenantId } = scope(ctx);
      const setName = input?.setName;
      if (typeof setName !== 'string' || !CODE_SETS.includes(setName)) fail('/set_name');
      return { data: await repo.listCodes(tx, tenantId, setName as string, CODES_MAX) };
    },
  };
}
export type SettingsService = ReturnType<typeof createSettingsService>;
