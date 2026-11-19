// Print profiles + signer profiles: listPrintProfiles, upsertPrintProfile, previewPrintProfile, listSignatoryProfiles, upsertSignatoryProfile
// (T0B-PRINTCFG-1; LD-316, LD-319(1); contract T0C-PRINTCFG-1). Tenant and actor come from ctx only; schema and x-permission (reporting.settings.manage) are the pipeline's,
// this code re-validates every body (a direct call is as strict) and never echoes input.
// - invoice / credit_note profiles also need billing.settings.manage (contract text), checked here through IdentityPort.assertRole; CR T0C-PRINTCFG-1 (finance only) is NOT decided here.
// - [CONV] audit action 'settings.change' (the one seeded code that fits; audit.g_cs_access_actions allows one dot only): see .orchestra/notes/T0B-PRINTCFG-1-dispute.md.
// - [CONV] signature_asset_id: no port can yet say "this id is an image of this tenant" (file store is T0B-STORAGE-1), so any id is refused (fail closed) until `assetMeta` is wired.
import { LimsError } from '../../../core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { assertImageAsset, validatePreviewInput, validatePrintProfileInput, validateSignatoryProfileInput, DOCUMENT_KINDS } from '../domain/printProfile.js';
import * as printRepo from '../repository/print.repo.js';
import * as repo from '../repository/printProfile.repo.js';
import { PRINT_MAX_ATTEMPTS, RENDER_PRINT_TASK, toPrintJob } from './print.service.js';

export interface PrintProfileCtx {
  readonly tenantId: string; readonly actor: { readonly type?: string; readonly id: string; readonly centreId?: string }; readonly tx: repo.Tx; readonly centreId?: string;
  readonly ports?: Record<string, any>; readonly now?: () => string; readonly audit?: { access(e: Record<string, unknown>): Promise<unknown> };
}
export interface PrintProfileDeps { assetMeta?: (ctx: PrintProfileCtx, assetId: string) => Promise<{ tenantId: string; mimeType: string } | undefined> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BILLING_PERMISSION = 'billing.settings.manage';
const TTL_MS = 24 * 3_600_000;
const iso = (v: unknown) => new Date(v as string).toISOString();
const invalid = (path: string) => new LimsError('common.validation_failed', undefined, [{ path, code: 'common.field_invalid', message: 'Field invalid' }]);
const needAudit = (c: PrintProfileCtx) => { if (typeof c.audit?.access !== 'function') throw new LimsError('common.internal'); return c.audit; };

async function assertBilling(c: PrintProfileCtx): Promise<void> {
  const idp = c.ports?.['IdentityPort'];
  if (typeof idp?.assertRole !== 'function') throw new LimsError('common.internal');   // fail closed
  await idp.assertRole(c, { permission: BILLING_PERMISSION });
}
const isForbidden = (e: unknown) => (e as { code?: string })?.code === 'auth.forbidden';

export function toPrintProfile(r: Record<string, any>) {
  return {
    id: r['id'], ...(r['branch_id'] ? { branch_id: r['branch_id'] } : {}), document_kind: r['document_kind'], ...(r['recipient_type'] ? { recipient_type: r['recipient_type'] } : {}),
    paper_mode: r['paper_mode'], header_text: r['header_text'], footer_text: r['footer_text'], reserve_top_mm: Number(r['reserve_top_mm']), reserve_bottom_mm: Number(r['reserve_bottom_mm']),
    show_logo: r['show_logo'], show_seller_pan: r['show_seller_pan'], grayscale: r['grayscale'], font_size_pt: Number(r['font_size_pt']), is_active: r['is_active'],
    updated_at: iso(r['updated_at']), updated_by: r['updated_by'],
  };
}
export function toSignatoryProfile(r: Record<string, any>) {
  return {
    user_id: r['user_id'], display_name: r['display_name'], ...(r['title'] != null ? { title: r['title'] } : {}), ...(r['registration_no'] != null ? { registration_no: r['registration_no'] } : {}),
    ...(r['signature_asset_id'] ? { signature_asset_id: r['signature_asset_id'] } : {}), is_active: r['is_active'], updated_at: iso(r['updated_at']), updated_by: r['updated_by'],
  };
}

export function createPrintProfileService(deps: PrintProfileDeps = {}) {
  return {
    async listPrintProfiles(c: PrintProfileCtx, query: Record<string, unknown>) {
      const kind = query['document_kind'];
      if (kind !== undefined && (typeof kind !== 'string' || !(DOCUMENT_KINDS as readonly string[]).includes(kind))) throw invalid('/document_kind');
      const branchId = query['branch_id'];
      if (branchId !== undefined && (typeof branchId !== 'string' || !UUID.test(branchId))) throw invalid('/branch_id');
      let reportOnly = false;
      if (kind === 'invoice' || kind === 'credit_note') await assertBilling(c);
      else if (kind === undefined) {   // [CONV] no filter: a caller without the billing code sees the report profiles only
        try { await assertBilling(c); } catch (e) { if (!isForbidden(e)) throw e; reportOnly = true; }
      }
      const rows = await repo.listPrintProfiles(c.tx, c.tenantId, { ...(kind ? { documentKind: kind as string } : {}), ...(branchId ? { branchId: branchId as string } : {}) });
      return { data: rows.filter((r) => !reportOnly || r['document_kind'] === 'report').map(toPrintProfile) };
    },

    async upsertPrintProfile(c: PrintProfileCtx, body: unknown) {
      const p = validatePrintProfileInput(body);
      const audit = needAudit(c);
      if (p.document_kind !== 'report') await assertBilling(c);
      // an unknown or another tenant's branch / user fails the (tenant_id, id) FK: 23503 -> common.not_found (core mapDbError), nothing written
      const row = await repo.upsertPrintProfile(c.tx, { id: uuidv7(), tenantId: c.tenantId, actorId: c.actor.id, p });
      if (!row) throw new LimsError('common.internal');
      await audit.access({ action: 'settings.change', entityType: 'print_profile', entityId: row['id'], outcome: 'allowed', detail: { document_kind: p.document_kind, paper_mode: p.paper_mode } });
      return toPrintProfile(row);
    },

    /** Synthetic sample data only (no id of any kind is accepted); same render job as previewReportTemplate; nothing about the profile is stored. */
    async previewPrintProfile(c: PrintProfileCtx, body: unknown) {
      const p = validatePreviewInput(body);
      if (p.document_kind !== 'report') await assertBilling(c);
      const id = uuidv7(); const now = Date.parse(typeof c.now === 'function' ? c.now() : new Date().toISOString());
      const expiresAt = new Date(now + TTL_MS).toISOString();
      // like previewReportTemplate: the pollable reporting.print_jobs row needs the caller's working centre (RLS print_jobs__insert__tenant_centre); none -> fail closed
      const centreId = c.centreId ?? c.actor.centreId;
      if (typeof centreId !== 'string' || centreId === '') throw new LimsError('common.internal');
      await printRepo.insertPrint(c.tx, { id, tenantId: c.tenantId, centreId, kind: 'template_preview', versionIds: [], excludedIds: [], templateVersionId: null, variant: 'plain', copies: 1,
        draftWatermark: false, state: 'rendering', expiresAt, actorId: c.actor.id });
      // the draft profile travels in the job payload (validated above); the worker renders it over the renderer's synthetic sample (render.ts template-preview).
      const { recipient_type: _r, ...printProfile } = p;
      await repo.enqueuePreview(c.tx, { task: RENDER_PRINT_TASK, tenantId: c.tenantId, printJobId: id, documentKind: p.document_kind, printProfile, maxAttempts: PRINT_MAX_ATTEMPTS });
      return toPrintJob({ id, state: 'rendering', variant: 'plain', copies: 1, expires_at: expiresAt });
    },

    async listSignatoryProfiles(c: PrintProfileCtx) {
      return { data: (await repo.listSignatoryProfiles(c.tx, c.tenantId)).map(toSignatoryProfile) };
    },

    async upsertSignatoryProfile(c: PrintProfileCtx, userId: unknown, body: unknown) {
      if (typeof userId !== 'string' || !UUID.test(userId)) throw new LimsError('common.not_found');
      const s = validateSignatoryProfileInput(body);
      const audit = needAudit(c);
      if (s.signature_asset_id !== undefined) assertImageAsset(deps.assetMeta ? await deps.assetMeta(c, s.signature_asset_id) : undefined, c.tenantId);
      const row = await repo.upsertSignatoryProfile(c.tx, { id: uuidv7(), tenantId: c.tenantId, userId: userId.toLowerCase(), actorId: c.actor.id, s });
      if (!row) throw new LimsError('common.internal');
      await audit.access({ action: 'settings.change', entityType: 'signatory_profile', entityId: row['id'], outcome: 'allowed' });
      return toSignatoryProfile(row);
    },
  };
}
