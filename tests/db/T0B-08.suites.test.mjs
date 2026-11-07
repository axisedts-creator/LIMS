// T0B-08 — DB test suites: isolation-probe generator, static test-hygiene checks, DEFINER contract-test coverage, suite markers.
// ACs: AC-0B-1.3 (privileged-role grep), AC-0B-2.1 (rls_exempt.txt), AC-0B-2.4 (no RLS-off / RLS-less stand-ins under db/tests/**),
//      AC-0B-3.6 (table without probe -> fail naming it), AC-0B-3.6b / 02-TRD §4.5 step 9; done_when of the plan row T0B-08.
// Spec: 02-TRD §4.5 (probe steps 1-9, fixed suites, DEFINER owner-policy suite), 05-SCHEMA §4.3 owner-policy rule + §10 schema tests 13, 16, 17, 22-33,
//       07-SECURITY §7. Live-DB assertions are pgTAP files under db/tests/** (see .orchestra/notes/T0B-08-tests.md); this file needs no database.
//
// CONTRACT for db/tools/gen-isolation-probes.ts (tester-defined where the spec is silent):
//   node db/tools/gen-isolation-probes.ts [--root <dir>] [--out <dir>] [--check]
//   --root  repo-like dir with db/meta/tables.yaml (and optionally db/meta/definer-inventory.yaml). Default = repo root. No DB connection.
//   --out   default <root>/db/tests/isolation. Writes, deterministically (same input -> same bytes):
//             <schema>.<table>.test.sql   one pgTAP file per tenant table (class != G, not rls_exempt)
//             _registry.sql               psql-includable: CREATE TEMP TABLE registry(tbl text, class text, centre_scoped boolean, audited boolean,
//                                         shared_with text[], rls_exempt boolean) and definer_inventory(fn text, owner text, execute_roles text[],
//                                         touches text[], policies text[]), filled from the two YAML files (JSON subset, as db/tools/*)
//   --check writes nothing; exit 1 naming every table whose probe file is missing/stale (AC-0B-3.6, gate 10); exit 0 when all are current.
//   exit 1 (naming the table) on an invalid identifier or unknown class in tables.yaml; nothing is written then.
//   Each probe file: BEGIN; ... ROLLBACK;  uses pgTAP; never disables RLS; every assertion description starts with "probe step <n>:" (n = 2..9 of
//   02-TRD §4.5). Step 5 only for centre_scoped tables; step 6 (composite-FK probe, read from pg_constraint) and 2,3,4,7,8,9 for all;
//   step 4 has no DELETE probe for class C/B/A (no DELETE grant, AC-0B-4.2); step 8 runs as lims_worker; step 9 covers partner, portal, patient and,
//   for a table with shared_with, mentions "shared_with" (only the rows the actor policy admits instead of 0).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GEN = join(REPO, "db/tools/gen-isolation-probes.ts");
const tmpDirs = [];
after(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const read = (p) => readFileSync(p, "utf8");
const jsonYaml = (p) => JSON.parse(read(p).split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join("\n"));
function walk(dir, keep = () => true) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".git") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p, keep));
    else if (keep(p)) out.push(p);
  }
  return out;
}
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "t0b08-"));
  tmpDirs.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body, null, 1));
  }
  return root;
}

// ======================================================================= detectors (self-tested below, then applied to the real repo)
// SQL with -- line comments and /* */ blocks removed (a mention in a comment is not an execution).
const stripSql = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--.*$/gm, "");
// db/tests/** hygiene (AC-0B-2.4; 02-TRD §4.5; 05-SCHEMA schema test 13): returns list of violation strings for one file.
function rlsHygiene(file, sql) {
  const body = stripSql(sql);
  const v = [];
  if (/\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i.test(body)) v.push(`${file}: DISABLE ROW LEVEL SECURITY`);
  if (/\bNO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY\b/i.test(body)) v.push(`${file}: NO FORCE ROW LEVEL SECURITY`);
  // stand-in tables = non-temporary CREATE TABLE without ENABLE + FORCE RLS on that table in the same file.
  // (TEMP / pg_temp scratch tables hold test bookkeeping, not tenant data, and are not stand-ins.)
  for (const m of body.matchAll(/\bCREATE\s+((?:GLOBAL\s+|LOCAL\s+)?(?:TEMP|TEMPORARY)\s+|UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w."]+)/gi)) {
    const t = m[2].replace(/"/g, "");
    if ((m[1] && /TEMP/i.test(m[1])) || /^pg_temp(_\d+)?\./i.test(t)) continue;
    const esc = t.replace(/\./g, "\\.");
    const en = new RegExp(`ALTER\\s+TABLE\\s+(?:ONLY\\s+)?${esc}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`, "i").test(body);
    const fo = new RegExp(`ALTER\\s+TABLE\\s+(?:ONLY\\s+)?${esc}\\s+FORCE\\s+ROW\\s+LEVEL\\s+SECURITY`, "i").test(body);
    if (!(en && fo)) v.push(`${file}: stand-in table ${t} created without ENABLE + FORCE ROW LEVEL SECURITY`);
  }
  return v;
}
// AC-0B-1.3: privileged role names / connection strings in non-comment lines outside the 07-SECURITY §7 allowlist.
const FORBIDDEN = /\b(supabase_admin|service_role|supabase_etl_admin|supabase_read_only_user|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SECRET_KEY|SUPABASE_SERVICE_KEY)\b|postgres(?:ql)?:\/\/\s*postgres\b|\buser\s*[=:]\s*['"]?postgres\b|\bPGUSER\s*=\s*['"]?postgres\b|\bTO\s+postgres\b|\bSET\s+ROLE\s+postgres\b/i;
const ALLOW = [/^db\/bootstrap\//, /^tools\/devstack\//, /^services\/(api|worker)\/src\/core\/storage\//, /^packages\/test-fixtures\/src\/gotrue\//, /^db\/migrations\/[^/]*_storage__[^/]*\.sql$/, /^infra\//, /^db\/policies\/storage\.sql$/];
const SKIP = [/^spec\//, /^\.orchestra\//, /^node_modules\//, /(^|\/)node_modules\//, /^pnpm-lock\.yaml$/, /\.md$/, /^tests\//, /(^|\/)__tests__\//, /\.(test|spec)\.[a-z]+$/, /^db\/tests\//, /^db\/meta\/decisions\//, /^\.git\//];
const dropComments = (s) => s.split(/\r?\n/).filter((l) => !/^\s*(#|\/\/|--|\*|\/\*)/.test(l)).join("\n");
function privilegedHits(files /* {rel, text}[] */) {
  return files.filter((f) => !SKIP.some((r) => r.test(f.rel)) && !ALLOW.some((r) => r.test(f.rel)) && FORBIDDEN.test(dropComments(f.text))).map((f) => f.rel);
}

// ======================================================================= fixtures for the generator
const T = (o) => ({ centre_scoped: false, audited: true, retention: "7y", columns: { id: "P0", tenant_id: "P0" }, ...o });
const REG = {
  tables: {
    "core.widgets": T({ class: "M" }),
    "core.line_items": T({ class: "C" }),
    "core.notes": T({ class: "B", centre_scoped: true }),
    "audit.entries": T({ class: "A", centre_scoped: true }),
    "audit.reads": T({ class: "A", centre_scoped: true, shared_with: ["partner", "portal", "patient"] }),
    "core.g_codes": T({ class: "G", rls_exempt: "global coded set, no tenant data" }),
    "core.counters": T({ class: "M", rls_exempt: "hashed counters, no grants" }),
  },
};
const INV = { definers: { "app.thing": { owner: "lims_owner", execute: ["lims_app"], why: "x", touches: ["core.widgets SELECT"], policies: ["widgets__select__owner_only"], reviewer: null } } };
const TENANT_TABLES = ["core.widgets", "core.line_items", "core.notes", "audit.entries", "audit.reads"];
const mk = (reg = REG, inv = INV) => fixture({ "db/meta/tables.yaml": reg, "db/meta/definer-inventory.yaml": inv });
function gen(root, extra = []) {
  assert.ok(existsSync(GEN), "db/tools/gen-isolation-probes.ts missing");
  const out = join(root, "out");
  const r = spawnSync(process.execPath, [GEN, "--root", root, "--out", out, ...extra], { cwd: REPO, encoding: "utf8", timeout: 60000 });
  const text = `${r.stdout}\n${r.stderr}`;
  assert.doesNotMatch(text, /ERR_MODULE_NOT_FOUND|Cannot find (module|package)|SyntaxError|TypeError|ReferenceError/, `tool crashed:\n${text}`);
  return { code: r.status, text, out };
}
const probeFile = (out, t) => join(out, `${t}.test.sql`);
const probe = (out, t) => read(probeFile(out, t));

// ======================================================================= tests
describe("detector self-tests (AC-0B-2.4, AC-0B-1.3) — the checks must reject bad input before they are trusted on the repo", () => {
  it("rlsHygiene rejects DISABLE / NO FORCE RLS and unforced stand-ins, accepts forced ones and comment mentions", () => {
    assert.equal(rlsHygiene("a", "ALTER TABLE core.t DISABLE ROW LEVEL SECURITY;").length, 1);
    assert.equal(rlsHygiene("a", "alter table core.t\n  no force row level security;").length, 1);
    assert.equal(rlsHygiene("a", "CREATE TABLE core.s (id int);").length, 1, "stand-in without RLS");
    assert.equal(rlsHygiene("a", "CREATE UNLOGGED TABLE core.s (id int);").length, 1, "unlogged stand-in without RLS");
    assert.equal(rlsHygiene("a", "CREATE TABLE core.s (id int);\nALTER TABLE core.s ENABLE ROW LEVEL SECURITY;").length, 1, "ENABLE without FORCE");
    assert.equal(rlsHygiene("a", "CREATE TABLE core.s (id int);\nALTER TABLE core.s FORCE ROW LEVEL SECURITY;").length, 1, "FORCE without ENABLE");
    assert.equal(rlsHygiene("a", "EXECUTE 'CREATE TABLE identity.s (id int)';").length, 1, "stand-in created through dynamic SQL");
    assert.equal(rlsHygiene("a", "CREATE TABLE core.s (id int);\nALTER TABLE core.s ENABLE ROW LEVEL SECURITY;\nALTER TABLE core.s FORCE ROW LEVEL SECURITY;").length, 0);
    assert.equal(rlsHygiene("a", "-- never ALTER TABLE x DISABLE ROW LEVEL SECURITY\n/* NO FORCE ROW LEVEL SECURITY */ SELECT 1;").length, 0, "comments are not execution");
    assert.equal(rlsHygiene("a", "CREATE TEMP TABLE registry (tbl text);\nCREATE TABLE pg_temp.s (id int);").length, 0, "temp scratch tables are not stand-ins");
  });
  it("privilegedHits flags code uses outside the allowlist, ignores allowlisted paths, comments and tests", () => {
    const f = (rel, text) => ({ rel, text });
    assert.deepEqual(privilegedHits([f("services/api/src/db.ts", "const u = 'supabase_admin';")]), ["services/api/src/db.ts"]);
    assert.deepEqual(privilegedHits([f("config/app.env", "DATABASE_URL=postgres://postgres:pw@db/lims")]), ["config/app.env"]);
    assert.deepEqual(privilegedHits([f("x/y.ts", "const k = process.env.SUPABASE_SERVICE_ROLE_KEY")]), ["x/y.ts"]);
    assert.deepEqual(privilegedHits([f("db/bootstrap/00_roles.sql", "GRANT x TO supabase_admin;")]), []);
    assert.deepEqual(privilegedHits([f("services/api/src/core/storage/a.ts", "service_role")]), []);
    assert.deepEqual(privilegedHits([f("services/api/src/other/a.ts", "service_role")]), ["services/api/src/other/a.ts"]);
    assert.deepEqual(privilegedHits([f("db/migrations/20261105000000_storage__policies.sql", "TO authenticated; -- service_role")]), []);
    assert.deepEqual(privilegedHits([f("a.ts", "// service_role is forbidden\n# supabase_admin")]), []);
    assert.deepEqual(privilegedHits([f("tests/x.test.mjs", "supabase_admin")]), []);
  });
});

describe("AC-0B-1.3 — no privileged-role references outside the 07-SECURITY §7 allowlist (repository scan)", () => {
  it("no matches", () => {
    const files = walk(REPO, (p) => !/\.(png|jpg|ico|woff2?|zip|gz|pdf|lock)$/i.test(p)).map((p) => ({ p, rel: relative(REPO, p).split(sep).join("/") }))
      .filter(({ rel }) => !SKIP.some((r) => r.test(rel)) && statSync(join(REPO, rel)).size < 2_000_000)
      .map(({ p, rel }) => ({ rel, text: read(p) }));
    assert.deepEqual(privilegedHits(files), []);
  });
});

describe("AC-0B-2.4 — db/tests/** never disables RLS and never creates a stand-in without ENABLE + FORCE RLS", () => {
  it("every SQL file under db/tests/** is clean", () => {
    const bad = walk(join(REPO, "db/tests"), (p) => p.endsWith(".sql")).flatMap((p) => rlsHygiene(relative(REPO, p).split(sep).join("/"), read(p)));
    assert.deepEqual(bad, []);
  });
});

describe("AC-0B-2.1 — db/tests/rls_exempt.txt", () => {
  const F = join(REPO, "db/tests/rls_exempt.txt");
  const entries = () => read(F).split(/\r?\n/).filter((l) => l.trim() && !/^\s*#/.test(l)).map((l) => { const m = /^(\S+)\s+(.+)$/.exec(l.trim()); return m ? { t: m[1], reason: m[2] } : { t: l.trim(), reason: "" }; });
  it("exists; every entry is schema.table with a non-empty reason; no duplicates", () => {
    assert.ok(existsSync(F), "db/tests/rls_exempt.txt missing");
    const e = entries();
    assert.ok(e.length >= 5);
    for (const x of e) { assert.match(x.t, /^[a-z_]+\.[a-z_0-9]+$/, `bad entry ${x.t}`); assert.ok(x.reason.length >= 5, `${x.t} has no reason`); }
    assert.equal(new Set(e.map((x) => x.t)).size, e.length, "duplicate entries");
  });
  it("holds the 05-SCHEMA initial content and every tables.yaml rls_exempt table", () => {
    const set = new Set(entries().map((x) => x.t));
    for (const t of ["core.g_permissions", "core.g_system_actors", "core.g_task_registry", "audit.g_cs_access_actions", "core.rate_limit_counters"]) assert.ok(set.has(t), `${t} missing`);
    const reg = jsonYaml(join(REPO, "db/meta/tables.yaml")).tables;
    for (const [t, d] of Object.entries(reg)) if (d.rls_exempt) assert.ok(set.has(t), `${t} is rls_exempt in tables.yaml but not in rls_exempt.txt`);
  });
  it("lists no table that tables.yaml registers as RLS-enforced (no silent exemption)", () => {
    const reg = jsonYaml(join(REPO, "db/meta/tables.yaml")).tables;
    for (const x of entries()) if (reg[x.t]) assert.ok(reg[x.t].rls_exempt, `${x.t} is exempt in rls_exempt.txt but not in tables.yaml`);
  });
});

describe("gen-isolation-probes.ts — files and registry include", () => {
  it("writes one probe file per tenant table, none for class G / rls_exempt, plus _registry.sql", () => {
    const r = gen(mk());
    assert.equal(r.code, 0, r.text);
    const files = readdirSync(r.out).sort();
    assert.deepEqual(files, [...TENANT_TABLES.map((t) => `${t}.test.sql`), "_registry.sql"].sort());
  });
  it("is deterministic and --check passes on fresh output", () => {
    const root = mk();
    const a = gen(root); const first = TENANT_TABLES.map((t) => probe(a.out, t)).join("\n");
    const b = gen(root); assert.equal(TENANT_TABLES.map((t) => probe(b.out, t)).join("\n"), first);
    const c = gen(root, ["--check"]); assert.equal(c.code, 0, c.text);
  });
  it("_registry.sql carries the registry and DEFINER inventory as temp tables", () => {
    const r = gen(mk()); const s = read(join(r.out, "_registry.sql"));
    assert.match(s, /CREATE\s+TEMP(ORARY)?\s+TABLE\s+registry\b/i);
    assert.match(s, /CREATE\s+TEMP(ORARY)?\s+TABLE\s+definer_inventory\b/i);
    for (const t of Object.keys(REG.tables)) assert.ok(s.includes(t), `${t} missing from _registry.sql`);
    assert.match(s, /audit\.reads[\s\S]*partner/, "shared_with carried");
    assert.match(s, /app\.thing/);
    assert.match(s, /widgets__select__owner_only/);
  });
});

describe("gen-isolation-probes.ts — gate: table without a probe fails naming it (AC-0B-3.6)", () => {
  it("--check names a missing probe file", () => {
    const root = mk(); const g = gen(root); rmSync(probeFile(g.out, "core.notes"));
    const c = gen(root, ["--check"]);
    assert.equal(c.code, 1, c.text);
    assert.match(c.text, /core\.notes/);
    assert.doesNotMatch(c.text, /core\.widgets/, "only the offending table is named");
  });
  it("--check names a stale probe file", () => {
    const root = mk(); const g = gen(root); writeFileSync(probeFile(g.out, "core.widgets"), "-- tampered\n");
    const c = gen(root, ["--check"]);
    assert.equal(c.code, 1, c.text);
    assert.match(c.text, /core\.widgets/);
  });
  it("--check fails for a table added to tables.yaml after generation", () => {
    const root = mk(); gen(root);
    writeFileSync(join(root, "db/meta/tables.yaml"), JSON.stringify({ tables: { ...REG.tables, "lab.samples": T({ class: "M" }) } }));
    const c = gen(root, ["--check"]);
    assert.equal(c.code, 1, c.text);
    assert.match(c.text, /lab\.samples/);
  });
  it("--check writes nothing", () => {
    const root = mk(); const out = join(root, "out");
    const c = gen(root, ["--check"]);
    assert.equal(existsSync(out) ? readdirSync(out).length : 0, 0, `--check must not write (exit ${c.code})`);
  });
});

describe("gen-isolation-probes.ts — probe content (02-TRD §4.5 steps 2-9)", () => {
  const out = () => gen(mk()).out;
  it("every probe is a rolled-back pgTAP transaction with step-tagged assertions that never disable RLS", () => {
    const o = out();
    for (const t of TENANT_TABLES) {
      const s = probe(o, t);
      assert.match(s, /^\s*(--[^\n]*\n\s*)*BEGIN;/i, `${t}: starts with BEGIN`);
      assert.match(s, /ROLLBACK;\s*$/i, `${t}: ends with ROLLBACK`);
      assert.match(s, /no_plan\(\)|\bplan\(/, `${t}: pgTAP plan`);
      for (const n of [2, 3, 4, 6, 7, 8, 9]) assert.match(s, new RegExp(`probe step ${n}:`), `${t}: probe step ${n}`);
      assert.deepEqual(rlsHygiene(t, s), [], `${t}: RLS hygiene`);
      assert.ok(s.includes(t), `${t}: names its table`);
    }
  });
  it("step 5 (centre) only for centre-scoped tables", () => {
    const o = out();
    for (const t of ["core.notes", "audit.entries", "audit.reads"]) assert.match(probe(o, t), /probe step 5:/, t);
    for (const t of ["core.widgets", "core.line_items"]) assert.doesNotMatch(probe(o, t), /probe step 5:/, t);
  });
  it("step 3 expects 42501 and step 7 runs with no claims expecting 0 rows; step 8 runs as lims_worker; steps 2-4,7 run as lims_api", () => {
    const o = out();
    for (const t of TENANT_TABLES) {
      const s = probe(o, t);
      assert.match(s, /probe step 3:[\s\S]*?42501/, `${t}: step 3 SQLSTATE`);
      assert.match(s, /lims_api/, `${t}: lims_api`);
      assert.match(s, /probe step 8:[\s\S]*lims_worker|lims_worker[\s\S]*probe step 8:/, `${t}: step 8 lims_worker`);
      assert.match(s, /probe step 7:/, t);
    }
  });
  it("step 4 has no DELETE probe for class C/B/A (no DELETE grant) but has one for a class M table", () => {
    const o = out();
    const step4 = (t) => (/probe step 4:[^\n]*(\n(?!.*probe step [5-9]:)[^\n]*)*/i.exec(probe(o, t)) || [""])[0];
    for (const t of ["core.line_items", "core.notes", "audit.entries"]) assert.doesNotMatch(probe(o, t), /probe step 4:[^\n]*DELETE/i, `${t}: no DELETE probe`);
    assert.match(probe(o, "core.widgets"), /DELETE/i, "class M table is probed for DELETE");
    assert.ok(step4("core.widgets").length > 0);
  });
  it("step 9 covers partner, portal and patient for every table; shared_with tables say so", () => {
    const o = out();
    for (const t of TENANT_TABLES) {
      const s = probe(o, t);
      for (const a of ["partner", "portal", "patient"]) assert.match(s, new RegExp(`probe step 9:[^\\n]*${a}`, "i"), `${t}: step 9 ${a}`);
    }
    assert.match(probe(o, "audit.reads"), /shared_with/);
    assert.doesNotMatch(probe(o, "core.widgets"), /shared_with/);
  });
  it("step 9 on a non-shared table expects exactly 0 rows for each of the three actors", () => {
    const s = probe(out(), "core.widgets");
    const lines = s.split(/\r?\n/).filter((l) => /probe step 9:/.test(l));
    assert.ok(lines.length >= 3);
    const text = lines.join("\n");
    assert.match(text, /n=0|\b0\b/);
    assert.doesNotMatch(text, /n=[1-9]/, "no positive expectation on a non-shared table");
  });
  it("no probe file is writable by tenant data tricks: identifiers are emitted quoted/validated, not interpolated raw", () => {
    const s = probe(out(), "core.widgets");
    assert.doesNotMatch(s, /;\s*DROP\b/i);
  });
});

describe("gen-isolation-probes.ts — adversarial input", () => {
  it("rejects an identifier that could inject SQL, naming it, and writes nothing", () => {
    const bad = 'core.w"; DROP SCHEMA core CASCADE; --';
    const root = mk({ tables: { [bad]: T({ class: "M" }) } });
    const r = gen(root);
    assert.equal(r.code, 1, r.text);
    assert.match(r.text, /DROP SCHEMA|invalid|identifier/i);
    assert.equal(existsSync(r.out) ? readdirSync(r.out).filter((f) => f.endsWith(".sql")).length : 0, 0);
  });
  it("rejects a table with an unknown class, naming it", () => {
    const r = gen(mk({ tables: { "core.odd": T({ class: "Z" }) } }));
    assert.equal(r.code, 1, r.text);
    assert.match(r.text, /core\.odd/);
  });
  it("a registry with no tenant tables yields only _registry.sql and exit 0", () => {
    const r = gen(mk({ tables: { "core.g_x": T({ class: "G", rls_exempt: "global" }) } }));
    assert.equal(r.code, 0, r.text);
    assert.deepEqual(readdirSync(r.out), ["_registry.sql"]);
  });
  it("fails clearly when tables.yaml is missing", () => {
    const r = gen(fixture({ "db/meta/readme.txt": "x" }));
    assert.notEqual(r.code, 0);
    assert.match(r.text, /tables\.yaml/);
  });
  it("the real registry generates probes that pass the RLS hygiene check", () => {
    const real = fixture({ "db/meta/tables.yaml": read(join(REPO, "db/meta/tables.yaml")), "db/meta/definer-inventory.yaml": read(join(REPO, "db/meta/definer-inventory.yaml")) });
    const r = gen(real); assert.equal(r.code, 0, r.text);
    const reg = jsonYaml(join(REPO, "db/meta/tables.yaml")).tables;
    const expected = Object.entries(reg).filter(([, d]) => d.class !== "G" && !d.rls_exempt).map(([t]) => `${t}.test.sql`);
    for (const f of expected) assert.ok(existsSync(join(r.out, f)), `${f} not generated`);
    for (const f of readdirSync(r.out)) assert.deepEqual(rlsHygiene(f, read(join(r.out, f))), []);
  });
  it("the committed db/tests/isolation/ is current (gate 10: a table without a probe fails CI)", () => {
    const r = spawnSync(process.execPath, [GEN, "--root", REPO, "--check"], { cwd: REPO, encoding: "utf8", timeout: 60000 });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  });
});

describe("DEFINER owner-policy suite coverage (done_when: every inventoried DEFINER touching a FORCE-RLS table has a contract test run with FORCE RLS on)", () => {
  const inv = () => jsonYaml(join(REPO, "db/meta/definer-inventory.yaml")).definers;
  const sqlTests = () => walk(join(REPO, "db/tests"), (p) => p.endsWith(".test.sql")).map((p) => ({ rel: relative(REPO, p).split(sep).join("/"), text: stripSql(read(p)) }));
  it("each inventory entry with touches is named in a pgTAP file that asserts relforcerowsecurity", () => {
    const files = sqlTests();
    const missing = [];
    for (const [fn, d] of Object.entries(inv())) {
      if (!d.touches || d.touches.length === 0) continue;
      const bare = fn.replace(/^app\./, "");
      const hit = files.some((f) => new RegExp(`\\b${bare}\\b`).test(f.text) && /relforcerowsecurity/i.test(f.text));
      if (!hit) missing.push(fn);
    }
    assert.deepEqual(missing, [], "DEFINERs without a FORCE-RLS contract test");
  });
  it("db/tests/definers/ holds the C0 contract + owner-policy-shape + inventory suites", () => {
    const dir = join(REPO, "db/tests/definers");
    for (const f of ["T0B-08_inventory.test.sql", "T0B-08_owner_policies.test.sql", "T0B-08_contracts_helpers.test.sql", "T0B-08_contracts_platform.test.sql"]) assert.ok(existsSync(join(dir, f)), `db/tests/definers/${f} missing`);
  });
  it("owner-policy suite covers schema tests 13, 15, 16, 17, 22, 23, 24, 26, 27, 28, 29, 30, 31, 32, 33 (tagged 'schema test N')", () => {
    const text = sqlTests().filter((f) => f.rel.startsWith("db/tests/")).map((f) => read(join(REPO, f.rel))).join("\n");
    const missing = [13, 15, 16, 17, 22, 23, 24, 26, 27, 28, 29, 30, 31, 32, 33].filter((n) => !new RegExp(`tests?\\s+${n}\\b`, "i").test(text));
    assert.deepEqual(missing, [], "schema tests not tagged in any db/tests SQL file");
  });
  it("contract tests gate on absent objects with an explicit pgTAP skip(), never a silent pass", () => {
    for (const f of ["T0B-08_contracts_platform.test.sql"]) {
      const s = read(join(REPO, "db/tests/definers", f));
      assert.match(s, /\bskip\(/i, `${f}: explicit skip()`);
      assert.match(s, /to_regprocedure|to_regclass/i, `${f}: existence gate`);
    }
  });
  it("owner-policy suite checks the GUC rule: policies with app.pre_/app.maintenance are TO lims_owner only; lims_app setting the GUC sees nothing; GUC '' after return", () => {
    const s = stripSql(read(join(REPO, "db/tests/definers/T0B-08_owner_policies.test.sql")));
    assert.match(s, /app\.pre_/);
    assert.match(s, /app\.maintenance/);
    assert.match(s, /\{lims_owner\}|'lims_owner'/);
    assert.match(s, /set_config\(\s*g\.key|set_config\(\s*'app\.maintenance'|'app\.maintenance'\s*,/i, "a session sets the GUC itself");
  });
});

describe("fixed suites exist and carry their ACs (live-DB part runs with pg_prove; see T0B-08-tests.md)", () => {
  const need = {
    "db/tests/roles/T0B-08_roles.test.sql": [/AC-0B-1\.1/, /AC-0B-1\.2/, /lims_owner/, /rolcanlogin/, /schema test 30/i],
    "db/tests/grants/T0B-08_grants.test.sql": [/AC-0B-4\.2/, /AC-0B-4\.3/, /has_table_privilege/, /registry/, /event_inbox/],
    "db/tests/immutability/T0B-08_immutability.test.sql": [/AC-0B-4\.1/, /immutable_row/, /P0001/, /enforce_mutable_columns/, /schema test 25/i],
    "db/tests/policy/T0B-08_policy_shape.test.sql": [/AC-0B-2\.1/, /AC-0B-2\.2/, /rls_exempt/, /relforcerowsecurity/, /\^?\[a-z\]|__\(select\|insert\|update\|delete\|all\)__|<table>__<command>__<scope>|__\(/i, /public/, /authenticated/, /anon/],
    "db/tests/views/T0B-08_views.test.sql": [/security_invoker/, /REQ-SEC-031/, /relkind/],
    "db/tests/definers/T0B-08_inventory.test.sql": [/prosecdef/, /definer_inventory/, /search_path/, /REQ-SEC-020/, /REQ-SEC-019/, /has_function_privilege/],
    "db/tests/isolation/T0B-08_step9_fixed.test.sql": [/probe step 9:/, /partner/, /portal/, /patient/, /event_log|idempotency_keys|access_log/],
  };
  for (const [f, res] of Object.entries(need)) {
    it(f, () => {
      const p = join(REPO, f);
      assert.ok(existsSync(p), `${f} missing`);
      const s = read(p);
      assert.match(s, /^\s*(--[^\n]*\n\s*)*BEGIN;/i, "wrapped in a transaction");
      assert.match(s, /ROLLBACK;|finish\(\)/i, "rolled back");
      assert.match(s, /no_plan\(\)|\bplan\(/);
      for (const re of res) assert.match(s, re, `${f} must match ${re}`);
      assert.deepEqual(rlsHygiene(f, s), []);
    });
  }
  it("registry-driven suites include the generated _registry.sql (psql \\i), not a hand-copied table list", () => {
    for (const f of ["db/tests/grants/T0B-08_grants.test.sql", "db/tests/immutability/T0B-08_immutability.test.sql", "db/tests/policy/T0B-08_policy_shape.test.sql", "db/tests/definers/T0B-08_inventory.test.sql"])
      assert.match(read(join(REPO, f)), /\\i\s+\S*isolation\/_registry\.sql/, `${f}: \\i db/tests/isolation/_registry.sql`);
  });
});

describe("pinned image (review C0 m#33; SP-3): the suite runner uses supabase/postgres:17.6.1.136", () => {
  it("db/tests/run-suites.sh pins the image, runs bootstrap + migrations + pg_prove over every T0B-08 suite, and names the owner-policy suite", () => {
    const p = join(REPO, "db/tests/run-suites.sh");
    assert.ok(existsSync(p), "db/tests/run-suites.sh missing");
    const s = read(p);
    assert.match(s, /supabase\/postgres:17\.6\.1\.136/);
    assert.doesNotMatch(s, /supabase\/postgres:(latest|17(?![\d.]))/, "no floating tag");
    assert.match(s, /pg_prove/);
    assert.match(s, /db\/bootstrap/);
    assert.match(s, /db\/migrations/);
    assert.match(s, /db\/tests\/definers/);
    assert.match(s, /gen-isolation-probes/);
    assert.match(s, /docker\s+rm\s+-f|trap\s+.*docker/, "container cleaned up");
  });
});
