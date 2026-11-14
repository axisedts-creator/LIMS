// C13 T23 — partners metric emitters (02-TRD §13). One place for the names and the label vocabulary; call sites pass only the bounded value.
// Label vocabulary (no id / name / PHI / URL / token label ever, REQ-SEC-045/133):
//   manifests_total{transition}  created | submitted | withdrawn | discarded | received | partially_received   (once per successful transition)
//   pickups_total{transition}    requested | scheduled | picked_up | cancelled | rejected                       (once per successful operation)
//   line_conversions_total{outcome[,failure_code]}  converted | replayed | failed_business(+errors.yaml code) | failed_infra
//   access_slips_total{outcome}  requested | issued | failed | expired | downloaded
// [CONV] metrics are not on the typed request ctx yet (same seam as report.service.ts): ctx.metrics?.inc?.(...). An emit NEVER throws and never
// changes the outcome of the operation (an unregistered name or a broken registry must not turn a 200 into a 500); it is called after the last
// write of the operation, so a refused or rolled-back request counts nothing.
// [CONV] ponytail: core/observability/metrics.ts must register the ten lims_partners_* names (CR-C13-T23 in .orchestra/cr/C13.T23.md); until then the real registry refuses them and the emit is a no-op.
type Labels = Readonly<Record<string, string | number>>;
type Sink = { inc?(name: string, labels?: Labels, by?: number): void; observe?(name: string, value: number, labels?: Labels): void; set?(name: string, value: number, labels?: Labels): void };
type WithMetrics = { metrics?: Sink };

export const M = {
  manifests: 'lims_partners_manifests_total',
  lineConversions: 'lims_partners_line_conversions_total',
  conversionDuration: 'lims_partners_conversion_duration_seconds',
  pickups: 'lims_partners_pickups_total',
  slips: 'lims_partners_access_slips_total',
  slipIssueSeconds: 'lims_partners_access_slip_issue_seconds',
  partnerInactive: 'lims_partners_partner_inactive_rejections_total',
} as const;

export type ManifestTransition = 'created' | 'submitted' | 'withdrawn' | 'discarded' | 'received' | 'partially_received';
export type PickupTransition = 'requested' | 'scheduled' | 'picked_up' | 'cancelled' | 'rejected';
export type ConversionOutcome = 'converted' | 'replayed' | 'failed_business' | 'failed_infra';
export type SlipOutcome = 'requested' | 'issued' | 'failed' | 'expired' | 'downloaded';

const safe = (fn: () => void): void => { try { fn(); } catch { /* metrics never break a request or a job */ } };

export const inc = (ctx: unknown, name: string, labels: Labels = {}, by = 1): void => safe(() => { (ctx as WithMetrics).metrics?.inc?.(name, labels, by); });
export const observe = (ctx: unknown, name: string, value: number, labels: Labels = {}): void => safe(() => { (ctx as WithMetrics).metrics?.observe?.(name, value, labels); });

export const manifestTransition = (ctx: unknown, transition: ManifestTransition): void => inc(ctx, M.manifests, { transition });
export const pickupTransition = (ctx: unknown, transition: PickupTransition): void => inc(ctx, M.pickups, { transition });
export const slip = (ctx: unknown, outcome: SlipOutcome, by = 1): void => inc(ctx, M.slips, { outcome }, by);
export const partnerInactive = (ctx: unknown): void => inc(ctx, M.partnerInactive);
export const lineConversion = (ctx: unknown, outcome: ConversionOutcome, failureCode?: string): void =>
  inc(ctx, M.lineConversions, failureCode === undefined ? { outcome } : { outcome, failure_code: failureCode });
