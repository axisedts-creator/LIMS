// Name only (never a value). Lives in core/storage so the credential-name scan (adapter.test.ts) keeps
// "only core/storage/** mentions it"; core/health.ts imports it for REQUIRED_ENV (T0B-OPSDOC-1, LD-277).
export const STORAGE_KEY_ENV = 'LIMS_CORE_STORAGE_KEY_FILE';
