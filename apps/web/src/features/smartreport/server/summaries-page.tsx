import 'server-only';
// SR-01 Review queue (04-UI-UX SR-01): permission -> whitelisted query -> API list -> plain-JSON view model for the client queue.
import { isPending, NotAvailable } from '@/core/shell/NotAvailable';
import { SummaryQueue, type QueueRow } from '../components/SummaryQueue';
import { listCentres, listSummaries, queueFilter, requireRead, smartReportOff, type Centre, type SummaryItem } from './summaries.server';

type SP = Record<string, string | string[] | undefined>;
const BAND: Record<string, string> = { good: 'Good', fair: 'Fair', needs_attention: 'Needs attention' };
const STATUS: Record<string, [string, 'info' | 'success' | 'danger' | 'neutral']> = {
  draft: ['Awaiting review', 'info'], approved: ['Approved', 'success'], rejected: ['Rejected', 'danger'], superseded: ['Superseded', 'neutral'],
};
const centreLabel = (c: Centre | undefined) => (c ? [c.code, c.name].filter(Boolean).join(' · ') || '—' : '—');
/** An API 5xx (duck typed ApiError): its request id for the ErrorState reference; anything else is not a page-level read failure. */
export const serverFailure = (e: unknown): { requestId?: string } | undefined => {
  const x = e as { status?: unknown; problem?: { request_id?: unknown } } | null;
  if (typeof x?.status !== 'number' || x.status < 500 || isPending(e)) return undefined; // 501 operation_pending stays NotAvailable
  return typeof x.problem?.request_id === 'string' ? { requestId: x.problem.request_id } : {};
};
const num = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n : 0);

function rowOf(s: SummaryItem, centres: Map<string, Centre>): QueueRow {
  const [statusLabel, tone] = STATUS[s.status] ?? [s.status, 'neutral' as const];
  return {
    id: s.id, builtAt: s.built_at ?? '', registrationNo: s.registration_no || '—', patient: s.patient_display_name || '—',
    centre: centreLabel(s.centre_id ? centres.get(s.centre_id) : undefined), deranged: num(s.deranged_count), critical: num(s.critical_count),
    band: (s.health_score_band && BAND[s.health_score_band]) || '—', status: s.status, statusLabel, tone,
  };
}

export async function summariesPage(sp: SP) {
  const perms = await requireRead();
  const f = queueFilter(sp);
  const admin = perms.includes('identity.settings.manage');
  // The list result is settled (not raced) so a failing list never leaves the centres/flags reads dangling past the request.
  const [settled, centres, off] = await Promise.all([listSummaries(f).then((v) => ({ v }), (e: unknown) => ({ e })), listCentres(), admin ? smartReportOff() : Promise.resolve(false)]);
  if ('e' in settled) {
    // T0D-UNSLOP-1 / LD-353 rule 6: 501 operation_pending keeps the title and the header row, never error.tsx.
    if (isPending(settled.e)) return <NotAvailable title="Smart summaries" helpKey="smartreport.queue" columns={['Built', 'Registration no.', 'Patient', 'Centre', 'Findings', 'Score band', 'Status']} />;
    // T0D-UILIST-1 / LD-353 rule 6: an API failure keeps the title, the filters and the header row; ErrorState with reference and Retry in the table body
    const failed = serverFailure(settled.e);
    if (!failed) throw settled.e;
    return <SummaryQueue rows={[]} status={f.status} sort={f.sort} hasPrevious={!!f.cursor} featureOff={off} centreId={f.centreId} hasCritical={f.hasCritical} loadError={failed} centres={centres.map((c) => ({ value: c.centre_id, label: centreLabel(c) }))} />;
  }
  const list = settled.v;
  const byId = new Map(centres.map((c) => [c.centre_id, c]));
  const rows = (Array.isArray(list?.data) ? list.data : []).map((s) => rowOf(s, byId));
  const next = list?.page?.next_cursor;
  return (
    <SummaryQueue
      rows={rows} status={f.status} sort={f.sort} hasPrevious={!!f.cursor} featureOff={off}
      centreId={f.centreId} hasCritical={f.hasCritical} {...(next ? { next } : {})}
      centres={centres.map((c) => ({ value: c.centre_id, label: centreLabel(c) }))}
    />
  );
}
