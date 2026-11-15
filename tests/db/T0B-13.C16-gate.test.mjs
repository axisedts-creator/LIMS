// T0B-13.C16-GATE — check-registry accepts exactly the 7 documented C16 ANY_T (table, command) pairs without the staff guard, nothing else.
// Authority: LD-215 (founder 2026-11-15 14:56 / 15:22 NPT); 08 A17 P-16 (staff guard rule); C16 05-SCHEMA §5.1 / §5.2 / §5.3 (ANY_T by design);
// CR-C0-T0B-13.C16 option (b), narrowed. The existing T0B-07 registry tests stay the owner of every other check-registry rule.
//
// CONTRACT (same as T0B-07): node db/tools/check-registry.ts --root <dir>; exit 0 = clean, exit 1 = violation lines naming the policy.
// Fixture = db/policies/engagement.sql + db/meta/tables.yaml (JSON-subset YAML). No migrations needed (the tool reads absent dirs as empty).
// The 7 pairs: settings select; number_counters select, insert, update; cs_booking_cancel_reasons select; cs_reminder_reasons select;
// cs_enquiry_categories select. Accepted only when every non-null clause (USING and WITH CHECK) equals, after collapsing whitespace and
// case, ANY_T = `tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system','patient','device')`.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TOOL = join(REPO, "db/tools/check-registry.ts");
const tmpDirs = [];
after(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function run(root) {
  assert.ok(existsSync(TOOL), "db/tools/check-registry.ts missing");
  const r = spawnSync(process.execPath, [TOOL, ...(root ? ["--root", root] : [])], { cwd: REPO, encoding: "utf8", timeout: 60000 });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.doesNotMatch(out, /ERR_MODULE_NOT_FOUND|Cannot find (module|package)|SyntaxError|TypeError|ReferenceError/, `tool crashed:\n${out}`);
  return { code: r.status, out };
}
const accepts = (root) => { const r = run(root); assert.equal(r.code, 0, `expected exit 0, got ${r.code}:\n${r.out}`); return r; };
function rejects(root, policyName, why) {
  const r = run(root);
  assert.equal(r.code, 1, `expected exit 1 (${why}), got ${r.code}:\n${r.out}`);
  assert.match(r.out, new RegExp(policyName), `output must name ${policyName} (${why}):\n${r.out}`);
  assert.match(r.out, /lacks the staff guard/i, `output must carry the usual staff-guard message (${why}):\n${r.out}`);
  assert.match(r.out, /A17 P-16/, `output must cite 08 A17 P-16 (${why}):\n${r.out}`);
  return r;
}
function fixture(policySql, tables, { schema = "engagement", file = "engagement.sql" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "t0b13c16gate-"));
  tmpDirs.push(root);
  const meta = { tables: Object.fromEntries(tables.map((t) => [t.includes(".") ? t : `${schema}.${t}`, { class: "M", centre_scoped: false, audited: true, retention: "7y", columns: { id: "P0", tenant_id: "P0" } }])) };
  for (const [rel, body] of [[`db/policies/${file}`, `-- fixture\n${policySql}\n`], ["db/meta/tables.yaml", JSON.stringify(meta, null, 1)]]) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  return root;
}

const T = "tenant_id = (SELECT app.current_tenant_id())";
const ACT = (list) => `(SELECT app.current_actor_type()) IN (${list})`;
const LIST = "'user','system','patient','device'";
const ANY_T = `${T} AND ${ACT(LIST)}`;
const GUARD = "(SELECT app.is_staff_or_system())";

// Policy builder: name and declared command are independent so name/command mismatches can be tested.
// kind: select -> USING; insert -> WITH CHECK; update -> USING + WITH CHECK; delete -> USING; all -> USING + WITH CHECK.
function pol(table, cmd, using, check = using, { name = `${table}__${cmd}__tenant`, schema = "engagement", declared = cmd } = {}) {
  const hasUsing = declared !== "insert" && using !== null;
  const hasCheck = (declared === "insert" || declared === "update" || declared === "all") && check !== null;
  return `CREATE POLICY ${name} ON ${schema}.${table} FOR ${declared.toUpperCase()} TO lims_app` +
    (hasUsing ? `\n  USING (${using})` : "") + (hasCheck ? `\n  WITH CHECK (${check})` : "") + ";";
}
const one = (table, cmd, using, check, opts) => fixture(pol(table, cmd, using, check, opts), [table], { schema: opts?.schema ?? "engagement" });

const PAIRS = [
  ["settings", "select"],
  ["number_counters", "select"], ["number_counters", "insert"], ["number_counters", "update"],
  ["cs_booking_cancel_reasons", "select"], ["cs_reminder_reasons", "select"], ["cs_enquiry_categories", "select"],
];

describe("T0B-13.C16-GATE: the 7 documented ANY_T pairs are accepted (LD-215)", () => {
  for (const [table, cmd] of PAIRS)
    it(`engagement.${table} ${cmd} with the exact ANY_T predicate -> accepted`, () => accepts(one(table, cmd, ANY_T)));

  it("all 7 pairs together in one policy file -> accepted", () =>
    accepts(fixture(PAIRS.map(([t, c]) => pol(t, c, ANY_T)).join("\n"), [...new Set(PAIRS.map(([t]) => t))])));

  it("the real C16 form (multi-line, padded USING/WITH CHECK as in db/policies/engagement.sql) -> accepted", () => {
    const sql = `CREATE POLICY number_counters__update__tenant ON engagement.number_counters FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system','patient','device'))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system','patient','device'));`;
    accepts(fixture(sql, ["number_counters"]));
  });

  it("whitespace differences (runs of spaces, tabs, newlines) in the exact predicate -> accepted", () => {
    const messy = `tenant_id   =\t(SELECT   app.current_tenant_id())\n   AND\n\t(SELECT app.current_actor_type())   IN   ('user','system','patient','device')`;
    accepts(one("settings", "select", messy));
    accepts(one("number_counters", "update", messy, messy));
  });
  it("letter-case differences in the exact predicate -> accepted", () => {
    accepts(one("settings", "select", ANY_T.toUpperCase()));
    accepts(one("cs_reminder_reasons", "select", ANY_T.toLowerCase()));
    accepts(one("number_counters", "insert", "Tenant_Id = (Select App.Current_Tenant_Id()) And (Select App.Current_Actor_Type()) In ('user','system','patient','device')"));
  });
  it("USING and WITH CHECK may differ in whitespace/case from each other, each still exact -> accepted", () =>
    accepts(one("number_counters", "update", ANY_T, ANY_T.toUpperCase().replace(/ AND /g, "\n AND "))));
});

describe("T0B-13.C16-GATE: nothing else is exempted", () => {
  it("the exact ANY_T predicate on a table outside the list (engagement.accounts select) -> rejected with the usual message", () =>
    rejects(one("accounts", "select", ANY_T), "accounts__select__tenant", "unlisted table"));
  it("the exact ANY_T predicate on a listed table name in another schema (core.settings select) -> rejected", () =>
    rejects(fixture(pol("settings", "select", ANY_T, ANY_T, { schema: "core" }), ["settings"], { schema: "core", file: "core.sql" }), "settings__select__tenant", "other schema"));
  it("the exact ANY_T predicate on core.widgets (T0B-07 table) -> rejected", () =>
    rejects(one("widgets", "select", ANY_T, ANY_T, { schema: "core" }), "widgets__select__tenant", "core table"));

  for (const cmd of ["insert", "update"])
    it(`settings ${cmd} without the staff guard -> rejected (only settings select is listed)`, () =>
      rejects(one("settings", cmd, ANY_T), `settings__${cmd}__tenant`, `settings ${cmd}`));
  for (const [table, cmd] of [
    ["cs_reminder_reasons", "insert"], ["cs_reminder_reasons", "update"], ["cs_reminder_reasons", "delete"],
    ["cs_booking_cancel_reasons", "insert"], ["cs_booking_cancel_reasons", "update"],
    ["cs_enquiry_categories", "insert"], ["cs_enquiry_categories", "delete"],
    ["number_counters", "delete"], ["settings", "delete"],
  ])
    it(`listed table, unlisted command: ${table} ${cmd} guard-less -> rejected`, () =>
      rejects(one(table, cmd, ANY_T), `${table}__${cmd}__tenant`, `${table} ${cmd}`));
  it("a FOR ALL policy named __all__tenant on a listed table -> rejected", () =>
    rejects(one("settings", "all", ANY_T), "settings__all__tenant", "all"));

  it("name says select but the policy is declared FOR ALL (write access smuggled under a listed name) -> rejected", () =>
    rejects(one("settings", "select", ANY_T, ANY_T, { declared: "all" }), "settings__select__tenant", "name/command mismatch all"));
  it("name says select but the policy is declared FOR INSERT -> rejected", () =>
    rejects(one("cs_reminder_reasons", "select", ANY_T, ANY_T, { declared: "insert" }), "cs_reminder_reasons__select__tenant", "name/command mismatch insert"));
  it("name says select but the policy is declared FOR UPDATE -> rejected", () =>
    rejects(one("cs_enquiry_categories", "select", ANY_T, ANY_T, { declared: "update" }), "cs_enquiry_categories__select__tenant", "name/command mismatch update"));

  it("exact predicate under a __tenant_centre name on a listed table -> rejected (only __tenant is exempted)", () =>
    rejects(one("settings", "select", ANY_T, ANY_T, { name: "settings__select__tenant_centre" }), "settings__select__tenant_centre", "tenant_centre"));

  describe("predicate must equal ANY_T exactly", () => {
    const bad = {
      "'partner' added to the actor list": `${T} AND ${ACT("'user','system','patient','device','partner'")}`,
      "'portal' added to the actor list": `${T} AND ${ACT("'user','system','patient','device','portal'")}`,
      "'device' removed": `${T} AND ${ACT("'user','system','patient'")}`,
      "'patient' removed": `${T} AND ${ACT("'user','system','device'")}`,
      "'user' removed": `${T} AND ${ACT("'system','patient','device'")}`,
      "actor list reordered": `${T} AND ${ACT("'device','patient','system','user'")}`,
      "actor check replaced by = 'patient'": `${T} AND (SELECT app.current_actor_type()) = 'patient'`,
      "trailing OR true": `${ANY_T} OR true`,
      "OR with another tenant branch": `${ANY_T} OR ${T}`,
      "parenthesised OR": `(${T} OR ${ACT(LIST)})`,
      "tenant predicate missing": ACT(LIST),
      "tenant predicate swapped for OR true": `true AND ${ACT(LIST)}`,
      "actor list missing": T,
      "tenant predicate negated": `tenant_id <> (SELECT app.current_tenant_id()) AND ${ACT(LIST)}`,
      "extra AND clause appended": `${ANY_T} AND expires_at IS NULL`,
      "extra AND clause prepended": `deleted_at IS NULL AND ${ANY_T}`,
      "tenant predicate without the SELECT wrapper": `tenant_id = app.current_tenant_id() AND ${ACT(LIST)}`,
      "empty-ish literal list": `${T} AND ${ACT("''")}`,
    };
    for (const [label, pred] of Object.entries(bad)) {
      it(`settings select with ${label} -> rejected`, () => rejects(one("settings", "select", pred), "settings__select__tenant", label));
      it(`number_counters insert with ${label} -> rejected`, () => rejects(one("number_counters", "insert", pred), "number_counters__insert__tenant", label));
    }
    it("number_counters update: USING exact but WITH CHECK widened to 'portal' -> rejected", () =>
      rejects(one("number_counters", "update", ANY_T, `${T} AND ${ACT("'user','system','patient','device','portal'")}`), "number_counters__update__tenant", "check widened"));
    it("number_counters update: WITH CHECK exact but USING with a trailing OR -> rejected", () =>
      rejects(one("number_counters", "update", `${ANY_T} OR true`, ANY_T), "number_counters__update__tenant", "using widened"));
    it("number_counters update: USING exact, WITH CHECK dropped actor 'device' -> rejected", () =>
      rejects(one("number_counters", "update", ANY_T, `${T} AND ${ACT("'user','system','patient'")}`), "number_counters__update__tenant", "check narrowed list"));
  });

  it("a policy of an unlisted table beside valid listed ones is still reported, the listed ones are not", () => {
    const sql = [pol("settings", "select", ANY_T), pol("accounts", "select", ANY_T), pol("cs_reminder_reasons", "select", ANY_T)].join("\n");
    const r = rejects(fixture(sql, ["settings", "accounts", "cs_reminder_reasons"]), "accounts__select__tenant", "mixed");
    assert.doesNotMatch(r.out, /settings__select__tenant|cs_reminder_reasons__select__tenant/, `listed policies must not be reported:\n${r.out}`);
  });
  it("the exception does not skip the registry rule: listed policy on a table absent from tables.yaml -> still rejected", () => {
    const r = run(fixture(pol("settings", "select", ANY_T), []));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /engagement\.settings/);
    assert.match(r.out, /not registered/i);
  });
  it("the exception does not skip the centre cast rule: listed policy that also carries an uncast centre predicate -> still rejected", () => {
    const r = run(one("settings", "select", `${ANY_T} AND centre_id = ANY ((SELECT app.current_centre_ids()))`));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /settings__select__tenant/);
  });
});

describe("T0B-13.C16-GATE: behaviour outside the exception table is unchanged", () => {
  it("guard-carrying __tenant policies on listed tables (insert/update with is_staff_or_system) -> accepted", () => {
    const g = `${T} AND ${GUARD} AND ${ACT("'user','system'")}`;
    accepts(fixture([pol("settings", "insert", g), pol("settings", "update", g), pol("cs_reminder_reasons", "insert", g)].join("\n"), ["settings", "cs_reminder_reasons"]));
  });
  it("guard-carrying policy on a listed pair with the actor list widened keeps passing the normal guard path (guard present)", () => {
    accepts(one("settings", "select", `${T} AND ${GUARD} AND ${ACT("'user','system','patient','device','partner'")}`));
  });
  it("guard-less __tenant on a shared_with table with no actor policy -> still rejected (shared_with rule)", () => {
    const root = fixture(pol("accounts", "select", T), ["accounts"]);
    const meta = join(root, "db/meta/tables.yaml");
    const j = JSON.parse(readFileSync(meta, "utf8"));
    j.tables["engagement.accounts"].shared_with = ["patient"];
    writeFileSync(meta, JSON.stringify(j));
    const r = run(root);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /accounts__select__tenant/);
    assert.match(r.out, /patient/);
  });
  it("guard-less __tenant on a shared_with table WITH the matching __patient policy -> still accepted", () => {
    const actor = `${T} AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'patient'`;
    const root = fixture([pol("accounts", "select", T), pol("accounts", "select", actor, actor, { name: "accounts__select__patient" })].join("\n"), ["accounts"]);
    const meta = join(root, "db/meta/tables.yaml");
    const j = JSON.parse(readFileSync(meta, "utf8"));
    j.tables["engagement.accounts"].shared_with = ["patient"];
    writeFileSync(meta, JSON.stringify(j));
    accepts(root);
  });
  it("plain guard-less __tenant policy on an ordinary table -> still rejected", () =>
    rejects(one("accounts", "select", T), "accounts__select__tenant", "plain guard-less"));
});

describe("T0B-13.C16-GATE: source + lane tree", () => {
  it("db/tools/check-registry.ts keeps the exception explicit and cites LD-215", () => {
    const s = readFileSync(TOOL, "utf8");
    assert.match(s, /LD-215/, "code comment must cite LD-215");
    for (const t of ["settings", "number_counters", "cs_booking_cancel_reasons", "cs_reminder_reasons", "cs_enquiry_categories"])
      assert.match(s, new RegExp(`engagement\\.${t}`), `exception table must name engagement.${t}`);
  });
  it("the staff-guard rule itself is still in place (GUARD regex + A17 P-16 message)", () => {
    const s = readFileSync(TOOL, "utf8");
    assert.match(s, /is_staff_or_system/);
    assert.match(s, /A17 P-16/);
  });
  it("node db/tools/check-registry.ts on the lane tree exits 0 and reports none of the 7 CR lines", () => {
    const r = accepts();
    assert.doesNotMatch(r.out, /lacks the staff guard/i, r.out);
    assert.match(r.out, /check-registry: ok/, r.out);
  });
});
