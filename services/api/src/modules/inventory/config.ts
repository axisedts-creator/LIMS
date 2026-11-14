// Configuration keys of 02-TRD §11 (env LIMS_INVENTORY_*; global). Fails fast naming the bad key.
export interface InventoryConfig {
  readonly reportMaxDays: number;
  readonly reportScreenRows: number;
  readonly exportMaxRows: number;
  readonly resolveBatch: number;
  readonly fixedCatchupDays: number;
  /** store-resolution steps enabled (§8.2); step 6 (unresolved) always applies */
  readonly resolutionSteps: readonly number[];
}

const posInt = (env: Record<string, string | undefined>, key: string, def: number): number => {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || !Number.isSafeInteger(Number(raw))) {
    throw new Error(`${key} must be a positive integer, got "${raw}"`);
  }
  return Number(raw);
};

const steps = (env: Record<string, string | undefined>, key: string, def: readonly number[]): readonly number[] => {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  const parts = raw.split(',').map((s) => s.trim());
  if (!parts.every((s) => /^[1-6]$/.test(s))) throw new Error(`${key} must be a comma list of steps 1-6, got "${raw}"`);
  return [...new Set(parts.map(Number))].sort((a, b) => a - b);
};

export async function loadInventoryConfig(env: Record<string, string | undefined> = process.env): Promise<InventoryConfig> {
  return {
    reportMaxDays: posInt(env, 'LIMS_INVENTORY_REPORT_MAX_DAYS', 366),
    reportScreenRows: posInt(env, 'LIMS_INVENTORY_REPORT_SCREEN_ROWS', 5000),
    exportMaxRows: posInt(env, 'LIMS_INVENTORY_EXPORT_MAX_ROWS', 50000),
    resolveBatch: posInt(env, 'LIMS_INVENTORY_RESOLVE_BATCH', 1000),
    fixedCatchupDays: posInt(env, 'LIMS_INVENTORY_FIXED_CATCHUP_DAYS', 7),
    resolutionSteps: steps(env, 'LIMS_INVENTORY_RESOLUTION_STEPS', [1, 2, 5]),
  };
}
