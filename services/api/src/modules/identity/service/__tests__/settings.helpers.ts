// T16 test helpers (not a test file). Synthetic data only. Fixes the SEAMS the spec leaves open - the writer must match them or raise a dispute:
//
//   ../settings.service.ts  exports `createSettingsService(deps?: { repo?: SettingsRepo; flagsRepo?: FlagsRepo; port?: { invalidateTenantSettings(tenantId: string): void };
//                           newId?: () => string })` -> { getSettings, updateSettings, uploadBrandingAsset, getBrandingAssetContent, listFeatureFlags,
//                           setTenantFeatureFlag, listOwnIrdAnnexes }, each `(ctx, input) => Promise<{ status, body, version?, headers? }>` (same convention as role/org.service).
//                           The DEFAULT repos (SQL on ctx.tx, explicit `tenant_id = $n` on every statement) are repository/settings.repo.ts + repository/flags.repo.ts;
//                           tests inject the fakes below. `deps.port` = the IdentityPort impl of this process (`invalidateTenantSettings`, ports/IdentityPort.impl.ts).
//   ctx = { tenantId, actor{type,id,membershipId}, requestId, tx, now(), audit.access(entry), commitOnError(), uploads, files, storage, download, log }
//   inputs: getSettings{} - updateSettings{expectedVersion|undefined, patch}  (patch = the snake_case wire body incl. `unset[]`, passed through)
//           uploadBrandingAsset{file:{filename,mimeType,bytes}, kind} - getBrandingAssetContent{assetId} - listFeatureFlags{}
//           setTenantFeatureFlag{flagCode, isEnabled, expectedVersion|undefined} - listOwnIrdAnnexes{}
//   outputs: bodies = TenantSettingsDto / BrandingAsset / FeatureFlag(List) / OwnIrdAnnexes of contracts/openapi/identity.yaml; getBrandingAssetContent returns
//            `ctx.download.stream` output verbatim ({status:200, headers, body: Uint8Array}). Wire errors are LimsError codes.
import { vi } from 'vitest';
import { createDownload } from '../../../../core/storage/download.js';
import { createStorage } from '../../../../core/storage/index.js';
import { createUploads } from '../../../../core/uploads/index.js';
import { fakeRaw, png, recorders, storageOpts } from '../../../../core/storage/__tests__/helpers.js';

export { png };
export const idN = (n: number) => `0190a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
export const TENANT_A = '0190a000-0000-7000-8000-00000000aaaa', TENANT_B = '0190a000-0000-7000-8000-00000000bbbb';
export const USER = idN(0xd1), MEM = idN(0xd2), REQ_ID = idN(0xe1);
export const ASSET_A1 = idN(0x501), ASSET_A_SIG = idN(0x502), ASSET_A_PENDING = idN(0x503), ASSET_A_QUAR = idN(0x504), ASSET_B1 = idN(0x5b1);
export const NOW = '2026-11-08T06:00:00.000Z';   // 2083-07-23 B.S. (Kartik) -> fiscal year 2083/84, next 2084/85
export const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, got success'); };

// ------------------------------------------------------------------------------------------------ settings rows (05-SCHEMA 4.6, snake_case)
export type Row = Record<string, any>;
export const settingsRow = (o: Row = {}): Row => ({
  calendar_display: 'AD_BS', timezone: 'Asia/Kathmandu', idle_timeout_minutes: 15, absolute_session_hours: 12, password_min_length: 12, support_access_mode: 'notify',
  report_link_ttl_days: 30, release_requires_payment: true, partial_release_allowed: false, letterhead_default: 'with', numbering_prefix: 'DL',
  patient_code_pattern: '{prefix}{seq:8}', registration_no_pattern: '{branch}{prefix}{seq:6}', barcode_pattern: '{prefix}{yy}{seq:8}',
  invoice_no_pattern: '{fy}-{seq:6}', credit_note_no_pattern: 'CN-{fy}-{seq:6}', receipt_no_pattern: 'RC-{fy}-{seq:6}', barcode_prefix: null,
  accession_no_pattern: '{prefix}{yy}-{seq:4}', accession_prefix_histology: 'S', accession_prefix_cytology: 'C', accession_prefix_ihc: 'I', accession_prefix_molecular: 'M',
  pending_invoice_no_pattern: null, pending_credit_note_no_pattern: null, pending_effective_fy_bs: null,
  whatsapp_enabled: false, sms_enabled: false, email_enabled: false, sms_sender_id: null,
  retention_clinical_years: 5, retention_audit_years: 5, retention_raw_instrument_years: 1, auto_verification_enabled: false, westgard_mode: 'classic',
  ird_pan: null, cbms_realtime_required: false, abbreviated_invoice_limit_paisa: null, ird_annex_1_record_id: null,
  legal_name_snapshot: 'Demo Lab Pvt. Ltd.', display_name: 'Demo Lab', address_lines: ['Demo street 1'], phones: ['01-4000000'], contact_email: null, website: null,
  logo_asset_id: null, letterhead_header_asset_id: null, letterhead_footer_asset_id: null, receipt_footer_note: null, accent_color: null,
  billing_live_on: null,   // core.tenants.billing_live_on, joined by the repo (04 L7/L8); NOT a tenant_settings column
  version: 4, ...o,
});

export type AssetRow = { id: string; tenant_id: string; kind: string; membership_id: string | null; bucket: string; object_path: string; content_type: string; size_bytes: number;
  width_px: number; height_px: number; sha256: string /* hex */; is_active: boolean; scan_state: 'pending' | 'clean' | 'quarantined'; version: number };
export const assetRow = (o: Partial<AssetRow> & { id: string; tenant_id: string }): AssetRow => ({
  kind: 'logo', membership_id: null, bucket: 'identity-assets', object_path: `${o.tenant_id}/branding/${o.id}.png`, content_type: 'image/png', size_bytes: 100,
  width_px: 4, height_px: 3, sha256: 'a'.repeat(64), is_active: true, scan_state: 'clean', version: 1, ...o,
});

export type FlagRow = { code: string; description: string; scope: 'tenant' | 'platform'; settable_by: 'tenant' | 'platform'; requires_founder_approval: boolean;
  blocker_ref: string | null; is_enabled: boolean; approval_ref_present: boolean; version: number };
const REGISTRY: Array<Omit<FlagRow, 'is_enabled' | 'approval_ref_present' | 'version'>> = [   // 05-SCHEMA 8 seed
  { code: 'whatsapp_pdf_attachment', description: 'Send report PDF as WhatsApp attachment', scope: 'tenant', settable_by: 'platform', requires_founder_approval: true, blocker_ref: 'B11' },
  { code: 'smart_report_llm', description: 'Optional LLM fluency layer', scope: 'tenant', settable_by: 'platform', requires_founder_approval: true, blocker_ref: 'B11' },
  { code: 'breached_password_online_check', description: 'Online breached-password check', scope: 'platform', settable_by: 'platform', requires_founder_approval: true, blocker_ref: 'B11' },
  { code: 'referral_incentive_report', description: 'Referral incentive report', scope: 'tenant', settable_by: 'tenant', requires_founder_approval: false, blocker_ref: 'B13' },
  { code: 'smart_report', description: 'Smart report', scope: 'tenant', settable_by: 'tenant', requires_founder_approval: false, blocker_ref: null },
];
export const IRD_PLATFORM_A1 = idN(0x701), IRD_A2 = idN(0x702), IRD_A3 = idN(0x703), IRD_A7 = idN(0x704);
export const ird = (o: Row): Row => ({ tenant_id: TENANT_A, status: 'completed', reference_no: null, office_name: null, counterparty_name: null, software_version: null,
  submitted_on: null, completed_on: null, notes: null, supersedes_id: null, version: 1, is_active: true, ...o });

// ------------------------------------------------------------------------------------------------ repo seams (every method: (tx, tenantId, ...))
export interface SettingsRepo {
  /** tenant_settings row (+ billing_live_on) of THAT tenant, undefined if none. */
  findSettings(tx: unknown, tenantId: string): Promise<Row | undefined>;
  /** `set` = column -> value (snake_case, already validated), `unset` = columns to NULL. Optimistic lock; undefined = version mismatch. Bumps version. */
  updateSettings(tx: unknown, tenantId: string, expectedVersion: number, set: Row, unset: string[], actorId: string): Promise<Row | undefined>;
  /** column = logo_asset_id | letterhead_header_asset_id | letterhead_footer_asset_id; bumps the settings version. */
  setAssetPointer(tx: unknown, tenantId: string, column: string, assetId: string, actorId: string): Promise<void>;
  findAsset(tx: unknown, tenantId: string, assetId: string): Promise<AssetRow | undefined>;
  insertAsset(tx: unknown, tenantId: string, r: Omit<AssetRow, 'version' | 'is_active'> & { actorId: string }): Promise<AssetRow>;
  enqueueJob(tx: unknown, j: { taskIdentifier: string; payload: unknown; jobKey: string }): Promise<void>;
}
export interface FlagsRepo {
  listFlags(tx: unknown, tenantId: string): Promise<FlagRow[]>;
  findFlag(tx: unknown, tenantId: string, code: string): Promise<FlagRow | undefined>;
  /** undefined = version mismatch. */
  updateFlag(tx: unknown, tenantId: string, code: string, expectedVersion: number, isEnabled: boolean, actorId: string): Promise<FlagRow | undefined>;
  /** the tenant's own annex records + the one referenced platform annex_1 row (RLS: ird_annex_records__select__tenant_platform_ref), nothing else. */
  listIrdAnnexes(tx: unknown, tenantId: string): Promise<Row[]>;
}

export function makeRepos(seed: { settings?: Record<string, Row>; assets?: AssetRow[]; flags?: Record<string, Partial<FlagRow>[]>; ird?: Row[] } = {}) {
  const st = {
    settings: new Map<string, Row>(Object.entries(seed.settings ?? { [TENANT_A]: settingsRow(), [TENANT_B]: settingsRow({ idle_timeout_minutes: 20, display_name: 'Tenant B Lab' }) }).map(([k, v]) => [k, { ...v }])),
    assets: (seed.assets ?? []).map((a) => ({ ...a })),
    flags: new Map<string, FlagRow[]>(),
    ird: (seed.ird ?? []).map((r) => ({ ...r })),
    leaky: false,
    jobs: [] as Array<{ taskIdentifier: string; payload: any; jobKey: string }>,
  };
  for (const t of [TENANT_A, TENANT_B]) {   // AC-C5.1: provisioning creates one off row per registry flag
    st.flags.set(t, REGISTRY.map((r) => ({ ...r, is_enabled: false, approval_ref_present: false, version: 1, ...(seed.flags?.[t]?.find((f) => f.code === r.code) ?? {}) })));
  }
  const calls: Array<{ m: string; tx: unknown; tenantId: string; args: unknown[] }> = [];
  const writes: string[] = [];
  const order: string[] = [];   // global event order shared with the port invalidation spy
  const fail: Record<string, Error | undefined> = {};
  const rec = (m: string, tx: unknown, tenantId: string, ...args: unknown[]) => { calls.push({ m, tx, tenantId, args }); if (fail[m]) throw fail[m]; };
  const w = (m: string) => { writes.push(m); order.push(m); };
  const settingsRepo: SettingsRepo = {
    async findSettings(tx, t) { rec('findSettings', tx, t); const r = st.settings.get(t); return r && { ...r }; },
    async updateSettings(tx, t, v, set, unset, actorId) {
      rec('updateSettings', tx, t, v, set, unset, actorId); w('updateSettings');
      const r = st.settings.get(t); if (!r || r.version !== v) return undefined;
      Object.assign(r, set); for (const u of unset) r[u] = null; r.version += 1; return { ...r };
    },
    async setAssetPointer(tx, t, column, assetId, actorId) {
      rec('setAssetPointer', tx, t, column, assetId, actorId); w('setAssetPointer');
      const r = st.settings.get(t); if (r) { r[column] = assetId; r.version += 1; }
    },
    async findAsset(tx, t, id) { rec('findAsset', tx, t, id); const a = st.assets.find((x) => x.tenant_id === t && x.id === id); return a && { ...a }; },
    async insertAsset(tx, t, r) {
      rec('insertAsset', tx, t, r); w('insertAsset');
      const { actorId: _a, ...cols } = r; const row: AssetRow = { ...cols, is_active: true, version: 1 }; st.assets.push(row); return { ...row };
    },
    async enqueueJob(tx, _j) { rec('enqueueJob', tx, '', _j); w('enqueueJob'); st.jobs.push({ ..._j, payload: _j.payload }); },
  };
  const flagsRepo: FlagsRepo = {
    async listFlags(tx, t) { rec('listFlags', tx, t); return (st.flags.get(t) ?? []).map((f) => ({ ...f })); },
    async findFlag(tx, t, code) { rec('findFlag', tx, t, code); const f = (st.flags.get(t) ?? []).find((x) => x.code === code); return f && { ...f }; },
    async updateFlag(tx, t, code, v, en, actorId) {
      rec('updateFlag', tx, t, code, v, en, actorId); w('updateFlag');
      const f = (st.flags.get(t) ?? []).find((x) => x.code === code); if (!f || f.version !== v) return undefined; f.is_enabled = en; f.version += 1; return { ...f };
    },
    async listIrdAnnexes(tx, t) { rec('listIrdAnnexes', tx, t); return st.ird.filter((r) => st.leaky || r.tenant_id === t || r.tenant_id === null || r.tenant_id === undefined).map((r) => ({ ...r })); },
  };
  return { settingsRepo, flagsRepo, st, calls, writes, order, fail, settingsOf: (t: string) => st.settings.get(t)! };
}
export type Repos = ReturnType<typeof makeRepos>;

// ------------------------------------------------------------------------------------------------ request context with the REAL core upload/storage/download helpers
export const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$' + 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
export type ScanMode = 'clean' | 'unavailable' | 'throw';
export async function makeCtx(o: { tenantId?: string; scan?: ScanMode } = {}) {
  const tenantId = o.tenantId ?? TENANT_A;
  const raw = fakeRaw(); const rec = recorders();
  const storage = await createStorage(storageOpts(raw, rec, 'identity', tenantId));
  const mode = { v: o.scan ?? 'clean' as ScanMode };
  const scan = vi.fn(async (bytes: Uint8Array) => {
    if (mode.v === 'throw') throw new Error('scanner down');
    if (mode.v === 'unavailable') return 'unavailable' as const;
    return Buffer.from(bytes).includes(Buffer.from('EICAR-STANDARD-ANTIVIRUS-TEST-FILE')) ? ('infected' as const) : ('clean' as const);
  });
  const access: Array<Record<string, any>> = [];
  const audit = { access: vi.fn(async (e: Record<string, any>) => { access.push(e); }) };
  const tx = { __tx: 'T16-request-tx', query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
  const ctx: any = {
    tenantId, actor: { type: 'user', id: USER, membershipId: MEM }, requestId: REQ_ID, tx, now: () => NOW,
    audit, commitOnError: vi.fn(), files: { scan }, storage,
    uploads: createUploads({ files: { scan }, storage, module: 'identity', tenantId, log: rec.log }),
    download: createDownload({ storage, audit }),
    log: rec.log,
  };
  return { ctx, access, tx, raw, scan, mode, logs: rec.lines, storageKeys: () => [...raw.objects.keys()] };
}
export const incoming = (bytes: Uint8Array, filename = 'logo.png', mimeType = 'image/png') => ({ filename, mimeType, bytes });
