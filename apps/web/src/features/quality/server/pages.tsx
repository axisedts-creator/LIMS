import 'server-only';
// C9 T-21 page composers (server components): permission -> whitelisted query -> API -> plain-JSON props for the client views.
// LD-140: no markup of their own; everything is composed from the client views, which use @lims/ui only.
import { notFound } from 'next/navigation';
import { ApiError } from '@/core/api/server-fetch';
import { LjView } from '../components/LjView';
import { ObservationsView } from '../components/ObservationsView';
import { QualityNotice } from '../components/Shared';
import { RunDetailView } from '../components/RunDetailView';
import { RunsView } from '../components/RunsView';
import { StatusBoardView } from '../components/StatusBoardView';
import { UNASSIGNED_STATUSES } from '../format';
import {
  MANAGE, REVIEW, UUID, gated, getCodedSet, getLjChart, getRun, getRuns, getStatusBoard, getUnassigned, ljQuery, observationsQuery, planLabel, planOptions, runsQuery, statusQuery,
} from './quality.server';

type SP = Record<string, string | string[] | undefined>;
const plain = (q: URLSearchParams, drop: string[]) => Object.fromEntries([...q].filter(([k]) => !drop.includes(k)));
const notice = (g: 'denied' | 'disabled', title: string, helpKey: string) => <QualityNotice kind={g} title={title} helpKey={helpKey} />;
const now = () => new Date().toISOString();

export async function statusBoardPage(sp: SP) {
  const q = statusQuery(sp);
  const r = await gated(() => getStatusBoard(q));
  if ('gate' in r) return notice(r.gate, 'QC status', 'quality.status');
  const clean = plain(q, ['limit']);
  return <StatusBoardView key={JSON.stringify(clean)} rows={r.data} generatedAt={now()} sp={clean} canManage={r.perms.includes(MANAGE)} />;
}

export async function runsPage(sp: SP) {
  const q = runsQuery(sp);
  const r = await gated(async () => ({ runs: await getRuns(q), plans: await planOptions() }));
  if ('gate' in r) return notice(r.gate, 'QC runs', 'quality.runs');
  const labels = Object.fromEntries(r.data.plans.map((p) => [p.plan_id, { instrument: p.instrument_label, analyte: p.analyte_code }]));
  return <RunsView rows={r.data.runs.rows} hasPrevious={q.has('cursor')} sp={plain(q, ['limit', 'sort'])} labels={labels} {...(r.data.runs.next ? { next: r.data.runs.next } : {})} />;
}

export async function observationsPage(sp: SP) {
  const q = observationsQuery(sp);
  const r = await gated(async () => ({ obs: await getUnassigned(q), plans: await planOptions() }));
  if ('gate' in r) return notice(r.gate, 'Unassigned QC', 'quality.observations');
  const clean = plain(q, ['limit', 'sort']);
  if (clean['status'] === UNASSIGNED_STATUSES.join(',')) delete clean['status']; // the default is not a filter
  const instruments = Object.fromEntries(r.data.plans.map((p) => [p.instrument_id, p.instrument_label]));
  return <ObservationsView rows={r.data.obs.rows} hasPrevious={q.has('cursor')} sp={clean} canManage={r.perms.includes(MANAGE)} instruments={instruments} {...(r.data.obs.next ? { next: r.data.obs.next } : {})} />;
}

export async function runDetailPage(params: { qc_run_id?: string }) {
  const id = params.qc_run_id ?? '';
  const r = await gated(async (perms) => {
    if (!UUID.test(id)) notFound(); // malformed id: no API call
    const run = await getRun(id).catch((e: unknown) => (e instanceof ApiError && e.status === 404 ? notFound() : Promise.reject(e)));
    const canReview = perms.includes(REVIEW);
    const [label, correctiveOptions] = await Promise.all([planLabel(run.plan_id, run.instrument_id), canReview && run.outcome === 'rejected' ? getCodedSet('corrective_actions') : []]);
    return { run, label, canReview, correctiveOptions };
  });
  if ('gate' in r) return notice(r.gate, 'QC run', 'quality.qc_run');
  return <RunDetailView run={r.data.run} label={r.data.label} canReview={r.data.canReview} correctiveOptions={r.data.correctiveOptions} />;
}

export async function ljPage(sp: SP) {
  const lj = ljQuery(sp);
  const r = await gated(async (perms) => {
    if (!lj) return { plans: await planOptions() }; // no plan chosen: nothing to chart yet
    const [chart, plans, exclusionOptions] = await Promise.all([getLjChart(lj.query), planOptions(), perms.includes(MANAGE) ? getCodedSet('exclusion_reasons') : []]);
    return { chart, plans, exclusionOptions };
  });
  if ('gate' in r) return notice(r.gate, 'Levey-Jennings chart', 'quality.lj_chart');
  const d = r.data;
  // sanitized copy of the URL state the client keeps (the polling action re-validates it)
  const clean: Record<string, string> = lj ? { ...plain(lj.query, ['observed_at_from', 'observed_at_to']), ...pick(sp, ['from', 'to']) } : {};
  const canManage = r.perms.includes(MANAGE);
  return <LjView key={JSON.stringify(clean)} sp={clean} plans={d.plans} canManage={canManage} exclusionOptions={'exclusionOptions' in d ? d.exclusionOptions : []} generatedAt={now()} {...('chart' in d ? { chart: d.chart } : {})} />;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
function pick(sp: SP, keys: string[]): Record<string, string> {
  return Object.fromEntries(keys.flatMap((k) => { const v = Array.isArray(sp[k]) ? sp[k][0] : sp[k]; return v && DATE.test(v) ? [[k, v]] : []; }));
}
