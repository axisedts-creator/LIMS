// T0B-DBSEED-1 — probe fixtures for every module table (LD-233, 2026-11-15; AC-0B-3.1..3.7). STATIC checks only: the lane cannot run SQL
// (no Docker). The generated isolation probes (db/tests/isolation/*.test.sql) assert in step 1 that rows of tenant A, tenant B, centres A1/A2
// and the actor fixtures exist in every probed table; today only the core preamble inserts rows ("module rows come from db/seeds", which holds
// only core + tenants). This file proves, from the migrations and db/meta/tables.yaml, that the generator now emits fixtures that are complete,
// in foreign-key dependency order, constraint-valid and synthetic. Whether PostgreSQL accepts them is left to the founder rerun
// (LIMS_SKIP_GEN=1 bash db/tests/run-suites.sh <probe files>; see .orchestra/notes/T0B-DBSEED-1-tests.md).
//
// CONTRACT this test fixes (the implementation must follow it; everything else is free):
//  * generator: `node db/tools/gen-isolation-probes.ts [--out <dir>] [--check]`; the fixture dir is `<out>/../fixtures/probe-rows`
//    (default db/tests/fixtures/probe-rows), one file `<schema>.sql` per registry schema that needs rows, written/checked/pruned like the probes.
//  * each fixture file is ONLY comments + `INSERT INTO <schema>.<table> (<cols>) VALUES (...), (...) [ON CONFLICT DO NOTHING];` (no INSERT..SELECT,
//    no DO, no ALTER/DISABLE: the rows must be statically readable). Values: literals, NULL, now(), pg_temp.id('xx'), ::casts, decode(...).
//  * every generated probe `\ir`s all fixture files, in one global order, inside its step-1 replica window (after the core preamble inserts).
//  * a table without fixtures is listed in .orchestra/cr/T0B-DBSEED-1.exceptions.nonblocking.md with a reason.
// Run: node --test tests/db/T0B-DBSEED-1.fixtures.test.mjs
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(join(REPO, p), "utf8");
const BASELINE_COMMIT = "13a5e1cf"; // lane HEAD when this test was written: probes at this commit are the "no assertion weakened" baseline
const FIX_DIR = "db/tests/fixtures/probe-rows";
const CR_PATH = ".orchestra/cr/T0B-DBSEED-1.exceptions.nonblocking.md";
const ACTORS = ["partner", "portal", "patient"];
const SUBS = { partner: "35", portal: "a3", patient: "34" }; // generator step-9 fixture actor ids
const A = "pg_temp.id('01')", B = "pg_temp.id('02')";

// ------------------------------------------------------------------ tiny SQL helpers (comments out, quotes respected)
function stripComments(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") { let j = i + 1; while (j < s.length) { if (s[j] === "'") { if (s[j + 1] === "'") { j += 2; continue; } break; } j++; } out += s.slice(i, j + 1); i = j; continue; }
    if (s.startsWith("--", i)) { const e = s.indexOf("\n", i); i = e < 0 ? s.length : e - 1; continue; }
    if (s.startsWith("/*", i)) { const e = s.indexOf("*/", i + 2); i = e < 0 ? s.length : e + 1; out += " "; continue; }
    out += c;
  }
  return out;
}
/** Statements split on ';' outside quotes and dollar quotes; dollar bodies are replaced by $$. */
function splitStatements(text) {
  const s = stripComments(text), out = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") { let j = i + 1; while (j < s.length) { if (s[j] === "'") { if (s[j + 1] === "'") { j += 2; continue; } break; } j++; } cur += s.slice(i, j + 1); i = j; continue; }
    if (c === '"') { const j = s.indexOf('"', i + 1); cur += s.slice(i, j + 1); i = j; continue; }
    if (c === "$") { const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i)); if (m) { const e = s.indexOf(m[0], i + m[0].length); cur += "$$"; i = (e < 0 ? s.length : e + m[0].length) - 1; continue; } }
    if (c === ";") { if (cur.trim()) out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
/** Text inside the balanced (...) starting at index `open`; returns [inner, indexAfter]. */
function balanced(s, open) {
  let d = 0;
  for (let j = open; j < s.length; j++) {
    if (s[j] === "'") { j++; while (j < s.length) { if (s[j] === "'") { if (s[j + 1] === "'") { j += 2; continue; } break; } j++; } continue; }
    if (s[j] === "(") d++;
    else if (s[j] === ")" && --d === 0) return [s.slice(open + 1, j), j + 1];
  }
  return [s.slice(open + 1), s.length];
}
function splitTop(s) {
  const out = [];
  let depth = 0, cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") { let j = i + 1; while (j < s.length) { if (s[j] === "'") { if (s[j + 1] === "'") { j += 2; continue; } break; } j++; } cur += s.slice(i, j + 1); i = j; continue; }
    if (c === "(" || c === "[") depth++;
    if (c === ")" || c === "]") depth--;
    if (c === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
/** Tuples of a VALUES list: ["a, b", "c, d"]. */
function tuples(values) {
  const out = [];
  let i = 0;
  while (i < values.length) {
    const o = values.indexOf("(", i);
    if (o < 0) break;
    const [inner, next] = balanced(values, o);
    out.push(inner);
    i = next;
  }
  return out;
}
/** Canonical form of a value expression, so `pg_temp.id( '01' )` equals `pg_temp.id('01')`. */
function norm(v) {
  let out = "", i = 0;
  const s = v.trim();
  while (i < s.length) {
    if (s[i] === "'") { let j = i + 1; while (j < s.length) { if (s[j] === "'") { if (s[j + 1] === "'") { j += 2; continue; } break; } j++; } out += s.slice(i, j + 1); i = j + 1; continue; }
    if (/\s/.test(s[i])) { i++; continue; }
    out += s[i].toLowerCase(); i++;
  }
  return out;
}
const isNull = (v) => norm(v) === "null";
const idLit = (k) => `pg_temp.id('${k}')`;

// ------------------------------------------------------------------ registry (same rule as the generator: class != G and not rls_exempt)
const META = JSON.parse(read("db/meta/tables.yaml").split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join("\n")).tables;
const PROBED = Object.keys(META).filter((t) => META[t].class !== "G" && !META[t].rls_exempt).sort();
const tcolOf = (t) => ("tenant_id" in META[t].columns ? "tenant_id" : "id");
const ccOf = (t) => { // generator rule (LD-230 7): centre_id, else the single *centre_id column, else centre_id
  const cs = Object.keys(META[t].columns).filter((c) => /centre_id$/.test(c));
  return !cs.includes("centre_id") && cs.length === 1 ? cs[0] : "centre_id";
};
const ownOf = (t) => ("actor_id" in META[t].columns ? "actor_id" : "created_by");

// ------------------------------------------------------------------ migrations: columns, NOT NULL, defaults, FKs, UNIQUE, CHECK IN-lists
const MIG_FILES = readdirSync(join(REPO, "db/migrations")).filter((f) => f.endsWith(".sql")).sort();
const TABLES = {}; // "s.t" -> { cols: Map(name -> {notNull, hasDefault, type}), pk: [], uniques: [[...]], fks: [{cols, parent, pcols}], enums: Map(col -> Set) }
const ENUM_TYPES = {};
const ident = (s) => s.replace(/"/g, "").trim();
const tbl = (name) => (TABLES[name] ??= { cols: new Map(), pk: [], uniques: [], fks: [], checks: [] });
function addColumn(t, def) {
  const m = /^("?[a-z_][a-z0-9_]*"?)\s+(.+)$/is.exec(def);
  if (!m) return;
  const name = ident(m[1]), rest = m[2];
  const type = /^([a-z_][a-z0-9_. ]*?(?:\([^)]*\))?(?:\[\])?)(?=\s+(?:NOT|NULL|DEFAULT|REFERENCES|CHECK|PRIMARY|UNIQUE|GENERATED|CONSTRAINT|COLLATE)\b|$)/i.exec(rest)?.[1] ?? rest.split(/\s+/)[0];
  const col = { notNull: /\bNOT\s+NULL\b/i.test(rest) || /\bPRIMARY\s+KEY\b/i.test(rest), hasDefault: /\bDEFAULT\b/i.test(rest) || /\bGENERATED\b/i.test(rest), type: type.trim() };
  tbl(t).cols.set(name, col);
  if (/\bPRIMARY\s+KEY\b/i.test(rest)) tbl(t).pk = [name];
  else if (/\bUNIQUE\b/i.test(rest)) tbl(t).uniques.push([name]);
  const ref = /\bREFERENCES\s+([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)\s*(?:\(([^)]*)\))?/i.exec(rest);
  if (ref) tbl(t).fks.push({ cols: [name], parent: ref[1], pcols: ref[2] ? ref[2].split(",").map((x) => x.trim()) : ["id"] });
  const ck = /\bCHECK\s*\(/i.exec(rest);
  if (ck) tbl(t).checks.push(balanced(rest, ck.index + ck[0].length - 1)[0]);
}
function addConstraint(t, def) {
  const d = def.replace(/^CONSTRAINT\s+"?[a-z_][a-z0-9_]*"?\s+/i, "");
  let m;
  if ((m = /^PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(d))) tbl(t).pk = m[1].split(",").map((x) => ident(x));
  else if ((m = /^UNIQUE\s*\(([^)]*)\)/i.exec(d))) tbl(t).uniques.push(m[1].split(",").map((x) => ident(x)));
  else if ((m = /^FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)\s*\(([^)]*)\)/i.exec(d)))
    tbl(t).fks.push({ cols: m[1].split(",").map((x) => ident(x)), parent: m[2], pcols: m[3].split(",").map((x) => ident(x)) });
  else if ((m = /^CHECK\s*\(/i.exec(d))) tbl(t).checks.push(balanced(d, m[0].length - 1)[0]);
}
for (const f of MIG_FILES) {
  for (const st of splitStatements(read(`db/migrations/${f}`))) {
    let m;
    if ((m = /^CREATE\s+TYPE\s+([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)\s+AS\s+ENUM\s*\(([^)]*)\)/i.exec(st)))
      ENUM_TYPES[m[1]] = new Set([...m[2].matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1]));
    else if ((m = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)\s*\(/i.exec(st))) {
      const t = m[1];
      tbl(t);
      const [body] = balanced(st, m[0].length - 1);
      for (const el of splitTop(body)) {
        if (/^(CONSTRAINT|PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|EXCLUDE|LIKE)\b/i.test(el)) addConstraint(t, el);
        else addColumn(t, el);
      }
    } else if ((m = /^ALTER\s+TABLE\s+(?:ONLY\s+)?([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)\s+([\s\S]*)$/i.exec(st))) {
      const t = m[1];
      if (!TABLES[t]) continue;
      for (const act of splitTop(m[2])) {
        let a;
        if ((a = /^ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([\s\S]*)$/i.exec(act))) addColumn(t, a[1]);
        else if ((a = /^ADD\s+(CONSTRAINT[\s\S]*|PRIMARY[\s\S]*|FOREIGN[\s\S]*|UNIQUE[\s\S]*|CHECK[\s\S]*)$/i.exec(act))) addConstraint(t, a[1]);
        else if ((a = /^ALTER\s+COLUMN\s+("?[a-z_][a-z0-9_]*"?)\s+SET\s+NOT\s+NULL/i.exec(act))) { const c = TABLES[t].cols.get(ident(a[1])); if (c) c.notNull = true; }
        else if ((a = /^ALTER\s+COLUMN\s+("?[a-z_][a-z0-9_]*"?)\s+SET\s+DEFAULT/i.exec(act))) { const c = TABLES[t].cols.get(ident(a[1])); if (c) c.hasDefault = true; }
      }
    } else if ((m = /^CREATE\s+UNIQUE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?\S+\s+ON\s+([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)\s*(?:USING\s+\w+\s*)?\(/i.exec(st))) {
      if (!TABLES[m[1]] || /\bWHERE\b/i.test(st)) continue; // partial indexes: not every row is constrained, skipped
      const cols = splitTop(balanced(st, m[0].length - 1)[0]);
      if (cols.every((c) => /^"?[a-z_][a-z0-9_]*"?$/i.test(c))) TABLES[m[1]].uniques.push(cols.map(ident));
    }
  }
}
// NOT NULL through the primary key
for (const t of Object.values(TABLES)) for (const c of t.pk) if (t.cols.get(c)) t.cols.get(c).notNull = true;

/** `col IN ('a','b')` shaped CHECKs (optionally `col IS NULL OR ...`): column -> allowed literal set. The only CHECK shape judged statically. */
function checkSets(t) {
  const sets = new Map();
  for (const ck of TABLES[t]?.checks ?? []) {
    let e = ck.trim();
    while (e.startsWith("(") && balanced(e, 0)[1] === e.length) e = e.slice(1, -1).trim();
    const m = /^"?([a-z_][a-z0-9_]*)"?\s+IN\s*\(((?:\s*'(?:[^']|'')*'\s*,?)+)\)$/i.exec(e)
      ?? /^(?:\(?\s*"?([a-z_][a-z0-9_]*)"?\s+IS\s+NULL\s*\)?\s+OR\s+\(?\s*)"?\1"?\s+IN\s*\(((?:\s*'(?:[^']|'')*'\s*,?)+)\)\s*\)?$/i.exec(e);
    if (m) sets.set(m[1], new Set([...m[2].matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1])));
  }
  return sets;
}

// ------------------------------------------------------------------ INSERT parsing (fixture files and the probe preamble)
/** [{table, cols, rows: [[expr...]], file, pos}] for every `INSERT INTO s.t (cols) VALUES ...`; `bad` lists statements not in that form. */
function parseInserts(text, file, startPos = 0) {
  const inserts = [], bad = [];
  let pos = startPos;
  for (const st of splitStatements(text)) {
    pos++;
    const m = /^INSERT\s+INTO\s+([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)\s*\(([^)]*)\)\s*VALUES\s*([\s\S]*?)(?:\s+ON\s+CONFLICT\s+DO\s+NOTHING)?$/i.exec(st);
    if (!m) { bad.push(st.slice(0, 120)); continue; }
    const cols = m[2].split(",").map((c) => ident(c));
    const rows = tuples(m[3]).map((tp) => splitTop(tp));
    inserts.push({ table: m[1], cols, rows, file, pos, arityOk: rows.every((r) => r.length === cols.length) });
  }
  return { inserts, bad };
}
const fixtureFiles = () => (existsSync(join(REPO, FIX_DIR)) ? readdirSync(join(REPO, FIX_DIR)).filter((f) => f.endsWith(".sql")).sort() : []);
const SAMPLE_PROBE = "db/tests/isolation/core.users.test.sql";
const preambleOf = (probeText) => probeText.slice(probeText.indexOf("-- probe step 1: fixtures"), probeText.indexOf("-- probe step 1: preconditions"));
const incl = (probeText) => [...preambleOf(probeText).matchAll(/^\\ir\s+(\.\.\/fixtures\/probe-rows\/[^\s]+)\s*$/gm)].map((m) => m[1]);

/** Everything a probe's step 1 inserts, in execution order: the core preamble statements, then the included fixture files. */
function loadSequence(probeText = read(SAMPLE_PROBE)) {
  const pre = preambleOf(probeText);
  const head = pre.split(/^\\ir\s/m)[0]; // INSERTs written inline in the probe (core/audit/platform/event_inbox)
  const seq = parseInserts(head, "probe-preamble");
  seq.bad = []; // the preamble also holds SET / DO / function text: only fixture-file statements must be plain INSERTs
  const lastPre = Math.max(0, ...seq.inserts.map((i) => i.pos));
  // the per-schema event_inbox DO block (FOREACH ... ARRAY[...]): one row per tenant, read from its literal schema list
  const inboxSchemas = /FOREACH\s+s\s+IN\s+ARRAY\s+ARRAY\[([^\]]*)\]/i.exec(pre.replace(/--.*$/gm, ""));
  if (inboxSchemas && /INSERT INTO %I\.event_inbox \(tenant_id, event_id, event_type, created_by\)/.test(pre))
    for (const s of [...inboxSchemas[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]))
      seq.inserts.push({ table: `${s}.event_inbox`, cols: ["tenant_id", "event_id", "event_type", "created_by"], arityOk: true, file: "probe-preamble(DO)", pos: lastPre + 0.5,
        rows: [[A, "pg_temp.id('e1')", "'probe.event'", "pg_temp.id('99')"], [B, "pg_temp.id('e5')", "'probe.event'", "pg_temp.id('99')"]] });
  let pos = 1000;
  const order = incl(probeText);
  const perFile = {};
  for (const ref of order) {
    const f = ref.split("/").pop();
    const p = join(REPO, FIX_DIR, f);
    if (!existsSync(p)) { perFile[f] = { missing: true }; continue; }
    const r = parseInserts(readFileSync(p, "utf8"), f, pos);
    pos += 1000;
    perFile[f] = r;
    seq.inserts.push(...r.inserts);
    seq.bad.push(...r.bad.map((b) => `${f}: ${b}`));
  }
  return { ...seq, order, perFile };
}

// ------------------------------------------------------------------ exceptions CR
function exceptions() {
  if (!existsSync(join(REPO, CR_PATH))) return { exists: false, tables: new Map() };
  const tables = new Map();
  for (const line of read(CR_PATH).split(/\r?\n/)) {
    const m = /\b([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)\b\s*(?:[:|—–-]|\s)\s*(.*)$/.exec(line.replace(/[`*]/g, ""));
    if (m && PROBED.includes(m[1])) tables.set(m[1], m[2].replace(/^[|:\s-]+|[|\s]+$/g, ""));
  }
  return { exists: true, tables };
}

// ------------------------------------------------------------------ the static model of one probe run
const SEQ = loadSequence();
const byTable = new Map();
for (const ins of SEQ.inserts) { if (!byTable.has(ins.table)) byTable.set(ins.table, []); byTable.get(ins.table).push(ins); }
const EX = exceptions();
const rowsOf = (t) => (byTable.get(t) ?? []).flatMap((ins) => ins.rows.map((r) => Object.fromEntries(ins.cols.map((c, i) => [c, r[i]]))));
const has = (rows, col, lit) => rows.some((r) => r[col] !== undefined && norm(r[col]) === norm(lit));
const covered = (t) => byTable.has(t);
const testable = PROBED.filter((t) => !EX.tables.has(t)); // uncovered tables fail the content tests too (no vacuous pass)
const fixtureInserts = () => SEQ.inserts.filter((i) => !i.file.startsWith("probe-preamble"));
const needFixtures = () => assert.ok(fixtureInserts().length > 0, "no fixture INSERTs found: the probes do not \\ir db/tests/fixtures/probe-rows/*.sql yet");
/** assert an empty problem list, showing the count and the first 25 entries */
const none = (bad, what = "problems") => {
  const u = [...new Set(bad)];
  assert.equal(u.length, 0, `${u.length} ${what}:\n  ` + u.slice(0, 25).join("\n  ") + (u.length > 25 ? `\n  ... +${u.length - 25} more` : ""));
};

// ================================================================== tests
describe("T0B-DBSEED-1 harness sanity (the parser reads what the tests rely on)", () => {
  it("db/meta/tables.yaml probe registry: 438 tables, the generator's rule (class != G, not rls_exempt)", () => {
    assert.equal(PROBED.length, 438);
  });
  it("every probed table has a CREATE TABLE in db/migrations that the test parser read (columns match tables.yaml)", () => {
    const bad = [];
    for (const t of PROBED) {
      const mig = TABLES[t];
      if (!mig || mig.cols.size === 0) { bad.push(`${t}: not parsed from migrations`); continue; }
      const missing = Object.keys(META[t].columns).filter((c) => !mig.cols.has(c));
      if (missing.length) bad.push(`${t}: tables.yaml columns not in migrations: ${missing.join(",")}`);
    }
    none(bad);
  });
  it("foreign keys were read (>= 900) and each FK parent exists in the parsed migrations", () => {
    const fks = Object.values(TABLES).flatMap((t) => t.fks);
    assert.ok(fks.length >= 900, `only ${fks.length} FKs parsed`);
    const bad = [...new Set(fks.map((f) => f.parent).filter((p) => !TABLES[p]))];
    assert.deepEqual(bad, [], "FK parents the parser has no CREATE TABLE for");
  });
});

describe("AC-0B-3.1..3.7 / LD-233: fixtures exist (done_when: every table has rows or an exception with a reason)", () => {
  it("db/tests/fixtures/probe-rows holds only generated <registry-schema>.sql files with the GENERATED header", () => {
    const files = fixtureFiles();
    assert.ok(files.length > 0, `${FIX_DIR} has no fixture files: the generator does not emit module rows yet`);
    const schemas = new Set(PROBED.map((t) => t.split(".")[0]));
    const bad = [];
    for (const f of files) {
      if (!schemas.has(f.replace(/\.sql$/, ""))) bad.push(`${f}: not a registry schema`);
      if (!/^-- GENERATED by db\/tools\/gen-isolation-probes\.ts/.test(read(`${FIX_DIR}/${f}`))) bad.push(`${f}: missing the 'GENERATED by db/tools/gen-isolation-probes.ts' header`);
      if (!/Do not edit/.test(read(`${FIX_DIR}/${f}`).split("\n").slice(0, 3).join("\n"))) bad.push(`${f}: header lacks 'Do not edit'`);
    }
    none(bad);
  });

  it("every probed table has fixture rows (probe preamble or fixture files) or an entry with a reason in the exceptions CR", () => {
    const missing = PROBED.filter((t) => !covered(t) && !EX.tables.has(t));
    none(missing, "probed tables with neither rows nor an exception entry");
  });

  it("exceptions CR: exists only as .nonblocking.md, each entry names a probed table with a reason (>= 25 chars), none is also fixtured, count is small", () => {
    if (EX.tables.size === 0 && !EX.exists) return; // no exceptions needed is a legal outcome once every table has rows
    const bad = [];
    for (const [t, why] of EX.tables) {
      if (why.length < 25) bad.push(`${t}: reason too short ('${why}')`);
      if (covered(t)) bad.push(`${t}: listed as an exception but also has fixture rows`);
    }
    none(bad);
    assert.ok(EX.tables.size <= Math.floor(PROBED.length * 0.1), `${EX.tables.size} exceptions > 10% of ${PROBED.length}: a table may be excepted only when no valid synthetic row can be built without disabling a constraint`);
  });

  it("fixture files are statically readable: only INSERT INTO s.t (cols) VALUES ... [ON CONFLICT DO NOTHING]; arity matches; columns exist", () => {
    assert.ok(SEQ.order.length > 0, "the sample probe does not \\ir any fixture file");
    const bad = [...SEQ.bad.map((b) => `unreadable statement: ${b}`)];
    for (const ins of SEQ.inserts) {
      if (!ins.arityOk) bad.push(`${ins.file}: ${ins.table} has a VALUES tuple whose length differs from its column list`);
      for (const c of ins.cols) if (!TABLES[ins.table]?.cols.has(c)) bad.push(`${ins.file}: ${ins.table}.${c} is not a column in the migrations`);
    }
    none(bad);
  });

  it("no fixture file disables or alters anything (no constraint disabled: DDL, DISABLE, DROP, TRUNCATE, DELETE, UPDATE, CREATE, GRANT, SET are banned)", () => {
    needFixtures();
    const bad = [];
    for (const f of fixtureFiles()) {
      for (const st of splitStatements(read(`${FIX_DIR}/${f}`)))
        if (!/^INSERT\s+INTO\b/i.test(st)) bad.push(`${f}: non-INSERT statement: ${st.slice(0, 80)}`);
      if (/DISABLE\s+(TRIGGER|ROW\s+LEVEL|RULE)|NO\s+FORCE|DROP\s+(CONSTRAINT|TRIGGER|POLICY)|NOT\s+VALID|session_replication_role|\bTRUNCATE\b/i.test(stripComments(read(`${FIX_DIR}/${f}`))))
        bad.push(`${f}: contains a constraint/RLS/trigger-disabling construct`);
    }
    none(bad);
  });
});

describe("AC-0B-3.2/3.5/3.6: per-table fixture content (tenant A, tenant B, centres A1/A2, actor fixtures)", () => {
  it("every fixtured table has rows for tenant A and tenant B in its tenant column (tenant_id, or id on tables without tenant_id)", () => {
    const bad = [];
    for (const t of testable) {
      const rows = rowsOf(t), tc = tcolOf(t);
      if (!has(rows, tc, A)) bad.push(`${t}: no row with ${tc} = ${A}`);
      if (!has(rows, tc, B)) bad.push(`${t}: no row with ${tc} = ${B}`);
    }
    none(bad);
  });

  it("centre-scoped tables have tenant-A rows on centre A1 (id 21) and A2 (id 22) in the column the probe filters on", () => {
    const bad = [];
    for (const t of testable.filter((x) => META[x].centre_scoped)) {
      const cc = ccOf(t), rows = rowsOf(t).filter((r) => r.tenant_id !== undefined && norm(r.tenant_id) === norm(A));
      if (!(cc in META[t].columns)) { bad.push(`${t}: registry says centre_scoped but has no ${cc} column (list it in the exceptions CR)`); continue; }
      for (const [k, n] of [["21", "A1"], ["22", "A2"]]) if (!has(rows, cc, idLit(k))) bad.push(`${t}: no tenant A row with ${cc} = ${idLit(k)} (centre ${n})`);
    }
    none(bad);
  });

  it("a tenant-B row never sits on a tenant-A centre, a tenant-A row never on centre B1 (id 23)", () => {
    const bad = [];
    for (const t of testable.filter((x) => META[x].centre_scoped)) {
      const cc = ccOf(t);
      for (const r of rowsOf(t)) {
        if (r[cc] === undefined || isNull(r[cc]) || r.tenant_id === undefined) continue;
        const ten = norm(r.tenant_id), c = norm(r[cc]);
        if (ten === norm(B) && (c === norm(idLit("21")) || c === norm(idLit("22")))) bad.push(`${t}: tenant B row on tenant A centre ${r[cc]}`);
        if (ten === norm(A) && c === norm(idLit("23"))) bad.push(`${t}: tenant A row on tenant B centre`);
      }
    }
    none(bad);
  });

  it("shared_with tables have a row owned by each step-9 fixture actor: partner 35, portal a3, patient 34 (actor_id, else created_by)", () => {
    const bad = [];
    for (const t of testable.filter((x) => META[x].shared_with?.length)) {
      const oc = ownOf(t), rows = rowsOf(t);
      for (const a of ACTORS) if (!has(rows, oc, idLit(SUBS[a]))) bad.push(`${t}: no row with ${oc} = ${idLit(SUBS[a])} (${a} fixture actor)`);
    }
    none(bad);
  });
});

describe("constraints: rows satisfy NOT NULL, enum CHECK lists, PK/UNIQUE and foreign keys read from the migrations", () => {
  it("every NOT NULL column without a default is supplied (and not NULL) in every row of every fixtured table", () => {
    needFixtures();
    const bad = [];
    for (const ins of SEQ.inserts) {
      const mig = TABLES[ins.table];
      if (!mig) continue;
      const need = [...mig.cols].filter(([, c]) => c.notNull && !c.hasDefault).map(([n]) => n);
      const lack = need.filter((n) => !ins.cols.includes(n));
      if (lack.length) bad.push(`${ins.file}: ${ins.table} omits NOT NULL column(s) without default: ${lack.join(", ")}`);
      for (const row of ins.rows) for (const n of need) { const i = ins.cols.indexOf(n); if (i >= 0 && row[i] !== undefined && isNull(row[i])) bad.push(`${ins.file}: ${ins.table}.${n} = NULL`); }
    }
    none(bad);
  });

  it("CHECK (col IN ('a','b',..)) lists: literal values are members; enum-typed columns use a member", () => {
    needFixtures();
    const bad = [];
    for (const ins of SEQ.inserts) {
      const sets = checkSets(ins.table);
      for (const row of ins.rows) ins.cols.forEach((c, i) => {
        const v = row[i]?.trim() ?? "", lit = /^'((?:[^']|'')*)'(?:::[a-z_. ]+)?$/.exec(v);
        if (!lit) return;
        const set = sets.get(c) ?? ENUM_TYPES[(TABLES[ins.table]?.cols.get(c)?.type ?? "").replace(/^.*?([a-z_]+\.[a-z_]+).*$/i, "$1")];
        if (set && !set.has(lit[1])) bad.push(`${ins.file}: ${ins.table}.${c} = ${v} not in {${[...set].join("|")}}`);
      });
    }
    none(bad);
  });

  it("bytea values with a literal length satisfy `octet_length(col) = N` CHECKs (LD-230 6: 2-byte email_hmac regression)", () => {
    needFixtures();
    const bad = [];
    const len = (v) => { let m;
      if ((m = /^decode\(\s*repeat\(\s*'([0-9a-f]{2})'\s*,\s*(\d+)\s*\)\s*,\s*'hex'\s*\)$/i.exec(v.trim()))) return Number(m[2]);
      if ((m = /^decode\(\s*'([0-9a-f]*)'\s*,\s*'hex'\s*\)$/i.exec(v.trim()))) return m[1].length / 2;
      if ((m = /^'\\x([0-9a-f]*)'(?:::bytea)?$/i.exec(v.trim()))) return m[1].length / 2;
      return null; };
    for (const ins of SEQ.inserts) {
      const eq = new Map();
      for (const ck of TABLES[ins.table]?.checks ?? []) for (const m of ck.matchAll(/octet_length\(\s*"?([a-z_][a-z0-9_]*)"?\s*\)\s*=\s*(\d+)/gi)) eq.set(m[1], Number(m[2]));
      for (const row of ins.rows) ins.cols.forEach((c, i) => { const n = eq.get(c); const l = n === undefined ? null : len(row[i] ?? ""); if (l !== null && l !== n) bad.push(`${ins.file}: ${ins.table}.${c} is ${l} bytes, CHECK needs ${n}`); });
    }
    none(bad);
  });

  it("no duplicate primary key / UNIQUE key among the rows of one table (ON CONFLICT DO NOTHING would silently drop the second row)", () => {
    needFixtures();
    const bad = [];
    for (const [t, inss] of byTable) {
      const mig = TABLES[t];
      if (!mig) continue;
      const rows = inss.flatMap((ins) => ins.rows.map((r) => Object.fromEntries(ins.cols.map((c, i) => [c, r[i]]))));
      for (const key of [mig.pk, ...mig.uniques].filter((k) => k.length)) {
        const seen = new Set();
        for (const r of rows) {
          if (key.some((c) => r[c] === undefined || isNull(r[c]))) continue; // defaulted or NULL: not comparable
          const k = key.map((c) => norm(r[c])).join("|");
          if (seen.has(k)) bad.push(`${t}: duplicate key (${key.join(",")}) = ${k}`);
          seen.add(k);
        }
      }
    }
    none(bad);
  });

  it("referential integrity: every non-NULL FK of every fixture row points at a fixture row of the parent (parent tables with fixtures)", () => {
    needFixtures();
    const bad = [];
    for (const [t, inss] of byTable) {
      const mig = TABLES[t];
      if (!mig) continue;
      for (const fk of mig.fks) {
        if (fk.parent === t || !byTable.has(fk.parent)) continue; // self-reference, or a parent seeded elsewhere (G tables) / excepted: out of static reach
        const parentRows = rowsOf(fk.parent);
        const keys = new Set(parentRows.filter((r) => fk.pcols.every((c) => r[c] !== undefined && !isNull(r[c]))).map((r) => fk.pcols.map((c) => norm(r[c])).join("|")));
        for (const ins of inss) for (const row of ins.rows) {
          const idx = fk.cols.map((c) => ins.cols.indexOf(c));
          if (idx.some((i) => i < 0)) continue;
          const vals = idx.map((i) => row[i]);
          if (vals.some((v) => isNull(v))) continue; // MATCH SIMPLE: a NULL column skips the check
          const k = vals.map(norm).join("|");
          if (!keys.has(k)) bad.push(`${t} (${fk.cols.join(",")}) = ${k} -> no ${fk.parent} (${fk.pcols.join(",")}) row`);
        }
      }
    }
    none(bad);
  });
});

describe("foreign-key dependency order (valid topological order of the FKs read from the migrations)", () => {
  it("the include order is one global order: every probe has the same \\ir list, covering every fixture file, inside the step-1 replica window", () => {
    const files = fixtureFiles();
    assert.ok(files.length > 0, "no fixture files");
    const want = JSON.stringify(SEQ.order);
    const bad = [];
    const probes = readdirSync(join(REPO, "db/tests/isolation")).filter((f) => /^[a-z_]+\.[a-z_]+\.test\.sql$/.test(f));
    for (const f of probes) {
      const txt = read(`db/tests/isolation/${f}`);
      if (JSON.stringify(incl(txt)) !== want) bad.push(`${f}: \\ir list differs from the other probes`);
      const pre = preambleOf(txt), firstIr = pre.search(/^\\ir\s+\.\.\/fixtures\/probe-rows\//m), lastOrigin = pre.lastIndexOf("SET LOCAL session_replication_role = origin;");
      const replica = pre.indexOf("SET LOCAL session_replication_role = replica;");
      if (!(replica >= 0 && replica < firstIr && firstIr < lastOrigin)) bad.push(`${f}: \\ir not inside the replica window (replica < \\ir < origin)`);
    }
    none(bad);
    assert.deepEqual([...SEQ.order].map((x) => x.split("/").pop()).sort(), files, "the \\ir list must name exactly the files in the fixture dir");
  });

  it("for every FK child -> parent (parent != child, both with rows): all parent INSERTs precede the first child INSERT", () => {
    const first = new Map(), last = new Map();
    for (const ins of SEQ.inserts) { const p = ins.file === "probe-preamble" ? ins.pos : ins.pos; if (!first.has(ins.table)) first.set(ins.table, p); last.set(ins.table, p); }
    // strongly connected components: edges inside a cycle have no valid order and are exempt (self-references included)
    const nodes = [...byTable.keys()], adj = new Map(nodes.map((n) => [n, new Set()]));
    for (const t of nodes) for (const fk of TABLES[t]?.fks ?? []) if (adj.has(fk.parent) && fk.parent !== t) adj.get(t).add(fk.parent);
    const idx = new Map(), low = new Map(), onS = new Set(), stack = [], comp = new Map();
    let n = 0, c = 0;
    const dfs = (v) => { idx.set(v, n); low.set(v, n++); stack.push(v); onS.add(v);
      for (const w of adj.get(v)) { if (!idx.has(w)) { dfs(w); low.set(v, Math.min(low.get(v), low.get(w))); } else if (onS.has(w)) low.set(v, Math.min(low.get(v), idx.get(w))); }
      if (low.get(v) === idx.get(v)) { let w; do { w = stack.pop(); onS.delete(w); comp.set(w, c); } while (w !== v); c++; } };
    for (const v of nodes) if (!idx.has(v)) dfs(v);
    const bad = [];
    let edges = 0;
    for (const t of nodes) for (const fk of TABLES[t]?.fks ?? []) {
      if (fk.parent === t || !byTable.has(fk.parent) || comp.get(t) === comp.get(fk.parent)) continue;
      edges++;
      if (!(last.get(fk.parent) < first.get(t))) bad.push(`${t} is inserted before/with its parent ${fk.parent} (FK ${fk.cols.join(",")})`);
    }
    assert.ok(edges >= 300, `only ${edges} FK edges were checked: fixtures too sparse (or parser broken)`);
    none(bad);
  });
});

describe("only probe ids appear: tenants, centres, actors and every uuid literal (REQ-SEC-041/136 synthetic only)", () => {
  const sysActors = new Set([...read("db/seeds/002_core__g_system_actors.sql").matchAll(/'([0-9a-f-]{36})'/g)].map((m) => m[1]));
  it("the tenant column holds only pg_temp.id('01') or pg_temp.id('02') in every fixture row", () => {
    needFixtures();
    const bad = [];
    for (const ins of SEQ.inserts.filter((i) => i.file !== "probe-preamble" && i.file !== "probe-preamble(DO)")) {
      const tc = tcolOf(ins.table);
      if (!ins.cols.includes(tc)) continue;
      for (const row of ins.rows) { const v = norm(row[ins.cols.indexOf(tc)]); if (v !== norm(A) && v !== norm(B)) bad.push(`${ins.file}: ${ins.table}.${tc} = ${v}`); }
    }
    none(bad);
  });
  it("no uuid literal in a fixture file other than the pg_temp.id family or a seeded system actor; pg_temp.id keys are 2 hex digits; no gen_random_uuid()", () => {
    needFixtures();
    const bad = [];
    for (const f of fixtureFiles()) {
      const txt = stripComments(read(`${FIX_DIR}/${f}`));
      for (const m of txt.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi))
        if (!/^01900000-0000-7000-8000-0000000000[0-9a-f]{2}$/i.test(m[0]) && !sysActors.has(m[0].toLowerCase())) bad.push(`${f}: uuid literal ${m[0]}`);
      for (const m of txt.matchAll(/pg_temp\.id\(\s*'([^']*)'\s*\)/g)) if (!/^[0-9a-f]{2}$/i.test(m[1])) bad.push(`${f}: pg_temp.id('${m[1]}') (lpad truncates keys longer than 2)`);
      if (/gen_random_uuid|uuid_generate|random\(\)|clock_timestamp|statement_timestamp/i.test(txt)) bad.push(`${f}: non-deterministic expression`);
    }
    none(bad);
  });
  it("synthetic only: e-mail addresses use reserved domains (example.com/org/net, *.test, *.invalid, *.example, *.localhost)", () => {
    needFixtures();
    const bad = [];
    for (const f of fixtureFiles())
      for (const m of read(`${FIX_DIR}/${f}`).matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+)/g))
        if (!/(^|\.)(example\.(com|org|net)|test|invalid|example|localhost)$/i.test(m[1])) bad.push(`${f}: ${m[0]}`);
    none(bad);
  });
  it("db/seeds is unchanged: same file list and content (nothing added: push-cloud.ps1 applies db/seeds to staging)", () => {
    const BASE = {
      "001_core__g_permissions.sql": null, "002_core__g_system_actors.sql": null, "003_audit__g_cs_access_actions.sql": null,
      "004_reporting__g_message_templates.sql": null, "010_core__synthetic_tenants.sql": null,
    };
    const files = readdirSync(join(REPO, "db/seeds")).sort();
    assert.deepEqual(files, Object.keys(BASE), "db/seeds gained or lost a file");
    const r = spawnSync("git", ["diff", "--stat", BASELINE_COMMIT, "--", "db/seeds"], { cwd: REPO, encoding: "utf8" });
    if (r.status === 0) assert.equal(r.stdout.trim(), "", `db/seeds differs from ${BASELINE_COMMIT}:\n${r.stdout}`);
    const st = spawnSync("git", ["status", "--porcelain", "--", "db/seeds"], { cwd: REPO, encoding: "utf8" });
    assert.equal(st.stdout.trim(), "", "uncommitted changes under db/seeds");
    for (const f of files) assert.doesNotMatch(read(`db/seeds/${f}`), /pg_temp\.id\(|probe_a|probe_b/, `${f} carries probe fixtures`);
  });
});

describe("generator: deterministic, gated by --check, and nothing in the probe assertions is weakened", () => {
  const tmps = [];
  after(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
  const gen = (args) => spawnSync(process.execPath, ["db/tools/gen-isolation-probes.ts", ...args], { cwd: REPO, encoding: "utf8" });
  const tree = (root) => { const o = {}; const w = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) w(p); else o[p.slice(root.length)] = createHash("sha256").update(readFileSync(p)).digest("hex"); } }; w(root); return o; };
  const fresh = () => { const d = mkdtempSync(join(tmpdir(), "dbseed-")); tmps.push(d); mkdirSync(join(d, "isolation"), { recursive: true }); return d; };

  it("--check passes on the committed tree (generated-files gate: probes AND fixtures current)", () => {
    const r = gen(["--check"]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.ok(fixtureFiles().length > 0, "--check passes but there are no fixture files: the gate covers nothing");
  });

  it("output is deterministic: two runs into fresh dirs are byte-identical and equal to the committed probes and fixtures", () => {
    const d1 = fresh(), d2 = fresh();
    assert.equal(gen(["--out", join(d1, "isolation")]).status, 0);
    assert.equal(gen(["--out", join(d2, "isolation")]).status, 0);
    const t1 = tree(d1), t2 = tree(d2);
    assert.deepEqual(t1, t2, "generator output differs between two runs");
    const fx = Object.keys(t1).filter((k) => /fixtures[\\/]probe-rows[\\/]/.test(k));
    assert.ok(fx.length > 0, "generator wrote no fixtures/probe-rows/*.sql next to --out");
    for (const k of fx) assert.equal(t1[k], createHash("sha256").update(readFileSync(join(REPO, FIX_DIR, k.split(/[\\/]/).pop()))).digest("hex"), `${k} differs from the committed file`);
  });

  // reviewer CHANGES 1c/2 (T0B-DBSEED-1-review.md): the generator must not emit a row it knows is invalid or will be dropped.
  const reportWarnings = () => {
    const d = fresh(), r = gen(["--report", "--out", join(d, "isolation")]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    return r.stderr.split(/\r?\n/).filter((l) => /: warning: /.test(l)).map((l) => l.replace(/^.*?: warning: /, ""));
  };
  it("--report prints no 'CHECK not satisfied statically' line: no emitted row is known to violate a CHECK (e.g. micro.instrument_records__payload__ck)", () => {
    none(reportWarnings().filter((w) => /CHECK not satisfied statically/.test(w)), "rows statically failing a CHECK");
  });
  it("--report: no non-excepted table has a slot that a partial UNIQUE index would drop under ON CONFLICT DO NOTHING (step-1 actor/tenant/centre preconditions)", () => {
    none(reportWarnings().filter((w) => /collides with a partial UNIQUE index/.test(w)).filter((w) => !EX.tables.has(w.split(":")[0])), "dropped slots not listed in the exceptions CR");
  });

  it("--check fails on a missing, edited or orphan fixture file (fixtures are inside the gate)", () => {
    const d = fresh();
    assert.equal(gen(["--out", join(d, "isolation")]).status, 0);
    const fdir = join(d, "fixtures", "probe-rows");
    assert.ok(existsSync(fdir), "no fixtures/probe-rows next to --out");
    const files = readdirSync(fdir).filter((f) => f.endsWith(".sql"));
    assert.ok(files.length > 0);
    assert.equal(gen(["--check", "--out", join(d, "isolation")]).status, 0, "fresh output must pass --check");
    const f = join(fdir, files[0]), orig = readFileSync(f);
    writeFileSync(f, Buffer.concat([orig, Buffer.from("\n-- tamper\nSELECT 1;\n")]));
    assert.notEqual(gen(["--check", "--out", join(d, "isolation")]).status, 0, "an edited fixture file must fail --check");
    writeFileSync(f, orig); rmSync(f);
    assert.notEqual(gen(["--check", "--out", join(d, "isolation")]).status, 0, "a deleted fixture file must fail --check");
    writeFileSync(f, orig); writeFileSync(join(fdir, "zz_orphan.sql"), "-- orphan\n");
    assert.notEqual(gen(["--check", "--out", join(d, "isolation")]).status, 0, "an orphan fixture file must fail --check");
  });

  it("no assertion removed or weakened: every probe equals its baseline except the step-1 fixture block (helpers prefix and all steps from 'preconditions' on are byte-identical)", () => {
    const probe = read(SAMPLE_PROBE);
    assert.ok(/^\\ir\s+\.\.\/fixtures\/probe-rows\//m.test(probe), "the probes do not include the fixtures yet");
    const probes = readdirSync(join(REPO, "db/tests/isolation")).filter((f) => /^[a-z_]+\.[a-z_]+\.test\.sql$/.test(f));
    const probeGit = spawnSync("git", ["cat-file", "-e", `${BASELINE_COMMIT}^{commit}`], { cwd: REPO });
    assert.equal(probeGit.status, 0, `baseline commit ${BASELINE_COMMIT} not in this clone: cannot prove no assertion was weakened (fetch history)`);
    const bad = [];
    for (const f of probes) {
      const g = spawnSync("git", ["show", `${BASELINE_COMMIT}:db/tests/isolation/${f}`], { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 26 });
      if (g.status !== 0) { bad.push(`${f}: not in baseline (new probe: add it to the baseline list deliberately)`); continue; }
      const old = g.stdout.replace(/\r\n/g, "\n"), now = read(`db/tests/isolation/${f}`).replace(/\r\n/g, "\n");
      const cut = old.indexOf("-- probe step 1: fixtures");
      if (!now.startsWith(old.slice(0, cut))) bad.push(`${f}: helper preamble changed`);
      const tail = (s) => s.slice(s.indexOf("-- probe step 1: preconditions"));
      if (tail(now) !== tail(old)) bad.push(`${f}: assertions from step 1 'preconditions' onward changed`);
      const win = (x) => x.slice(x.indexOf("SET LOCAL session_replication_role = replica;"), x.indexOf("SET LOCAL session_replication_role = origin;", x.indexOf("-- probe step 1: fixtures"))).replace(/\s+/g, " ").trim();
      if (!now.replace(/\s+/g, " ").includes(win(old))) bad.push(`${f}: a core preamble INSERT of the baseline was removed or changed`);
    }
    none(bad);
  });
});

describe("notes: the lane states it could not run SQL (done_when)", () => {
  it(".orchestra/notes/T0B-DBSEED-1-impl.md says the lane could not run SQL and names the founder rerun", () => {
    const p = ".orchestra/notes/T0B-DBSEED-1-impl.md";
    assert.ok(existsSync(join(REPO, p)), `${p} missing (writer notes)`);
    const t = read(p);
    assert.match(t, /(could\s*not|cannot|can't|no)\s+(run\s+SQL|Docker)|(SQL|Docker)[^.\n]*(not available|unavailable|not run)/i, "notes must state that the lane could not run SQL");
    assert.match(t, /run-suites\.sh/, "notes must name the founder rerun (LIMS_SKIP_GEN=1 bash db/tests/run-suites.sh <probes>)");
  });
});
