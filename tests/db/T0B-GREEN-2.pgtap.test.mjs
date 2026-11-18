// T0B-GREEN-2 (LD-268, LD-273): every pgTAP suite of db/tests/{homecollection,partners,migration_staging,instruments,lab,reporting,storage,views,policy,app} (C5, C6, C7, C13, C17, C18 and the shared helpers)
// on the pinned image through db/tests/run-suites.sh. Fails on: a psql abort, ANY `not ok` (no REAL defect is parked in these directories, see .orchestra/notes/T0B-GREEN-2.md), a suite that did not run,
// a TAP SKIP outside the one documented in the storage suite, or an assertion count below the pre-task count of an edited suite (an assertion was deleted).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

const DIRS = ["homecollection", "partners", "migration_staging", "instruments", "lab", "reporting", "storage", "views", "policy", "app"];
const SUITES = DIRS.flatMap((d) => readdirSync(`db/tests/${d}`).filter((f) => f.endsWith(".test.sql")).sort().map((f) => `db/tests/${d}/${f}`));
// assertion counts of the edited suites at HEAD before this task (measured with the regex below); a drop means an assertion was deleted
const MIN_ASSERTIONS = {
  "db/tests/homecollection/T0B-13.C17_anonymise.test.sql": 38, "db/tests/homecollection/T0B-13.C17_schema.test.sql": 94,
  "db/tests/instruments/T0B-10.C7_behaviour.test.sql": 157, "db/tests/instruments/T0B-10.C7_schema.test.sql": 111, "db/tests/lab/T0B-10.C5_schema.test.sql": 76,
  "db/tests/migration_staging/T0B-13.C18_behaviour.test.sql": 103, "db/tests/migration_staging/T0B-13.C18_schema.test.sql": 91,
  "db/tests/partners/T0B-13.C13_behaviour.test.sql": 132, "db/tests/partners/T0B-13.C13_schema.test.sql": 80, "db/tests/policy/T0B-08_policy_shape.test.sql": 27,
  "db/tests/reporting/T0B-10.C6_schema.test.sql": 106, "db/tests/storage/T0B-12_storage.test.sql": 21, "db/tests/views/C9-T20.v_pub_qc_summary.test.sql": 22,
};
const noComments = (s) => s.replace(/--[^\n]*/g, "");
const RE = /(?<![\w.])(ok|is|isnt|like|unlike|matches|doesnt_match|alike|is_empty|isnt_empty|set_eq|bag_eq|results_eq|cmp_ok|pass|fail|throws_ok|lives_ok|skip|has_\w+|hasnt_\w+|col_\w+|fk_ok|function_\w+|table_privs_are|schema_privs_are|can)\s*\(/g;

test("the suite list is the 10 directories and no assertion was deleted from an edited suite", () => {
  assert.ok(SUITES.length >= 23, `only ${SUITES.length} suites found`);
  for (const [f, n] of Object.entries(MIN_ASSERTIONS)) {
    assert.ok(SUITES.includes(f), `${f} is not in the run list`);
    assert.ok([...noComments(readFileSync(f, "utf8")).matchAll(RE)].length >= n, `${f}: assertion count dropped below ${n}`);
  }
});

test("storage: the provisioning script creates exactly the 11 buckets the probe suite lists (the half of 'every bucket exists' the empty harness stub cannot run)", () => {
  const prov = readFileSync("db/provisioning/create-storage-buckets.mjs", "utf8");
  const arr = /export const BUCKETS = \[([\s\S]*?)\]/.exec(prov)?.[1] ?? "";
  const fromScript = [...arr.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]).sort();
  const sql = readFileSync("db/tests/storage/T0B-12_storage.test.sql", "utf8");
  const want = /CREATE TEMP TABLE want\(b\) AS VALUES([\s\S]*?);/.exec(sql)?.[1] ?? "";
  const fromTest = [...want.matchAll(/\('([a-z-]+)'\)/g)].map((m) => m[1]).sort();
  assert.equal(fromScript.length, 11);
  assert.deepEqual(fromScript, fromTest);
});

test("run-suites.sh: every suite of the 10 directories passes (no psql abort, no not ok)", { timeout: 25 * 60 * 1000 }, () => {
  const bash = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
  const r = spawnSync(bash, ["db/tests/run-suites.sh", ...SUITES], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 24 * 60 * 1000 });
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  assert.doesNotMatch(out, /psql failed:/, "a suite aborted in psql:\n" + out.split("\n").filter((l) => /psql failed|ERROR:/.test(l)).join("\n"));
  for (const s of SUITES) assert.ok(out.includes(`# --- ${s}`), `${s} did not run`);
  const failed = []; const skipped = []; let cur = null;
  for (const line of out.split("\n")) {
    const h = /^# --- (\S+)/.exec(line); if (h) { cur = h[1]; continue; }
    if (/^not ok /.test(line)) failed.push(`${cur}: ${line}`);
    if (/^ok .*# SKIP/i.test(line)) skipped.push(cur);
  }
  assert.deepEqual(failed, [], "not ok");
  assert.deepEqual(skipped, ["db/tests/storage/T0B-12_storage.test.sql"], "only the storage bucket-existence probe may SKIP (empty harness stub, LD-54)");
  assert.equal(r.status, 0, out.slice(-2000));
});
