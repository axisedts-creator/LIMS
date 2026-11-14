import 'server-only';
// BFF writes for the reporting screens. Every write sends Idempotency-Key (except rotateChannelCallbackToken: x-idempotency none, the secret
// must never be stored for replay) and versioned writes send If-Match: "<version>".
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import { UUID_RE, type ChannelAccount, type BulkResult, type InputFile, type MessageText, type Narrative, type ReportingSettings, type ReportSummary, type TemplateConfig, type TemplateDetail, type VersionSummary } from './types';

const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const bad = () => new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
const uuid = (v: string) => {
  if (!UUID_RE.test(v)) throw bad();
  return v;
};
const code = (v: string) => {
  if (!/^[a-z0-9_]{1,64}$/.test(v)) throw bad();
  return v;
};
const tcode = (v: string) => {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(v)) throw bad();
  return v;
};
const CHANNELS = ['whatsapp', 'sms', 'email'];
const channel = (v: string) => {
  if (!CHANNELS.includes(v)) throw bad();
  return v;
};

interface Send { method: 'POST' | 'PUT' | 'PATCH'; path: string; body?: unknown; form?: FormData; key?: string | undefined; version?: number | undefined }
function send<T>({ method, path, body, form, key, version }: Send): Promise<T> {
  if (key !== undefined && !KEY_RE.test(key)) throw bad();
  const headers: Record<string, string> = {};
  if (key) headers['idempotency-key'] = key;
  if (version !== undefined) headers['if-match'] = `"${version}"`;
  if (!form) headers['content-type'] = 'application/json'; // multipart: fetch sets the boundary itself
  return serverFetch<T>(path, { method, headers, body: form ?? JSON.stringify(body ?? {}) });
}
const R = '/v1/reporting';

export const searchReports = (k: { barcode: string } | { registration_no: string }) => {
  const v = 'barcode' in k ? k.barcode : k.registration_no;
  if (!/^[A-Z0-9]{1,20}$/.test(v)) throw bad();
  return send<{ data: ReportSummary[] }>({ method: 'POST', path: `${R}/reports/search`, body: k });
};
export const releaseVersion = (versionId: string, version: number, b: { audiences?: string[]; suppress_notifications?: boolean }, key: string) =>
  send<VersionSummary>({ method: 'POST', path: `${R}/report-versions/${uuid(versionId)}/release`, body: b, key, version });
export const bulkRelease = (ids: string[], key: string) => {
  if (ids.length < 1 || ids.length > 200) throw bad();
  return send<BulkResult>({ method: 'POST', path: `${R}/report-versions/bulk-release`, body: { ids: ids.map(uuid) }, key });
};
export const retryRender = (versionId: string, key: string) => send<VersionSummary>({ method: 'POST', path: `${R}/report-versions/${uuid(versionId)}/retry-render`, key });
export const regenerate = (reportId: string, r: { reason_code: string; reason_text?: string }, key: string) =>
  send<unknown>({ method: 'POST', path: `${R}/reports/${uuid(reportId)}/regenerations`, body: { ...r, reason_code: code(r.reason_code) }, key });
export const createPrint = (versionId: string, r: { variant: 'letterhead' | 'plain'; copies: number }, key: string) => {
  if (!['letterhead', 'plain'].includes(r.variant) || !Number.isInteger(r.copies) || r.copies < 1 || r.copies > 5) throw bad();
  return send<{ id: string; state: string }>({ method: 'POST', path: `${R}/report-versions/${uuid(versionId)}/prints`, body: r, key });
};
export const revokeQr = (versionId: string, r: { reason_code: string; reason_text?: string }, key: string) =>
  send<{ revoked: number }>({ method: 'POST', path: `${R}/report-versions/${uuid(versionId)}/qr-token/revoke`, body: { ...r, reason_code: code(r.reason_code) }, key });
/** C4 recordReleaseOverride — the held-for-dues override; the release dialog reopens afterwards. */
export const recordOverride = (orderId: string, r: { reason_code: string; reason_text: string; valid_until?: string }, key: string) => {
  if (r.reason_text.length > 500) throw bad();
  return send<{ override_id: string }>({ method: 'POST', path: `/v1/billing/orders/${uuid(orderId)}/release-overrides`, body: { ...r, reason_code: code(r.reason_code) }, key });
};

export const uploadOutsourced = (orderItemId: string, form: FormData, key: string) => {
  const lab = form.get('external_lab_name');
  if (typeof lab !== 'string' || lab.trim() === '' || lab.length > 120 || !(form.get('file') instanceof Blob)) throw bad();
  return send<InputFile>({ method: 'POST', path: `${R}/order-items/${uuid(orderItemId)}/outsourced-files`, form, key });
};
export const listOutsourcedFiles = (orderItemId: string) => serverFetch<{ data: InputFile[] }>(`${R}/order-items/${uuid(orderItemId)}/outsourced-files`);
export const confirmOutsourced = (fileId: string, version: number, key: string) => send<InputFile>({ method: 'POST', path: `${R}/outsourced-files/${uuid(fileId)}/confirm`, key, version });

export const saveNarrativeDraft = (id: string, version: number, b: { template_id?: string; sections: { key: string; html: string }[]; images: { image_id: string; caption?: string }[] }, key: string) =>
  send<Narrative>({ method: 'PUT', path: `${R}/narratives/${uuid(id)}/draft`, body: b, key, version });
export const signNarrative = (id: string, version: number, key: string) => send<Narrative>({ method: 'POST', path: `${R}/narratives/${uuid(id)}/sign`, key, version });
export const startAmendment = (id: string, version: number, r: { reason_code: string; reason_text?: string }, key: string) =>
  send<Narrative>({ method: 'POST', path: `${R}/narratives/${uuid(id)}/amendments`, body: { ...r, reason_code: code(r.reason_code) }, key, version });
export const uploadNarrativeImage = (id: string, form: FormData, key: string) => {
  if (!(form.get('file') instanceof Blob)) throw bad();
  return send<{ image_id: string }>({ method: 'POST', path: `${R}/narratives/${uuid(id)}/images`, form, key });
};

export const retryDelivery = (id: string, key: string) => send<unknown>({ method: 'POST', path: `${R}/deliveries/${uuid(id)}/retry`, key });

/** Contract T5: body {variant} is required; the preview is a print job (poll GET /prints/{id}, PDF at /prints/{id}/pdf). */
export const previewTemplate = (id: string, key: string, variant: 'letterhead' | 'plain' = 'letterhead') =>
  send<{ id: string; state: string }>({ method: 'POST', path: `${R}/report-templates/${uuid(id)}/previews`, body: { variant }, key });
export const saveTemplateDraft = (id: string, draftVersion: number, config: TemplateConfig, key: string) =>
  send<TemplateDetail>({ method: 'PUT', path: `${R}/report-templates/${uuid(id)}/draft`, body: { config }, key, version: draftVersion });
export const publishTemplate = (id: string, version: number, key: string) => send<TemplateDetail>({ method: 'POST', path: `${R}/report-templates/${uuid(id)}/publish`, key, version });

export const upsertMessageText = (templateCode: string, ch: string, version: number | undefined, b: Omit<MessageText, 'channel' | 'version'>) =>
  send<MessageText>({ method: 'PUT', path: `${R}/message-templates/${tcode(templateCode)}/texts/${channel(ch)}`, body: b, version });
export const upsertChannelAccount = (ch: string, b: Pick<ChannelAccount, 'provider_kind' | 'secret_ref' | 'is_active'> & { sender_id?: string }) => {
  if (!/^[a-z0-9_./-]{1,128}$/.test(b.secret_ref)) throw bad();
  return send<ChannelAccount>({ method: 'PUT', path: `${R}/channel-accounts/${channel(ch)}`, body: b });
};
/** Callback URL is returned once and never stored by core; guarded by If-Match instead of an idempotency key. */
export const rotateCallbackToken = (ch: string, version: number) => send<{ callback_url: string }>({ method: 'POST', path: `${R}/channel-accounts/${channel(ch)}/callback-token`, version });

export const updateSettings = (version: number, patch: Partial<Omit<ReportingSettings, 'version'>>, key: string) =>
  send<ReportingSettings>({ method: 'PATCH', path: `${R}/settings`, body: patch, key, version });
