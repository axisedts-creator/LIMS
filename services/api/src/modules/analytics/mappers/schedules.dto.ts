// Explicit field allow-lists of #24–#29 (02-TRD §5; contracts ScheduleDto / ScheduleDetailDto / ReportRunDto). Nothing is spread from a stored row:
// tenant_id, created_by, updated_by, last_run_id, expires_at, counters, delivery ids and e-mail addresses cannot reach a response (07-SECURITY S4).
import { resolvePeriod } from '../domain/period.js';
import type { RecipientRow, RunRecipientRow, RunRow, ScheduleRow } from '../repository/schedules.repo.js';

const MAX_PERIOD_DAYS = 366; // report_runs__period__ck

/** Both calendars + timezone, derived from the stored dates (not stored). */
export function toPeriodDto(from: string, to: string) {
  const p = resolvePeriod({ business_date_from: from, business_date_to: to }, from as never, MAX_PERIOD_DAYS);
  return {
    business_date_from: p.from, business_date_to: p.to, days: p.days, label_ad: p.labelAd, label_bs: p.labelBs, timezone: 'Asia/Kathmandu' as const,
  };
}

export const toRunSummary = (r: Pick<RunRow, 'id' | 'created_at' | 'period_from' | 'period_to'>) => ({ id: r.id, created_at: r.created_at, period: toPeriodDto(r.period_from, r.period_to) });

export const activeRecipientIds = (rows: readonly RecipientRow[]): string[] => rows.filter((r) => r.is_active).map((r) => r.membership_id);

export function toScheduleDto(s: ScheduleRow, recipientMembershipIds: readonly string[], lastRun?: ReturnType<typeof toRunSummary> | undefined) {
  return {
    id: s.id, name: s.name, report_codes: [...s.report_codes], frequency: s.frequency, send_time_local: s.send_time_local,
    ...(s.weekday === null || s.weekday === undefined ? {} : { weekday: s.weekday }),
    period_rule: s.period_rule,
    scope: { all_centres: s.scope_all_centres, centre_ids: s.scope_all_centres ? [] : [...s.scope_centre_ids] },
    recipient_membership_ids: [...recipientMembershipIds],
    version: s.version, is_active: s.is_active,
    ...(s.next_run_at ? { next_run_at: s.next_run_at } : {}),
    created_at: s.created_at, owner_membership_id: s.owner_membership_id,
    ...(lastRun ? { last_run: lastRun } : {}),
  };
}

export function toScheduleDetailDto(s: ScheduleRow, recipientMembershipIds: readonly string[], runs: readonly RunRow[]) {
  const summaries = runs.map(toRunSummary);
  return { ...toScheduleDto(s, recipientMembershipIds, summaries[0]), runs: summaries };
}

export interface RunViewer {
  readonly omitted: readonly string[];
  readonly effectiveScope: { all: boolean; centreIds: readonly string[] };
  readonly recipients?: readonly { membership_id: string; display_name: string; outcome: RunRecipientRow['outcome'] }[] | undefined;
}

export function toReportRunDto(run: RunRow, scheduleName: string, v: RunViewer) {
  return {
    id: run.id, schedule_id: run.schedule_id, schedule_name: scheduleName, report_codes: [...run.report_codes], period: toPeriodDto(run.period_from, run.period_to),
    scope_all_centres: run.scope_all_centres, scope_centre_ids: [...run.scope_centre_ids], created_at: run.created_at,
    effective_scope: { all_centres: v.effectiveScope.all, centre_ids: v.effectiveScope.all ? [] : [...v.effectiveScope.centreIds], tenant_wide_sections_hidden: [] as string[] },
    viewer_omitted_report_codes: [...v.omitted],
    ...(v.recipients ? { recipients: v.recipients.map((r) => ({ membership_id: r.membership_id, display_name: r.display_name, outcome: r.outcome })) } : {}),
  };
}
