// T0B-07 — registry + scripted gate-9 checks. AC-0B-2.3 (policy-dump/pgcatalog diff: DB-only part NOT covered here), AC-0B-6.2, AC-0B-6.3,
// done_when: check-registry fails a staff-guard-less __tenant policy without shared_with + actor policy, and any uncast centre predicate.
// Spec: 02-TRD §4.1 / §4.2 / §4.3, 05-SCHEMA §3 / §4.1 / §9 rule 2, 08 A16.1, A17 P-16.
//
// CONTRACT the implementation must satisfy (tester-defined where the spec is silent; dispute via .orchestra/notes if wrong):
//   node db/tools/<tool>.ts [--root <dir>]      <tool> = check-migrations | check-registry | check-fk-dag
//   --root <dir>  repo-like dir holding db/migrations/*.sql, db/policies/*.sql, db/meta/*.yaml, db/tests/rls_exempt.txt.
//                 Default = repo root (the real db/). No DB connection: static (text) analysis of the files.
//   exit 0 = clean; exit 1 = >=1 violation, each printed (stdout or stderr) on a line naming the offending file/policy/table.
//   Fixture YAML is written as JSON (valid YAML 1.2). Shapes read by the tools:
//     tables.yaml : {"tables": {"<schema>.<table>": {"class":"M|C|B|A|G|...", "centre_scoped":bool, "audited":bool, "retention":str,
//                     "columns": {"<col>": "<phi_class P0..P3>"}, "shared_with":["partner"|"portal"|"patient"],
//                     "mandatory_column_exceptions":[...], "rls_exempt":"<reason>"}}}
//     dag.yaml    : {"allowed": {"<schema>": ["<schema it may reference>", ...]}}     (R3: downstream -> upstream only)
//   Policy names follow <table>__<cmd>__<actor> (tenant | tenant_centre | partner | portal | patient | owner_only).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TOOLS = join(REPO, "db/tools");
const tmpDirs = [];
after(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function run(tool, root) {
  const script = join(TOOLS, `${tool}.ts`);
  assert.ok(existsSync(script), `db/tools/${tool}.ts missing`);
  const args = [script, ...(root ? ["--root", root] : [])];
  const r = spawnSync(process.execPath, args, { cwd: REPO, encoding: "utf8", timeout: 60000 });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.doesNotMatch(out, /ERR_MODULE_NOT_FOUND|Cannot find (module|package)|SyntaxError|TypeError|ReferenceError/, `tool crashed:\n${out}`);
  return { code: r.status, out };
}
const accepts = (tool, root) => { const r = run(tool, root); assert.equal(r.code, 0, `expected exit 0, got ${r.code}:\n${r.out}`); };
function rejects(tool, root, mention, why) {
  const r = run(tool, root);
  assert.equal(r.code, 1, `expected exit 1 (${why}), got ${r.code}:\n${r.out}`);
  for (const m of [].concat(mention)) assert.match(r.out, m, `output must name ${m}:\n${r.out}`);
}
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "t0b07-"));
  tmpDirs.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body, null, 1));
  }
  return root;
}

// ---------------------------------------------------------------- shared good fixture pieces
const TABLES = (extra = {}) => ({
  tables: {
    "core.widgets": { class: "M", centre_scoped: false, audited: true, retention: "7y", columns: { id: "P0", tenant_id: "P0", name: "P0" }, ...extra },
  },
});
const DAG = { allowed: { core: [], catalog: ["core"], frontdesk: ["core", "catalog"], billing: ["core", "catalog", "frontdesk"], lab: ["core", "catalog", "frontdesk"], reporting: ["core", "lab"] } };
const GUARD = "(SELECT app.is_staff_or_system())";
const TENANT = `tenant_id = (SELECT app.current_tenant_id()) AND ${GUARD}`;
const GOOD_MIG = `-- T0B-07 fixture
SET LOCAL ROLE lims_owner;
CREATE TABLE core.widgets (
  id uuid NOT NULL, tenant_id uuid NOT NULL, name text NOT NULL,
  CONSTRAINT widgets__pk PRIMARY KEY (id),
  CONSTRAINT widgets__tenant_id_id__uq UNIQUE (tenant_id, id)
);
ALTER TABLE core.widgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.widgets FORCE ROW LEVEL SECURITY;
CREATE POLICY widgets__select__tenant ON core.widgets FOR SELECT TO lims_app USING (${TENANT});
GRANT SELECT ON core.widgets TO lims_app;
`;
const MIG = "db/migrations/20261201000000_core__create_widgets.sql";
const goodMigRoot = (extra = {}) =>
  fixture({ [MIG]: GOOD_MIG, "db/meta/tables.yaml": TABLES(), "db/meta/dag.yaml": DAG, "db/tests/rls_exempt.txt": "", ...extra });
const withMig = (name, sql, extra = {}) => goodMigRoot({ [`db/migrations/${name}`]: sql, ...extra });

// ================================================================ check-migrations (AC-0B-6.3, TRD §4.2 / §4.3 items 1–2, 4)
describe("check-migrations: fixture bad migrations rejected", () => {
  it("accepts the good fixture", () => accepts("check-migrations", goodMigRoot()));

  it("AC-0B-6.3: first statement not the owner role switch -> rejected", () => {
    const f = "20261201000100_core__create_gadgets.sql";
    const sql = GOOD_MIG.replace("SET LOCAL ROLE lims_owner;\n", "").replace(/widgets/g, "gadgets");
    rejects("check-migrations", withMig(f, sql, { "db/meta/tables.yaml": TABLES() }), [new RegExp(f), /owner/i], "no role switch");
  });
  it("AC-0B-6.3: a statement before the role switch -> rejected", () => {
    const f = "20261201000100_core__create_gadgets.sql";
    const sql = "SELECT 1;\n" + GOOD_MIG.replace(/widgets/g, "gadgets");
    rejects("check-migrations", withMig(f, sql), [new RegExp(f), /owner/i], "statement first");
  });
  it("transactional file using SET ROLE (session) instead of SET LOCAL ROLE -> rejected", () => {
    const f = "20261201000100_core__create_gadgets.sql";
    rejects("check-migrations", withMig(f, GOOD_MIG.replace("SET LOCAL ROLE", "SET ROLE").replace(/widgets/g, "gadgets")), [new RegExp(f), /owner|SET LOCAL/i], "SET ROLE in tx file");
  });
  it("bad file name (not <ts>_<schema>__<verb>_<object>.sql) -> rejected", () => {
    const f = "add_widgets.sql";
    rejects("check-migrations", withMig(f, GOOD_MIG.replace(/widgets/g, "gadgets")), [/add_widgets\.sql/, /name/i], "file name");
  });
  it("CREATE TYPE ... AS ENUM -> rejected", () => {
    const f = "20261201000100_core__create_kind.sql";
    rejects("check-migrations", withMig(f, "SET LOCAL ROLE lims_owner;\nCREATE TYPE core.kind AS ENUM ('a','b');\n"), [new RegExp(f), /enum/i], "enum");
  });
  for (const [label, clause] of [["USING (true)", "USING (true)"], ["WITH CHECK (true)", "WITH CHECK (true)"]]) {
    it(`${label} policy -> rejected (REQ-SEC-016)`, () => {
      const f = "20261201000100_core__open_widgets.sql";
      const sql = `SET LOCAL ROLE lims_owner;\nCREATE POLICY widgets__insert__open ON core.widgets FOR INSERT TO lims_app ${clause};\n`;
      rejects("check-migrations", withMig(f, sql), [new RegExp(f), /true/i], label);
    });
  }
  it("allowlisted exception identity.platform_staff__select__owner_only TO lims_owner USING (true) -> accepted", () => {
    const f = "20261201000100_identity__create_platform_staff.sql";
    const sql = `SET LOCAL ROLE lims_owner;
CREATE TABLE identity.platform_staff (id uuid NOT NULL, CONSTRAINT platform_staff__pk PRIMARY KEY (id));
ALTER TABLE identity.platform_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.platform_staff FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_staff__select__owner_only ON identity.platform_staff FOR SELECT TO lims_owner USING (true);
`;
    const meta = { tables: { ...TABLES().tables, "identity.platform_staff": { class: "G", rls_exempt: "platform table", columns: { id: "P0" } } } };
    accepts("check-migrations", withMig(f, sql, { "db/meta/tables.yaml": meta }));
  });
  for (const role of ["public", "anon", "authenticated"]) {
    it(`policy/grant TO ${role} on a module table -> rejected`, () => {
      const f = "20261201000100_core__grant_widgets.sql";
      rejects("check-migrations", withMig(f, `SET LOCAL ROLE lims_owner;\nGRANT SELECT ON core.widgets TO ${role};\n`), [new RegExp(f), new RegExp(role, "i")], role);
    });
  }
  it("SECURITY DEFINER without SET search_path = '' -> rejected", () => {
    const f = "20261201000100_app__create_fn.sql";
    const sql = "SET LOCAL ROLE lims_owner;\nCREATE FUNCTION app.fx() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;\n";
    rejects("check-migrations", withMig(f, sql), [new RegExp(f), /search_path/i], "definer w/o search_path");
  });
  it("SECURITY DEFINER with SET search_path = '' -> accepted", () => {
    const f = "20261201000100_app__create_fn.sql";
    const sql = "SET LOCAL ROLE lims_owner;\nCREATE FUNCTION app.fx() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ SELECT 1 $$;\n";
    accepts("check-migrations", withMig(f, sql));
  });
  for (const col of ["id", "tenant_id"]) {
    it(`DEFAULT on column ${col} -> rejected`, () => {
      const f = "20261201000100_core__create_gadgets.sql";
      const sql = GOOD_MIG.replace(/widgets/g, "gadgets").replace(`${col} uuid NOT NULL`, `${col} uuid NOT NULL DEFAULT gen_random_uuid()`);
      rejects("check-migrations", withMig(f, sql), [new RegExp(f), /default/i], `default ${col}`);
    });
  }
  it("table without tenant_id that is neither class G nor in rls_exempt.txt -> rejected", () => {
    const f = "20261201000100_core__create_loose.sql";
    const sql = "SET LOCAL ROLE lims_owner;\nCREATE TABLE core.loose (id uuid NOT NULL, note text);\nALTER TABLE core.loose ENABLE ROW LEVEL SECURITY;\nALTER TABLE core.loose FORCE ROW LEVEL SECURITY;\n";
    rejects("check-migrations", withMig(f, sql), [new RegExp(f), /tenant_id|loose/i], "no tenant_id");
  });
  it("GRANT DELETE to lims_app on a class C table -> rejected", () => {
    const f = "20261201000100_core__grant_delete.sql";
    const meta = { tables: { "core.widgets": { ...TABLES().tables["core.widgets"], class: "C" } } };
    rejects("check-migrations", withMig(f, "SET LOCAL ROLE lims_owner;\nGRANT DELETE ON core.widgets TO lims_app;\n", { "db/meta/tables.yaml": meta }), [new RegExp(f), /delete/i], "delete on C");
  });
  it("ALTER TABLE ... DISABLE ROW LEVEL SECURITY -> rejected", () => {
    const f = "20261201000100_core__disable_rls.sql";
    rejects("check-migrations", withMig(f, "SET LOCAL ROLE lims_owner;\nALTER TABLE core.widgets DISABLE ROW LEVEL SECURITY;\n"), [new RegExp(f), /row level security|rls/i], "disable rls");
  });
  it("new tenant table without ENABLE + FORCE RLS in the same file -> rejected", () => {
    const f = "20261201000100_core__create_gadgets.sql";
    const sql = GOOD_MIG.replace(/widgets/g, "gadgets").replace(/ALTER TABLE core\.gadgets (ENABLE|FORCE) ROW LEVEL SECURITY;\n/g, "");
    rejects("check-migrations", withMig(f, sql), [new RegExp(f), /rls|row level security|force/i], "no rls");
  });
  it("A16.1: uncast centre predicate `centre_id = ANY ((SELECT app.current_centre_ids()))` -> rejected", () => {
    const f = "20261201000100_core__centre_policy.sql";
    const sql = `SET LOCAL ROLE lims_owner;\nCREATE POLICY widgets__select__tenant_centre ON core.widgets FOR SELECT TO lims_app\n  USING (${TENANT} AND centre_id = ANY ((SELECT app.current_centre_ids())));\n`;
    rejects("check-migrations", withMig(f, sql), [new RegExp(f), /cast|centre/i], "uncast centre");
  });
  it("A16.1: cast form `= ANY ((SELECT app.current_centre_ids())::uuid[])` -> accepted", () => {
    const f = "20261201000100_core__centre_policy.sql";
    const sql = `SET LOCAL ROLE lims_owner;\nCREATE POLICY widgets__select__tenant_centre ON core.widgets FOR SELECT TO lims_app\n  USING (${TENANT} AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]));\n`;
    accepts("check-migrations", withMig(f, sql));
  });
  it("DROP without the cr-approved-breaking label -> rejected; with the label -> accepted", () => {
    const f = "20261201000100_core__drop_widgets.sql";
    rejects("check-migrations", withMig(f, "SET LOCAL ROLE lims_owner;\nDROP TABLE core.widgets;\n"), [new RegExp(f), /drop/i], "drop");
    accepts("check-migrations", withMig(f, "-- cr-approved-breaking\nSET LOCAL ROLE lims_owner;\nDROP TABLE core.widgets;\n"));
  });
  it("REQ-SEC-038: reference to the auth schema from a module schema -> rejected", () => {
    const f = "20261201000100_core__create_view.sql";
    const sql = "SET LOCAL ROLE lims_owner;\nCREATE VIEW core.v AS SELECT id FROM auth.users;\n";
    rejects("check-migrations", withMig(f, sql), [new RegExp(f), /auth/i], "auth.");
  });
  describe("CREATE INDEX CONCURRENTLY (non-transactional file)", () => {
    const idx = "CREATE INDEX CONCURRENTLY widgets__tenant_id_name__idx ON core.widgets (tenant_id, name);\n";
    const f = "20261201000100_core__index_widgets_name.sql";
    it("`SET ROLE lims_owner;` + exactly one CONCURRENTLY statement -> accepted", () => accepts("check-migrations", withMig(f, `SET ROLE lims_owner;\n${idx}`)));
    it("CONCURRENTLY under SET LOCAL ROLE -> rejected", () => rejects("check-migrations", withMig(f, `SET LOCAL ROLE lims_owner;\n${idx}`), [new RegExp(f), /concurrently|SET ROLE/i], "local"));
    it("two statements in a CONCURRENTLY file -> rejected", () => rejects("check-migrations", withMig(f, `SET ROLE lims_owner;\n${idx}${idx.replace("name__idx", "name2__idx")}`), [new RegExp(f), /concurrently|alone|one/i], "two"));
    it("CONCURRENTLY mixed with DDL -> rejected", () => rejects("check-migrations", withMig(f, `SET ROLE lims_owner;\nALTER TABLE core.widgets ADD COLUMN x int;\n${idx}`), [new RegExp(f), /concurrently|alone|one/i], "mixed"));
    it("CONCURRENTLY file in the same PR needs a DROP INDEX CONCURRENTLY IF EXISTS recovery file (03-APP-FLOW)", () => {
      const r = run("check-migrations", withMig(f, `SET ROLE lims_owner;\n${idx}`));
      assert.equal(r.code, 0, "recovery pattern is only checked across files of the same PR; a lone index file must not fail by itself");
    });
  });
  it("real db/migrations pass gate-9 scripted checks", () => accepts("check-migrations"));
});

// ================================================================ check-fk-dag (AC-0B-6.2)
describe("check-fk-dag: R3 direction + no FK into billing", () => {
  const mk = (schema, table, ref) => `SET LOCAL ROLE lims_owner;
CREATE TABLE ${schema}.${table} (
  id uuid NOT NULL, tenant_id uuid NOT NULL, ref_id uuid,
  CONSTRAINT ${table}__pk PRIMARY KEY (id),
  CONSTRAINT ${table}__ref__fk FOREIGN KEY (tenant_id, ref_id) REFERENCES ${ref} (tenant_id, id)
);
`;
  const root = (schema, table, ref, ts = "20261201000200") =>
    fixture({ "db/meta/dag.yaml": DAG, [`db/migrations/${ts}_${schema}__create_${table}.sql`]: mk(schema, table, ref) });
  it("downstream -> upstream FK (frontdesk -> core) accepted", () => accepts("check-fk-dag", root("frontdesk", "orders", "core.widgets")));
  it("same-schema FK accepted", () => accepts("check-fk-dag", root("lab", "results", "lab.samples")));
  it("upstream -> downstream FK (core -> frontdesk) rejected", () =>
    rejects("check-fk-dag", root("core", "bad_up", "frontdesk.orders"), [/core\.bad_up/, /frontdesk/], "reverse"));
  it("sibling-order violation (lab -> reporting) rejected", () =>
    rejects("check-fk-dag", root("lab", "bad_down", "reporting.reports"), [/lab\.bad_down/, /reporting/], "lab->reporting"));
  it("any FK into billing (even lab -> billing, allowed order-wise) rejected (CV §5.4)", () => {
    const dag = { allowed: { ...DAG.allowed, lab: ["core", "catalog", "frontdesk", "billing"] } };
    const r = fixture({ "db/meta/dag.yaml": dag, "db/migrations/20261201000200_lab__create_x.sql": mk("lab", "x", "billing.invoices") });
    rejects("check-fk-dag", r, [/lab\.x/, /billing/], "into billing");
  });
  it("FK added via ALTER TABLE ... ADD CONSTRAINT is checked too", () => {
    const sql = "SET LOCAL ROLE lims_owner;\nALTER TABLE core.widgets ADD CONSTRAINT w__fk FOREIGN KEY (tenant_id, ref_id) REFERENCES frontdesk.orders (tenant_id, id);\n";
    rejects("check-fk-dag", fixture({ "db/meta/dag.yaml": DAG, "db/migrations/20261201000200_core__add_fk.sql": sql }), [/core\.widgets/, /frontdesk/], "alter fk");
  });
  it("real db/migrations respect db/meta/dag.yaml", () => accepts("check-fk-dag"));
});

// ================================================================ check-registry (done_when; 08 A16.1, A17 P-16, REQ-SEC-004)
describe("check-registry: staff guard, shared_with + actor policy, centre cast", () => {
  const pol = (body) => `-- fixture\n${body}\n`;
  const sel = (name, pred) => `CREATE POLICY ${name} ON core.widgets FOR SELECT TO lims_app\n  USING (${pred});`;
  const ins = (name, pred) => `CREATE POLICY ${name} ON core.widgets FOR INSERT TO lims_app\n  WITH CHECK (${pred});`;
  const rootOf = (policies, tables = TABLES()) =>
    fixture({ "db/policies/core.sql": pol(policies), "db/meta/tables.yaml": tables, "db/meta/dag.yaml": DAG, [MIG]: GOOD_MIG });
  const ACTOR = (a) => `tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = '${a}'`;

  it("guarded __tenant policies accepted", () =>
    accepts("check-registry", rootOf(sel("widgets__select__tenant", TENANT) + "\n" + ins("widgets__insert__tenant", TENANT))));
  it("__tenant policy with no staff guard, not shared_with -> rejected", () =>
    rejects("check-registry", rootOf(sel("widgets__select__tenant", "tenant_id = (SELECT app.current_tenant_id())")), [/widgets__select__tenant/, /staff|is_staff_or_system/i], "no guard"));
  it("guard present in USING but missing from WITH CHECK (qual or with_check) -> rejected", () =>
    rejects("check-registry", rootOf(`CREATE POLICY widgets__update__tenant ON core.widgets FOR UPDATE TO lims_app\n  USING (${TENANT})\n  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));`), [/widgets__update__tenant/, /staff|is_staff_or_system/i], "check only"));
  it("guard only in WITH CHECK, not in USING -> rejected", () =>
    rejects("check-registry", rootOf(`CREATE POLICY widgets__update__tenant ON core.widgets FOR UPDATE TO lims_app\n  USING (tenant_id = (SELECT app.current_tenant_id()))\n  WITH CHECK (${TENANT});`), [/widgets__update__tenant/, /staff|is_staff_or_system/i], "using only"));
  it("guard-less __tenant, shared_with [partner] but NO __partner policy -> rejected", () =>
    rejects("check-registry", rootOf(ins("widgets__insert__tenant", "tenant_id = (SELECT app.current_tenant_id())"), TABLES({ shared_with: ["partner"] })), [/widgets/, /partner/i], "missing actor policy"));
  it("guard-less __tenant, shared_with [partner] + matching __partner policy -> accepted", () =>
    accepts("check-registry", rootOf(ins("widgets__insert__tenant", "tenant_id = (SELECT app.current_tenant_id())") + "\n" + ins("widgets__insert__partner", ACTOR("partner")), TABLES({ shared_with: ["partner"] }))));
  it("shared_with [partner, portal] with only the __partner policy -> rejected for the missing __portal", () =>
    rejects("check-registry", rootOf(ins("widgets__insert__tenant", "tenant_id = (SELECT app.current_tenant_id())") + "\n" + ins("widgets__insert__partner", ACTOR("partner")), TABLES({ shared_with: ["partner", "portal"] })), [/portal/i], "partial actor set"));
  it("guard-less __tenant_centre policy -> rejected", () =>
    rejects("check-registry", rootOf(sel("widgets__select__tenant_centre", "tenant_id = (SELECT app.current_tenant_id()) AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])"), TABLES({ centre_scoped: true })), [/widgets__select__tenant_centre/, /staff|is_staff_or_system/i], "centre no guard"));
  it("guarded + cast __tenant_centre policy accepted", () =>
    accepts("check-registry", rootOf(sel("widgets__select__tenant_centre", `${TENANT} AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])`), TABLES({ centre_scoped: true }))));
  it("uncast centre predicate (08 A16.1) -> rejected even when guarded", () =>
    rejects("check-registry", rootOf(sel("widgets__select__tenant_centre", `${TENANT} AND centre_id = ANY ((SELECT app.current_centre_ids()))`), TABLES({ centre_scoped: true })), [/widgets__select__tenant_centre/, /cast|centre/i], "uncast"));
  it("uncast centre predicate on a non-__tenant policy name is still rejected", () =>
    rejects("check-registry", rootOf(sel("widgets__select__owner_only", "centre_id = ANY ((SELECT app.current_centre_ids()))")), [/widgets__select__owner_only/, /cast|centre/i], "uncast any policy"));
  it("whitespace/newline variants of the uncast form are still rejected", () =>
    rejects("check-registry", rootOf(sel("widgets__select__tenant_centre", `${TENANT}\n AND centre_id   =  ANY(\n (SELECT app.current_centre_ids())\n)`), TABLES({ centre_scoped: true })), [/widgets__select__tenant_centre/], "uncast variant"));
  it("REQ-SEC-004: column without phi_class in tables.yaml -> rejected", () =>
    rejects("check-registry", rootOf(sel("widgets__select__tenant", TENANT), TABLES({ columns: { id: "P0", tenant_id: "P0" } })), [/core\.widgets/, /phi|name/i], "missing phi"));
  it("table with policies but absent from tables.yaml -> rejected", () =>
    rejects("check-registry", rootOf(sel("widgets__select__tenant", TENANT), { tables: {} }), [/core\.widgets/], "unregistered"));
  it("real repo: db/meta/tables.yaml + db/policies/*.sql pass check-registry", () => accepts("check-registry"));
});

// ================================================================ registry files + policy-dump (static)
describe("db/meta registry files and policy-dump", () => {
  const meta = (f) => { const p = join(REPO, "db/meta", f); assert.ok(existsSync(p), `db/meta/${f} missing`); return readFileSync(p, "utf8"); };
  it("dag.yaml lists the R3 chain core -> catalog -> frontdesk/billing -> lab -> instruments -> reporting -> analytics", () => {
    const t = meta("dag.yaml");
    for (const s of ["core", "catalog", "frontdesk", "billing", "lab", "instruments", "reporting", "analytics"]) assert.match(t, new RegExp(`\\b${s}\\b`), s);
  });
  it("system-actors.yaml: `core` present, every actor id a unique UUIDv7", () => {
    const t = meta("system-actors.yaml");
    assert.match(t, /\bcore\b/);
    const ids = t.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
    assert.ok(ids.length >= 2, "expected >= 2 actor ids");
    for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, `not UUIDv7: ${id}`);
    assert.equal(new Set(ids.map((i) => i.toLowerCase())).size, ids.length, "duplicate actor id");
  });
  it("tables.yaml registers every CREATE TABLE of db/migrations (REQ-SEC-004 / gate 9 item 3)", () => {
    const t = meta("tables.yaml");
    const dir = join(REPO, "db/migrations");
    const missing = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql"))) {
      for (const m of readFileSync(join(dir, f), "utf8").matchAll(/^\s*CREATE TABLE\s+(?:IF NOT EXISTS\s+)?([a-z_]+\.[a-z_0-9]+)/gim)) if (!t.includes(m[1])) missing.push(`${m[1]} (${f})`);
    }
    assert.deepEqual(missing, []);
  });
  it("definer-inventory.yaml lists every SECURITY DEFINER function of db/migrations (REQ-SEC-020)", () => {
    const inv = meta("definer-inventory.yaml");
    const dir = join(REPO, "db/migrations");
    const missing = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql"))) {
      const chunks = readFileSync(join(dir, f), "utf8").split(/^(?=CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s)/im);
      for (const c of chunks) {
        const m = c.match(/^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-z_]+\.[a-z_0-9]+)/i);
        if (m && /SECURITY\s+DEFINER/i.test(c.split(/^(?=CREATE\s|ALTER\s|GRANT\s|REVOKE\s)/im)[0]) && !inv.includes(m[1])) missing.push(`${m[1]} (${f})`);
      }
    }
    assert.deepEqual(missing, []);
  });
  it("policy-dump.ts reads pg_policies and targets db/policies (AC-0B-2.3 diff itself needs a DB: not run here)", () => {
    const p = join(TOOLS, "policy-dump.ts");
    assert.ok(existsSync(p), "db/tools/policy-dump.ts missing");
    const s = readFileSync(p, "utf8");
    assert.match(s, /pg_policies/);
    assert.match(s, /db\/policies|policies/);
  });
  it("policy-dump.ts without a database connection exits non-zero (no silent success)", () => {
    const p = join(TOOLS, "policy-dump.ts");
    assert.ok(existsSync(p), "db/tools/policy-dump.ts missing");
    const env = { ...process.env }; delete env.DATABASE_URL; delete env.PGHOST; delete env.PGDATABASE;
    const r = spawnSync(process.execPath, [p], { cwd: REPO, encoding: "utf8", env, timeout: 30000 });
    assert.notEqual(r.status, 0);
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /ERR_MODULE_NOT_FOUND|SyntaxError/);
  });
});
