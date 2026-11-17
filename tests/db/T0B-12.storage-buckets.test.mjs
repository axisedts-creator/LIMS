// T0B-12 — Storage buckets (08 §4.8, R26) private; no end-user storage policies (SP-4 api-proxied). REQ-SEC-034 (+035 no signed URL / key in files).
// LD-54 (2026-11-07, CR-C0-T0B-12 option b): SQL never touches the Storage-owned schema `storage` (no GRANT, no policy, no INSERT into storage.buckets).
//   Buckets are ensured by the idempotent script db/provisioning/create-storage-buckets.mjs through the Storage service HTTP API with the server credential.
//   The live run against the real Storage service is NOT part of this task: first-deploy smoke test in db/provisioning/README.md
//   (then db/tests/storage/T0B-12_storage.test.sql, which is a post-provisioning probe, not run by the DB harness).
// Spec: 08-CR-REGISTER §4.8 + R12b + R26; 05-SCHEMA §8; db/meta/decisions/SP-4.md; 07-SECURITY REQ-SEC-034/035.
//
// STATUS: static checks + the "contract recorded" gate below. The stub-HTTP-server behaviour tests (idempotency, flip public -> private, auth header,
//   failure paths) are NOT written: the Storage service URL env name and the bucket admin endpoints are not recorded in db/meta/decisions/SP-4.md or the
//   C0/C1 TRD (only the credential file env LIMS_CORE_STORAGE_KEY_FILE is). LD-54 forbids guessing -> .orchestra/cr/T0B-12.provisioning-contract.md.
//
// CONTRACT for the implementation (tester-defined where the spec is silent; dispute via .orchestra/notes if wrong):
//   * db/provisioning/create-storage-buckets.mjs (ES module, parses with `node --check`) names the 11 buckets of 08 §4.8 verbatim (not reporting-legacy),
//     sends public:false for every bucket (never true), reads the credential only from the file named by LIMS_CORE_STORAGE_KEY_FILE, hard-codes no key/URL.
//   * db/migrations/*_storage__*.sql: none, or comment-only (ledger placeholder). No SQL in db/{migrations,policies,seeds,bootstrap} references schema storage.
//   * db/provisioning/README.md records the first-deploy smoke test and says it is not run by CI/the task.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(join(REPO, p), "utf8");
const stripSql = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--.*$/gm, "");
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\\'"`])\/\/.*$/gm, "$1");
const ls = (d, re) => (existsSync(join(REPO, d)) ? readdirSync(join(REPO, d)).filter((f) => re.test(f)).sort() : []);

// ---- expected buckets, parsed from the spec table (not hard-coded): | `name` | owner (Cn) | ...
const spec = read("spec/program/08-CR-REGISTER.md");
const sec = spec.slice(spec.indexOf("### 4.8 Storage buckets"), spec.indexOf("### 4.9 Published views"));
const rows = [...sec.matchAll(/^\|\s*`([a-z]+(?:-[a-z]+)*)`\s*\|\s*([a-z]+)/gm)].map((m) => ({ name: m[1], owner: m[2] }));
const RESERVED = "reporting-legacy";
const EXPECTED = rows.filter((r) => r.name !== RESERVED);
const NAMES = EXPECTED.map((r) => r.name).sort();

// ---- detector (self-tested below, then applied to the repo): SQL that touches the Storage-owned schema
function touchesStorageSchema(file, sql) {
  const v = [];
  const s = stripSql(sql).replace(/'(?:[^']|'')*'/g, "''"); // string literals do not count (e.g. a text value 'storage')
  if (/\bstorage\s*\.\s*[a-z_"]/i.test(s)) v.push(`${file}: qualified storage.<object>`);
  if (/"storage"\s*\./i.test(s)) v.push(`${file}: quoted "storage".<object>`);
  if (/\b(SCHEMA|IN\s+SCHEMA)\s+"?storage\b/i.test(s)) v.push(`${file}: SCHEMA storage (GRANT/DEFAULT PRIVILEGES/CREATE/SET)`);
  if (/\bsearch_path\b[^;]*\bstorage\b/i.test(s)) v.push(`${file}: storage on a search_path`);
  if (/\b(CREATE|ALTER)\s+POLICY\b[\s\S]*?\bON\s+"?realtime"?\./i.test(s)) v.push(`${file}: policy on realtime object`);
  return v;
}

describe("detector self-tests — the check must reject bad input before it is trusted on the repo", () => {
  const bad = {
    insert: "INSERT INTO storage.buckets (id, name, public) VALUES ('reports','reports',false);",
    policy: "CREATE POLICY p ON storage.objects FOR SELECT TO authenticated USING (true);",
    grant: "GRANT USAGE ON SCHEMA storage TO lims_owner;",
    grantTable: "GRANT SELECT, INSERT ON storage.buckets TO lims_owner;",
    quoted: 'UPDATE "storage".buckets SET public = false;',
    defpriv: "ALTER DEFAULT PRIVILEGES IN SCHEMA storage GRANT SELECT ON TABLES TO authenticated;",
    path: "SET LOCAL search_path = app, storage;",
    realtime: "CREATE POLICY p ON realtime.messages FOR SELECT TO authenticated USING (true);",
  };
  for (const [k, sql] of Object.entries(bad)) it(`flags ${k}`, () => assert.ok(touchesStorageSchema("x.sql", sql).length >= 1, `not flagged: ${sql}`));
  it("ignores comments, string literals and a column storage clause", () => {
    assert.deepEqual(
      touchesStorageSchema(
        "x.sql",
        "-- INSERT INTO storage.buckets (id) VALUES ('x');\n/* GRANT USAGE ON SCHEMA storage TO a; */\nALTER TABLE a.b ALTER COLUMN c SET STORAGE EXTERNAL;\nINSERT INTO a.b(k) VALUES ('storage.objects');",
      ),
      [],
    );
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

describe("LD-54 — no SQL file references schema storage (REQ-SEC-034: SQL never touches the Storage-owned schema)", () => {
  const storageFiles = ls("db/migrations", /_storage__.*\.sql$/);
  it("no *_storage__*.sql migration holds any statement (deleted, or comment-only ledger placeholder)", () => {
    for (const f of storageFiles) assert.equal(stripSql(read(`db/migrations/${f}`)).trim(), "", `db/migrations/${f} still has executable SQL`);
  });
  for (const d of ["db/migrations", "db/policies", "db/seeds", "db/bootstrap"])
    for (const f of ls(d, /\.sql$/)) it(`${d}/${f}`, () => assert.deepEqual(touchesStorageSchema(`${d}/${f}`, read(`${d}/${f}`)), []));
  it("the scan covered the migration set (not vacuous)", () => assert.ok(ls("db/migrations", /\.sql$/).length >= 20));
});

describe("repo gate: check-migrations accepts the migration set", () => {
  it("node db/tools/check-migrations.ts exits 0", () => {
    const r = spawnSync(process.execPath, [join(REPO, "db/tools/check-migrations.ts")], { cwd: REPO, encoding: "utf8", timeout: 120000 });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  });
});

const SCRIPT = "db/provisioning/create-storage-buckets.mjs";
describe("REQ-SEC-034 — provisioning script db/provisioning/create-storage-buckets.mjs (static)", () => {
  const code = () => {
    assert.ok(existsSync(join(REPO, SCRIPT)), `${SCRIPT} missing`);
    return stripJs(read(SCRIPT));
  };
  it("exists and parses as an ES module (node --check)", () => {
    assert.ok(existsSync(join(REPO, SCRIPT)), `${SCRIPT} missing`);
    const r = spawnSync(process.execPath, ["--check", join(REPO, SCRIPT)], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  });
  it("names every 08 §4.8 bucket (except reserved reporting-legacy) verbatim", () => {
    const c = code();
    for (const n of NAMES) assert.match(c, new RegExp(`(['"\`])${n}\\1`), `bucket '${n}' missing from the script`);
  });
  it("does not provision a legacy/generic/unlisted bucket name", () => {
    const c = code();
    for (const g of ["exports", "trf", "tenant-assets", "report-inputs", "report-prints", "instrument-attachments", "analytics-exports", "catalog-files"])
      assert.doesNotMatch(c, new RegExp(`(['"\`])${g}\\1`), `'${g}' must not be created`);
  });
  it("every bucket is private: public:false is sent, public:true / 'public': true appears nowhere", () => {
    const c = code();
    assert.match(c, /["']?public["']?\s*:\s*false\b/, "no public:false");
    assert.doesNotMatch(c, /["']?public["']?\s*:\s*true\b/, "public:true must never appear");
  });
  it("credential comes only from the file named by LIMS_CORE_STORAGE_KEY_FILE; no key/URL/token material in the file (REQ-SEC-035, 07-SECURITY §6-§7)", () => {
    const raw = read(SCRIPT);
    assert.match(stripJs(raw), /LIMS_CORE_STORAGE_KEY_FILE/);
    assert.match(stripJs(raw), /readFile(Sync)?\s*\(/, "credential must be read from the file");
    assert.doesNotMatch(raw, /eyJ[A-Za-z0-9_-]{10,}|sb_secret_|service_role|SERVICE_ROLE_KEY|SUPABASE_SECRET_KEY|signedUrl/i);
    assert.doesNotMatch(stripJs(raw), /https?:\/\/(?!\$\{)[^\s'"`]+/, "no hard-coded service URL");
    assert.doesNotMatch(stripJs(raw), /console\.[a-z]+\([^)]*\b(key|token|secret|credential|authorization)\b/i, "must not log the credential");
  });
  it("never opens the database: no pg client, no SQL on storage", () => {
    const c = code();
    assert.doesNotMatch(c, /from\s+["'](pg|postgres|pg-promise|@supabase\/[^"']+)["']|require\(\s*["']pg["']\s*\)|INSERT\s+INTO\s+storage|storage\.buckets/i);
  });
});

describe("provisioning README records the first-deploy smoke test (LD-54: not executed in this task)", () => {
  const p = "db/provisioning/README.md";
  const body = () => {
    assert.ok(existsSync(join(REPO, p)), `${p} missing`);
    return read(p);
  };
  it("names the script, the credential file env, the live pgTAP probe and says it is a first-deploy smoke test", () => {
    const b = body();
    for (const re of [/create-storage-buckets\.mjs/, /LIMS_CORE_STORAGE_KEY_FILE/, /T0B-12_storage\.test\.sql/, /first[- ]deploy/i, /smoke/i, /CR-C0-T0B-12|LD-54/])
      assert.match(b, re, `README lacks ${re}`);
  });
  it("contains no key, token or signed URL", () => assert.doesNotMatch(body(), /eyJ[A-Za-z0-9_-]{10,}|sb_secret_|[?&]token=/i));
});

describe("GATE — the provisioning contract the stub-server tests need is recorded in the spec/decision records (not guessed)", () => {
  // LD-54: endpoints and env names "must come from db/meta/decisions/SP-4.md and the C0/C1 TRD; if they are not recorded there, raise a CR".
  // Fails until the lead rules on .orchestra/cr/T0B-12.provisioning-contract.md and the record is updated; then the behaviour tests can be written.
  const corpus = () =>
    ["db/meta/decisions/SP-4.md", "spec/chunks/C0-foundation-contracts/02-TRD.md", "spec/chunks/C1-infrastructure-ops/02-TRD.md"].map(read).join("\n");
  it("a Storage service base-URL env name for the provisioning script is recorded (LIMS_CORE_STORAGE_*URL*)", () => {
    assert.ok(/LIMS_CORE_STORAGE_[A-Z_]*URL\b/.test(corpus()), "no LIMS_CORE_STORAGE_*URL env name recorded in SP-4.md / C0 TRD / C1 TRD");
  });
  it("the Storage bucket admin endpoints (list/create/update bucket) are recorded", () => {
    assert.ok(/\/storage\/v1\/bucket\b|`\/bucket\b|(GET|POST|PUT)\s+\/bucket\b/.test(corpus()), "no bucket admin endpoint recorded in SP-4.md / C0 TRD / C1 TRD");
  });
});

describe("live pgTAP probe file exists and carries the REQ-SEC-034 probes (post-provisioning smoke; not run by the DB harness, not run here)", () => {
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
  it("header says it runs only after db/provisioning/create-storage-buckets.mjs (LD-54)", () => {
    assert.match(read(p).split("BEGIN;")[0], /create-storage-buckets\.mjs/);
  });
  it("never disables RLS or relaxes row_security (AC-0B-2.4)", () => {
    assert.doesNotMatch(body(), /DISABLE\s+ROW\s+LEVEL\s+SECURITY|row_security\s*(=|TO)\s*off|BYPASSRLS/i);
  });
});
