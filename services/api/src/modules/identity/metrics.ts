// C2 T28 (LD-147 / CR-C2-T28-001): best-effort emitters for the lims_identity_* metrics of C2 02-TRD §13 (registered in core/observability/metrics.ts).
// Same pattern as smartreport/metrics.ts: the sink is ctx.metrics, else the process sink bound by the module manifest (createServices).
// A missing sink or a refused name/label never breaks an auth path. Labels are TRD codes only: never a user/membership/session id,
// e-mail or IP (02-TRD §13 logs rule, 02-CV §9.2).
type L = Record<string, string | number>;
export type IdentityMetricsSink = { inc?: (n: string, l?: L, by?: number) => void; set?: (n: string, v: number, l?: L) => void; observe?: (n: string, v: number, l?: L) => void };

let processSink: IdentityMetricsSink | undefined;
/** Process-wide sink for call sites without a ctx (GoTrue gateway, login limiter, IdentityPort). */
export const bindIdentityMetrics = (s: IdentityMetricsSink | undefined): void => { processSink = s; };

const sinkOf = (ctx: unknown): IdentityMetricsSink | undefined => (ctx as { metrics?: IdentityMetricsSink } | undefined)?.metrics ?? processSink;
const safe = (f: () => void): void => { try { f(); } catch { /* best effort */ } };
const inc = (ctx: unknown, n: string, l?: L) => safe(() => sinkOf(ctx)?.inc?.(n, l));
const set = (ctx: unknown, n: string, v: number, l?: L) => safe(() => sinkOf(ctx)?.set?.(n, v, l));
const observe = (ctx: unknown, n: string, v: number, l?: L) => safe(() => sinkOf(ctx)?.observe?.(n, Math.max(0, v), l));

export type LoginOutcome = 'success' | 'failed' | 'step_up' | 'locked' | 'suspended' | 'inactive' | 'rate_limited' | 'ip_throttled' | 'ip_denied';
export type SessionResolveOutcome = 'ok' | 'refreshed' | 'expired' | 'revoked' | 'refresh_failed';

/** Login error code -> TRD §13 outcome (ip_throttled is decided by the caller: same error code as rate_limited). */
export function loginOutcomeOf(code: string | undefined): LoginOutcome {
  switch (code) {
    case 'auth.step_up_required': return 'step_up';
    case 'auth.account_locked': return 'locked';
    case 'identity.tenant_suspended': return 'suspended';
    case 'identity.membership_inactive': return 'inactive';
    case 'common.rate_limited': return 'rate_limited';
    case 'identity.platform_ip_denied': return 'ip_denied';
    default: return 'failed';
  }
}

export const idMetrics = {
  login: (ctx: unknown, outcome: LoginOutcome, kind: string) => inc(ctx, 'lims_identity_logins_total', { outcome, kind }),
  ipThrottlesActive: (ctx: unknown, n: number) => set(ctx, 'lims_identity_login_ip_throttles_active', n),
  stuffing: (ctx: unknown, accounts: number, ips: number) => {
    set(ctx, 'lims_identity_stuffing_distinct_accounts_15m', accounts);
    set(ctx, 'lims_identity_stuffing_distinct_ips_15m', ips);
  },
  tenantFailures5m: (ctx: unknown, tenantId: string, n: number) => set(ctx, 'lims_identity_login_failures_by_tenant_5m', n, { tenant_id: tenantId }),
  mfa: (ctx: unknown, outcome: 'success' | 'failed', flow: 'challenge' | 'enrol') => inc(ctx, 'lims_identity_mfa_verifications_total', { outcome, flow }),
  sessionResolve: (ctx: unknown, outcome: SessionResolveOutcome) => inc(ctx, 'lims_identity_session_resolves_total', { outcome }),
  claimsResolveSeconds: (ctx: unknown, s: number) => observe(ctx, 'lims_identity_claims_resolve_duration_seconds', s),
  authz: (ctx: unknown, outcome: string, privileged: boolean) => inc(ctx, 'lims_identity_authz_decisions_total', { outcome, privileged: String(privileged) }),
  gotrue: (ctx: unknown, op: string, outcome: 'ok' | 'rejected' | 'error', seconds: number) => {
    inc(ctx, 'lims_identity_gotrue_requests_total', { op, outcome });
    observe(ctx, 'lims_identity_gotrue_request_duration_seconds', seconds, { op, outcome });
  },
  auditExportsTenantDay: (ctx: unknown, tenantId: string, n: number) => set(ctx, 'lims_identity_audit_exports_tenant_day', n, { tenant_id: tenantId }),
  supportOpened: (ctx: unknown, scope: string) => inc(ctx, 'lims_identity_support_sessions_opened_total', { scope }),
  settingsCache: (ctx: unknown, result: 'hit' | 'miss') => inc(ctx, 'lims_identity_settings_cache_total', { result }),
  breachedListLoaded: (ctx: unknown, loaded: boolean) => set(ctx, 'lims_identity_breached_list_loaded', loaded ? 1 : 0),
  /** DB-sampled gauges (02-TRD §13: "sampled every 5 min"). The cross-tenant counts need a DEFINER that 05-SCHEMA §6 does not
   *  inventory: no caller until .orchestra/cr/C2.T28.md CR-C2-T28-002 lands. */
  sampled: (ctx: unknown, s: { activeSessions: Readonly<Record<string, number>>; supportSessionsActive: number }) => {
    for (const [kind, n] of Object.entries(s.activeSessions)) set(ctx, 'lims_identity_active_sessions', n, { kind });
    set(ctx, 'lims_identity_support_sessions_active', s.supportSessionsActive);
  },
};
