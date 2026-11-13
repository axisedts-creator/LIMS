// C14 T17 (lead T17-01): best-effort emitters for the lims_smartreport_* metrics of 02-TRD §12 outside the build path (registered in core/observability/metrics.ts).
// A missing sink or a rejected name/label never breaks a clinical write. Labels are codes only: no id, text, value, registration number or name (AC-21.3; 02-CV §9.2).
type L = Record<string, string | number>;
type Sink = { inc?: (n: string, l?: L, by?: number) => void; set?: (n: string, v: number, l?: L) => void; observe?: (n: string, v: number, l?: L) => void };
const sinkOf = (ctx: unknown): Sink | undefined => (ctx as { metrics?: Sink } | undefined)?.metrics;
const safe = (f: () => void): void => { try { f(); } catch { /* best effort */ } };

export const srMetrics = {
  review: (ctx: unknown, action: 'approved' | 'rejected') => safe(() => sinkOf(ctx)?.inc?.('lims_smartreport_reviews_total', { action })),
  draftAge: (ctx: unknown, seconds: number) => safe(() => sinkOf(ctx)?.observe?.('lims_smartreport_draft_age_seconds', Math.max(0, seconds))),
  libraryTransition: (ctx: unknown, toStatus: string) => safe(() => sinkOf(ctx)?.inc?.('lims_smartreport_library_transitions_total', { to_status: toStatus })),
  drafts: (ctx: unknown, tenantId: string, pending: number, oldestAgeSeconds: number) => safe(() => {
    sinkOf(ctx)?.set?.('lims_smartreport_drafts_pending', pending, { tenant_id: tenantId });
    sinkOf(ctx)?.set?.('lims_smartreport_drafts_oldest_age_seconds', Math.max(0, oldestAgeSeconds), { tenant_id: tenantId });   // 0 when none
  }),
};
