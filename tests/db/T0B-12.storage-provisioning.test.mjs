// T0B-12 (LD-55): behaviour tests for db/provisioning/create-storage-buckets.mjs against a stub Storage HTTP server.
// Contract under test (LD-55 items 1-4, REQ-SEC-034/035): LIMS_CORE_STORAGE_URL base incl. prefix; GET /bucket?limit=100&offset=N (paged until
// a page has <100 items); POST /bucket {"id","name","public":false}; PUT /bucket/{id} {"public":false}; headers Authorization: Bearer + apikey;
// credential = trimmed contents of LIMS_CORE_STORAGE_KEY_FILE; list first, POST only absent, PUT only public ones; POST non-2xx -> re-list;
// output = bucket names + created/ok/flipped only. Synthetic data only. No real Supabase, no network beyond 127.0.0.1.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it, after } from "node:test";

const SCRIPT = resolve("db/provisioning/create-storage-buckets.mjs");
const PREFIX = "/storage/v1";
const CRED = "synthetic-credential-0123456789abcdef";
const BODY_MARKER = "SECRET-BODY-MARKER-7731";
const ELEVEN = [
  "reports", "reporting-inputs", "reporting-prints", "identity-assets", "identity-exports", "frontdesk-trf",
  "billing-exports", "instruments-attachments", "micro-imports", "anatomic-images", "partners-slips",
];
const tmp = mkdtempSync(join(tmpdir(), "t0b12-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const keyFile = join(tmp, "key.txt");
writeFileSync(keyFile, `\n  ${CRED}  \r\n`); // surrounding whitespace must be trimmed
const emptyKeyFile = join(tmp, "empty.txt");
writeFileSync(emptyKeyFile, " \n");

// --- stub Storage service -------------------------------------------------------------------------------------------------------------
// buckets: [{id,name,public}]. opts: listStatus, putStatus, postStatus, postCreates (undefined|"private"|"public"), listFailOnCall (n-th GET).
async function stub(initial = [], opts = {}) {
  const buckets = initial.map((b) => ({ name: b.id, ...b }));
  const reqs = [];
  let gets = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const u = new URL(req.url, "http://stub");
      let body;
      try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
      reqs.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: req.headers, body });
      const send = (status, obj) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(obj)); };
      const fail = (status) => send(status, { error: BODY_MARKER, message: BODY_MARKER });
      if (!u.pathname.startsWith(PREFIX + "/bucket")) return send(404, { error: "not found" });
      const rest = u.pathname.slice((PREFIX + "/bucket").length);
      if (req.method === "GET" && rest === "") {
        gets++;
        if (opts.listStatus || (opts.listFailOnCall && gets === opts.listFailOnCall)) return fail(opts.listStatus ?? 500);
        const limit = Number(u.searchParams.get("limit") ?? 100), offset = Number(u.searchParams.get("offset") ?? 0);
        return send(200, buckets.slice(offset, offset + limit));
      }
      if (req.method === "POST" && rest === "") {
        if (opts.postStatus) {
          if (opts.postCreates) buckets.push({ id: body.id, name: body.id, public: opts.postCreates === "public" });
          return fail(opts.postStatus);
        }
        buckets.push({ id: body.id, name: body.name, public: body.public === true });
        return send(200, { name: body.name });
      }
      if (req.method === "PUT" && rest.startsWith("/")) {
        if (opts.putStatus) return fail(opts.putStatus);
        const b = buckets.find((x) => x.id === decodeURIComponent(rest.slice(1)));
        if (!b) return send(404, { error: "no bucket" });
        b.public = body.public === true;
        return send(200, { message: "ok" });
      }
      return send(405, { error: "nope" });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return { url: `http://127.0.0.1:${port}${PREFIX}`, port, reqs, buckets, close: () => new Promise((r) => server.close(r)) };
}

function run(env) {
  return new Promise((res) => {
    const e = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env };
    execFile(process.execPath, [SCRIPT], { env: e, timeout: 20000, windowsHide: true }, (err, stdout, stderr) =>
      res({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr, out: stdout + stderr }));
  });
}
async function withStub(initial, opts, fn) {
  const s = await stub(initial, opts);
  try { return await fn(s, (extra = {}) => run({ LIMS_CORE_STORAGE_URL: s.url, LIMS_CORE_STORAGE_KEY_FILE: keyFile, ...extra })); }
  finally { await s.close(); }
}
const posts = (s) => s.reqs.filter((r) => r.method === "POST");
const puts = (s) => s.reqs.filter((r) => r.method === "PUT");
const gets = (s) => s.reqs.filter((r) => r.method === "GET");
const priv = (id) => ({ id, public: false });

describe("harness self-test — the stub and runner behave before they are trusted", () => {
  it("stub pages by limit/offset and records requests", async () => {
    await withStub([priv("a"), priv("b"), priv("c")], {}, async (s) => {
      const r = await fetch(`${s.url}/bucket?limit=2&offset=1`);
      assert.deepEqual((await r.json()).map((b) => b.id), ["b", "c"]);
      assert.equal(s.reqs.length, 1);
    });
  });
});

describe("LD-55 item 1 — base URL env LIMS_CORE_STORAGE_URL (no default, no hard-coded host)", () => {
  it("unset URL: prints one line, exits non-zero, sends no request", async () => {
    await withStub([], {}, async (s) => {
      const r = await run({ LIMS_CORE_STORAGE_KEY_FILE: keyFile });
      assert.notEqual(r.code, 0, r.out);
      assert.equal(r.out.trim().split(/\r?\n/).length, 1, `expected exactly one line: ${r.out}`);
      assert.ok(r.out.includes("LIMS_CORE_STORAGE_URL"), "message names the missing env");
      assert.equal(s.reqs.length, 0);
    });
  });
  it("empty URL behaves like unset", async () => {
    const r = await run({ LIMS_CORE_STORAGE_URL: "", LIMS_CORE_STORAGE_KEY_FILE: keyFile });
    assert.notEqual(r.code, 0, r.out);
  });
  it("requests go to the base URL including its path prefix", async () => {
    await withStub([], {}, async (s, go) => {
      await go();
      assert.ok(s.reqs.length > 0 && s.reqs.every((q) => q.path.startsWith(PREFIX + "/bucket")), JSON.stringify(s.reqs.map((q) => q.path)));
    });
  });
  it("a trailing slash on the base URL does not break routing", async () => {
    await withStub([], {}, async (s, go) => {
      const r = await go({ LIMS_CORE_STORAGE_URL: s.url + "/" });
      assert.equal(r.code, 0, r.out);
      assert.equal(posts(s).length, 11);
    });
  });
});

describe("credential file (LD-55 item 3)", () => {
  it("unset LIMS_CORE_STORAGE_KEY_FILE: non-zero, no request", async () => {
    await withStub([], {}, async (s) => {
      const r = await run({ LIMS_CORE_STORAGE_URL: s.url });
      assert.notEqual(r.code, 0, r.out);
      assert.equal(s.reqs.length, 0);
    });
  });
  it("missing or empty key file: non-zero, no request, nothing leaked", async () => {
    await withStub([], {}, async (s, go) => {
      for (const f of [join(tmp, "nope.txt"), emptyKeyFile]) {
        const r = await go({ LIMS_CORE_STORAGE_KEY_FILE: f });
        assert.notEqual(r.code, 0, r.out);
        assert.ok(!r.out.includes(CRED));
      }
      assert.equal(s.reqs.length, 0);
    });
  });
  it("every request carries Authorization: Bearer <trimmed credential> AND apikey: <trimmed credential>", async () => {
    await withStub([{ id: "reports", public: true }], {}, async (s, go) => {
      const r = await go();
      assert.equal(r.code, 0, r.out);
      assert.ok(s.reqs.length >= 3);
      for (const q of s.reqs) {
        assert.equal(q.headers.authorization, `Bearer ${CRED}`, `${q.method} ${q.path}`);
        assert.equal(q.headers.apikey, CRED, `${q.method} ${q.path}`);
      }
      assert.ok(gets(s).length && posts(s).length && puts(s).length, "exercised GET, POST and PUT");
    });
  });
});

describe("LD-55 item 2/4 — list, create absent, flip public, leave private", () => {
  it("empty service: lists, then POSTs each of the eleven names private (id=name, public:false), exit 0", async () => {
    await withStub([], {}, async (s, go) => {
      const r = await go();
      assert.equal(r.code, 0, r.out);
      assert.deepEqual(gets(s)[0].query, { limit: "100", offset: "0" });
      assert.ok(s.reqs.indexOf(gets(s)[0]) === 0, "list happens before any write");
      assert.equal(puts(s).length, 0);
      assert.deepEqual(posts(s).map((q) => q.body).sort((a, b) => a.id.localeCompare(b.id)),
        [...ELEVEN].sort().map((id) => ({ id, name: id, public: false })));
      for (const q of posts(s)) assert.equal(q.path, `${PREFIX}/bucket`);
      for (const n of ELEVEN) assert.match(r.out, new RegExp(`${n}\\b.*created|created.*\\b${n}\\b`), `no 'created' line for ${n}`);
      assert.ok(s.buckets.every((b) => b.public === false));
    });
  });
  it("never creates reporting-legacy or any unlisted name; never sends DELETE", async () => {
    await withStub([], {}, async (s, go) => {
      await go();
      assert.ok(posts(s).every((q) => ELEVEN.includes(q.body.id)));
      assert.ok(!s.reqs.some((q) => q.method === "DELETE"));
      assert.ok(!s.buckets.some((b) => b.id === "reporting-legacy"));
    });
  });
  it("idempotent re-run: second run sends only GETs, exits 0, reports ok", async () => {
    await withStub([], {}, async (s, go) => {
      assert.equal((await go()).code, 0);
      const before = s.reqs.length;
      const r = await go();
      assert.equal(r.code, 0, r.out);
      const second = s.reqs.slice(before);
      assert.ok(second.length >= 1 && second.every((q) => q.method === "GET"), JSON.stringify(second.map((q) => q.method)));
      for (const n of ELEVEN) assert.match(r.out, new RegExp(`${n}\\b.*ok|ok.*\\b${n}\\b`), `no 'ok' line for ${n}`);
      assert.doesNotMatch(r.out, /created|flipped/);
      assert.equal(s.buckets.length, 11);
    });
  });
  it("a public bucket is flipped private with PUT /bucket/{id} {public:false}; no POST for it", async () => {
    await withStub([{ id: "billing-exports", public: true }, priv("reports")], {}, async (s, go) => {
      const r = await go();
      assert.equal(r.code, 0, r.out);
      assert.deepEqual(puts(s).map((q) => [q.path, q.body]), [[`${PREFIX}/bucket/billing-exports`, { public: false }]]);
      assert.ok(!posts(s).some((q) => q.body.id === "billing-exports" || q.body.id === "reports"));
      assert.equal(s.buckets.find((b) => b.id === "billing-exports").public, false);
      assert.match(r.out, /billing-exports\b.*flipped|flipped.*\bbilling-exports\b/);
    });
  });
  it("already-private buckets are untouched (no PUT, no POST)", async () => {
    await withStub(ELEVEN.map(priv), {}, async (s, go) => {
      const r = await go();
      assert.equal(r.code, 0, r.out);
      assert.equal(posts(s).length + puts(s).length, 0);
    });
  });
  it("buckets outside the eleven are left alone (not flipped, not deleted), even if public", async () => {
    await withStub([{ id: "someone-elses", public: true }], {}, async (s, go) => {
      const r = await go();
      assert.equal(r.code, 0, r.out);
      assert.ok(!puts(s).some((q) => q.path.endsWith("someone-elses")));
      assert.equal(s.buckets.find((b) => b.id === "someone-elses").public, true);
    });
  });
  it("a listed bucket with public missing/null is not assumed private (flipped)", async () => {
    await withStub([{ id: "reports", public: null }], {}, async (s, go) => {
      const r = await go();
      assert.equal(r.code, 0, r.out);
      assert.equal(s.buckets.find((b) => b.id === "reports").public, false);
    });
  });
});

describe("LD-55 item 2 — pagination over more than 100 buckets", () => {
  const filler = (n) => Array.from({ length: n }, (_, i) => priv(`zz-synthetic-${String(i).padStart(4, "0")}`));
  it("finds our buckets on later pages: no duplicate POST, public one on page 3 is flipped", async () => {
    const initial = [...filler(120), ...ELEVEN.slice(0, 10).map(priv), { id: "partners-slips", public: true }, ...filler(80)]; // partners-slips at index 130 (page 2)
    await withStub(initial, {}, async (s, go) => {
      const r = await go();
      assert.equal(r.code, 0, r.out);
      assert.equal(posts(s).length, 0, "all eleven exist; none may be re-created");
      assert.deepEqual(puts(s).map((q) => q.path), [`${PREFIX}/bucket/partners-slips`]);
      const offs = gets(s).map((q) => q.query.offset);
      assert.deepEqual(offs.slice(0, 3), ["0", "100", "200"]);
      assert.ok(gets(s).every((q) => q.query.limit === "100"));
    });
  });
  it("a bucket that exists only beyond offset 100 is not re-created (the classic first-page-only bug)", async () => {
    const initial = [...filler(100), priv("reports")];
    await withStub(initial, {}, async (s, go) => {
      const r = await go();
      assert.equal(r.code, 0, r.out);
      assert.ok(!posts(s).some((q) => q.body.id === "reports"));
      assert.equal(posts(s).length, 10);
    });
  });
  it("a full page (exactly 100) forces a further request; stops at the first page with <100 items", async () => {
    await withStub(filler(100), {}, async (s, go) => {
      await go();
      const offs = gets(s).map((q) => q.query.offset);
      assert.deepEqual(offs.slice(0, 2), ["0", "100"]);
    });
    await withStub(filler(99), {}, async (s, go) => {
      await go();
      assert.equal(gets(s).filter((q) => q.query.offset === "100").length, 0, "short first page must end paging");
    });
  });
});

describe("LD-55 item 4 — failures exit non-zero", () => {
  for (const status of [400, 401, 403, 404, 500, 503]) {
    it(`list returns ${status}: non-zero, no writes`, async () => {
      await withStub([], { listStatus: status }, async (s, go) => {
        const r = await go();
        assert.notEqual(r.code, 0, r.out);
        assert.equal(posts(s).length + puts(s).length, 0);
      });
    });
  }
  for (const status of [400, 403, 500, 502]) {
    it(`PUT returns ${status}: non-zero`, async () => {
      await withStub([{ id: "reports", public: true }], { putStatus: status }, async (s, go) => {
        const r = await go();
        assert.notEqual(r.code, 0, r.out);
      });
    });
  }
  it("list fails on a later page: non-zero (no partial plan trusted)", async () => {
    const initial = Array.from({ length: 150 }, (_, i) => priv(`zz-${i}`));
    await withStub(initial, { listFailOnCall: 2 }, async (s, go) => {
      const r = await go();
      assert.notEqual(r.code, 0, r.out);
      assert.equal(posts(s).length, 0, "must not create from an incomplete listing");
    });
  });
  it("POST non-2xx and bucket still absent after re-list: non-zero", async () => {
    await withStub([], { postStatus: 500 }, async (s, go) => {
      const r = await go();
      assert.notEqual(r.code, 0, r.out);
      assert.ok(gets(s).length >= 2, "re-lists after a failed POST");
    });
  });
  it("POST non-2xx (e.g. 409 race) but bucket now exists and is private: accepted, exit 0", async () => {
    await withStub([], { postStatus: 409, postCreates: "private" }, async (s, go) => {
      const r = await go();
      assert.equal(r.code, 0, r.out);
    });
  });
  it("POST non-2xx and bucket now exists but PUBLIC: non-zero", async () => {
    await withStub([], { postStatus: 409, postCreates: "public" }, async (s, go) => {
      const r = await go();
      assert.notEqual(r.code, 0, r.out);
    });
  });
  it("unreachable service: non-zero, one-line failure without URL or credential", async () => {
    const r = await run({ LIMS_CORE_STORAGE_URL: `http://127.0.0.1:1${PREFIX}`, LIMS_CORE_STORAGE_KEY_FILE: keyFile });
    assert.notEqual(r.code, 0, r.out);
    assert.ok(!r.out.includes(CRED) && !/127\.0\.0\.1|http:\/\//.test(r.out), r.out);
  });
});

describe("REQ-SEC-035 / 07-SECURITY §6-§7 — output never carries credential, URL or response body", () => {
  const scenarios = {
    "success (create)": [[], {}],
    "success (flip)": [[{ id: "reports", public: true }], {}],
    "list 401": [[], { listStatus: 401 }],
    "PUT 500": [[{ id: "reports", public: true }], { putStatus: 500 }],
    "POST 500": [[], { postStatus: 500 }],
  };
  for (const [name, [initial, opts]] of Object.entries(scenarios)) {
    it(`${name}: no credential, host, port, scheme, header value or body text in stdout/stderr`, async () => {
      await withStub(initial, opts, async (s, go) => {
        const r = await go();
        assert.ok(!r.out.includes(CRED), "credential printed");
        assert.ok(!r.out.includes(String(s.port)), "port/URL printed");
        assert.ok(!/127\.0\.0\.1|localhost|https?:\/\/|\/storage\/v1/i.test(r.out), `URL material: ${r.out}`);
        assert.ok(!r.out.includes(BODY_MARKER), "response body echoed");
        assert.ok(!/bearer\s/i.test(r.out), "auth header echoed");
      });
    });
  }
  it("success output lines are only `<bucket> created|ok|flipped` style (bucket names + status words)", async () => {
    await withStub([{ id: "reports", public: true }, priv("partners-slips")], {}, async (s, go) => {
      const r = await go();
      assert.equal(r.code, 0, r.out);
      for (const line of r.stdout.split(/\r?\n/).filter(Boolean)) {
        assert.ok(ELEVEN.some((n) => line.includes(n)) && /created|ok|flipped/.test(line), `unexpected line: ${line}`);
      }
    });
  });
});
