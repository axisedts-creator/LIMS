// T0C-09 / PRD "Isolation" metric, gate 10, 08 A19.1 (AB-25), CR-C3-008 — tools/codegen/gen-probe-manifest.ts
// Contract the implementation must satisfy (02-TRD §5.3 `gen-probe-manifest`; export names are mine, spec is silent):
//   buildProbeManifest(files: {name,text}[]): { operations: ProbeOperation[] }   (specs incl. _common.yaml, as lintOpenapi)
//     ProbeOperation = { operationId, method (lowercase), path, security: string[] (scheme names; op-level wins, else doc-level;
//       `security: []` = []), pathParams: string[] (from path template), bodyIdFields: string[] (top-level JSON request-body
//       properties named `id` or `*_id`, $ref-resolved), bulkIdArrays: string[] (top-level array properties named `*_ids`),
//       deviceBoundary: { applies: boolean, deviceToken: boolean, staffMobile: boolean, expectStatus: [401, 403] } }
//     sorted by operationId; duplicate operationId throws.
//     deviceBoundary (A19.1): applies = path does NOT start with `/v1/instruments/agent/`; staffMobile = applies;
//       deviceToken = applies && security does not include `queueDisplayToken` (getQueueBoard exemption).
//   probeTags(src): string[]  — operationIds from `// @probe <operationId>` line comments (exact token).
//   checkProbeCoverage(manifest, tagged: string[], pending: string[]): { uncovered: string[] }  (pending ops are skipped).
//   CLI: `tsx gen-probe-manifest.ts --root <dir> [--check]` (default root = repo root). Always writes
//     <root>/tools/codegen/out/probe-manifest.json ({ operations }). Reads <root>/contracts/openapi/*.yaml; tags only from
//     files directly in any <root>/**/__tests__/probes/ dir; skip list from each such dir's pending.json (JSON array of
//     operationIds); node_modules ignored. With --check: exit 1 listing every uncovered operationId, else exit 0.
//     Malformed pending.json (bad JSON / not an array of strings) -> nonzero (fail closed).
//   `tools/codegen/out/` is gitignored.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const CODEGEN = resolve(HERE, "..");
const ROOT = resolve(CODEGEN, "../..");
const SCRIPT = join(CODEGEN, "gen-probe-manifest.ts");
const gen = () => import(pathToFileURL(SCRIPT).href);

const tmp = mkdtempSync(join(tmpdir(), "probe-manifest-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const COMMON = `openapi: 3.0.3
info: { title: c, version: 1.0.0 }
paths: {}
components:
  schemas:
    InvoiceCreate:
      type: object
      properties:
        id: { type: string, format: uuid }
        patient_id: { type: string, format: uuid }
        order_ids: { type: array, items: { type: string, format: uuid } }
        note: { type: string }
        nested: { type: object, properties: { hidden_id: { type: string } } }
  requestBodies:
    InvoiceBody:
      content:
        application/json:
          schema: { $ref: '#/components/schemas/InvoiceCreate' }
  securitySchemes:
    bearerJwt: { type: http, scheme: bearer }
    deviceToken: { type: http, scheme: bearer }
    queueDisplayToken: { type: apiKey, in: header, name: X-Lims-Display-Token }
`;
const INSTRUMENTS = `openapi: 3.0.3
info: { title: i, version: 1.0.0 }
security: [{ bearerJwt: [] }]
paths:
  /v1/instruments/agent/results:
    post:
      operationId: submitAgentResults
      security: [{ deviceToken: [] }]
      responses: { '202': { description: ok } }
  /v1/instruments/analyzers/{analyzer_id}:
    parameters: [{ name: analyzer_id, in: path, required: true, schema: { type: string } }]
    get:
      operationId: getAnalyzer
      responses: { '200': { description: ok } }
    delete:
      operationId: deleteAnalyzer
      responses: { '204': { description: ok } }
`;
const BILLING = `openapi: 3.0.3
info: { title: b, version: 1.0.0 }
paths:
  /v1/billing/invoices:
    get:
      operationId: listInvoices
      security: [{ bearerJwt: [] }]
      responses: { '200': { description: ok } }
    post:
      operationId: createInvoice
      security: [{ bearerJwt: [] }]
      requestBody: { $ref: '_common.yaml#/components/requestBodies/InvoiceBody' }
      responses: { '201': { description: ok } }
  /v1/billing/invoices/{invoice_id}/payments/{payment_id}:
    put:
      operationId: recordPayment
      security: [{ bearerJwt: [] }]
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                invoice_id: { type: string }
                order_ids: { type: array, items: { type: string } }
                amount: { type: number }
      responses: { '200': { description: ok } }
`;
const ENGAGEMENT = `openapi: 3.0.3
info: { title: e, version: 1.0.0 }
paths:
  /v1/engagement/queue/board:
    get:
      operationId: getQueueBoard
      security: [{ queueDisplayToken: [] }]
      responses: { '200': { description: ok } }
  /v1/engagement/health:
    get:
      operationId: getEngagementHealth
      security: []
      responses: { '200': { description: ok } }
`;
const FILES = [
  ["_common", COMMON],
  ["instruments", INSTRUMENTS],
  ["billing", BILLING],
  ["engagement", ENGAGEMENT],
].map(([n, t]) => ({ name: `${n}.yaml`, text: t! }));
const OPS = ["createInvoice", "deleteAnalyzer", "getAnalyzer", "getEngagementHealth", "getQueueBoard", "listInvoices", "recordPayment", "submitAgentResults"];

describe("buildProbeManifest — fixture spec", () => {
  it("lists every operationId, sorted, with method and path", async () => {
    const { buildProbeManifest } = await gen();
    const m = buildProbeManifest(FILES);
    expect(m.operations.map((o: any) => o.operationId)).toEqual(OPS);
    const o = m.operations.find((x: any) => x.operationId === "getAnalyzer");
    expect(o).toMatchObject({ method: "get", path: "/v1/instruments/analyzers/{analyzer_id}" });
  });

  it("path params from the template; body id fields and bulk-id arrays from the (ref-resolved) JSON body", async () => {
    const { buildProbeManifest } = await gen();
    const by = (id: string) => buildProbeManifest(FILES).operations.find((x: any) => x.operationId === id);
    expect(by("recordPayment")).toMatchObject({ pathParams: ["invoice_id", "payment_id"], bodyIdFields: ["invoice_id"], bulkIdArrays: ["order_ids"] });
    // body via $ref requestBody -> $ref schema; nested *_id and arrays excluded from bodyIdFields
    const c = by("createInvoice");
    expect([...c.bodyIdFields].sort()).toEqual(["id", "patient_id"]);
    expect(c.bulkIdArrays).toEqual(["order_ids"]);
    expect(by("listInvoices")).toMatchObject({ pathParams: [], bodyIdFields: [], bulkIdArrays: [] });
  });

  it("security: operation-level wins, document-level default applies, `security: []` is public", async () => {
    const { buildProbeManifest } = await gen();
    const by = (id: string) => buildProbeManifest(FILES).operations.find((x: any) => x.operationId === id);
    expect(by("submitAgentResults").security).toEqual(["deviceToken"]);
    expect(by("getAnalyzer").security).toEqual(["bearerJwt"]); // inherited from doc-level
    expect(by("getEngagementHealth").security).toEqual([]);
  });

  it("A19.1 device boundary: every non-agent op gets deviceToken + staff_mobile probes expecting 401/403", async () => {
    const { buildProbeManifest } = await gen();
    const m = buildProbeManifest(FILES);
    const subject = m.operations.filter((x: any) => !x.path.startsWith("/v1/instruments/agent/") && x.operationId !== "getQueueBoard");
    expect(subject.length).toBeGreaterThan(0);
    for (const o of subject) {
      expect(o.deviceBoundary, o.operationId).toEqual({ applies: true, deviceToken: true, staffMobile: true, expectStatus: [401, 403] });
    }
  });

  it("A19.1: /v1/instruments/agent/* is the only prefix exempt; lookalike prefixes are NOT", async () => {
    const { buildProbeManifest } = await gen();
    const agent = buildProbeManifest(FILES).operations.find((x: any) => x.operationId === "submitAgentResults");
    expect(agent.deviceBoundary).toMatchObject({ applies: false, deviceToken: false, staffMobile: false });
    const evil = [{
      name: "x.yaml",
      text: `openapi: 3.0.3
info: { title: x, version: 1.0.0 }
paths:
  /v1/instruments/agents/results: { get: { operationId: lookalikeA, responses: { '200': { description: ok } } } }
  /v1/instruments/agent: { get: { operationId: lookalikeB, responses: { '200': { description: ok } } } }
`,
    }];
    const ops = buildProbeManifest(evil).operations;
    expect(ops).toHaveLength(2);
    for (const o of ops) expect(o.deviceBoundary, o.operationId).toMatchObject({ applies: true, deviceToken: true, staffMobile: true });
  });

  it("A19.1: getQueueBoard (queueDisplayToken) is exempt from the deviceToken part only; staff_mobile still probed", async () => {
    const { buildProbeManifest } = await gen();
    const q = buildProbeManifest(FILES).operations.find((x: any) => x.operationId === "getQueueBoard");
    expect(q.deviceBoundary).toMatchObject({ applies: true, deviceToken: false, staffMobile: true, expectStatus: [401, 403] });
  });

  it("duplicate operationId across files throws", async () => {
    const { buildProbeManifest } = await gen();
    const dup = [
      ...FILES,
      {
        name: "dup.yaml",
        text: `openapi: 3.0.3
info: { title: d, version: 1.0.0 }
paths:
  /v1/dup: { get: { operationId: listInvoices, responses: { '200': { description: ok } } } }
`,
      },
    ];
    expect(() => buildProbeManifest(dup)).toThrow(/listInvoices/);
  });

  it("real contracts/openapi: one manifest entry per operation, includes getLiveness", async () => {
    const { buildProbeManifest } = await gen();
    const dir = join(ROOT, "contracts/openapi");
    const files = readdirSync(dir).filter((f) => f.endsWith(".yaml")).map((f) => ({ name: f, text: readFileSync(join(dir, f), "utf8") }));
    const ids = buildProbeManifest(files).operations.map((o: any) => o.operationId);
    expect(ids).toContain("getLiveness");
    expect(new Set(ids).size).toBe(ids.length);
    const declared = files.reduce((n, f) => n + (f.text.match(/^\s+operationId:/gm)?.length ?? 0), 0);
    expect(ids.length).toBe(declared);
  });
});

describe("probeTags / checkProbeCoverage", () => {
  it("reads `// @probe <operationId>` line comments, exact token only", async () => {
    const { probeTags } = await gen();
    const src = `// @probe getAnalyzer
it("x", () => {});
  // @probe  listInvoices
// @probes recordPayment
/* @probe notALineComment */
`;
    const t = probeTags(src);
    expect(t).toEqual(expect.arrayContaining(["getAnalyzer", "listInvoices"]));
    expect(t).not.toContain("recordPayment");
    expect(t).not.toContain("notALineComment");
  });

  it("gate 10: uncovered = manifest ops with no tag and not pending; a prefix tag does not cover", async () => {
    const { buildProbeManifest, checkProbeCoverage } = await gen();
    const m = buildProbeManifest(FILES);
    expect(checkProbeCoverage(m, OPS, []).uncovered).toEqual([]);
    expect(checkProbeCoverage(m, OPS.filter((o) => o !== "recordPayment"), []).uncovered).toEqual(["recordPayment"]);
    expect(checkProbeCoverage(m, ["getAnalyze"], []).uncovered).toContain("getAnalyzer");
    expect(checkProbeCoverage(m, [], []).uncovered).toEqual(OPS);
  });

  it("CR-C3-008: pending ops are skipped, others still reported", async () => {
    const { buildProbeManifest, checkProbeCoverage } = await gen();
    const m = buildProbeManifest(FILES);
    const r = checkProbeCoverage(m, OPS.filter((o) => o !== "recordPayment" && o !== "listInvoices"), ["recordPayment"]);
    expect(r.uncovered).toEqual(["listInvoices"]);
  });
});

// ---- CLI / gate 10 end to end on a throwaway repo ----
const PD = (m: string) => `services/api/src/modules/${m}/__tests__/probes`;
const tagFile = (ids: string[]) => ids.map((i) => `// @probe ${i}\n`).join("") + `import { it } from "vitest";\n`;
const FULL: Record<string, string> = {
  [`${PD("billing")}/billing.probe.test.ts`]: tagFile(["createInvoice", "listInvoices", "recordPayment"]),
  [`${PD("instruments")}/instruments.probe.test.ts`]: tagFile(["deleteAnalyzer", "getAnalyzer", "submitAgentResults"]),
  [`${PD("engagement")}/engagement.probe.test.ts`]: tagFile(["getEngagementHealth", "getQueueBoard"]),
};
const BILLING_FILE = `${PD("billing")}/billing.probe.test.ts`;

function repo(name: string, opts: { tags?: Record<string, string>; pending?: string[]; pendingJson?: string } = {}) {
  const root = join(tmp, name);
  mkdirSync(join(root, "contracts/openapi"), { recursive: true });
  for (const f of FILES) writeFileSync(join(root, "contracts/openapi", f.name), f.text);
  for (const [rel, body] of Object.entries(opts.tags ?? {})) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  if (opts.pending || opts.pendingJson) {
    const pdir = join(root, PD("billing"));
    mkdirSync(pdir, { recursive: true });
    writeFileSync(join(pdir, "pending.json"), opts.pendingJson ?? JSON.stringify(opts.pending));
  }
  return root;
}
const run = (root: string, check = true) =>
  spawnSync(process.execPath, ["--import", "tsx", SCRIPT, "--root", root, ...(check ? ["--check"] : [])], { cwd: CODEGEN, encoding: "utf8" });
const out = (r: ReturnType<typeof run>) => `${r.stdout}\n${r.stderr}`;

describe("gate 10 CLI", () => {
  it("all operations tagged -> exit 0 and probe-manifest.json written", () => {
    const root = repo("full", { tags: FULL });
    const r = run(root);
    expect(r.status, out(r)).toBe(0);
    const mf = JSON.parse(readFileSync(join(root, "tools/codegen/out/probe-manifest.json"), "utf8"));
    expect(mf.operations.map((o: any) => o.operationId)).toEqual(OPS);
  });

  it("an uncovered operation -> nonzero exit naming it (and only it)", () => {
    const r = run(repo("uncovered", { tags: { ...FULL, [BILLING_FILE]: tagFile(["createInvoice", "listInvoices"]) } }));
    expect(r.status).not.toBe(0);
    expect(out(r)).toContain("recordPayment");
    expect(out(r)).not.toContain("listInvoices");
  });

  it("no probe tests at all -> fails", () => {
    const r = run(repo("none"));
    expect(r.status).not.toBe(0);
    for (const id of OPS) expect(out(r)).toContain(id);
  });

  it("tags outside __tests__/probes/ (or in node_modules) do not count", () => {
    const tags = {
      ...FULL,
      [BILLING_FILE]: tagFile(["createInvoice", "listInvoices"]),
      "services/api/src/modules/billing/billing.test.ts": tagFile(["recordPayment"]),
      "node_modules/pkg/__tests__/probes/x.test.ts": tagFile(["recordPayment"]),
    };
    const r = run(repo("outside", { tags }));
    expect(r.status).not.toBe(0);
    expect(out(r)).toContain("recordPayment");
  });

  it("CR-C3-008: operations in pending.json are skipped by the gate", () => {
    const tags = { ...FULL, [BILLING_FILE]: tagFile(["createInvoice", "listInvoices"]) };
    const r = run(repo("pending", { tags, pending: ["recordPayment"] }));
    expect(r.status, out(r)).toBe(0);
  });

  it("pending.json skips only what it lists", () => {
    const tags = { ...FULL, [BILLING_FILE]: tagFile(["createInvoice"]) };
    const r = run(repo("pending-partial", { tags, pending: ["recordPayment"] }));
    expect(r.status).not.toBe(0);
    expect(out(r)).toContain("listInvoices");
    expect(out(r)).not.toContain("recordPayment");
  });

  it("malformed pending.json fails closed (nonzero), never silently skips", () => {
    const tags = { ...FULL, [BILLING_FILE]: tagFile(["createInvoice", "listInvoices"]) };
    for (const [n, json] of [["pending-bad", "{not json"], ["pending-obj", '{"recordPayment":true}']] as const) {
      const r = run(repo(n, { tags, pendingJson: json }));
      expect(r.status, n).not.toBe(0);
      expect(out(r), n).toContain("pending.json");
    }
  });

  it("without --check it still writes the manifest and exits 0 on gaps", () => {
    const root = repo("nocheck");
    expect(run(root, false).status).toBe(0);
    expect(existsSync(join(root, "tools/codegen/out/probe-manifest.json"))).toBe(true);
  });
});

describe("hygiene", () => {
  it("tools/codegen/out/ is gitignored", () => {
    const r = spawnSync("git", ["check-ignore", "-q", "tools/codegen/out/probe-manifest.json"], { cwd: ROOT });
    expect(r.status).toBe(0);
  });
});
