// T0B-DBINV-1 — definer inventory repair (LD-230 item 10, 2026-11-15). STATIC only: the lane cannot run SQL (no Docker).
//   (a) db/meta/definer-inventory.yaml gains app.identity_platform_auth_write_invitation_accept_by_user and
//       app.identity_platform_auth_write_revoke_other_sessions (fields read from db/migrations/20261105000800_app__create_identity_definers.sql);
//   (b) the four reporting definers (owner lims_reporting_lookup, REVOKEd from PUBLIC, granted to lims_api) are modelled the way the inventory
//       models owner-held functions elsewhere (app.enqueue_job: owner lims_queue lists itself in `execute`): execute = lims_api + the owner, no other role;
//   (c) the DEFINER set of db/migrations equals the inventory (both directions; T0B-07 only checks one direction);
//   (d) no other row changes and the pgTAP EXECUTE assertion of db/tests/definers/T0B-08_inventory.test.sql is not weakened.
// Run: node --test tests/db/T0B-DBINV-1.inventory.test.mjs
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(join(REPO, p), "utf8");
const inventory = () => JSON.parse(read("db/meta/definer-inventory.yaml").split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join("\n")).definers;

const NEW_ROWS = ["app.identity_platform_auth_write_invitation_accept_by_user", "app.identity_platform_auth_write_revoke_other_sessions"];
const REPORTING = ["app.reporting_verify_qr", "app.reporting_resolve_portal_credential", "app.reporting_ingest_provider_callback", "app.reporting_redeem_link_for_app"];
// Rows that exist before this task and are not the four reporting rows (60 of the 64 on the unrepaired tree). sha256 of [fn, owner, execute] sorted by fn.
const BASELINE_OTHER_ROWS = { count: 60, sha256: "d7e418deb96119dc83be7f4cc97f9cb5d881ab757784ffb30ad22cb344d265d3" };
const KNOWN_ROLES = ["lims_app", "lims_api", "lims_worker", "lims_queue", "lims_migration", "lims_reporting_lookup"];

describe("T0B-DBINV-1 (a): the two identity rows (LD-230 item 10; 08 A38-1)", () => {
  const inv = inventory();
  for (const fn of NEW_ROWS) {
    it(`${fn} is inventoried with the fields of its migration`, () => {
      const d = inv[fn];
      assert.ok(d, `${fn} missing from db/meta/definer-inventory.yaml`);
      assert.equal(d.owner, "lims_owner");
      assert.deepEqual(d.execute, ["lims_api"], "REVOKE ... FROM PUBLIC; GRANT EXECUTE ... TO lims_api (migration lines 442-445)");
      assert.equal(typeof d.why, "string");
      assert.match(d.why, /platform/i);
      assert.match(d.why, /A38-1/, "cite the spec decision that introduced it");
      assert.equal(d.reviewer, null, "reviewer stays null until the gate-9 reviewer signs");
      assert.ok(Array.isArray(d.touches) && d.touches.length > 0);
      assert.ok(Array.isArray(d.policies) && d.policies.length > 0);
    });
  }
  it("revoke_other_sessions touches identity.sessions (SELECT, UPDATE) and names the sessions owner policies", () => {
    const d = inv["app.identity_platform_auth_write_revoke_other_sessions"];
    assert.ok(d.touches.some((t) => /^identity\.sessions\b.*\bSELECT\b/.test(t) && /\bUPDATE\b/.test(t)) || (d.touches.some((t) => /^identity\.sessions SELECT/.test(t)) && d.touches.some((t) => /^identity\.sessions UPDATE/.test(t))), `touches: ${JSON.stringify(d.touches)}`);
    assert.ok(d.policies.some((p) => /sessions__(\{select,update\}|select|update)__owner_only/.test(p)), `policies: ${JSON.stringify(d.policies)}`);
  });
  it("invitation_accept_by_user touches identity.invitations (SELECT, UPDATE) and names the invitations owner policies", () => {
    const d = inv["app.identity_platform_auth_write_invitation_accept_by_user"];
    assert.ok(d.touches.some((t) => /^identity\.invitations\b.*\bSELECT\b/.test(t) && /\bUPDATE\b/.test(t)) || (d.touches.some((t) => /^identity\.invitations SELECT/.test(t)) && d.touches.some((t) => /^identity\.invitations UPDATE/.test(t))), `touches: ${JSON.stringify(d.touches)}`);
    assert.ok(d.policies.some((p) => /invitations__(\{select,update\}|select|update)__owner_only/.test(p)), `policies: ${JSON.stringify(d.policies)}`);
  });
  it("the FORCE-RLS contract-test rule of T0B-08.suites holds for both: a pgTAP file names the function and asserts relforcerowsecurity", () => {
    const sql = read("db/tests/identity/T9-A38_platform_set_password.test.sql").replace(/--.*$/gm, "");
    assert.match(sql, /relforcerowsecurity/i, "T9-A38 must assert FORCE RLS on identity.sessions / identity.invitations (the inventory rows now have touches)");
    for (const fn of NEW_ROWS) assert.match(sql, new RegExp(`\\b${fn.replace(/^app\./, "")}\\b`));
  });
});

describe("T0B-DBINV-1 (b): the four reporting rows model the owner-held EXECUTE", () => {
  const inv = inventory();
  for (const fn of REPORTING) {
    it(`${fn}: owner lims_reporting_lookup, execute = lims_api + owner only`, () => {
      const d = inv[fn];
      assert.ok(d, `${fn} missing`);
      assert.equal(d.owner, "lims_reporting_lookup");
      assert.deepEqual([...d.execute].sort(), ["lims_api", "lims_reporting_lookup"], "owner holds EXECUTE (pg_proc.proacl owner entry); lims_api by GRANT; nobody else");
    });
  }
  it("the owner appears in `execute` only for functions it owns (no role gains EXECUTE it does not hold)", () => {
    for (const [fn, d] of Object.entries(inv)) {
      if (d.execute.includes("lims_reporting_lookup")) assert.equal(d.owner, "lims_reporting_lookup", `${fn} lists lims_reporting_lookup but is owned by ${d.owner}`);
      if (d.owner === "lims_reporting_lookup") assert.ok(REPORTING.includes(fn), `unexpected lims_reporting_lookup-owned row ${fn}`);
    }
  });
  it("no execute list names PUBLIC, anon, authenticated, lims_analytics or an unknown role", () => {
    for (const [fn, d] of Object.entries(inv)) for (const r of d.execute) assert.ok(KNOWN_ROLES.includes(r), `${fn}: unexpected EXECUTE role ${r}`);
  });
});

describe("T0B-DBINV-1 (d): nothing else is weakened", () => {
  it("every other pre-existing row keeps owner and execute (digest baseline)", () => {
    const inv = inventory();
    const skip = new Set([...NEW_ROWS, ...REPORTING]);
    const rows = Object.entries(inv).filter(([k]) => !skip.has(k)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, d]) => [k, d.owner, d.execute]);
    assert.equal(rows.length, BASELINE_OTHER_ROWS.count, "a row was added or removed besides the two new ones");
    assert.equal(createHash("sha256").update(JSON.stringify(rows)).digest("hex"), BASELINE_OTHER_ROWS.sha256, "owner/execute of an existing row changed");
  });
  it("the pgTAP EXECUTE assertion still compares all eight probe roles against the inventory, with no per-function exception", () => {
    const s = read("db/tests/definers/T0B-08_inventory.test.sql");
    assert.match(s, /VALUES \('lims_app'\),\('lims_api'\),\('lims_worker'\),\('lims_queue'\),\('lims_reporting_lookup'\),\('lims_analytics'\),\('anon'\),\('authenticated'\)/);
    assert.match(s, /SELECT is\(has_function_privilege\(e\.r, e\.fn_oid, 'EXECUTE'\), e\.expected,/);
    assert.match(s, /\(r\.r = ANY \(i\.execute_roles\) OR EXISTS \(SELECT 1 FROM unnest\(i\.execute_roles\) g WHERE g <> r\.r AND pg_has_role\(r\.r, g, 'USAGE'\)\)\) AS expected/);
    assert.match(s, /PUBLIC has no EXECUTE on any DEFINER/);
    assert.doesNotMatch(s.replace(/--.*$/gm, ""), /reporting_(verify_qr|resolve_portal_credential|ingest_provider_callback|redeem_link_for_app)/, "no special-casing of the reporting definers in the suite");
  });
});

describe("T0B-DBINV-1 (c): the DEFINER set equals the inventory (static checker)", () => {
  it("every SECURITY DEFINER function of db/migrations is inventoried and every inventory key is created as DEFINER by a migration", () => {
    const dir = join(REPO, "db/migrations");
    const found = new Set();
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql"))) {
      const chunks = readFileSync(join(dir, f), "utf8").split(/^(?=CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s)/im);
      for (const c of chunks) {
        const m = c.match(/^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-z_]+\.[a-z_0-9]+)/i);
        if (m && /SECURITY\s+DEFINER/i.test(c.split(/^(?=CREATE\s|ALTER\s|GRANT\s|REVOKE\s)/im)[0])) found.add(m[1]);
      }
    }
    const keys = new Set(Object.keys(inventory()));
    assert.deepEqual([...found].filter((x) => !keys.has(x)).sort(), [], "DEFINER in a migration, not in the inventory");
    assert.deepEqual([...keys].filter((x) => !found.has(x)).sort(), [], "inventory row without a DEFINER in any migration");
  });
  it("db/tools/gen-isolation-probes.ts --check: the generated db/tests/isolation/_registry.sql carries the new inventory rows (regenerate)", () => {
    const r = spawnSync(process.execPath, [join(REPO, "db/tools/gen-isolation-probes.ts"), "--root", REPO, "--check"], { cwd: REPO, encoding: "utf8", timeout: 60000 });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const reg = read("db/tests/isolation/_registry.sql");
    for (const fn of NEW_ROWS) assert.ok(reg.includes(`'${fn}'`), `_registry.sql has no definer_inventory row for ${fn}`);
  });
});
