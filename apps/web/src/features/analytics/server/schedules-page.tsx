import 'server-only';
// S6 Scheduled reports (04-UI-UX §8): list, new, edit. Permission analytics.schedule.manage is checked before any API call; a malformed id is a 404 with no API call.
import { notFound } from 'next/navigation';
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { getShellSession } from '@/core/session/server';
import { ScheduleEditor, type EditorInit } from '../components/ScheduleEditor';
import { SchedulesView, type ScheduleRowVM } from '../components/SchedulesView';
import { REPORT_CODES, UUID_RE, reportLabel } from '../report-codes';
import { frequencyText, periodLabel } from '../schedule-labels';
import { requirePermission } from './reports.server';
import { getSchedule, listSchedules, schedulesQuery, type Schedule } from './schedules.server';

type SP = Record<string, string | string[] | undefined>;
const PERM = 'analytics.schedule.manage';
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export async function schedulesListPage(sp: SP) {
  await requirePermission(PERM);
  const q = schedulesQuery(sp);
  const res = await listSchedules(q);
  const rows: ScheduleRowVM[] = (Array.isArray(res?.data) ? res.data : []).slice(0, 50).map((s) => ({
    id: s.id, version: s.version, name: s.name,
    reportCount: s.report_codes.length, reportNames: s.report_codes.slice(0, 2).map(reportLabel).join(', '),
    frequency: frequencyText(s.frequency, s.send_time_local, s.weekday), period: periodLabel(s.period_rule),
    recipients: s.recipient_membership_ids.length, ...(str(s.next_run_at) ? { nextRunAt: str(s.next_run_at) } : {}), active: s.is_active === true,
  }));
  const next = str(res?.page?.next_cursor);
  return <SchedulesView rows={rows} hasPrevious={q.has('cursor')} {...(next ? { next } : {})} />;
}

interface Options { centres?: { id: string; label: string }[]; recipients?: { membership_id: string; display_name: string }[] }

/** `id` undefined = new schedule. Reads the recipients/centres from getAnalyticsFilterOptions (#16) and, for edit, the schedule with its run log. */
export async function scheduleEditorPage(id?: string) {
  const perms = await requirePermission(PERM);
  if (id !== undefined && !UUID_RE.test(id)) notFound();
  let schedule: Awaited<ReturnType<typeof getSchedule>> | undefined;
  let options: Options;
  try {
    [options, schedule] = await Promise.all([serverFetch<Options>('/v1/analytics/filter-options'), id ? getSchedule(id) : Promise.resolve(undefined)]);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
  const have = new Set(schedule?.report_codes ?? []);
  const reports = REPORT_CODES.filter((r) => (r.schedulable && perms.includes(r.permission)) || have.has(r.code)).map((r) => ({ code: r.code, label: r.label }));
  const recipients = (options?.recipients ?? []).map((r) => ({ id: r.membership_id, name: r.display_name }));
  const init: EditorInit = schedule ? initOf(schedule) : {
    name: '', reportCodes: ['dashboard', 'income'].filter((c) => reports.some((r) => r.code === c)), frequency: 'daily', weekday: 7, time: '07:00', period: 'previous_business_day',
    allCentres: true, centreIds: [], recipientIds: [] as string[],
  };
  // LD-89 / CR-C8-001: actor.membershipId is optional (absent in production until C2 resolveSession carries it); no creator default then.
  const self = (await getShellSession())?.actor.membershipId;
  if (!schedule && self) init.recipientIds = [self]; // default recipient = the creator
  return (
    <ScheduleEditor
      key={schedule?.version ?? 'new'} init={init} reports={reports} recipients={recipients} centres={(options?.centres ?? []).map((c) => ({ id: c.id, label: c.label }))}
      {...(schedule ? { id: schedule.id, version: schedule.version, runs: schedule.runs.slice(0, 20).map((r) => ({ id: r.id, createdAt: r.created_at, periodAd: str(r.period?.label_ad), periodBs: str(r.period?.label_bs) })) } : {})}
    />
  );
}

const initOf = (s: Schedule): EditorInit => ({
  name: s.name, reportCodes: s.report_codes, frequency: s.frequency, weekday: s.weekday ?? 7, time: s.send_time_local, period: s.period_rule,
  allCentres: s.scope.all_centres, centreIds: s.scope.centre_ids ?? [], recipientIds: s.recipient_membership_ids,
});
