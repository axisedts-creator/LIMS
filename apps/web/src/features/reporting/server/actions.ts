'use server';
// Server actions for the reporting client components. Errors become { ok:false, status, code } because a thrown ApiError loses its code across
// the action boundary in production. Only ApiError is mapped; anything else rethrows to the error boundary.
import 'server-only';
import { ApiError } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import { getReport, getReportPrint, listCriticalAlerts, listOverrideReasons, listReportingCodes } from './read.server';
import { bulkRelease, confirmOutsourced, createPrint, listOutsourcedFiles, previewTemplate, publishTemplate, recordOverride, regenerate, releaseVersion, retryDelivery, retryRender, revokeQr, rotateCallbackToken, saveNarrativeDraft, saveTemplateDraft, searchReports, signNarrative, startAmendment, updateSettings, uploadNarrativeImage, uploadOutsourced, upsertChannelAccount, upsertMessageText } from './write.server';
import type { ActionResult, BulkResult, ChannelAccount, CodedOption, CriticalAlert, Delivery, InputFile, MessageText, Narrative, Page, ReportSummary, ReportingSettings, TemplateConfig, TemplateDetail, VersionSummary } from './types';

async function run<T>(f: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await f() };
  } catch (e) {
    if (e instanceof ApiError) {
      const { balance_due_paisa, release_basis } = e.problem as unknown as Record<string, unknown>;
      return { ok: false, status: e.status, code: e.problem.code, ...(balance_due_paisa !== undefined || release_basis !== undefined ? { extra: { balance_due_paisa, release_basis } } : {}) };
    }
    throw e;
  }
}

// ── reads for dialogs / polling
export async function listCodesAction(set: 'regeneration_reasons' | 'token_revoke_reasons' | 'narrative_amend_reasons'): Promise<ActionResult<CodedOption[]>> {
  return run(async () => (await listReportingCodes(set)).data);
}
export async function listOverrideReasonsAction(): Promise<ActionResult<CodedOption[]>> {
  return run(async () => (await listOverrideReasons()).data);
}
export async function listCriticalAlertsAction(centreId?: string): Promise<ActionResult<Page<CriticalAlert>>> {
  return run(() => listCriticalAlerts(centreId));
}
export async function getPrintAction(printId: string): Promise<ActionResult<{ id: string; state: string }>> {
  return run(() => getReportPrint(printId));
}
export async function listOutsourcedFilesAction(orderItemId: string): Promise<ActionResult<InputFile[]>> {
  return run(async () => (await listOutsourcedFiles(orderItemId)).data);
}

// ── report writes
export async function searchReportsAction(k: { barcode: string } | { registration_no: string }): Promise<ActionResult<ReportSummary[]>> {
  return run(async () => (await searchReports(k)).data);
}
export async function releaseVersionAction(versionId: string, version: number, b: { audiences?: string[]; suppress_notifications?: boolean }, key: string): Promise<ActionResult<VersionSummary>> {
  return run(() => releaseVersion(versionId, version, b, key));
}
// R7 takes report-VERSION ids. The UI selects report ids; each is resolved here via getReport (ReportDetail.versions[].id) to its newest
// `rendered` version (the only releasable status, reporting.yaml VersionSummary.status). Results come back keyed by report id.
// Reports without a rendered version are not sent and count as "not released" in the UI.
export async function bulkReleaseAction(reportIds: string[], key: string): Promise<ActionResult<BulkResult>> {
  return run(async () => {
    if (reportIds.length < 1 || reportIds.length > 200) throw new ApiError(400, problem('common.validation_failed', 'Validation failed', 400)); // getReport validates each uuid
    const pairs = await Promise.all(reportIds.map(async (rid) => {
      const v = (await getReport(rid)).versions.filter((x) => x.status === 'rendered').sort((a, b) => b.version_no - a.version_no)[0];
      return v ? ([v.id, rid] as const) : null;
    }));
    const toReport = new Map(pairs.filter((p): p is readonly [string, string] => p !== null));
    if (toReport.size === 0) return { results: [] };
    const r = await bulkRelease([...toReport.keys()], key);
    return { results: r.results.map((x) => ({ ...x, id: toReport.get(x.id) ?? x.id })) };
  });
}
export async function retryRenderAction(versionId: string, key: string): Promise<ActionResult<VersionSummary>> {
  return run(() => retryRender(versionId, key));
}
export async function regenerateAction(reportId: string, r: { reason_code: string; reason_text?: string }, key: string): Promise<ActionResult<unknown>> {
  return run(() => regenerate(reportId, r, key));
}
export async function createPrintAction(versionId: string, r: { variant: 'letterhead' | 'plain'; copies: number }, key: string): Promise<ActionResult<{ id: string; state: string }>> {
  return run(() => createPrint(versionId, r, key));
}
export async function revokeQrAction(versionId: string, r: { reason_code: string; reason_text?: string }, key: string): Promise<ActionResult<{ revoked: number }>> {
  return run(() => revokeQr(versionId, r, key));
}
export async function recordOverrideAction(orderId: string, r: { reason_code: string; reason_text: string; valid_until?: string }, key: string): Promise<ActionResult<{ override_id: string }>> {
  return run(() => recordOverride(orderId, r, key));
}

// ── outsourced + narrative
export async function uploadOutsourcedAction(orderItemId: string, form: FormData, key: string): Promise<ActionResult<InputFile>> {
  return run(() => uploadOutsourced(orderItemId, form, key));
}
export async function confirmOutsourcedAction(fileId: string, version: number, key: string): Promise<ActionResult<InputFile>> {
  return run(() => confirmOutsourced(fileId, version, key));
}
export async function saveNarrativeDraftAction(id: string, version: number, b: { template_id?: string; sections: { key: string; html: string }[]; images: { image_id: string; caption?: string }[] }, key: string): Promise<ActionResult<Narrative>> {
  return run(() => saveNarrativeDraft(id, version, b, key));
}
export async function signNarrativeAction(id: string, version: number, key: string): Promise<ActionResult<Narrative>> {
  return run(() => signNarrative(id, version, key));
}
export async function startAmendmentAction(id: string, version: number, r: { reason_code: string; reason_text?: string }, key: string): Promise<ActionResult<Narrative>> {
  return run(() => startAmendment(id, version, r, key));
}
export async function uploadNarrativeImageAction(id: string, form: FormData, key: string): Promise<ActionResult<{ image_id: string }>> {
  return run(() => uploadNarrativeImage(id, form, key));
}

// ── deliveries, templates, messages, settings
export async function retryDeliveryAction(id: string, key: string): Promise<ActionResult<Delivery | unknown>> {
  return run(() => retryDelivery(id, key));
}
export async function previewTemplateAction(id: string, key: string): Promise<ActionResult<{ id: string; state: string }>> {
  return run(() => previewTemplate(id, key));
}
export async function saveTemplateDraftAction(id: string, draftVersion: number, config: TemplateConfig, key: string): Promise<ActionResult<TemplateDetail>> {
  return run(() => saveTemplateDraft(id, draftVersion, config, key));
}
export async function publishTemplateAction(id: string, version: number, key: string): Promise<ActionResult<TemplateDetail>> {
  return run(() => publishTemplate(id, version, key));
}
export async function upsertMessageTextAction(templateCode: string, channel: string, version: number | undefined, b: Omit<MessageText, 'channel' | 'version'>): Promise<ActionResult<MessageText>> {
  return run(() => upsertMessageText(templateCode, channel, version, b));
}
export async function upsertChannelAccountAction(channel: string, b: Pick<ChannelAccount, 'provider_kind' | 'secret_ref' | 'is_active'> & { sender_id?: string }): Promise<ActionResult<ChannelAccount>> {
  return run(() => upsertChannelAccount(channel, b));
}
export async function rotateCallbackTokenAction(channel: string, version: number): Promise<ActionResult<{ callback_url: string }>> {
  return run(() => rotateCallbackToken(channel, version));
}
export async function updateSettingsAction(version: number, patch: Partial<Omit<ReportingSettings, 'version'>>, key: string): Promise<ActionResult<ReportingSettings>> {
  return run(() => updateSettings(version, patch, key));
}
