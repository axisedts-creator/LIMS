// Apply a role pack to one tenant (LD-141; spec/program/11-ROLE-MATRIX.md R6, §4 item 5). Run after tenant provisioning, safe to re-run.
// Runbook: `pnpm --filter @lims/api identity:apply-role-pack --tenant <tenant uuid> --pack <pack code>`.
// ADMINPACK-3 (LD-262, LD-254, LD-189): `--add-missing <role_code>` (repeatable) gives a role the lab ALREADY has the permissions its pack gained.
// It is a dry run unless `--yes` is given, additive only (nothing is ever removed), and touches only the named roles.
// ADMINPACK-4 (LD-265, LD-189): a refusal prints `refused: <reason> <role>`; the plain apply lists role codes; `--list` is a read-only look at the pack's roles in the lab
// (a SELECT, no audit, no write); a failing statement prints one `db:` line (SQLSTATE, schema.table, constraint; never message, detail or values).
// No HTTP operation (needs CR-C2-RM-001 to C0). Importing this file runs nothing.
import { pathToFileURL } from 'node:url';
import type { PackRoleRow } from '../service/role-pack.service.js';

export type AddMissingResult = Array<{ role_code: string; missing: string[]; extra: string[]; added: string[] }>;
export type ListRow = { role_code: string; in_lab: boolean; is_system_default: boolean; is_active: boolean; mfa_required: boolean; lab_permissions: number; pack_permissions: number; missing_in_lab: number };
export type DbDiag = { code?: string; schema?: string; table?: string; constraint?: string };
export interface ApplyDeps {
  apply(tenantId: string, packCode: string): Promise<{ created: string[]; updated: string[]; unchanged: string[] }>;
  /** LD-262: only called with --add-missing. yes=false is a dry run that writes nothing. */
  addMissing?(tenantId: string, packCode: string, roles: string[], yes: boolean): Promise<AddMissingResult>;
  /** LD-265: only called with --list. Read-only. */
  list?(tenantId: string, packCode: string): Promise<ListRow[]>;
  /** LD-265: SQLSTATE coordinates of the first failing statement, if any (see captureDbErrors). */
  dbDiag?(): DbDiag | undefined;
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PACK = /^[a-z][a-z0-9_]{0,63}$/;
const USAGE = 'usage: identity:apply-role-pack --tenant <tenant uuid> --pack <pack code> [--add-missing <role code>]... [--yes] | --list\n';

class UsageError extends Error {}

function parseArgs(argv: string[]): { tenant: string; pack: string; roles: string[]; yes: boolean; list: boolean } {
  const seen: Record<string, string> = {}, roles: string[] = [];
  let yes = false, list = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--yes') { if (yes) throw new UsageError(); yes = true; continue; }   // takes no value: `--yes=x` fails the match below
    if (a === '--list') { if (list) throw new UsageError(); list = true; continue; }   // takes no value: `--list=x` fails the match below
    const m = /^(--tenant|--pack|--add-missing)(?:=(.*))?$/s.exec(a);
    if (!m) throw new UsageError();
    const value = m[2] ?? argv[++i];
    if (value === undefined) throw new UsageError();
    if (m[1] === '--add-missing') { if (!PACK.test(value)) throw new UsageError(); roles.push(value); continue; }   // repeatable
    if (m[1]! in seen) throw new UsageError();
    seen[m[1]!] = value;
  }
  const tenant = seen['--tenant'] ?? '', pack = seen['--pack'] ?? '';
  if (!UUID.test(tenant) || !PACK.test(pack) || (yes && roles.length === 0) || (list && (yes || roles.length > 0))) throw new UsageError();
  return { tenant, pack, roles, yes, list };
}

const REASONS = new Set(['args', 'role_not_in_pack', 'role_missing_in_lab', 'role_is_system_default', 'unassignable_code', 'privileged_without_mfa']);
const yn = (b: boolean) => (b ? 'yes' : 'no');
const num = (n: unknown) => (Number.isSafeInteger(n) ? String(n) : '0');
const SQLSTATE = /^[0-9A-Z]{5}$/, IDENT = /^[A-Za-z0-9_]{1,63}$/;
const own = (e: unknown, k: string): unknown => (e !== null && typeof e === 'object' && Object.prototype.hasOwnProperty.call(e, k) ? (e as Record<string, unknown>)[k] : undefined);

/** What --list shows: one row per PACK role, in pack order; lab-only roles are never listed. Pure. */
export function describePackRoles(packRoles: ReadonlyArray<{ code: string; permissions: readonly string[] }>, labRoles: PackRoleRow[]): ListRow[] {
  return packRoles.map((pr) => {
    const want = new Set(pr.permissions), lr = labRoles.find((r) => r.code === pr.code);
    const has = new Set(lr?.permission_codes ?? []);
    return { role_code: pr.code, in_lab: !!lr, is_system_default: !!lr?.is_system_default, is_active: !!lr?.is_active, mfa_required: !!lr?.mfa_required,
      lab_permissions: has.size, pack_permissions: want.size, missing_in_lab: [...want].filter((c) => !has.has(c)).length };
  });
}

/** LD-265: wraps the tx handed to the service. On the FIRST failing statement records the pg SQLSTATE, schema, table, constraint (identifier-shaped only; never message,
 *  detail or values) before core/db/sqlstate.ts maps it, then rethrows the same error. The core tx is frozen, so the wrapper inherits from it instead of copying. */
export function captureDbErrors<T extends { query(...a: any[]): Promise<any> }>(tx: T): { tx: T; diag(): DbDiag | undefined } {
  let d: DbDiag | undefined;
  const wrapped = Object.create(tx, { query: { value: async (...a: unknown[]) => {
    try { return await tx.query(...a); } catch (e) {
      const f = (k: string, re: RegExp) => { const v = own(e, k) ?? (e as Record<string, unknown> | null)?.[k]; return typeof v === 'string' && re.test(v) ? v : undefined; };
      const code = f('code', SQLSTATE);
      if (!d && code) { d = { code }; for (const [k, v] of [['schema', f('schema', IDENT)], ['table', f('table', IDENT)], ['constraint', f('constraint', IDENT)]] as const) if (v) d[k] = v; }
      throw e;
    }
  } } }) as T;
  return { tx: wrapped, diag: () => d };
}

const list = (c: string[]) => (c.length ? c.join(', ') : '(none)');

/** Exit codes: 0 ok (also when nothing changed), 1 failure, 2 usage or refusal. Errors print one bounded line, never a stack or an object dump. */
export async function main(argv: string[], deps: ApplyDeps): Promise<number> {
  let args: ReturnType<typeof parseArgs>;
  try { args = parseArgs(argv); } catch { deps.stderr.write(USAGE); return 2; }
  try {
    if (args.list) {
      if (!deps.list) throw new Error('list is not available');
      const rows = await deps.list(args.tenant, args.pack);
      const out = [`role pack ${args.pack}: list, read-only, nothing written`];
      for (const r of rows) {
        const code = typeof r.role_code === 'string' && PACK.test(r.role_code) ? r.role_code : '-';   // never echo a raw code
        const f = (b: boolean) => (r.in_lab ? yn(!!b) : '-');
        out.push(`role ${code}: in_lab=${yn(!!r.in_lab)} is_system_default=${f(r.is_system_default)} is_active=${f(r.is_active)} mfa_required=${f(r.mfa_required)} lab_permissions=${num(r.lab_permissions)} pack_permissions=${num(r.pack_permissions)} missing_in_lab=${num(r.missing_in_lab)}`);
      }
      deps.stdout.write(out.join('\n') + '\n');
      return 0;
    }
    if (args.roles.length > 0) {
      if (!deps.addMissing) throw new Error('add-missing is not available');
      const res = await deps.addMissing(args.tenant, args.pack, args.roles, args.yes);
      const out = [args.yes ? `role pack ${args.pack}: --yes applied` : `role pack ${args.pack}: dry run, nothing written (repeat with --yes to apply)`];
      for (const r of res) {
        out.push(args.yes ? `role ${r.role_code}: added ${r.added.length}: ${list(r.added)}` : `role ${r.role_code}: would add ${r.missing.length}: ${list(r.missing)}`);
        out.push(`role ${r.role_code}: only in the lab, kept, never removed (${r.extra.length}): ${list(r.extra)}`);
      }
      deps.stdout.write(out.join('\n') + '\n');
      return 0;
    }
    const r = await deps.apply(args.tenant, args.pack);
    deps.stdout.write(`role pack ${args.pack}: created=${r.created.length} updated=${r.updated.length} unchanged=${r.unchanged.length}\ncreated: ${list(r.created)}\nupdated: ${list(r.updated)}\nunchanged: ${list(r.unchanged)}\n`);
    return 0;
  } catch (e) {
    const refusal = own(e, 'code') === 'common.validation_failed';
    const exit = (args.roles.length > 0 || args.list) && refusal ? 2 : 1;   // a refusal is a usage-type error
    const reason = own(e, 'reason'), role = own(e, 'role_code');
    if (refusal && typeof reason === 'string' && REASONS.has(reason)) {   // LD-265: the closed reason set; the role code only if it looks like one
      deps.stderr.write(`refused: ${reason}${typeof role === 'string' && PACK.test(role) ? ` ${role}` : ''}\n`);
      return exit;
    }
    const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : 'unknown error';
    deps.stderr.write(`apply-role-pack failed: ${String(raw).split('\n')[0]!.slice(0, 200)}\n`);
    try {   // LD-265: SQLSTATE coordinates only, re-validated here; a misbehaving dbDiag changes nothing
      const d = deps.dbDiag?.();
      if (typeof d?.code === 'string' && SQLSTATE.test(d.code)) {
        const v = (x: unknown) => (typeof x === 'string' && IDENT.test(x) ? x : '-');
        deps.stderr.write(`db: ${d.code} ${v(d.schema)}.${v(d.table)} ${v(d.constraint)}\n`);
      }
    } catch { /* ignore */ }
    return exit;
  }
}

// Entry point only when executed directly. DB connection from the standard libpq PG* environment of the operator's shell.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { createDb } = await import('../../../core/db/tx.js');
  const { access } = await import('../../../core/audit/access.js');
  const { createRolePackService, createRolePackRepo } = await import('../service/role-pack.service.js');
  const { loadRolePacks } = await import('../role-packs/loader.js');
  // [CONV] uuidv7 relative import, same as bootstrap-platform-admin.
  const { uuidv7 } = await import('../../../../../../packages/shared-ts/src/uuidv7/index.js');
  const pg = (await import('pg' as string)).default as { Pool: new () => any };
  const pool = new pg.Pool();
  // [CONV] system actor = nil UUID (no system-actor id is configured for CLIs yet; open point in RM-T02-impl.md).
  const SYSTEM = '00000000-0000-0000-0000-000000000000';
  const svc = createRolePackService();
  const repo = createRolePackRepo();
  let dbDiag: (() => DbDiag | undefined) | undefined;   // LD-265: the diag of the latest transaction
  const db = createDb({ pool } as any);
  // One transaction per run: a refusal or failure rolls everything back.
  const inTx = (tenantId: string, fn: (ctx: any) => Promise<{ body: any }>) => db.requestTx(
    { requestId: uuidv7(), clientIp: '127.0.0.1', operation: { module: 'identity', operationId: 'applyRolePack', context: 'cli' },
      claims: { sub: SYSTEM, actor_type: 'system', tenant_id: tenantId } as any },
    async (tx) => {
      const cap = captureDbErrors(tx); dbDiag = cap.diag;
      const actor = { type: 'system', id: SYSTEM };
      const ctx = { tenantId, actor, requestId: uuidv7(), tx: cap.tx, audit: { access: (e: any) => access({ tenantId, actor, requestId: ctx.requestId, tx: cap.tx } as any, e) } };
      return (await fn(ctx)).body;
    });
  try {
    process.exitCode = await main(process.argv.slice(2), {
      stdout: process.stdout, stderr: process.stderr,
      apply: (tenantId, packCode) => inTx(tenantId, (ctx) => svc.applyRolePack(ctx, { packCode })),
      dbDiag: () => dbDiag?.(),
      // LD-265 --list: a SELECT through the repo's listRoles; no audit call, no write.
      list: async (tenantId, packCode) => {
        const pack = loadRolePacks().packs.find((p: { code: string }) => p.code === packCode);
        if (!pack) throw Object.assign(new Error('common.validation_failed'), { code: 'common.validation_failed', reason: 'args' });
        return inTx(tenantId, async (ctx) => ({ body: describePackRoles(pack.roles, await repo.listRoles(ctx.tx, tenantId)) }));
      },
      addMissing: async (tenantId, packCode, roles, yes) => (await inTx(tenantId, (ctx) => svc.applyRolePack(ctx, { packCode }, { roles, yes }))).add_missing,
    });
  } finally { await pool.end(); }
}
