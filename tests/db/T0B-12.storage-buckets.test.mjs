// T0B-12 — Storage buckets (08 §4.8, R26) created PRIVATE; end-user storage policies only if SP-4 passed. REQ-SEC-034 (+035 no signed URL in the migration).
// Spec: 08-CR-REGISTER §4.8 + R12b + R26; 05-SCHEMA §8; db/meta/decisions/SP-4.md (Outcome: api-proxied => NO policy on storage.objects, buckets only);
//       07-SECURITY row REQ-SEC-034/035 and §7 (db/migrations/*_storage__*.sql is the one place that may name Supabase-served objects).
// No database needed: static analysis of db/migrations + a check of the live pgTAP file. Live half: db/tests/storage/T0B-12_storage.test.sql (run-suites.sh).
//
// CONTRACT for the implementation (tester-defined where the spec is silent; dispute via .orchestra/notes if wrong):
//   * ONE migration  db/migrations/<14-digit ts>_storage__create_buckets.sql  (or ..._storage__create_policies.sql: the plan-row name; SP-4 says it holds
//     buckets only). Stamped after the frontdesk, billing and reporting migrations.
//   * It inserts the 11 buckets of 08 §4.8 (all except the reserved `reporting-legacy`) into storage.buckets with public = false, and the INSERT is
//     `ON CONFLICT (id) DO UPDATE SET public = false` (a bucket pre-created public by the Storage service must be flipped private, not skipped).
//   * No other bucket name. No CREATE/ALTER POLICY on storage.* or realtime.*, no GRANT on storage objects to anon/authenticated/PUBLIC, anywhere.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(join(REPO, p), "utf8");
const stripSql = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--.*$/gm, "");
const ls = (d, re) => (existsSync(join(REPO, d)) ? readdirSync(join(REPO, d)).filter((f) => re.test(f)).sort() : []);

// ---- expected buckets, parsed from the spec table (not hard-coded): | `name` | owner (Cn) | ...
const spec = read("spec/program/08-CR-REGISTER.md");
const sec = spec.slice(spec.indexOf("### 4.8 Storage buckets"), spec.indexOf("### 4.9 Published views"));
const rows = [...sec.matchAll(/^\|\s*`([a-z]+(?:-[a-z]+)*)`\s*\|\s*([a-z]+)/gm)].map((m) => ({ name: m[1], owner: m[2] }));
const RESERVED = "reporting-legacy";
const EXPECTED = rows.filter((r) => r.name !== RESERVED);
const NAMES = EXPECTED.map((r) => r.name).sort();

// ---- detectors (self-tested below, then applied to the repo)
function bucketStatement(sql) {
  const m = stripSql(sql).match(/\bINSERT\s+INTO\s+storage\.buckets\b[\s\S]*?;/i);
  return m ? m[0] : null;
}
function endUserStorageAccess(file, sql) {
  const v = [];
  for (const st of stripSql(sql).split(";")) {
    if (/\b(CREATE|ALTER)\s+POLICY\b[\s\S]*?\bON\s+"?(storage|realtime)"?\./i.test(st)) v.push(`${file}: policy on storage/realtime object`);
    if (/\bGRANT\b/i.test(st) && /\bstorage\b/i.test(st) && /\b(anon|authenticated|public)\b/i.test(st)) v.push(`${file}: GRANT on storage to an end-user role`);
    if (/\bALTER\s+DEFAULT\s+PRIVILEGES\b[\s\S]*\bIN\s+SCHEMA\s+storage\b/i.test(st)) v.push(`${file}: default privileges in schema storage`);
    if (/\bALTER\s+TABLE\b[\s\S]*\bstorage\.[\s\S]*\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i.test(st)) v.push(`${file}: RLS disabled on storage table`);
    if (/\bUPDATE\s+storage\.buckets\b[\s\S]*\bpublic\s*=\s*true\b/i.test(st)) v.push(`${file}: bucket made public`);
  }
  return v;
}

describe("detector self-tests — the checks must reject bad input before they are trusted on the repo", () => {
  const bad = {
    policy: "CREATE POLICY reports__select__tenant ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'reports');",
    realtime: "CREATE POLICY p ON realtime.messages FOR SELECT TO authenticated USING (true);",
    grant: "GRANT SELECT ON storage.objects TO authenticated;",
    grantAnon: "GRANT ALL ON ALL TABLES IN SCHEMA storage TO anon;",
    defpriv: "ALTER DEFAULT PRIVILEGES IN SCHEMA storage GRANT SELECT ON TABLES TO authenticated;",
    rls: "ALTER TABLE storage.objects DISABLE ROW LEVEL SECURITY;",
    pub: "UPDATE storage.buckets SET public = true WHERE id = 'reports';",
  };
  for (const [k, sql] of Object.entries(bad)) it(`flags ${k}`, () => assert.ok(endUserStorageAccess("x.sql", sql).length >= 1, `not flagged: ${sql}`));
  it("ignores a policy named only in a comment and a GRANT to a LIMS role", () => {
    assert.deepEqual(
      endUserStorageAccess("x.sql", "-- CREATE POLICY a ON storage.objects FOR SELECT;\n/* GRANT SELECT ON storage.objects TO authenticated; */\nGRANT SELECT ON core.tenants TO lims_app;"),
      [],
    );
  });
  it("bucketStatement ignores a commented INSERT and finds a real one", () => {
    assert.equal(bucketStatement("-- INSERT INTO storage.buckets (id) VALUES ('x');"), null);
    assert.match(bucketStatement("INSERT INTO storage.buckets (id, name, public) VALUES ('reports','reports',false);"), /VALUES/);
  });
});

describe("spec parse sanity (08 §4.8)", () => {
  it("11 creatable buckets + the reserved reporting-legacy", () => {
    assert.equal(rows.length, 12, `parsed ${rows.map((r) => r.name)}`);
    assert.equal(EXPECTED.length, 11);
    assert.ok(rows.some((r) => r.name === RESERVED));
  });
  it("names follow <owner-module>-<purpose>; only `reports` is the exception (R26)", () => {
    for (const r of EXPECTED) assert.ok(r.name === "reports" || r.name.startsWith(`${r.owner}-`), `${r.name} vs owner ${r.owner}`);
  });
});

describe("SP-4 outcome gates what T0B-12 may create", () => {
  it("SP-4 decided api-proxied (if this changes, the policy half of T0B-12 needs new tests)", () => {
    assert.match(read("db/meta/decisions/SP-4.md"), /outcome[^\n]*\bapi-proxied\b/i);
  });
});

const files = ls("db/migrations", /_storage__.*\.sql$/);
describe("REQ-SEC-034 — bucket migration", () => {
  it("exactly one *_storage__create_(buckets|policies).sql exists, stamped after frontdesk, billing and reporting migrations", () => {
    assert.equal(files.length, 1, `db/migrations/*_storage__*.sql: ${JSON.stringify(files)}`);
    assert.match(files[0], /^\d{14}_storage__create_(buckets|policies)\.sql$/);
    const deps = ls("db/migrations", /_(frontdesk|billing|reporting)__/);
    assert.ok(deps.length >= 3);
    for (const d of deps) assert.ok(files[0].slice(0, 14) > d.slice(0, 14), `${files[0]} must sort after ${d}`);
  });

  const sql = () => (files.length ? read(`db/migrations/${files[0]}`) : "");
  const stmt = () => {
    const s = bucketStatement(sql());
    assert.ok(s, "no INSERT INTO storage.buckets statement (outside comments)");
    return s;
  };

  it("every 08 §4.8 bucket (except reserved reporting-legacy) is created, by its verbatim name", () => {
    const s = stmt();
    for (const n of NAMES) assert.ok(s.includes(`'${n}'`), `bucket '${n}' missing from the INSERT`);
  });
  it("creates no other bucket: no reporting-legacy, no analytics-exports/catalog-files, no legacy generic names", () => {
    const s = stmt();
    for (const m of s.matchAll(/'([a-z]+(?:-[a-z]+)+)'/g)) assert.ok(NAMES.includes(m[1]), `unexpected bucket literal '${m[1]}'`);
    for (const g of [RESERVED, "exports", "trf", "tenant-assets", "report-inputs", "report-prints", "instrument-attachments", "analytics-exports", "catalog-files"])
      assert.ok(!s.includes(`'${g}'`), `'${g}' must not be created`);
  });
  it("sets the public column and never to true (all buckets private)", () => {
    const s = stmt();
    assert.match(s, /\(\s*[^)]*\bpublic\b[^)]*\)\s*(VALUES|SELECT)/i, "column list must name public explicitly");
    assert.doesNotMatch(s, /\btrue\b/i, "no `true` anywhere in the bucket INSERT");
    assert.match(s, /\bfalse\b/i);
    for (const n of NAMES) {
      const t = s.match(new RegExp(`\\(\\s*'${n}'\\s*,[^)]*\\)`));
      if (t) assert.match(t[0], /\bfalse\b/i, `tuple of '${n}' must set public false: ${t[0]}`);
    }
  });
  it("re-run/pre-existing bucket is forced private: ON CONFLICT (id) DO UPDATE SET public = false (not DO NOTHING)", () => {
    assert.match(stmt(), /ON\s+CONFLICT\s*\(\s*id\s*\)\s+DO\s+UPDATE\s+SET[\s\S]*\bpublic\s*=\s*(false|EXCLUDED\.public)\b/i);
  });
  it("no signed URL / key / token material in the migration (REQ-SEC-035, 07-SECURITY §7)", () => {
    assert.ok(files.length, "migration missing");
    assert.doesNotMatch(stripSql(sql()), /https?:\/\/|eyJ[A-Za-z0-9_-]{10,}|signedUrl|service_role|SUPABASE_[A-Z_]*KEY/);
  });
});

describe("SP-4 api-proxied — no end-user access to Storage or Realtime objects is created anywhere", () => {
  for (const d of ["db/migrations", "db/policies", "db/seeds", "db/bootstrap"])
    for (const f of ls(d, /\.sql$/)) it(`${d}/${f}`, () => assert.deepEqual(endUserStorageAccess(`${d}/${f}`, read(`${d}/${f}`)), []));
  it("the scan covered the migration set (not vacuous)", () => assert.ok(ls("db/migrations", /\.sql$/).length >= 20));
});

describe("repo gate: check-migrations accepts the migration set", () => {
  it("node db/tools/check-migrations.ts exits 0", () => {
    const r = spawnSync(process.execPath, [join(REPO, "db/tools/check-migrations.ts")], { cwd: REPO, encoding: "utf8", timeout: 120000 });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  });
});

describe("live pgTAP probe file exists and carries the REQ-SEC-034 probes (executed by db/tests/run-suites.sh; not run here)", () => {
  const p = "db/tests/storage/T0B-12_storage.test.sql";
  const body = () => {
    assert.ok(existsSync(join(REPO, p)), `${p} missing`);
    return stripSql(read(p));
  };
  it("covers bucket set, privacy, no policies, RLS on, authenticated + anon cross-tenant read/write/delete", () => {
    const b = body();
    for (const re of [/storage\.buckets/, /storage\.objects/, /pg_policies/, /relrowsecurity/, /'authenticated'/, /'anon'/, /request\.jwt\.claims/, /reporting-legacy/, /ROLLBACK;/])
      assert.match(b, re, `pgTAP file lacks ${re}`);
    assert.match(read(p), /REQ-SEC-034/);
    for (const n of NAMES) assert.ok(b.includes(n), `pgTAP file does not mention bucket ${n}`);
  });
  it("never disables RLS or relaxes row_security (AC-0B-2.4)", () => {
    assert.doesNotMatch(body(), /DISABLE\s+ROW\s+LEVEL\s+SECURITY|row_security\s*(=|TO)\s*off|BYPASSRLS/i);
  });
});
