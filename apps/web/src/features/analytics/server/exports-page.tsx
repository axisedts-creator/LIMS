import 'server-only';
// S5 My exports (04-UI-UX §7): permission -> whitelisted query -> API list -> plain-JSON view model for the client table.
// Download eligibility is decided here (status ready, not past expires_at, downloads left); the file itself is only reachable through the BFF route.
import { ExportsView, type ExportRowVM } from '../components/ExportsView';
import { addDays } from '../components/period';
import { reportLabel } from '../report-codes';
import { exportsQuery, listAnalyticsExports, type ExportRow } from './exports.server';
import { requirePermission } from './reports.server';

type SP = Record<string, string | string[] | undefined>;
const FAIL: Record<string, string> = {
  'analytics.export_too_large': 'Too much data — choose a shorter period or fewer centres.',
  'auth.forbidden': 'You no longer have access to this data.',
  'common.feature_disabled': 'This report is disabled for your lab.',
};
const STATUS_LABEL: Record<string, string> = { queued: 'Queued', building: 'Building', ready: 'Ready', failed: 'Failed', expired: 'Expired' };
const FORMAT_LABEL: Record<string, string> = { xlsx: 'Excel (.xlsx)', csv: 'CSV (.csv)', pdf: 'PDF' };
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const nn = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Period as the user chose it, exactly as stored in params (no B.S.<->A.D. conversion). */
function periodOf(p: Record<string, unknown> | undefined): string {
  const d = p ?? {};
  if (str(d['bs_month'])) return str(d['bs_month']);
  if (str(d['fiscal_year_bs'])) return str(d['fiscal_year_bs']);
  const from = str(d['business_date_from']);
  const to = str(d['business_date_to']);
  if (ISO.test(from) && ISO.test(to)) return `${from} – ${addDays(to, -1)}`; // stored `to` is exclusive (01-PRD:246); show the inclusive last day
  if (from && to) return `${from} – ${to}`;
  return '—';
}

function rowOf(e: ExportRow, now: number): ExportRowVM {
  const exp = Date.parse(str(e.expires_at));
  const lapsed = e.status === 'expired' || (e.status === 'ready' && Number.isFinite(exp) && exp <= now);
  const status = lapsed ? 'expired' : STATUS_LABEL[e.status] ? e.status : 'failed';
  const used = nn(e.downloads_used);
  const allowed = nn(e.downloads_allowed);
  const canDownload = status === 'ready' && (used === undefined || allowed === undefined || used < allowed);
  return {
    id: e.id, requestedAt: str(e.requested_at), report: reportLabel(str(e.report_code)), period: periodOf(e.params),
    format: FORMAT_LABEL[e.format] ?? str(e.format).toUpperCase(), status, statusLabel: STATUS_LABEL[status] ?? status,
    ...(nn(e.row_count) !== undefined ? { rows: nn(e.row_count)! } : {}), ...(nn(e.size_bytes) !== undefined ? { sizeBytes: nn(e.size_bytes)! } : {}),
    downloads: used !== undefined && allowed !== undefined ? `${used} of ${allowed}` : '—',
    ...(str(e.expires_at) ? { expiresAt: str(e.expires_at) } : {}), canDownload,
    ...(status === 'failed' ? { failure: FAIL[str(e.failure_code)] ?? `Export failed. Reference: ${e.id.slice(0, 8)}` } : {}), // [CONV] ExportDto carries no request id: the export id prefix is the reference
  };
}

export async function exportsPage(sp: SP) {
  await requirePermission('analytics.data.export');
  const q = exportsQuery(sp);
  const res = await listAnalyticsExports(q);
  const now = Date.now();
  const rows = (Array.isArray(res?.data) ? res.data : []).slice(0, 50).map((e) => rowOf(e, now));
  const next = str(res?.page?.next_cursor);
  const status = q.get('status')?.split(',')[0] ?? 'all'; // the filter is a single choice; a multi-value URL shows its first value
  return <ExportsView rows={rows} status={status} hasPrevious={q.has('cursor')} {...(next ? { next } : {})} />;
}
