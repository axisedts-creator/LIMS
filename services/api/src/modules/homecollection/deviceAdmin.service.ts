// HC-T15 H16 listPhleboDevices (GET /devices) / H17 requestDeviceWipe (POST /devices/{device_id}/wipe), both `homecollection.device.manage` (privileged: IdentityPort.assertRole answers
// auth.forbidden / auth.mfa_required BEFORE any validation or lookup; 07-SECURITY §4). US-13-5: the wipe is only STORED (status wipe_requested); the snapshot (A2) delivers it (TRD §6.2).
// The actor comes from the claims (ctx.actor), never the body. SQL lives in repository/*.repo.ts only. Nothing of staff / device data is logged (REQ-SEC-081).
import { LimsError, type FieldError } from '../../core/errors.js';
import { toDeviceDto } from './mappers/device.mapper.js';
import { HOMECOLLECTION_PERMISSIONS } from './permissions.js';
import { getDeviceById, listDevicesPage, updateDevice } from './repository/devices.repo.js';
import { getReason } from './repository/reasons.repo.js';

const PERM_DEVICE_MANAGE = HOMECOLLECTION_PERMISSIONS[3];   // 'homecollection.device.manage'
const WIPE_REASONS = 'wipe_reasons';   // g_cs_reasons set_code (05-SCHEMA §4)
type Obj = Record<string, any>;
type Result = { status: number; body?: unknown };
interface Ctx {
  readonly tenantId: string; readonly tx: { query(t: string, v?: unknown[]): Promise<{ rows: any[] }> }; readonly actor: { readonly id: string };
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
const bad = (path: string): LimsError => new LimsError('common.validation_failed', undefined, [{ path, code: 'common.field_invalid', message: 'Field invalid' } as FieldError]);
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATUSES = ['active', 'signed_off', 'wipe_requested', 'wiped'];
const noExtra = (v: Obj, allowed: readonly string[]): void => {
  for (const k of Object.keys(v)) if (!allowed.includes(k)) throw new LimsError('common.validation_failed', undefined, [{ path: `/${k}`, code: 'common.unknown_field', message: 'Unknown field' }]);
};
const code = (e: unknown): string => (typeof (e as Obj)?.['code'] === 'string' ? (e as Obj)['code'] : 'unknown');

function expectedVersion(headers: unknown): number {   // 02-CV §4.2, as H19: If-Match "<n>"
  const h = isObj(headers) ? headers['if-match'] : undefined;
  if (h === undefined) throw new LimsError('common.precondition_required');
  const m = typeof h === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(h) : null;
  if (!m || Number(m[1]) > 2147483647) throw bad('/headers/if-match');
  return Number(m[1]);
}

const limitOf = (v: unknown): number => {
  if (v === undefined) return 50;
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^[0-9]{1,3}$/.test(v) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 200) throw bad('/limit');
  return n;
};

// ---- cursor: base64url(JSON{v:1, k: registered_at text, i: id}); carries no authority (02-CV §4.3); anything malformed -> common.invalid_cursor ----
const TS_KEY = /^\d{4,}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;
const invalidCursor = (): LimsError => new LimsError('common.invalid_cursor');
const encodeCursor = (key: string, id: string): string => Buffer.from(JSON.stringify({ v: 1, k: key, i: id })).toString('base64url');
function decodeCursor(raw: unknown): { key: string; id: string } {
  if (typeof raw !== 'string' || raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw invalidCursor();
  let o: unknown;
  try { o = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { throw invalidCursor(); }
  if (!isObj(o) || o['v'] !== 1 || typeof o['k'] !== 'string' || !TS_KEY.test(o['k']) || typeof o['i'] !== 'string' || !UUID.test(o['i'])) throw invalidCursor();
  return { key: o['k'], id: o['i'] };
}

/** One memberships.list call for all owners (savepoint: a failing lookup never poisons the tx, P-44); a miss or failure -> placeholder, never an error. */
async function namesOf(ctx: Ctx, membershipIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (membershipIds.length === 0) return out;
  try {
    const rows = await ctx.db.tx((x) => ctx.core.memberships.list(x, { membershipIds, activeOnly: false }));
    for (const r of rows) if (typeof r.displayName === 'string' && r.displayName !== '') out.set(r.membershipId, r.displayName);
  } catch (e) { ctx.log.warn({ code: code(e) }, 'homecollection.staff_names_unavailable'); }
  return out;
}
const PLACEHOLDER = '—';

// ---- H16 ----
export async function listPhleboDevices(hctx: unknown, query: unknown): Promise<Result> {
  const ctx = ctxOf(hctx);
  await ctx.ports.IdentityPort.assertRole(ctx, { permission: PERM_DEVICE_MANAGE });
  const q = isObj(query) ? query : {};
  noExtra(q, ['status', 'membership_id', 'limit', 'cursor']);
  const status = q['status'];
  if (status !== undefined && (typeof status !== 'string' || !STATUSES.includes(status))) throw bad('/status');
  const membershipId = q['membership_id'];
  if (membershipId !== undefined && (typeof membershipId !== 'string' || !UUID.test(membershipId))) throw bad('/membership_id');
  const limit = limitOf(q['limit']);
  const after = q['cursor'] === undefined ? undefined : decodeCursor(q['cursor']);

  const rows = await listDevicesPage(ctx.tx, ctx.tenantId, { limit: limit + 1, ...(status !== undefined ? { status } : {}), ...(membershipId !== undefined ? { membershipId } : {}), ...(after ? { after } : {}) });
  const page = rows.slice(0, limit); const last = page[page.length - 1];
  const names = await namesOf(ctx, [...new Set(page.map((r) => r['membership_id'] as string))]);
  return { status: 200, body: { data: page.map((r) => toDeviceDto(r, names.get(r['membership_id']) ?? PLACEHOLDER)), page: { limit, ...(rows.length > limit && last ? { next_cursor: encodeCursor(last['sort_key'], last['id']) } : {}) } } };
}

// ---- H17 ----
export async function requestDeviceWipe(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const ctx = ctxOf(hctx);
  await ctx.ports.IdentityPort.assertRole(ctx, { permission: PERM_DEVICE_MANAGE });
  const deviceId = isObj(params) ? params['device_id'] : undefined;
  if (typeof deviceId !== 'string' || !UUID.test(deviceId)) throw bad('/device_id');
  const expected = expectedVersion(headers);
  if (!isObj(body)) throw bad('');
  noExtra(body, ['reason_code', 'reason_text']);
  const reasonCode = body['reason_code'];
  if (typeof reasonCode !== 'string' || !/^[a-z_]{1,64}$/.test(reasonCode)) throw bad('/reason_code');
  const rawText = body['reason_text'];
  if (rawText !== undefined && (typeof rawText !== 'string' || rawText.includes('\u0000') || [...rawText].length < 1 || [...rawText].length > 500)) throw bad('/reason_text');
  const reason = await getReason(ctx.tx, WIPE_REASONS, reasonCode);   // normative wipe_reasons set only
  if (!reason) throw bad('/reason_code');
  if (reason['requires_text'] === true && rawText === undefined) throw bad('/reason_text');

  const row = await getDeviceById(ctx.tx, ctx.tenantId, deviceId);
  if (!row) throw new LimsError('common.not_found');   // unknown and other-tenant look the same
  if (row['status'] === 'wiped' || row['status'] === 'signed_off' || Number(row['version']) !== expected) throw new LimsError('common.version_conflict');
  let done = row;
  if (row['status'] !== 'wipe_requested') {   // a repeat on a pending wipe is a no-op: the first reason / time stay
    done = await updateDevice(ctx.tx, ctx.tenantId, deviceId, expected, {
      status: 'wipe_requested', wipe_requested_at: ctx.now(), wipe_requested_by: ctx.actor.id, wipe_reason_code: reasonCode, ...(rawText !== undefined ? { wipe_reason_text: rawText } : {}),
    });
    if (!done) throw new LimsError('common.version_conflict');   // lost the race (another wipe / sign-off bumped the version)
  }
  const names = await namesOf(ctx, [done['membership_id']]);
  return { status: 200, body: toDeviceDto(done, names.get(done['membership_id']) ?? PLACEHOLDER) };
}
