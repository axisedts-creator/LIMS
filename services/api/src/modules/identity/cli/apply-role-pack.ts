// Apply a role pack to one tenant (LD-141; spec/program/11-ROLE-MATRIX.md R6, §4 item 5). Run after tenant provisioning, safe to re-run.
// Runbook: `pnpm --filter @lims/api identity:apply-role-pack --tenant <tenant uuid> --pack <pack code>`.
// No HTTP operation (needs CR-C2-RM-001 to C0). Importing this file runs nothing.
import { pathToFileURL } from 'node:url';

export interface ApplyDeps {
  apply(tenantId: string, packCode: string): Promise<{ created: string[]; updated: string[]; unchanged: string[] }>;
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PACK = /^[a-z][a-z0-9_]{0,63}$/;
const USAGE = 'usage: identity:apply-role-pack --tenant <tenant uuid> --pack <pack code>\n';

class UsageError extends Error {}

function parseArgs(argv: string[]): { tenant: string; pack: string } {
  const seen: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^(--tenant|--pack)(?:=(.*))?$/s.exec(argv[i]!);
    if (!m) throw new UsageError();
    const value = m[2] ?? argv[++i];
    if (value === undefined || m[1]! in seen) throw new UsageError();
    seen[m[1]!] = value;
  }
  const tenant = seen['--tenant'] ?? '', pack = seen['--pack'] ?? '';
  if (!UUID.test(tenant) || !PACK.test(pack)) throw new UsageError();
  return { tenant, pack };
}

/** Exit codes: 0 ok (also when nothing changed), 1 failure, 2 usage. Errors print one bounded line, never a stack or an object dump. */
export async function main(argv: string[], deps: ApplyDeps): Promise<number> {
  let args: ReturnType<typeof parseArgs>;
  try { args = parseArgs(argv); } catch { deps.stderr.write(USAGE); return 2; }
  try {
    const r = await deps.apply(args.tenant, args.pack);
    deps.stdout.write(`role pack ${args.pack}: created=${r.created.length} updated=${r.updated.length} unchanged=${r.unchanged.length}\n`);
    return 0;
  } catch (e) {
    const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : 'unknown error';
    deps.stderr.write(`apply-role-pack failed: ${String(raw).split('\n')[0]!.slice(0, 200)}\n`);
    return 1;
  }
}

// Entry point only when executed directly. DB connection from the standard libpq PG* environment of the operator's shell.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { createDb } = await import('../../../core/db/tx.js');
  const { access } = await import('../../../core/audit/access.js');
  const { createRolePackService } = await import('../service/role-pack.service.js');
  // [CONV] uuidv7 relative import, same as bootstrap-platform-admin.
  const { uuidv7 } = await import('../../../../../../packages/shared-ts/src/uuidv7/index.js');
  const pg = (await import('pg' as string)).default as { Pool: new () => any };
  const pool = new pg.Pool();
  // [CONV] system actor = nil UUID (no system-actor id is configured for CLIs yet; open point in RM-T02-impl.md).
  const SYSTEM = '00000000-0000-0000-0000-000000000000';
  const svc = createRolePackService();
  const db = createDb({ pool } as any);
  try {
    process.exitCode = await main(process.argv.slice(2), {
      stdout: process.stdout, stderr: process.stderr,
      apply: (tenantId, packCode) => db.requestTx(
        { requestId: uuidv7(), clientIp: '127.0.0.1', operation: { module: 'identity', operationId: 'applyRolePack', context: 'cli' },
          claims: { sub: SYSTEM, actor_type: 'system', tenant_id: tenantId } as any },
        async (tx) => {
          const actor = { type: 'system', id: SYSTEM };
          const ctx = { tenantId, actor, requestId: uuidv7(), tx, audit: { access: (e: any) => access({ tenantId, actor, requestId: ctx.requestId, tx } as any, e) } };
          return (await svc.applyRolePack(ctx, { packCode })).body;
        }),
    });
  } finally { await pool.end(); }
}
