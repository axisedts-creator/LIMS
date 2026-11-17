// HC-T10 A1 registerPhleboDevice (POST /devices) / A5 signOffPhleboDevice (POST /devices/{device_id}/sign-off), both `homecollection.sync.upload` (02-TRD §5.2; US-13-2).
// The device is bound to the CALLER membership (ctx.actor.membershipId, never a body field). A device_id of another membership / tenant / unknown -> 409 device_not_registered (nothing about the owner).
// Headers x-lims-device-id / x-lims-app-version must equal the path/body values (400 common.id_mismatch). SQL lives in repository/*.repo.ts only. Nothing of the device / staff data is logged (REQ-SEC-081).
import { LimsError, type FieldError } from '../../core/errors.js';
import { toDeviceDto } from './mappers/device.mapper.js';
import { HOMECOLLECTION_PERMISSIONS } from './permissions.js';
import { getDeviceById, insertDeviceIfAbsent, updateDevice } from './repository/devices.repo.js';
import { getSettings, insertSettingsIfAbsent } from './repository/settings.repo.js';
import { settingsDefaults } from './settings.service.js';
import { uuidv7 } from '../../../../../packages/shared-ts/src/uuidv7/index.js';

const PERM_SYNC_UPLOAD = HOMECOLLECTION_PERMISSIONS[5];   // 'homecollection.sync.upload'
type Obj = Record<string, any>;
type Result = { status: number; body?: unknown };
interface Ctx {
  readonly tenantId: string; readonly tx: { query(t: string, v?: unknown[]): Promise<{ rows: any[] }> }; readonly actor: { readonly id: string; readonly membershipId?: string };
  readonly now: () => Date;
  readonly db: { tx<T>(fn: (c: any) => Promise<T>): Promise<T> };
  readonly log: { warn(o: object, m?: string): void };
  readonly ports: { readonly IdentityPort: { assertRole(ctx: unknown, r: { permission: string }): Promise<void> } };
  readonly core: { readonly memberships: { list(ctx: unknown, i: Obj): Promise<ReadonlyArray<{ membershipId: string; displayName: string }>> } };
}

function ctxOf(c: unknown): Ctx {
  const x = c as Partial<Ctx> | null;
  if (typeof x?.tenantId !== 'string' || !x.tx || typeof x.actor?.id !== 'string' || typeof x.now !== 'function' || !x.db || !x.ports?.IdentityPort || !x.core?.memberships) throw new LimsError('auth.unauthenticated');   // fail closed
  return x as Ctx;
}

// ---- validation (fixed messages: no submitted value is echoed) ----
export const bad = (path: string): LimsError => new LimsError('common.validation_failed', undefined, [{ path, code: 'common.field_invalid', message: 'Field invalid' } as FieldError]);
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
export const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const APP_VERSION = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/;
export const deviceIdOf =(v: unknown, path: string): string => { if (typeof v !== 'string' || !UUID_V7.test(v)) throw bad(path); return v; };
const text = (v: unknown, min: number, max: number, path: string): string => {
  if (typeof v !== 'string' || v.includes('\u0000') || [...v].length < min || [...v].length > max) throw bad(path);
  return v;
};
export const noExtra = (v: Obj, allowed: readonly string[]): void => {
  for (const k of Object.keys(v)) if (!allowed.includes(k)) throw new LimsError('common.validation_failed', undefined, [{ path: `/${k}`, code: 'common.unknown_field', message: 'Unknown field' }]);
};
const header = (headers: unknown, name: string): unknown => (isObj(headers) ? headers[name] : undefined);
const code = (e: unknown): string => (typeof (e as Obj)?.['code'] === 'string' ? (e as Obj)['code'] : 'unknown');
const notRegistered = (): LimsError => new LimsError('homecollection.device_not_registered');
const callerMembership = (ctx: Ctx): string => { if (!ctx.actor.membershipId) throw new LimsError('auth.forbidden'); return ctx.actor.membershipId; };

/** TRD §5 preamble: X-Lims-Device-Id / X-Lims-App-Version must equal the body / path values. */
const sameHeader = (headers: unknown, name: string, expected: string): void => { if (header(headers, name) !== expected) throw new LimsError('common.id_mismatch'); };

const partsOf = (v: string): number[] => v.split('.').map(Number);
export function belowMin(app: string, min: string): boolean {   // numeric per part (1.10.0 >= 1.9.0)
  const a = partsOf(app); const m = partsOf(min);
  for (let i = 0; i < 3; i++) { if ((a[i] ?? 0) !== (m[i] ?? 0)) return (a[i] ?? 0) < (m[i] ?? 0); }
  return false;
}

async function displayNameOf(ctx: Ctx, membershipId: string): Promise<string> {
  try {
    const rows = await ctx.db.tx((x) => ctx.core.memberships.list(x, { membershipIds: [membershipId], activeOnly: false }));   // savepoint: a failing lookup never poisons the tx (P-44)
    const name = rows.find((r) => r.membershipId === membershipId)?.displayName;
    if (typeof name === 'string' && name !== '') return name;
  } catch (e) { ctx.log.warn({ code: code(e) }, 'homecollection.staff_names_unavailable'); }
  return '—';
}

// ---- A1 ----
export async function registerPhleboDevice(hctx: unknown, headers: unknown, body: unknown): Promise<Result> {
  const ctx = ctxOf(hctx);
  await ctx.ports.IdentityPort.assertRole(ctx, { permission: PERM_SYNC_UPLOAD });
  const membershipId = callerMembership(ctx);
  if (!isObj(body)) throw bad('');
  noExtra(body, ['device_id', 'platform', 'os_version', 'app_version', 'model']);
  const deviceId = deviceIdOf(body['device_id'], '/device_id');
  const platform = body['platform'];
  if (platform !== 'android' && platform !== 'ios') throw bad('/platform');
  const osVersion = text(body['os_version'], 1, 40, '/os_version');
  const appVersion = text(body['app_version'], 1, 20, '/app_version');
  if (!APP_VERSION.test(appVersion)) throw bad('/app_version');
  const model = body['model'] === undefined ? undefined : text(body['model'], 1, 80, '/model');
  sameHeader(headers, 'x-lims-device-id', deviceId);
  sameHeader(headers, 'x-lims-app-version', appVersion);

  let settings = await getSettings(ctx.tx, ctx.tenantId);
  if (!settings) settings = (await insertSettingsIfAbsent(ctx.tx, ctx.tenantId, { ...settingsDefaults(), id: uuidv7() })) ?? (await getSettings(ctx.tx, ctx.tenantId));   // lazy create (08 A17 P-22), race-safe
  const min = String(settings?.['min_app_version'] ?? '1.0.0');
  if (APP_VERSION.test(min) && belowMin(appVersion, min)) throw new LimsError('homecollection.app_version_unsupported');   // REQ-SEC-113

  const created = await insertDeviceIfAbsent(ctx.tx, ctx.tenantId, { id: deviceId, membership_id: membershipId, platform, os_version: osVersion, app_version: appVersion, ...(model !== undefined ? { model } : {}), status: 'active' });
  let row = created ?? (await getDeviceById(ctx.tx, ctx.tenantId, deviceId));   // null insert = id exists (same tenant, lost race, or another tenant: then the tenant read finds nothing)
  if (!row || row['membership_id'] !== membershipId) throw notRegistered();
  if (!created && (row['status'] === 'signed_off' || row['status'] === 'wiped')) throw notRegistered();   // terminal: the app must register a new device id
  return { status: created ? 201 : 200, body: toDeviceDto(row, await displayNameOf(ctx, membershipId)) };   // wipe_requested is returned as is, never undone
}

// ---- A5 ----
export async function signOffPhleboDevice(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const ctx = ctxOf(hctx);
  await ctx.ports.IdentityPort.assertRole(ctx, { permission: PERM_SYNC_UPLOAD });
  const membershipId = callerMembership(ctx);
  const deviceId = deviceIdOf(isObj(params) ? params['device_id'] : undefined, '/device_id');
  sameHeader(headers, 'x-lims-device-id', deviceId);
  if (!isObj(body)) throw bad('');
  noExtra(body, ['last_device_seq']);
  const seq = body['last_device_seq'];
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) throw bad('/last_device_seq');

  for (let attempt = 0; attempt < 5; attempt++) {   // a concurrent writer (push, wipe, another sign-off) bumps the version: re-read and decide again
    const row = await getDeviceById(ctx.tx, ctx.tenantId, deviceId);
    if (!row || row['membership_id'] !== membershipId) throw notRegistered();   // binding before the seq check: no hint about the owner's state
    if (row['status'] === 'signed_off') return { status: 204 };                // retry of a lost 204: no-op
    if (row['status'] === 'wiped') throw notRegistered();
    if (row['status'] === 'wipe_requested') throw new LimsError('homecollection.unsynced_changes');   // AB13: until the wipe is acknowledged
    if (BigInt(seq) > BigInt(row['max_device_seq_received'])) throw new LimsError('homecollection.unsynced_changes');   // US-13-2
    const done = await updateDevice(ctx.tx, ctx.tenantId, deviceId, Number(row['version']), { status: 'signed_off', signed_off_at: ctx.now() });
    if (done) return { status: 204 };
  }
  throw new LimsError('common.version_conflict');
}
