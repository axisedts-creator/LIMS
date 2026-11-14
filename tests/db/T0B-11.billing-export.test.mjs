// T0B-11 — per-tenant billing export/restore tool (db/tools/export-tenant-billing.ts). AC-0B-6.4; 04 D16 / B17 design rule; 05-SCHEMA §9 rule 5;
// 07-SECURITY §(billing isolation checklist). This file needs NO database and NO psql: it covers (1) the D16 design rule on the billing DDL
// (no sequences, tenant_id leads every key) and (2) the CLI's input-validation / fail-closed behaviour. The runtime half of AC-0B-6.4 (seeded A/B data,
// export A, restore into an empty billing schema, counts + checksums match, no B row) is db/tests/billing_isolatable/T0B-11_billing_isolatable.sh.
//
// CONTRACT for db/tools/export-tenant-billing.ts (tester-defined where the spec is silent; conventions of db/tools/policy-dump.ts):
//   DATABASE_URL=postgres://… node db/tools/export-tenant-billing.ts --tenant <uuid> [--out <file>]
//   --tenant  REQUIRED, a canonical UUID (8-4-4-4-12 hex). Validated BEFORE any connection or file write; anything else -> exit 1 (usage), nothing written.
//   --out     file to write the restore script to (default: stdout). Written only when the whole export succeeded (no partial file on failure).
//   Needs `psql` on PATH and DATABASE_URL (exit 2 when either is missing/fails: never succeeds silently, never writes output).
//   Output = a data-only SQL script for ONE tenant: restorable with `psql -v ON_ERROR_STOP=1 -1 -f <file>` into a database whose `billing` schema
//   holds the (empty) billing tables; contains every billing row of that tenant of every billing table that has tenant_id, and nothing of any other tenant.
//   Read-only against the source (no DDL/DML on it). Exit codes: 0 ok, 1 usage/validation, 2 environment/DB failure.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TOOL = join(REPO, "db/tools/export-tenant-billing.ts");
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const scratch = mkdtempSync(join(tmpdir(), "t0b11-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function run(args, env = {}) {
  const emptyBin = join(scratch, "nobin");   // PATH with no psql: any attempt to reach a DB must fail closed
  return spawnSync(process.execPath, [TOOL, ...args], {
    cwd: REPO, encoding: "utf8", timeout: 30000,
    env: { PATH: emptyBin, SystemRoot: process.env.SystemRoot ?? "", ...env },
  });
}

describe("billing DDL stays isolatable per tenant (04 D16; 05-SCHEMA §9 rule 5)", () => {
  const dir = join(REPO, "db/migrations");
  const tables = [];   // { name, body, file }
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    const text = readFileSync(join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
    for (const m of text.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(billing\.[a-z_0-9]+)\s*\(([\s\S]*?)\n\);/gi)) tables.push({ name: m[1], body: m[2], file: f });
    for (const m of text.matchAll(/CREATE SEQUENCE\s+(?:IF NOT EXISTS\s+)?billing\./gi)) tables.push({ name: "SEQUENCE", body: "", file: f });
  }
  it("finds the billing tables (sanity)", () => {
    assert.ok(tables.filter((t) => t.name !== "SEQUENCE").length >= 20, `only ${tables.length} billing tables parsed`);
  });
  it("no cross-tenant sequence, serial, identity or nextval in billing", () => {
    const bad = tables.filter((t) => t.name === "SEQUENCE" || /\b(?:small|big)?serial\b|GENERATED\s+(?:ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY|nextval\s*\(/i.test(t.body));
    assert.deepEqual(bad.map((t) => `${t.file}: ${t.name}`), []);
  });
  it("tenant_id leads every key of a tenant table: PRIMARY KEY (tenant_id, …) or PRIMARY KEY (id) + UNIQUE (tenant_id, id) (CV §5.3); UNIQUEs lead with tenant_id; g_* are global", () => {
    const bad = [];
    for (const t of tables.filter((x) => x.name !== "SEQUENCE" && !x.name.startsWith("billing.g_"))) {
      if (/\bPRIMARY\s+KEY\b(?!\s*\()/i.test(t.body) || /\bUNIQUE\b(?!\s*\()/i.test(t.body.replace(/\bUNIQUE\s+(?:NULLS|INDEX)/gi, "UNIQUE ("))) bad.push(`${t.name}: inline key`);
      for (const k of t.body.matchAll(/\b(PRIMARY\s+KEY|UNIQUE)\s*\(\s*([^),]+)/gi)) {
        const first = k[2].trim(), pk = /PRIMARY/i.test(k[1]);
        if (first === "tenant_id") continue;
        if (pk && first === "id" && /UNIQUE\s*\(\s*tenant_id\s*,\s*id\s*\)/i.test(t.body)) continue;   // uuidv7 id: no counter, composite FK target
        bad.push(`${t.name}: ${k[1]} starts with ${first}`);
      }
      if (!/\btenant_id\s+uuid\b/i.test(t.body)) bad.push(`${t.name}: no tenant_id uuid column`);
    }
    assert.deepEqual(bad, []);
  });
});

describe("export-tenant-billing CLI: validate first, fail closed (AC-0B-6.4)", () => {
  it("the tool exists", () => assert.ok(existsSync(TOOL), "db/tools/export-tenant-billing.ts is missing"));

  it("no --tenant -> exit 1, usage names --tenant, nothing on stdout", () => {
    const r = run([], { DATABASE_URL: "postgres://x@localhost/x" });
    assert.doesNotMatch(r.stderr, /Cannot find module/, "tool missing");
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /--tenant/);
    assert.equal(r.stdout, "");
  });

  for (const bad of ["A", "", "not-a-uuid", `${A}x`, `x${A}`, `${A}; DROP SCHEMA billing CASCADE`, `' OR '1'='1`, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa", "aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa", "gggggggg-gggg-4ggg-8ggg-gggggggggggg"]) {
    it(`--tenant ${JSON.stringify(bad)} -> exit 1 before any connection, no file, no stdout`, () => {
      const out = join(scratch, "bad.sql");
      const r = run(["--tenant", bad, "--out", out], { DATABASE_URL: "postgres://x@localhost/x" });
      assert.doesNotMatch(r.stderr, /Cannot find module/, "tool missing");
      assert.equal(r.status, 1, `exit ${r.status}: ${r.stderr}`);   // 1 (validation), not 2 (connection): validation precedes the DB
      assert.match(r.stderr, /tenant/i, "error must name the bad option");
      assert.equal(r.stdout, "");
      assert.equal(existsSync(out), false, "output file written for an invalid tenant");
    });
  }

  it("valid tenant, DATABASE_URL unset -> exit 2 naming DATABASE_URL; never succeeds silently, no file", () => {
    const out = join(scratch, "nourl.sql");
    const r = run(["--tenant", A, "--out", out]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /DATABASE_URL/);
    assert.equal(existsSync(out), false);
    assert.equal(r.stdout, "");
  });

  it("valid tenant, psql not on PATH -> exit 2, no file (no partial output)", () => {
    const out = join(scratch, "nopsql.sql");
    const r = run(["--tenant", A, "--out", out], { DATABASE_URL: "postgres://x@localhost:1/x" });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /psql/i);
    assert.equal(existsSync(out), false);
    assert.equal(r.stdout, "");
  });

  it("psql runs read-only AND with row_security=off (FORCE RLS must error, not silently shorten the export)", () => {
    const src = readFileSync(TOOL, "utf8");
    assert.match(src, /PGOPTIONS[^\n]*default_transaction_read_only=on/);
    assert.match(src, /PGOPTIONS[^\n]*row_security=off/);
  });

  it("the tenant id never leaks the DATABASE_URL password into stderr", () => {
    const r = run(["--tenant", A], { DATABASE_URL: "postgres://u:S3cretPw@localhost:1/x" });
    assert.equal(r.status, 2, `tool must fail closed (exit 2): ${r.stderr}`);
    assert.doesNotMatch(r.stderr + r.stdout, /S3cretPw/);
  });
});
