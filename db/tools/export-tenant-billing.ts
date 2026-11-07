// Per-tenant export of the `billing` schema (AC-0B-6.4; 04 D16 / B17: billing isolatable per tenant). 07-SECURITY billing isolation checklist.
// Usage: DATABASE_URL=postgres://… node db/tools/export-tenant-billing.ts --tenant <uuid> [--out <file>]   (default out: stdout)
// Output: a data-only SQL script with every row of <tenant> from every billing table that has a tenant_id column, nothing of any other tenant.
//   Restore: psql -v ON_ERROR_STOP=1 -1 -f <file>  into a database whose `billing` tables exist and are empty (schema-qualified INSERTs;
//   generated columns are left to the target). The script starts with SET session_replication_role = replica, so the restoring role must be
//   superuser (or hold SET on that parameter), same as the test seed. Read-only on the source (default_transaction_read_only=on).
// Needs `psql` on PATH. Exit codes: 0 ok, 1 usage/validation (checked before any connection or file), 2 environment/DB failure (no output written).
// row_security=off: a role subject to RLS gets an error (exit 2) instead of a silently short export; use a BYPASSRLS/superuser role.
import { spawnSync } from "node:child_process";
import { writeFileSync, writeSync } from "node:fs";
import { resolve } from "node:path";

const USAGE = "usage: DATABASE_URL=postgres://… node db/tools/export-tenant-billing.ts --tenant <uuid> [--out <file>]";
const fail = async (code: number, msg: string): Promise<never> => {
  writeSync(2, `export-tenant-billing: ${msg}\n`);
  process.exitCode = code;
  await new Promise((r) => setImmediate(r));   // let pending async warning/stderr work settle: process.exit() mid-flight aborts libuv on Windows (0xC0000409)
  return process.exit(code);
};

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] ?? "" : undefined;
};
const tenant = arg("--tenant");
if (tenant === undefined) await fail(1, `--tenant is required\n${USAGE}`);
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenant!)) await fail(1,`--tenant must be a canonical UUID\n${USAGE}`);
const outArg = arg("--out");
if (outArg === "") await fail(1,`--out needs a file name\n${USAGE}`);

const url = process.env.DATABASE_URL;
if (!url) await fail(2,"DATABASE_URL is not set; a migrated database is required");

// Server-side generation: one INSERT per row via json_populate_record (exact types, no client-side quoting); tenant bound as a psql variable.
// ponytail: whole export held in memory, stream per table if a tenant's billing data outgrows that.
// First line: replica role skips FK checks and the immutability/numbering triggers on restore (rows go in table-name order; ledger self-refs).
const q = String.raw`
SELECT format(E'SET session_replication_role = replica;\n-- export-tenant-billing: tenant %s, %s billing tables\n', :'tenant', count(*)) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'billing' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
    AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped);
SELECT format('SELECT format(%L, row_to_json(x.*)::text) FROM billing.%I x WHERE x.tenant_id = %L::uuid ORDER BY 1',
              format('INSERT INTO billing.%I (%s) SELECT %s FROM json_populate_record(NULL::billing.%I, %%L);', c.relname, cols, cols, c.relname),
              c.relname, :'tenant')
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL (SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) AS cols FROM pg_attribute a
                      WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = '') k
  WHERE n.nspname = 'billing' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
    AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
  ORDER BY c.relname
\gexec
`;
const r = spawnSync("psql", [url!, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-v", `tenant=${tenant}`], {
  input: q, encoding: "utf8", maxBuffer: 1 << 30,
  env: { ...process.env, PGOPTIONS: `${process.env.PGOPTIONS ?? ""} -c default_transaction_read_only=on -c row_security=off`.trim() },
});
if (r.error || r.status !== 0) {
  const why = r.error ? (r.error as NodeJS.ErrnoException).code === "ENOENT" ? "psql is not on PATH" : r.error.message : r.stderr;
  await fail(2, `psql failed: ${why.split(url!).join("<DATABASE_URL>")}`);
}
const script = `${r.stdout.trimEnd()}\n`;
if (outArg === undefined) process.stdout.write(script);
else writeFileSync(resolve(outArg), script);
