// Deploy-time core.g_task_registry sync (02-TRD §7.7). Run as lims_migrator (C1 pipeline step, `pnpm dev:up`), never at worker
// runtime. Upserts every identifier and deactivates removed ones (is_active = false, never deleted, so queued jobs still resolve).
import type { RegistryEntry } from './tasklist.js';

export interface SyncClient { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }

const UPSERT = `INSERT INTO core.g_task_registry (identifier, module, kind, scope, max_attempts, is_active)
  SELECT u.identifier, u.module, u.kind, u.scope, u.max_attempts, true
    FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::int[]) AS u(identifier, module, kind, scope, max_attempts)
  ON CONFLICT (identifier) DO UPDATE SET module = EXCLUDED.module, kind = EXCLUDED.kind, scope = EXCLUDED.scope,
    max_attempts = EXCLUDED.max_attempts, is_active = true, registered_at = now()`;

export async function syncRegistry(client: SyncClient, entries: readonly RegistryEntry[]): Promise<{ upserted: number; deactivated: number }> {
  const ids = entries.map((e) => e.identifier);
  if (new Set(ids).size !== ids.length) throw new Error('syncRegistry: duplicate identifiers');
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL ROLE lims_owner');
    await client.query('LOCK TABLE core.g_task_registry IN SHARE ROW EXCLUSIVE MODE');   // two deploys never interleave
    const existing = (await client.query('SELECT identifier, is_active FROM core.g_task_registry')).rows;
    const wanted = new Set(ids);
    const removed = existing.filter((r) => r.is_active && !wanted.has(r.identifier)).map((r) => String(r.identifier));
    await client.query(UPSERT, [ids, entries.map((e) => e.module), entries.map((e) => e.kind), entries.map((e) => e.scope), entries.map((e) => e.maxAttempts)]);
    if (removed.length > 0) await client.query('UPDATE core.g_task_registry SET is_active = false WHERE identifier = ANY($1::text[])', [removed]);
    await client.query('COMMIT');
    return { upserted: ids.length, deactivated: removed.length };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
}
