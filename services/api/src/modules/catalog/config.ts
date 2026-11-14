// Typed LIMS_CATALOG_* config (02-TRD §11). All keys global, all optional; a bad value fails fast naming the key.
type Env = Readonly<Record<string, string | undefined>>;

const DEFAULTS = {
  cacheMaxEntries: 50000,
  cacheTtlSeconds: 600,
  importMaxBytes: 15728640,
  importMaxUncompressedBytes: 52428800,
  importMaxZipEntries: 200,
  importMaxCompressionRatio: 100,
  importMaxRows: 20000,
  importMaxIssues: 5000,
  importParseTimeoutMs: 60000,
  importTtlHours: 168,
  fileRetentionDays: 30,
  maxActiveImportsPerTenant: 2,
  panelMaxDepth: 4,
  formulaMaxChainDepth: 5,
  effectiveFromToleranceSeconds: 300,
  priceChangeWarnPct: 50,
} as const;

export type CatalogConfig = { readonly [K in keyof typeof DEFAULTS]: number };

/** cacheMaxEntries -> LIMS_CATALOG_CACHE_MAX_ENTRIES */
const envKey = (field: string): string => 'LIMS_CATALOG_' + field.replace(/[A-Z]/g, (c) => '_' + c).toUpperCase();

export function loadCatalogConfig(env: Env): CatalogConfig {
  const out: Record<string, number> = {};
  for (const [field, fallback] of Object.entries(DEFAULTS)) {
    const key = envKey(field);
    const v = env[key];
    if (v === undefined) {
      out[field] = fallback;
      continue;
    }
    if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v))) throw new Error(`config: ${key} must be a non-negative integer`);
    out[field] = Number(v);
  }
  return Object.freeze(out) as CatalogConfig;
}
