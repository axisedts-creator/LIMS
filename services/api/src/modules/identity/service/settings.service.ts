// Tenant settings, branding assets, feature flags, tenant IRD view (02-TRD §5.6, §7.3, §10; 03-APP-FLOW §6.1-6.3, §2.5; 01-PRD US-C2, AC-C3.1-3.3,
// US-C4, AC-C5.1/5.2/5.4; 08 A13 P-2, P-6, P-15, A17 P-19; 07-SECURITY D-T20, D-T21). Tenant and actor come from ctx only; every repo call
// carries ctx.tenantId + ctx.tx (REQ-SEC-024/040). Every settings-visible write invalidates this process's IdentityPort cache; other
// instances converge within the 30 s TTL (02-TRD §7.3).
// LD-26 (training_mode) and LD-27 (signatory council) have no column on this surface: CR .orchestra/cr/C2.T16.md.
import { LimsError, type FieldError } from '../../../core/errors.js';
// [CONV] relative imports until @lims/shared-ts is a services/api dependency (same as role.service).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { validateSettingsPatch } from '../domain/settings.ranges.js';
import { ASSET_COLUMNS, BOOLS, BRANDING_KINDS, DEFERRED, EDITABLE, PATTERNS, PATTERN_MAX, PLATFORM_ONLY, UNSETTABLE, nextFiscalYear, toDto } from '../domain/settings.fields.js';
import { validateNumberingPattern, type NumberingKind } from '../domain/numbering-pattern.js';
import { createSettingsRepo } from '../repository/settings.repo.js';
import { createFlagsRepo } from '../repository/flags.repo.js';

export type Row = Record<string, any>;
export type AssetRow = {
  id: string; tenant_id: string; kind: string; membership_id: string | null; bucket: string; object_path: string; content_type: string; size_bytes: number;
  width_px: number; height_px: number; sha256: string; is_active: boolean; scan_state: 'pending' | 'clean' | 'quarantined'; version: number;
};
export type FlagRow = {
  code: string; description: string; scope: 'tenant' | 'platform'; settable_by: 'tenant' | 'platform'; requires_founder_approval: boolean;
  blocker_ref: string | null; is_enabled: boolean; approval_ref_present: boolean; version: number;
};
type Job = { taskIdentifier: string; payload: unknown; jobKey: string };
export interface SettingsRepo {
  findSettings(tx: unknown, tenantId: string): Promise<Row | undefined>;
  updateSettings(tx: unknown, tenantId: string, expectedVersion: number, set: Row, unset: string[], actorId: string): Promise<Row | undefined>;
  setAssetPointer(tx: unknown, tenantId: string, column: string, assetId: string, actorId: string): Promise<void>;
  findAsset(tx: unknown, tenantId: string, assetId: string): Promise<AssetRow | undefined>;
  insertAsset(tx: unknown, tenantId: string, r: Omit<AssetRow, 'version' | 'is_active'> & { actorId: string }): Promise<AssetRow>;
  enqueueJob(tx: unknown, j: Job): Promise<void>;
}
export interface FlagsRepo {
  listFlags(tx: unknown, tenantId: string): Promise<FlagRow[]>;
  findFlag(tx: unknown, tenantId: string, code: string): Promise<FlagRow | undefined>;
  updateFlag(tx: unknown, tenantId: string, code: string, expectedVersion: number, isEnabled: boolean, actorId: string): Promise<FlagRow | undefined>;
  listIrdAnnexes(tx: unknown, tenantId: string): Promise<Row[]>;
}

type Access = { action: string; entityType: string; entityId?: string; outcome: 'allowed' | 'denied'; detail?: Record<string, string | number | boolean> };
export interface SettingsCtx {
  readonly tenantId: string;
  readonly actor: { readonly type: string; readonly id: string; readonly membershipId?: string };
  readonly requestId?: string;
  readonly tx: unknown;
  readonly now?: () => string;
  readonly audit?: { access(entry: Access): Promise<unknown> };
  readonly commitOnError?: () => void;
  // core request helpers (03-IC §13.6); absent -> TypeError -> 500 (fail closed)
  readonly uploads: { accept(file: unknown, opts: unknown): Promise<any> };
  readonly storage: { delete(bucket: any, objectPath: string): Promise<void> };
  readonly download: { stream(input: unknown): Promise<any> };
}
export interface Result { status: number; body: any; version?: number; headers?: Record<string, string> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FLAG_CODE = /^[a-z][a-z0-9_]{2,63}$/;
const BUCKET = 'identity-assets';
const MAX_BRANDING_BYTES = 2 * 1024 * 1024;   // 02-TRD §5.6 PNG/JPEG <= 2 MB = DB branding_assets__size__ck
const MAX_DIM = 4000;                          // 02-TRD §5.6 [CONV] <= 4000x4000 px = branding_assets__dims__ck
const RESCAN_TASK = 'identity.rescan_upload';

const fieldErr = (path: string, code = 'common.field_invalid'): FieldError => ({ path, code, message: 'Field invalid' });
const fail = (errors: FieldError[]): never => { throw new LimsError('common.validation_failed', undefined, errors); };
const failAt = (path: string): never => fail([fieldErr(path)]);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function scope(ctx: SettingsCtx, write = false) {
  if (typeof ctx?.tenantId !== 'string' || !UUID.test(ctx.tenantId) || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
  if (write && typeof ctx.audit?.access !== 'function') throw new LimsError('common.internal');   // fail closed: no access log
  return { tx: ctx.tx, tenantId: ctx.tenantId, actorId: ctx.actor.id };
}
function expected(v: unknown): number {
  if (v === undefined || v === null) throw new LimsError('common.precondition_required');
  if (!Number.isSafeInteger(v) || (v as number) < 1 || (v as number) > 2147483647) failAt('/If-Match');
  return v as number;
}
const toFlag = (f: FlagRow) => ({
  code: f.code, description: f.description, scope: f.scope, settable_by: f.settable_by, is_enabled: f.is_enabled,
  ...(f.blocker_ref ? { blocker_ref: f.blocker_ref } : {}), approval_ref_present: f.approval_ref_present, version: f.version,
});
const IRD_FIELDS = ['annex_code', 'status', 'reference_no', 'office_name', 'counterparty_name', 'software_version', 'submitted_on', 'completed_on', 'notes', 'supersedes_id', 'version'];
const toIrd = (r: Row) => {
  const out: Row = { record_id: r['id'] };
  if (r['tenant_id']) out['tenant_id'] = r['tenant_id'];
  for (const k of IRD_FIELDS) if (r[k] !== null && r[k] !== undefined) out[k] = r[k];
  return out;
};

export function createSettingsService(deps: { repo?: SettingsRepo; flagsRepo?: FlagsRepo; port?: { invalidateTenantSettings(tenantId: string): void }; newId?: () => string } = {}) {
  const repo = deps.repo ?? createSettingsRepo();
  const flags = deps.flagsRepo ?? createFlagsRepo();
  const newId = deps.newId ?? uuidv7;
  // [CONV] the manifest does not yet expose the process IdentityPort to handlers: without deps.port the 30 s TTL alone bounds staleness (US-C2).
  const invalidate = (t: string) => deps.port?.invalidateTenantSettings(t);

  /** Validates a PATCH body; returns the columns to set and to NULL (both tenant-editable only). */
  async function checkPatch(s: ReturnType<typeof scope>, patch: unknown) {
    if (!isObj(patch)) return failAt('');
    const { unset: rawUnset, ...set } = patch;
    const bad: FieldError[] = [];
    let forbidden = false;
    for (const k of Object.keys(set)) {
      if (PLATFORM_ONLY.has(k)) forbidden = true;
      else if (!EDITABLE.has(k)) bad.push(fieldErr(`/${k}`));
      else if (set[k] === null) bad.push(fieldErr(`/${k}`));   // NULL only via unset[]
    }
    const unset: string[] = [];
    if (rawUnset !== undefined) {
      if (!Array.isArray(rawUnset) || rawUnset.length > 12) bad.push(fieldErr('/unset'));
      else rawUnset.forEach((c, i) => {
        if (typeof c === 'string' && PLATFORM_ONLY.has(c)) forbidden = true;
        else if (typeof c !== 'string' || !UNSETTABLE.has(c) || Object.hasOwn(set, c)) bad.push(fieldErr(`/unset/${i}`));
        else if (!unset.includes(c)) unset.push(c);
      });
    }
    if (bad.length) fail(bad);
    if (forbidden) throw new LimsError('auth.forbidden');

    for (const [k, v] of Object.entries(set)) {
      if (BOOLS.has(k) && typeof v !== 'boolean') bad.push(fieldErr(`/${k}`));
      if (PATTERNS.has(k) && (typeof v !== 'string' || v.length > PATTERN_MAX || !validateNumberingPattern(k.slice(0, -'_pattern'.length) as NumberingKind, v).ok)) bad.push(fieldErr(`/${k}`));
      if (ASSET_COLUMNS.has(k) && (typeof v !== 'string' || !UUID.test(v))) bad.push(fieldErr(`/${k}`));
    }
    const r = validateSettingsPatch(set);
    const ranges = r.ok ? [] : r.errors;
    bad.push(...ranges.filter((e) => e.code === 'common.field_invalid').map((e) => fieldErr(e.pointer)));
    if (bad.length) fail(bad);
    const oor = ranges.filter((e) => e.code === 'identity.setting_out_of_range');
    if (oor.length) throw new LimsError('identity.setting_out_of_range', undefined, oor.map((e) => fieldErr(e.pointer, e.code)));
    // A pointer must name a clean branding asset of this tenant and of the matching kind.
    for (const [kind, col] of Object.entries(BRANDING_KINDS)) {
      if (!Object.hasOwn(set, col)) continue;
      const a = await repo.findAsset(s.tx, s.tenantId, set[col] as string);
      if (!a || a.kind !== kind || a.scan_state !== 'clean') bad.push(fieldErr(`/${col}`));
    }
    if (bad.length) fail(bad);
    return { set: set as Row, unset };
  }

  return {
    async getSettings(ctx: SettingsCtx, _input: Record<string, unknown> = {}): Promise<Result> {
      const s = scope(ctx);
      const row = await repo.findSettings(s.tx, s.tenantId);
      if (!row) throw new LimsError('common.not_found');
      return { status: 200, body: toDto(row), version: row['version'] };
    },

    async updateSettings(ctx: SettingsCtx, input: { expectedVersion?: unknown; patch?: unknown }): Promise<Result> {
      const s = scope(ctx, true);
      const v = expected(input?.expectedVersion);
      const { set, unset } = await checkPatch(s, input?.patch);
      const cur = await repo.findSettings(s.tx, s.tenantId);
      if (!cur) throw new LimsError('common.not_found');
      if (cur['version'] !== v) throw new LimsError('common.version_conflict');
      // AC-C3.3: once billing is live, invoice / credit-note pattern changes wait for the next fiscal year (applied by identity.apply_pending_numbering).
      if (cur['billing_live_on']) {
        for (const k of DEFERRED) {
          if (!Object.hasOwn(set, k)) continue;
          const next = set[k]; delete set[k];
          if (next === cur[k]) continue;   // re-sending the current pattern is not a change
          set[`pending_${k}`] = next;
          set['pending_effective_fy_bs'] = nextFiscalYear((ctx.now ?? (() => new Date().toISOString()))());
        }
      }
      const out = await repo.updateSettings(s.tx, s.tenantId, v, set, unset, s.actorId);
      if (!out) throw new LimsError('common.version_conflict');
      // 03-APP-FLOW §6.1 step 4: changed keys only, never values.
      await ctx.audit!.access({ action: 'settings.change', entityType: 'tenant_settings', entityId: s.tenantId, outcome: 'allowed',
        detail: { fields: [...Object.keys(set), ...unset].sort().join(',') } });
      invalidate(s.tenantId);
      return { status: 200, body: toDto(out), version: out['version'] };
    },

    async uploadBrandingAsset(ctx: SettingsCtx, input: { file?: unknown; kind?: unknown }): Promise<Result> {
      const s = scope(ctx, true);
      const kind = input?.kind;
      if (typeof kind !== 'string' || !Object.hasOwn(BRANDING_KINDS, kind)) return failAt('/kind');
      const id = newId();
      const name = isObj(input.file) && typeof input.file['filename'] === 'string' ? input.file['filename'] : '';
      const objectPath = `${s.tenantId}/branding/${id}.${/\.jpe?g$/i.test(name) ? 'jpg' : 'png'}`;   // client filename never reaches the key
      const acc = await ctx.uploads.accept(input.file, {
        allow: ['image/png', 'image/jpeg'], maxBytes: MAX_BRANDING_BYTES, bucket: BUCKET, objectPath,
        images: { reencode: true, stripMetadata: true, maxMegapixels: 16 }, scan: 'required',
      });
      const scanState: AssetRow['scan_state'] = acc.scanState === 'clean' ? 'clean' : 'pending';   // P-19: pending/unavailable stored as pending
      try {
        const w = acc.image?.width, h = acc.image?.height;
        if (!w || !h || w > MAX_DIM || h > MAX_DIM) failAt('/file');
        await repo.insertAsset(s.tx, s.tenantId, {
          id, tenant_id: s.tenantId, kind, membership_id: null, bucket: BUCKET, object_path: objectPath, content_type: acc.mime, size_bytes: acc.byteSize,
          width_px: w!, height_px: h!, sha256: acc.sha256, scan_state: scanState, actorId: s.actorId,
        });
        // 03-APP-FLOW §6.2: pointer updated on upload (old asset kept); content stays 422 until clean (US-C4).
        await repo.setAssetPointer(s.tx, s.tenantId, BRANDING_KINDS[kind]!, id, s.actorId);
        invalidate(s.tenantId);
        if (scanState === 'pending') {
          await repo.enqueueJob(s.tx, { taskIdentifier: RESCAN_TASK, payload: { tenant_id: s.tenantId, asset_id: id, kind }, jobKey: `rescan:branding_assets:${id}` });
        }
      } catch (e) {
        await ctx.storage.delete(BUCKET, objectPath).catch(() => undefined);   // no orphan object when the row is refused
        throw e;
      }
      return { status: 201, body: { asset_id: id, kind, width: acc.image.width, height: acc.image.height, sha256: acc.sha256, scan_state: scanState } };
    },

    /** P-2: bytes only through ctx.download.stream (attachment, nosniff, no-store; access-log every call). */
    async getBrandingAssetContent(ctx: SettingsCtx, input: { assetId?: unknown }): Promise<Result> {
      const s = scope(ctx, true);
      const id = input?.assetId;
      if (typeof id !== 'string' || !UUID.test(id)) throw new LimsError('common.not_found');
      const a = await repo.findAsset(s.tx, s.tenantId, id);
      if (!a || !Object.hasOwn(BRANDING_KINDS, a.kind)) throw new LimsError('common.not_found');   // D-26: signatures are not served here
      const access = { action: 'branding_asset.download', entityType: 'branding_asset', entityId: a.id };
      if (a.scan_state !== 'clean') {
        await ctx.audit!.access({ ...access, outcome: 'denied' });
        ctx.commitOnError?.();
        throw new LimsError('common.upload_quarantined');
      }
      const ext = a.content_type === 'image/jpeg' ? 'jpg' : 'png';
      return ctx.download.stream({
        bucket: a.bucket, objectPath: a.object_path, filename: `${a.kind}.${ext}`, contentType: a.content_type, scanState: a.scan_state,
        access: { ...access, outcome: 'allowed' },
      });
    },

    async listFeatureFlags(ctx: SettingsCtx, _input: Record<string, unknown> = {}): Promise<Result> {
      const s = scope(ctx);
      return { status: 200, body: { data: (await flags.listFlags(s.tx, s.tenantId)).map(toFlag) } };
    },

    async setTenantFeatureFlag(ctx: SettingsCtx, input: { flagCode?: unknown; isEnabled?: unknown; expectedVersion?: unknown }): Promise<Result> {
      const s = scope(ctx, true);
      const code = input?.flagCode;
      if (typeof code !== 'string' || !FLAG_CODE.test(code)) throw new LimsError('common.not_found');
      const f = await flags.findFlag(s.tx, s.tenantId, code);
      if (!f) throw new LimsError('common.not_found');
      if (f.settable_by !== 'tenant' || f.requires_founder_approval) throw new LimsError('auth.forbidden');   // AC-C5.2 (B11 platform-only)
      const v = expected(input.expectedVersion);
      if (typeof input.isEnabled !== 'boolean') failAt('/is_enabled');
      if (f.version !== v) throw new LimsError('common.version_conflict');
      const out = await flags.updateFlag(s.tx, s.tenantId, code, v, input.isEnabled as boolean, s.actorId);
      if (!out) throw new LimsError('common.version_conflict');
      await ctx.audit!.access({ action: 'feature_flag.change', entityType: 'feature_flag', outcome: 'allowed', detail: { flag_code: code } });
      invalidate(s.tenantId);
      return { status: 200, body: toFlag(out), version: out.version };
    },

    /** Own annex_2/3/7 rows + the referenced platform annex_1 row; readiness per 03-APP-FLOW §2.5. */
    async listOwnIrdAnnexes(ctx: SettingsCtx, _input: Record<string, unknown> = {}): Promise<Result> {
      const s = scope(ctx);
      const settings = await repo.findSettings(s.tx, s.tenantId);
      const ref = settings?.['ird_annex_1_record_id'] ?? null;
      // Defense in depth: drop anything the repo returns that is neither this tenant's nor the referenced platform row.
      const rows = (await flags.listIrdAnnexes(s.tx, s.tenantId))
        .filter((r) => r['is_active'] !== false && (r['tenant_id'] === s.tenantId || (r['tenant_id'] == null && ref !== null && r['id'] === ref)));
      const done = (code: string) => rows.some((r) => r['annex_code'] === code && r['status'] === 'completed');
      const complete = ['annex_1', 'annex_2', 'annex_3', 'annex_7'].every(done);
      return { status: 200, body: { data: rows.map(toIrd), annex_readiness: complete ? 'complete' : 'incomplete' } };
    },
  };
}
export type SettingsService = ReturnType<typeof createSettingsService>;
