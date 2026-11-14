// Billing env config (02-TRD §11.1). Read lazily on first use so import never throws (boot checks run in the core).
const int = (env: NodeJS.ProcessEnv, key: string, dflt: number): number => {
  const raw = env[key];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`config: ${key} must be a positive integer`);
  return n;
};

export interface BillingConfig {
  readonly cbmsMode: 'stub' | 'live';
  readonly counterLockTimeoutMs: number;
  readonly exportMaxRows: number;
  readonly exportPdfMaxRows: number;
  readonly exportTtlHours: number;
}

export function loadBillingConfig(env: NodeJS.ProcessEnv = process.env): BillingConfig {
  const mode = env.LIMS_BILLING_CBMS_MODE || 'stub';
  if (mode !== 'stub' && mode !== 'live') throw new Error('config: LIMS_BILLING_CBMS_MODE must be stub|live');
  // LiveCbmsClient does not exist yet: `live` is refused (02-TRD §11.1).
  if (mode === 'live') throw new Error('config: LIMS_BILLING_CBMS_MODE=live is refused until LiveCbmsClient exists');
  return Object.freeze({
    cbmsMode: mode,
    counterLockTimeoutMs: int(env, 'LIMS_BILLING_COUNTER_LOCK_TIMEOUT_MS', 3000),
    exportMaxRows: int(env, 'LIMS_BILLING_EXPORT_MAX_ROWS', 100000),
    exportPdfMaxRows: int(env, 'LIMS_BILLING_EXPORT_PDF_MAX_ROWS', 5000),
    exportTtlHours: int(env, 'LIMS_BILLING_EXPORT_TTL_HOURS', 24),
  });
}
