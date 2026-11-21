// Explicit field allow-lists of #24–#29 (02-TRD §5; contracts ScheduleDto / ScheduleDetailDto / ReportRunDto). Nothing is spread from a stored row:
// tenant_id, created_by, updated_by, last_run_id, expires_at, counters, delivery ids and e-mail addresses cannot reach a response (07-SECURITY S4).
import { resolvePeriod, type Period } from '../domain/period.js';
import type { RecipientRow, RunRecipientRow, RunRow, ScheduleRow } from '../repository/schedules.repo.js';

const MAX_PERIOD_DAYS = 366; // report_runs__period__ck

// VERIFY-GREEN-1 / LD-253: explicit exported result types, types only (TS2883: the inferred types named IsoDate through another package's node_modules path).
// Shapes are exactly what the mappers below already returned; no field added, removed or retyped.
export interface PeriodDto {
  business_date_from: Period['from']; business_date_to: Period['to']; days: number; label_ad: string; label_bs: string; timezone: 'Asia/Kathmandu';
}
export interface RunSummaryDto { id: string; created_at: string; period: PeriodDto }
export interface ScheduleDto {
  id: string; name: string; report_codes: string[]; frequency: string; send_time_local: string; weekday?: number; period_rule: string;
  scope: { all_centres: boolean; centre_ids: string[] }; recipient_membership_ids: string[]; version: number; is_active: boolean;
  next_run_at?: string; created_at: string; owner_membership_id: string; last_run?: RunSummaryDto;
}
export interface ScheduleDetailDto extends ScheduleDto { runs: RunSummaryDto[] }
export interface ReportRunDto {
  id: string; schedule_id: string; schedule_name: string; report_codes: string[]; period: PeriodDto;
  scope_all_centres: boolean; scope_centre_ids: string[]; created_at: string;
  effective_scope: { all_centres: boolean; centre_ids: string[]; tenant_wide_sections_hidden: string[] };
  viewer_omitted_report_codes: string[];
  recipients?: { membership_id: string; display_name: string; outcome: RunRecipientRow['outcome'] }[];
}

/** Both calendars + timezone, derived from the stored dates (not stored). */
export function toPeriodDto(from: string, to: string): PeriodDto {
  const p = resolvePeriod({ business_date_from: from, business_date_to: to }, from as never, MAX_PERIOD_DAYS);
  return {
    business_date_from: p.from, business_date_to: p.to, days: p.days, label_ad: p.labelAd, label_bs: p.labelBs, timezone: 'Asia/Kathmandu' as const,
  };
}

export const toRunSummary = (r: Pick<RunRow, 'id' | 'created_at' | 'period_from' | 'period_to'>): RunSummaryDto => ({ id: r.id, created_at: r.created_at, period: toPeriodDto(r.period_from, r.period_to) });

export const activeRecipientIds = (rows: readonly RecipientRow[]): string[] => rows.filter((r) => r.is_active).map((r) => r.membership_id);

export function toScheduleDto(s: ScheduleRow, recipientMembershipIds: readonly string[], lastRun?: RunSummaryDto | undefined): ScheduleDto {
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

export function toScheduleDetailDto(s: ScheduleRow, recipientMembershipIds: readonly string[], runs: readonly RunRow[]): ScheduleDetailDto {
  const summaries = runs.map(toRunSummary);
  return { ...toScheduleDto(s, recipientMembershipIds, summaries[0]), runs: summaries };
}

export interface RunViewer {
  readonly omitted: readonly string[];
  readonly effectiveScope: { all: boolean; centreIds: readonly string[] };
  readonly recipients?: readonly { membership_id: string; display_name: string; outcome: RunRecipientRow['outcome'] }[] | undefined;
}

export function toReportRunDto(run: RunRow, scheduleName: string, v: RunViewer): ReportRunDto {
  return {
    id: run.id, schedule_id: run.schedule_id, schedule_name: scheduleName, report_codes: [...run.report_codes], period: toPeriodDto(run.period_from, run.period_to),
    scope_all_centres: run.scope_all_centres, scope_centre_ids: [...run.scope_centre_ids], created_at: run.created_at,
    effective_scope: { all_centres: v.effectiveScope.all, centre_ids: v.effectiveScope.all ? [] : [...v.effectiveScope.centreIds], tenant_wide_sections_hidden: [] as string[] },
    viewer_omitted_report_codes: [...v.omitted],
    ...(v.recipients ? { recipients: v.recipients.map((r) => ({ membership_id: r.membership_id, display_name: r.display_name, outcome: r.outcome })) } : {}),
  };
}
