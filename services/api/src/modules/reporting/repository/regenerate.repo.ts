// R9 regenerateReport statements (02-TRD §6.3 R9). REQ-SEC-024: tenant_id is bound explicitly in addition to RLS. Static SQL only; values are parameters.
import type { Tx } from './settings.repo.js';

export async function lockReport(tx: Tx, tenantId: string, reportId: string): Promise<{ id: string; state: string } | undefined> {
  return (await tx.query(`SELECT id, state FROM reporting.reports WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tenantId, reportId])).rows[0];
}

/** Tenant override row of a coded set, if any (is_active decides: an inactive override hides the global code, 02-CV §5.5). */
export async function tenantReason(tx: Tx, tenantId: string, setName: string, code: string): Promise<{ is_active: boolean } | undefined> {
  return (await tx.query(`SELECT is_active FROM reporting.cs_reasons WHERE tenant_id = $1 AND set_name = $2 AND code = $3`, [tenantId, setName, code])).rows[0];
}

export async function globalReason(tx: Tx, setName: string, code: string): Promise<{ is_active: boolean } | undefined> {
  return (await tx.query(`SELECT is_active FROM reporting.g_cs_reasons WHERE set_name = $1 AND code = $2`, [setName, code])).rows[0];
}

/** counter + 1 changes the content fingerprint (TRD §4.2); the oldest pending needs_assembly_since is kept. */
export async function bumpRegeneration(tx: Tx, tenantId: string, reportId: string, actorId: string): Promise<void> {
  await tx.query(`UPDATE reporting.reports SET regeneration_counter = regeneration_counter + 1, needs_assembly = true,
      needs_assembly_since = COALESCE(needs_assembly_since, now()), version = version + 1, updated_by = $3, updated_at = now()
    WHERE tenant_id = $1 AND id = $2`, [tenantId, reportId, actorId]);
}
