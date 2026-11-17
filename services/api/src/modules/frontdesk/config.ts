// Frontdesk env config, 02-TRD §11.1. Every key is LIMS_FRONTDESK_*; defaults as documented there.
type Env = Readonly<Record<string, string | undefined>>;

export interface FrontdeskConfig {
  readonly trfMaxBytes: number;
  readonly searchMaxResults: number;
  readonly approvalTtlMinutes: number;
  readonly trfDraftTtlHours: number;
  /** No default. Boot must fail when unset while the real PaymentProviderPort is registered (§11.1); enforced with B12. */
  readonly paymentResultUrl: string | undefined;
}

function positiveInt(env: Env, key: string, fallback: number): number {
  const v = env[key];
  if (v === undefined) return fallback;
  if (!/^[1-9]\d{0,9}$/.test(v)) throw new Error(`config: ${key} must be a positive integer`);
  return Number(v);
}

export function loadFrontdeskConfig(env: Env = process.env): FrontdeskConfig {
  return Object.freeze({
    trfMaxBytes: positiveInt(env, 'LIMS_FRONTDESK_TRF_MAX_BYTES', 15728640),
    searchMaxResults: positiveInt(env, 'LIMS_FRONTDESK_SEARCH_MAX_RESULTS', 20),
    approvalTtlMinutes: positiveInt(env, 'LIMS_FRONTDESK_APPROVAL_TTL_MINUTES', 15),
    trfDraftTtlHours: positiveInt(env, 'LIMS_FRONTDESK_TRF_DRAFT_TTL_HOURS', 24),
    paymentResultUrl: env.LIMS_FRONTDESK_PAYMENT_RESULT_URL || undefined,
  });
}
