// T0B-DBFIX-1 — real-database test repair (no schema change). LD-230 (2026-11-15), faults (1), (2), (6 partly), (7), (8), (9).
// STATIC checks only: the lane has no Docker and cannot run SQL. The faults that need a database to prove (3) pgTAP call resolution,
// (4) audit_context_missing, (5) syntax near uuid / :=, (6) lock_reason / hmac_len / subquery rows are NOT covered here; the founder reruns the suites
// (see .orchestra/notes/T0B-DBFIX-1-tests.md). No test file may lose an assertion (baseline below measured on the unrepaired tree).
// Run: node --test tests/db/T0B-DBFIX-1.fixtures.test.mjs
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(join(REPO, p), "utf8");
const noComments = (s) => s.replace(/--.*$/gm, "");
const walk = (d, re, acc = []) => {
  for (const e of readdirSync(join(REPO, d), { withFileTypes: true })) {
    const p = `${d}/${e.name}`;
    if (e.isDirectory()) walk(p, re, acc);
    else if (re.test(e.name)) acc.push(p);
  }
  return acc.sort();
};
const SQL_TESTS = walk("db/tests", /\.test\.sql$/);

// ---- split helpers: top-level comma / tuple split that respects quotes and parentheses
function splitTop(s) {
  const out = [];
  let depth = 0, q = false, cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === "'") { if (s[i + 1] === "'") { cur += "'"; i++; } else q = false; } continue; }
    if (c === "'") { q = true; cur += c; continue; }
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const tuples = (valuesSql) => {
  const out = [];
  let depth = 0, q = false, start = -1;
  for (let i = 0; i < valuesSql.length; i++) {
    const c = valuesSql[i];
    if (q) { if (c === "'") { if (valuesSql[i + 1] === "'") i++; else q = false; } continue; }
    if (c === "'") { q = true; continue; }
    if (c === "(") { if (depth++ === 0) start = i + 1; }
    if (c === ")" && --depth === 0) out.push(valuesSql.slice(start, i));
  }
  return out;
};

// ---------------------------------------------------------------- (1) platform_staff role_code
describe("LD-230 (1): platform_staff fixtures use role codes the CHECK allows", () => {
  const mig = walk("db/migrations", /\.sql$/).map((f) => read(f)).join("\n");
  const m = [...mig.matchAll(/platform_staff__role_code__ck\s+CHECK\s*\(\s*role_code\s+IN\s*\(([^)]*)\)\s*\)/g)].pop();
  const ALLOWED = m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];

  it("the CHECK list is readable from the identity migration", () => {
    assert.deepEqual(ALLOWED.sort(), ["platform_superadmin", "platform_support"]);
  });

  it("no platform_admin role_code literal remains under db/tests (quoted, incl. inside jsonb expectations)", () => {
    const bad = SQL_TESTS.filter((f) => /['"]platform_admin['"]/.test(noComments(read(f))));
    assert.deepEqual(bad, [], `stale role_code 'platform_admin' (CHECK allows ${ALLOWED.join("|")}) in: ${bad.join(", ")}`);
  });

  it("every INSERT INTO identity.platform_staff fixture has a literal role_code from the CHECK list", () => {
    let inserts = 0, rows = 0;
    const bad = [];
    for (const f of SQL_TESTS) {
      const sql = noComments(read(f));
      for (const ins of sql.matchAll(/INSERT\s+INTO\s+identity\.platform_staff\s*\(([^)]*)\)\s*VALUES\s*([\s\S]*?);/gi)) {
        inserts++;
        const cols = ins[1].split(",").map((c) => c.trim());
        const ix = cols.indexOf("role_code");
        if (ix < 0) { bad.push(`${f}: platform_staff insert without role_code column`); continue; }
        for (const t of tuples(ins[2])) {
          rows++;
          const v = splitTop(t)[ix] ?? "";
          const lit = /^'([^']*)'$/.exec(v);
          if (!lit) bad.push(`${f}: role_code is not a literal (${v})`);
          else if (!ALLOWED.includes(lit[1])) bad.push(`${f}: role_code '${lit[1]}' not in CHECK list`);
        }
      }
      const all = (sql.match(/INSERT\s+INTO\s+identity\.platform_staff\b/gi) ?? []).length;
      const vals = (sql.match(/INSERT\s+INTO\s+identity\.platform_staff\s*\([^)]*\)\s*VALUES/gi) ?? []).length;
      if (all !== vals) bad.push(`${f}: ${all - vals} platform_staff insert(s) not in INSERT (cols) VALUES form: the test cannot read their role_code`);
    }
    assert.ok(inserts >= 9 && rows >= 15, `fixture parser found only ${inserts} inserts / ${rows} rows (parser or fixtures broken)`);
    assert.deepEqual(bad, []);
  });
});

// ---------------------------------------------------------------- (2) audit_log INSERT policy: fixture claims follow the row's tenant
describe("LD-230 (2): audit.audit_log owner_only policy: pg_temp.ins sets the claims of the row's tenant", () => {
  for (const f of ["db/tests/inventory/T0B-13.C12_behaviour.test.sql", "db/tests/partners/T0B-13.C13_behaviour.test.sql"]) {
    it(`${f}: pg_temp.ins sets request.jwt.claims from the row tenant_id before the INSERT`, () => {
      const sql = noComments(read(f));
      const m = /CREATE\s+FUNCTION\s+pg_temp\.ins\s*\([^)]*\)[\s\S]*?\$f\$([\s\S]*?)\$f\$/i.exec(sql);
      assert.ok(m, "pg_temp.ins(regclass, jsonb) not found");
      const body = m[1];
      const setIx = body.search(/set_config\s*\(\s*'request\.jwt\.claims'/i);
      const insIx = body.search(/EXECUTE\s+format\s*\(\s*'INSERT/i);
      assert.ok(setIx >= 0, "pg_temp.ins never sets request.jwt.claims: audit rows of tenant B are written under tenant A claims (RLS 42501)");
      assert.ok(setIx < insIx, "claims must be set BEFORE the INSERT executes");
      assert.match(body.slice(setIx, insIx), /tenant_id/, "claims must carry the tenant_id of the row being inserted");
      assert.match(body.slice(setIx, insIx), /\bsub\b/, "claims must carry a sub (actor) so audit triggers do not raise audit_context_missing");
    });
  }
});

// ---------------------------------------------------------------- (6, partly) tenant_settings NOT NULL legal_name_snapshot
describe("LD-230 (6): identity.tenant_settings fixture supplies legal_name_snapshot", () => {
  it("db/tests/identity/T0B-06_definers.test.sql inserts legal_name_snapshot", () => {
    const sql = noComments(read("db/tests/identity/T0B-06_definers.test.sql"));
    const ins = /INSERT\s+INTO\s+identity\.tenant_settings\s*\(([^)]*)\)/i.exec(sql);
    assert.ok(ins, "tenant_settings fixture insert not found");
    assert.match(ins[1], /\blegal_name_snapshot\b/);
  });
});

// ---------------------------------------------------------------- (7) generator + generated probes
describe("LD-230 (7): isolation probes use the table's real centre column", () => {
  const tablesYaml = (() => {
    const lib = read("db/tools/sql-lib.ts");
    assert.ok(lib.length > 0);
    return JSON.parse(read("db/meta/tables.yaml").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n")).tables;
  })();
  const probes = readdirSync(join(REPO, "db/tests/isolation")).filter((f) => /^[a-z_]+\.[a-z_]+\.test\.sql$/.test(f));

  it("generated files equal generator output (generated-files gate: --check exits 0)", () => {
    const r = spawnSync(process.execPath, ["db/tools/gen-isolation-probes.ts", "--check"], { cwd: REPO, encoding: "utf8" });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  });

  it("every *centre_id column a probe filters on exists in db/meta/tables.yaml columns of that table", () => {
    const bad = [];
    for (const f of probes) {
      const t = f.replace(/\.test\.sql$/, "");
      const cols = Object.keys(tablesYaml[t]?.columns ?? {});
      const body = read(`db/tests/isolation/${f}`).split("-- probe step 1: preconditions")[1] ?? "";
      for (const m of body.matchAll(/(?<![\w.])([a-z_]*centre_id)\s*=\s*pg_temp\.id\(/g)) if (!cols.includes(m[1])) bad.push(`${f}: ${m[1]}`);
    }
    assert.deepEqual([...new Set(bad)], [], "probe references a centre column the table does not have");
  });

  const SEVEN = ["manifest_lines", "manifests", "order_reports", "order_tracking", "pickup_request_manifests", "pickup_requests", "tracked_specimens"];
  for (const n of SEVEN)
    it(`partners.${n}: centre probes (step 1 and step 5) filter on receiving_centre_id`, () => {
      const body = read(`db/tests/isolation/partners.${n}.test.sql`).split("-- probe step 1: preconditions")[1];
      assert.match(body, /receiving_centre_id\s*=\s*pg_temp\.id\(''21''\)/);
      assert.match(body, /receiving_centre_id\s*=\s*pg_temp\.id\(''22''\)/);
      assert.doesNotMatch(body, /(?<![\w])centre_id\s*=/);
    });

  it("tables with a plain centre_id column keep centre_id (no regression)", () => {
    const body = read("db/tests/isolation/audit.audit_log.test.sql").split("-- probe step 1: preconditions")[1];
    assert.match(body, /(?<![\w])centre_id\s*=\s*pg_temp\.id\(''21''\)/);
  });
});

// ---------------------------------------------------------------- (8) storage stub in run-suites.sh
describe("LD-230 (8): run-suites.sh creates a minimal storage stub before the suites", () => {
  const sh = read("db/tests/run-suites.sh");
  const loopIx = sh.search(/for\s+s\s+in\s+"\$\{SUITES\[@\]\}"/);
  const stubIx = sh.search(/CREATE\s+SCHEMA\s+IF\s+NOT\s+EXISTS\s+storage/i);
  it("a CREATE SCHEMA IF NOT EXISTS storage step exists, after the container is ready and before the suite loop", () => {
    assert.ok(loopIx > 0, "suite loop not found");
    assert.ok(stubIx >= 0, "no storage stub step in run-suites.sh");
    assert.ok(stubIx < loopIx, "stub must run before the suite loop");
    assert.ok(stubIx > sh.indexOf("pg_isready"), "stub must run after the container accepts connections");
  });
  it("the stub is idempotent, runs as superuser (SU) and defines storage.buckets with id, name, public (columns T0B-12_storage.test.sql reads)", () => {
    const seg = sh.slice(Math.max(0, stubIx - 200), loopIx);
    assert.match(seg, /\bSU\b/, "the stub must run through the SU (supabase_admin) helper");
    assert.match(seg, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+storage\.buckets\s*\(/i);
    const def = /storage\.buckets\s*\(([\s\S]*?)\)\s*[;"']/i.exec(seg)?.[1] ?? "";
    for (const c of ["id", "name", "public"]) assert.match(def, new RegExp(`\\b${c}\\b`), `stub buckets lacks column ${c}`);
    assert.doesNotMatch(seg, /DROP\s+(SCHEMA|TABLE)[^;]*storage/i, "the stub must never drop a real storage schema");
  });
  it("the stub does not insert bucket rows (buckets are provisioned by the Storage API, LD-54)", () => {
    const seg = sh.slice(stubIx, loopIx);
    assert.doesNotMatch(seg, /INSERT\s+INTO\s+storage\./i);
  });
});

// ---------------------------------------------------------------- (9) stale expectations
describe("LD-230 (9): stale expectations", () => {
  it("roles test: the expected membership set includes lims_app|lims_migrator|false|true", () => {
    assert.match(noComments(read("db/tests/roles/00_bootstrap_roles.test.sql")), /'lims_app\|lims_migrator\|false\|true'/);
  });
  it("roles test: the existing membership entries are all still expected (nothing weakened)", () => {
    const s = read("db/tests/roles/00_bootstrap_roles.test.sql");
    for (const e of ["lims_app|lims_api|true|false", "lims_app|lims_worker|true|false", "lims_owner|lims_migrator|false|true", "lims_queue|lims_migrator|false|true", "lims_queue|lims_worker|true|false", "lims_reporting_lookup|lims_migrator|false|true"])
      assert.ok(s.includes(`'${e}'`), e);
  });
  it("helpers test: the lims_owner tables default-ACL assertion asserts that NO PUBLIC entry exists, not that a pg_default_acl row exists", () => {
    const sql = noComments(read("db/tests/app/T0B-02_helpers.test.sql"));
    const stmt = sql.split(";").find((s) => /default ACL for tables/i.test(s));
    assert.ok(stmt, "the 'default ACL for tables' assertion was removed");
    assert.doesNotMatch(stmt, /ok\s*\(\s*EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+pg_default_acl/i, "still requires a pg_default_acl row (PostgreSQL drops the row when the ACL equals the built-in default)");
    assert.match(stmt, /NOT\s+EXISTS|is_empty|is\s*\(/i);
    assert.match(stmt, /grantee\s*=\s*0/i, "must check that no PUBLIC (grantee 0) entry exists");
    assert.match(stmt, /pg_default_acl/i);
  });
});

// ---------------------------------------------------------------- no assertion lost / none made conditional
describe("LD-230 rules: no assertion removed, weakened by skipping, or hidden in a comment", () => {
  // measured on the unrepaired tree (comments stripped); the same counter runs below
  const BASELINE = {
    "definers/T0B-08_contracts_helpers.test.sql": 21, "definers/T0B-08_contracts_platform.test.sql": 6,
    "identity/AUTH-MFA-COMPLETE-1_platform_event.test.sql": 103, "identity/AUTH-PLATFORM-SESSION-1_platform_reads.test.sql": 100,
    "identity/SESSION-ACTOR-1_session_actor.test.sql": 55, "inventory/T0B-13.C12_behaviour.test.sql": 98, "partners/T0B-13.C13_behaviour.test.sql": 132,
    "engagement/T-A3_pre_acc.test.sql": 19, "engagement/T-OPS1_purge.test.sql": 66, "payments/T0B-13.C15_schema.test.sql": 99,
    "reporting/T0B-10.C6_behaviour.test.sql": 139, "reporting/C6-T43.a21.test.sql": 41, "engagement/T-A2_resolve_preauth.test.sql": 50,
    "engagement/T-Q3_resolve_display.test.sql": 34, "identity/T9-A38_platform_set_password.test.sql": 53, "engagement/T0B-13.C16_schema.test.sql": 94,
    "migration_staging/T0B-13.C18_behaviour.test.sql": 103, "identity/T0B-06_definers.test.sql": 204, "identity/T0B-10.C2_lookups.test.sql": 51,
    "identity/T0B-10.C2_maintenance.test.sql": 82, "core/T0B-03_audit.test.sql": 89, "roles/00_bootstrap_roles.test.sql": 38, "app/T0B-02_helpers.test.sql": 68,
  };
  const RE = /(?<![\w.])(ok|is|isnt|like|unlike|matches|doesnt_match|is_empty|isnt_empty|set_eq|bag_eq|set_has|bag_has|results_eq|results_ne|cmp_ok|pass|fail|throws_ok|lives_ok|performs_ok|isa_ok|is_strict|has_\w+|hasnt_\w+|col_\w+|fk_ok|function_\w+|table_privs_are|schema_privs_are|can)\s*\(/g;
  const SKIP = /(?<![\w.])(skip|todo_skip|todo)\s*\(|#\s*SKIP/gi;
  const SKIP_BASE = { "definers/T0B-08_contracts_helpers.test.sql": 1, "definers/T0B-08_contracts_platform.test.sql": 1, "core/T0B-03_audit.test.sql": 1 }; // already present (comments stripped)
  for (const [f, n] of Object.entries(BASELINE))
    it(`${f}: >= ${n} assertion calls, no new skip/todo`, () => {
      const sql = noComments(read(`db/tests/${f}`));
      assert.ok([...sql.matchAll(RE)].length >= n, `assertion count dropped below ${n}`);
      const skipsNow = [...sql.matchAll(SKIP)].length;
      assert.ok(skipsNow <= (SKIP_BASE[f] ?? 0), `skip/todo introduced (${skipsNow} > ${SKIP_BASE[f] ?? 0})`);
    });
});
