// T0B-GREEN-1 (LD-268, LD-273): the pgTAP suites of C9 to C15 (quality, micro, anatomic, inventory, smartreport, payments) on the pinned image.
// Runs db/tests/run-suites.sh for the 12 suites and fails on: a psql abort, any `not ok` outside the REAL list below, or an assertion count that dropped.
// REAL = the database does not do what the contract says (CRs in .orchestra/cr/T0B-GREEN-1.*.md); those assertions stay red on purpose and are NOT edited.
// A REAL assertion that turns green is reported, not failed (the fix landed; remove it from the list).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SUITES = [
  "db/tests/anatomic/T0B-13.C11_schema.test.sql", "db/tests/anatomic/T0B-13.C11_behaviour.test.sql",
  "db/tests/payments/T0B-13.C15_schema.test.sql", "db/tests/payments/T0B-13.C15_behaviour.test.sql",
  "db/tests/inventory/T0B-13.C12_schema.test.sql", "db/tests/inventory/T0B-13.C12_behaviour.test.sql",
  "db/tests/micro/T0B-13.C10_schema.test.sql", "db/tests/micro/T0B-13.C10_behaviour.test.sql",
  "db/tests/quality/T0B-13.C9_schema.test.sql", "db/tests/quality/T0B-13.C9_behaviour.test.sql",
  "db/tests/smartreport/T0B-13.C14_schema.test.sql", "db/tests/smartreport/T0B-13.C14_behaviour.test.sql",
];
// suite -> assertion numbers that are REAL defects (CR-C0-T0B-GREEN-1-001 .. -003)
const REAL = {
  "db/tests/smartreport/T0B-13.C14_behaviour.test.sql": [357, 370, 373],   // -001 CHECKs accept NULL
  "db/tests/payments/T0B-13.C15_behaviour.test.sql": [373],                // -002 enforce_mutable_columns vs generated column
  "db/tests/anatomic/T0B-13.C11_behaviour.test.sql": [432],                // -003 lims_analytics cannot read v_pub_* views
};
// minimum number of assertions per suite (measured after T0B-GREEN-1); a drop means an assertion was deleted
const MIN_ASSERTIONS = {
  "db/tests/payments/T0B-13.C15_schema.test.sql": 99, "db/tests/inventory/T0B-13.C12_behaviour.test.sql": 98,
};
const noComments = (s) => s.replace(/--[^\n]*/g, "");
const RE = /(?<![\w.])(ok|is|isnt|like|unlike|matches|doesnt_match|is_empty|isnt_empty|set_eq|bag_eq|results_eq|cmp_ok|pass|fail|throws_ok|lives_ok|has_\w+|hasnt_\w+|col_\w+|fk_ok|function_\w+|table_privs_are|schema_privs_are|can)\s*\(/g;

test("no assertion was deleted from the two suites measured before the task", () => {
  for (const [f, n] of Object.entries(MIN_ASSERTIONS))
    assert.ok([...noComments(readFileSync(f, "utf8")).matchAll(RE)].length >= n, `${f}: assertion count dropped below ${n}`);
});

test("the REAL assertions are still written as the contract states them (not weakened)", () => {
  const has = (f, re) => assert.ok(re.test(readFileSync(f, "utf8")), `${f}: ${re} not found (assertion edited or removed)`);
  has("db/tests/smartreport/T0B-13.C14_behaviour.test.sql", /'\^E23514\\\|\.\*rules__followup_fields__ck'/);
  has("db/tests/smartreport/T0B-13.C14_behaviour.test.sql", /'\^E23514\\\|\.\*library_versions__hash__ck'/);
  has("db/tests/smartreport/T0B-13.C14_behaviour.test.sql", /'\^E23514\\\|\.\*summaries__score__ck'/);
  has("db/tests/payments/T0B-13.C15_behaviour.test.sql", /'n=1', 'C15 test 3: static_qr is_active changes/);
  has("db/tests/anatomic/T0B-13.C11_behaviour.test.sql", /!~ '\^E42501', true, 'C11 check 15 \/ §8 GRANT: lims_analytics may SELECT the view/);
});

test("run-suites.sh: every suite of C9..C15 passes except the REAL defects listed with their CR", { timeout: 20 * 60 * 1000 }, () => {
  const bash = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
  const r = spawnSync(bash, ["db/tests/run-suites.sh", ...SUITES], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 19 * 60 * 1000 });
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  assert.doesNotMatch(out, /psql failed:/, "a suite aborted in psql:\n" + out.split("\n").filter((l) => /psql failed|ERROR:/.test(l)).join("\n"));
  const failed = {}; let cur = null; const fixed = [];
  for (const line of out.split("\n")) {
    const h = /^# --- (\S+)/.exec(line); if (h) { cur = h[1]; continue; }
    const m = /^not ok (\d+)/.exec(line); if (m && cur) (failed[cur] ??= []).push(Number(m[1]));
  }
  for (const s of SUITES) assert.ok(out.includes(`# --- ${s}`), `${s} did not run`);
  const unexpected = [];
  for (const [s, nums] of Object.entries(failed)) for (const n of nums) if (!(REAL[s] ?? []).includes(n)) unexpected.push(`${s} #${n}`);
  for (const [s, nums] of Object.entries(REAL)) for (const n of nums) if (!(failed[s] ?? []).includes(n)) fixed.push(`${s} #${n}`);
  if (fixed.length) console.log(`REAL assertions now green (remove from REAL): ${fixed.join(", ")}`);
  assert.deepEqual(unexpected, [], "not ok outside the REAL list");
});
