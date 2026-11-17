// Shared bits of the instruments worker tasks (API-T14).
import type { JobContext } from '../../core/manifest.js';
import type { WorkerDeps } from '../../core/tasklist.js';

/** JobContext + the seams the T14 tasks need. `ports` and `metrics` are not on the C0 JobContext yet (.orchestra/cr/API-T14.md). */
export type Ctx = JobContext & {
  readonly metrics: WorkerDeps['metrics'];
  readonly ports: {
    readonly IdentityPort: { getTenantSettings(ctx: unknown, input: { keys: readonly string[] }): Promise<any> };
    readonly CatalogPort: { mapInstrumentCode(ctx: unknown, input: { instrumentId: string; direction: 'inbound'; instrumentCode: string }): Promise<{ analyteId: string }> };
  };
  readonly storage: { delete(bucket: string, objectPath: string): Promise<void> };
  readonly events: { publish(ctx: unknown, type: string, input: object): Promise<{ eventId: string; duplicate: boolean }> };
};

/** The tenant of a per-tenant job is the one of its claims; a payload naming another tenant is refused (REQ-SEC-024). */
export function jobTenant(payload: { tenant_id?: unknown }, ctx: JobContext): string {
  const t = ctx.tenantId;
  if (!t) throw new Error('instruments task: tenant claims required');
  if (payload?.tenant_id !== undefined && payload.tenant_id !== t) throw new Error('instruments task: payload tenant does not match the job claims');
  return t;
}

export const iso = (v: Date | string | null | undefined): string | null => (v === null || v === undefined ? null : new Date(v).toISOString());
