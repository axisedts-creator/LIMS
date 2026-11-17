// Deploy-time core.g_task_registry sync (02-TRD §7.7). Run as lims_migrator (C1 pipeline step, `pnpm dev:up`), never at worker
// runtime. Upserts every identifier and deactivates removed ones (is_active = false, never deleted, so queued jobs still resolve).
import { pathToFileURL } from 'node:url';
import type { RegistryEntry, WorkerDeps } from './tasklist.js';

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

// T0B-ASYNC-1 (audit RS-10; LD-277): the registry rows of EVERY worker manifest (the one list in ../manifests.ts) in one call.
// Lazy import: loading every jobs module validates the payments config (LIMS_PAYMENTS_*), which a plain syncRegistry caller does not need.
export async function syncAllManifests(client: SyncClient): Promise<{ upserted: number; deactivated: number }> {
  const [{ MANIFESTS }, { buildTaskList }] = await Promise.all([import(/* @vite-ignore */ MANIFESTS_MODULE) as Promise<typeof import('../manifests.js')>, import('./tasklist.js')]);
  return syncRegistry(client, buildTaskList(INERT_DEPS, MANIFESTS).registry);
}

const MANIFESTS_MODULE = '../manifests.js';   // not a static literal in import(): the bundler must not pull every jobs module into a plain syncRegistry import
// buildTaskList only wraps the handlers; nothing here runs at sync time (no task executes).
const noop = () => undefined;
const refuse = () => Promise.reject(new Error('registry-sync: no task runs'));
const INERT_DEPS: WorkerDeps = {
  db: { tx: refuse }, withTenantScope: refuse,
  systemActorOf: () => '', coreActorId: '',
  metrics: { inc: noop, set: noop, observe: noop },
  log: { child: () => INERT_DEPS.log, info: noop, warn: noop, error: noop },
  now: () => new Date(),
  events: undefined, core: undefined, storage: undefined, files: undefined, audit: undefined,
};

// CLI: `pnpm --filter @lims/worker registry-sync`. Connects as the migrator login (it must SET LOCAL ROLE lims_owner), never lims_worker.
// [CONV] LIMS_MIGRATOR_DATABASE_URL (prefix of the existing LIMS_MIGRATOR_PASSWORD); unset -> graphile-worker's DATABASE_URL / PG* fallback (tools/devstack/up.ts).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { makeWorkerUtils } = await import('graphile-worker');
  const connectionString = process.env.LIMS_MIGRATOR_DATABASE_URL || undefined;
  const utils = await makeWorkerUtils(connectionString ? { connectionString } : {});
  try {
    const r = await utils.withPgClient((c) => syncAllManifests(c as unknown as SyncClient));
    process.stdout.write(`registry-sync upserted ${r.upserted} deactivated ${r.deactivated}\n`);
  } catch (e) {
    process.exitCode = 1;
    process.stderr.write(`registry-sync failed: ${String((e as { code?: unknown }).code ?? '')} ${(e as Error).message}\n`);
  } finally {
    await utils.release();
  }
}
