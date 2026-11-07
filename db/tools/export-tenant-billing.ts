// Per-tenant export of the `billing` schema (AC-0B-6.4; 04 D16 / B17: billing isolatable per tenant). 07-SECURITY billing isolation checklist.
// Usage: DATABASE_URL=postgres://… node db/tools/export-tenant-billing.ts --tenant <uuid> [--out <file>]   (default out: stdout)
// Output: a data-only SQL script with every row of <tenant> from every billing table that has a tenant_id column, nothing of any other tenant.
//   Restore: psql -v ON_ERROR_STOP=1 -1 -f <file>  into a database whose `billing` tables exist and are empty (schema-qualified INSERTs;
//   generated columns are left to the target). Read-only on the source (default_transaction_read_only=on).
// Needs `psql` on PATH. Exit codes: 0 ok, 1 usage/validation (checked before any connection or file), 2 environment/DB failure (no output written).
// The connecting role must see the tenant's rows (owner/superuser or a role whose RLS admits the tenant), else the export is silently short.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const USAGE = "usage: DATABASE_URL=postgres://… node db/tools/export-tenant-billing.ts --tenant <uuid> [--out <file>]";
const fail = (code: number, msg: string): never => { console.error(`export-tenant-billing: ${msg}`); process.exit(code); };

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] ?? "" : undefined;
};
const tenant = arg("--tenant");
if (tenant === undefined) fail(1, `--tenant is required\n${USAGE}`);
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenant!)) fail(1, `--tenant must be a canonical UUID\n${USAGE}`);
const outArg = arg("--out");
if (outArg === "") fail(1, `--out needs a file name\n${USAGE}`);

const url = process.env.DATABASE_URL;
if (!url) fail(2, "DATABASE_URL is not set; a migrated database is required");

// Server-side generation: one INSERT per row via json_populate_record (exact types, no client-side quoting); tenant bound as a psql variable.
// ponytail: whole export held in memory, stream per table if a tenant's billing data outgrows that.
const q = String.raw`
SELECT format(E'-- export-tenant-billing: tenant %s, %s billing tables\n', :'tenant', count(*)) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
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
  env: { ...process.env, PGOPTIONS: `${process.env.PGOPTIONS ?? ""} -c default_transaction_read_only=on`.trim() },
});
if (r.error || r.status !== 0) {
  const why = r.error ? (r.error as NodeJS.ErrnoException).code === "ENOENT" ? "psql is not on PATH" : r.error.message : r.stderr;
  fail(2, `psql failed: ${why.split(url!).join("<DATABASE_URL>")}`);
}
const script = `${r.stdout.trimEnd()}\n`;
if (outArg === undefined) process.stdout.write(script);
else writeFileSync(resolve(outArg), script);
