import 'server-only';
// BFF reads for the reporting screens (R1, R2a, R16–R18, D1/D2, O-list, N-reads, T-reads, M/C/S-reads). All GET; the API enforces permissions
// and centre scope, the UI only hides. Query values are validated by shape before they leave the BFF.
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import { REPORT_TABS, UUID_RE, type Centre, type ChannelAccount, type CentreContact, type CodedOption, type CriticalAlert, type Delivery, type MessageTemplate, type Narrative, type NarrativeTemplate, type OutsourcedItem, type Page, type ReportDetail, type ReportSummary, type ReportTab, type ReportTemplateRow, type ReportingSettings, type TemplateDetail } from './types';

const bad = () => new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURSOR_RE = /^[A-Za-z0-9_\-=.]{1,512}$/;
const ENUM = (...v: string[]) => new RegExp(`^(${v.join('|')})$`);

function qs(params: Record<string, string | number | undefined>, checks: Record<string, RegExp> = {}): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue;
    const s = String(v);
    const re = checks[k];
    if (re && !re.test(s)) throw bad();
    p.set(k, s);
  }
  const out = p.toString();
  return out ? `?${out}` : '';
}
const id = (v: string) => {
  if (!UUID_RE.test(v)) throw bad();
  return v;
};

const NPT_MS = 345 * 60_000; // Asia/Kathmandu is UTC+05:45, no DST
const DISPLAY_STATUS: Record<Exclude<ReportTab, 'all' | 'released_today'>, string> = {
  awaiting_content: 'awaiting_content,assembling,rendering', ready_to_release: 'ready_to_release', held: 'held', render_failed: 'render_failed',
};
/** Start of today (Asia/Kathmandu) as a UTC instant — the "Released today" window. */
export const startOfTodayNpt = (now = Date.now()) => new Date(Date.parse(`${new Date(now + NPT_MS).toISOString().slice(0, 10)}T00:00:00Z`) - NPT_MS).toISOString();

export interface WorklistQuery { tab?: string | undefined; centreId?: string | undefined; family?: string | undefined; registered?: string | undefined; review?: string | undefined; cursor?: string | undefined; sort?: string | undefined }
export const tabOf = (t?: string): ReportTab => (REPORT_TABS as readonly string[]).includes(t ?? '') ? (t as ReportTab) : 'ready_to_release';

export function listReports(q: WorklistQuery = {}) {
  const tab = tabOf(q.tab);
  const [from, to] = (q.registered ?? '').split(',');
  return serverFetch<Page<ReportSummary>>(`/v1/reporting/reports${qs({
    display_status: tab === 'all' || tab === 'released_today' ? (tab === 'released_today' ? 'released' : undefined) : DISPLAY_STATUS[tab],
    released_at_from: tab === 'released_today' ? startOfTodayNpt() : undefined,
    centre_id: q.centreId, family: q.family,
    registered_at_from: from && ISO_DATE_RE.test(from) ? `${from}T00:00:00.000Z` : undefined,
    registered_at_to: to && ISO_DATE_RE.test(to) ? `${to}T23:59:59.999Z` : undefined,
    has_review_flag: q.review === 'yes' ? 'true' : q.review === 'no' ? 'false' : undefined,
    sort: q.sort, cursor: q.cursor, limit: 50,
  }, { centre_id: UUID_RE, family: ENUM('laboratory', 'narrative'), sort: ENUM('-updated_at', 'registered_at', '-released_at'), cursor: CURSOR_RE })}`);
}
export const getReport = (reportId: string) => serverFetch<ReportDetail>(`/v1/reporting/reports/${id(reportId)}`);
export const listCriticalAlerts = (centreId?: string, now = Date.now()) =>
  serverFetch<Page<CriticalAlert>>(`/v1/reporting/critical-alerts${qs({ centre_id: centreId, since: new Date(now - 86_400_000).toISOString(), limit: 50 }, { centre_id: UUID_RE })}`);
export const listOutsourcedItems = (q: { state?: string | undefined; centreId?: string | undefined } = {}) =>
  serverFetch<Page<OutsourcedItem>>(`/v1/reporting/outsourced-items${qs({ state: q.state, centre_id: q.centreId, limit: 50 }, { state: ENUM('awaiting_file', 'awaiting_confirmation', 'confirmed'), centre_id: UUID_RE })}`);
export const getNarrative = (narrativeId: string) => serverFetch<Narrative>(`/v1/reporting/narratives/${id(narrativeId)}`);
export const listNarrativeTemplates = (kind?: string) =>
  serverFetch<Page<NarrativeTemplate>>(`/v1/reporting/narrative-templates${qs({ kind, is_active: 'true', limit: 100 }, { kind: /^[a-z_]{1,16}$/ })}`);
export const listDeliveries = (q: { status?: string | undefined; channel?: string | undefined; purpose?: string | undefined; reportId?: string | undefined; range?: string | undefined; cursor?: string | undefined } = {}) => {
  const [from, to] = (q.range ?? '').split(',');
  return serverFetch<Page<Delivery>>(`/v1/reporting/deliveries${qs({
    status: q.status, channel: q.channel, purpose: q.purpose, report_id: q.reportId,
    created_at_from: from && ISO_DATE_RE.test(from) ? `${from}T00:00:00.000Z` : undefined, created_at_to: to && ISO_DATE_RE.test(to) ? `${to}T23:59:59.999Z` : undefined,
    cursor: q.cursor, limit: 50,
  }, { status: /^[a-z_]{1,16}$/, channel: ENUM('whatsapp', 'sms', 'email', 'print', 'portal'), purpose: /^[a-z_]{1,32}$/, report_id: UUID_RE, cursor: CURSOR_RE })}`);
};
export const getDelivery = (deliveryId: string) => serverFetch<Delivery>(`/v1/reporting/deliveries/${id(deliveryId)}`);
export const listReportTemplates = () => serverFetch<Page<ReportTemplateRow>>('/v1/reporting/report-templates?limit=100');
export const getReportTemplate = (templateId: string) => serverFetch<TemplateDetail>(`/v1/reporting/report-templates/${id(templateId)}`);
export const listMessageTemplates = () => serverFetch<{ data: MessageTemplate[] }>('/v1/reporting/message-templates');
export const listChannelAccounts = () => serverFetch<{ data: ChannelAccount[] }>('/v1/reporting/channel-accounts');
export const getReportingSettings = () => serverFetch<ReportingSettings>('/v1/reporting/settings');
export const listCentreContacts = () => serverFetch<{ data: CentreContact[] }>('/v1/reporting/centre-contacts');

/** C2 listCentres for filter options; a failure only empties the filter, never the page. */
export const listCentres = (): Promise<Centre[]> =>
  serverFetch<{ data: { id: string; name: string }[] }>('/v1/identity/centres').then((r) => (r.data ?? []).map(({ id: i, name }) => ({ id: i, name })), () => []);

export const listReportingCodes = (set: 'regeneration_reasons' | 'token_revoke_reasons' | 'narrative_amend_reasons') =>
  serverFetch<{ data: CodedOption[] }>(`/v1/reporting/coded-sets/${set}`);
/** C4 listBillingCodes — override reasons for the held-for-dues override dialog. */
export const listOverrideReasons = () => serverFetch<{ data: CodedOption[] }>('/v1/billing/coded-sets/override_reasons');
export const getReportPrint = (printId: string) => serverFetch<{ id: string; state: string; variant?: string; copies?: number; expires_at?: string }>(`/v1/reporting/prints/${id(printId)}`);
