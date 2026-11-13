import 'server-only';
// SR-02 Summary review (04-UI-UX SR-02). Order: id shape -> permission (smartreport.summary.read) -> reads (#28 summary, #26 reasons, centres).
// API 404/403 on the summary -> notFound(); any other failed read throws to the error boundary (never rendered as data).
import { notFound } from 'next/navigation';
import { ApiError } from '@/core/api/server-fetch';
import { SummaryReview } from '../components/SummaryReview';
import { UUID_RE } from '../library';
import { buildView } from '../summary-review';
import { listCentres, requireRead } from './summaries.server';
import { getSummary, rejectReasons } from './summary.server';

export async function summaryPage(id: string) {
  if (!UUID_RE.test(id ?? '')) notFound();
  const perms = await requireRead();
  // Settled (not raced) so a failing summary read never leaves the other reads dangling past the request.
  const [settled, reasons, centres] = await Promise.all([getSummary(id).then((v) => ({ v }), (e: unknown) => ({ e })), rejectReasons(), listCentres()]);
  if ('e' in settled) {
    if (settled.e instanceof ApiError && (settled.e.status === 404 || settled.e.status === 403)) notFound();
    throw settled.e;
  }
  const c = centres.find((x) => x.centre_id === settled.v['centre_id']);
  const centre = c ? [c.code, c.name].filter(Boolean).join(' · ') : undefined;
  const vm = buildView(settled.v, { id, perms, reasons, ...(centre ? { centre } : {}) });
  return <SummaryReview key={`${vm.id}:${vm.version}`} vm={vm} />;
}
