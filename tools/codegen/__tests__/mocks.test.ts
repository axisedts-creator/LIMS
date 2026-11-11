// T0C-08 / AC-0C-4.1, AC-0C-4.2 — Prism scripts + MSW handlers (02-TRD §5.3 `gen-msw`, §5.5).
// Contract the implementation must satisfy (names beyond the spec are mine):
//   root package.json
//     scripts["mock:<m>"] for every contracts/openapi/<m>.yaml (not _common):
//       contains `prism mock contracts/openapi/<m>.yaml`, `--host 127.0.0.1`, `--port <N>`; N unique, 4100..4199
//       (exact index = "index of m in CM §3 module table" is spec-ambiguous, so only uniqueness/range is tested)
//     scripts["mock:list"] exists (prints the port mapping)
//     Prism pinned exactly 5.16.0 (npm package @stoplight/prism-cli) in root devDependencies
//   packages/fakes/package.json: name @lims/fakes, exports "./msw", msw pinned exactly 3.0.3
//   packages/fakes/src/msw/handlers.generated.ts: `export const handlers` (array, ONE msw handler per operationId),
//     emitted by tools/codegen/codegen.ts generateAll() (path "packages/fakes/src/msw/handlers.generated.ts"),
//     byte-equal to the committed file. Handlers match ANY origin (e.g. `*/v1/...`) and every `{param}` value.
//   packages/fakes/src/msw/server.ts: `export const server` = setupServer(...handlers) (msw/node)
//   Response = lowest 2xx, else lowest 3xx status in the spec (ruling T0C-10.C15), first `examples` entry (or `example`) of application/json; no body if none.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const yaml = (p: string) => parse(read(p)) as any;
const mod = (p: string) => import(pathToFileURL(join(ROOT, p)).href);

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch"];
const domains = readdirSync(join(ROOT, "contracts/openapi"))
  .filter((f) => f.endsWith(".yaml") && !f.startsWith("_")).map((f) => f.replace(/\.yaml$/, "")).sort();

type Op = { id: string; method: string; path: string; status: number; example?: unknown };
function resolveRef(doc: any, node: any, file: string): any {
  if (!node?.$ref) return node;
  const [f, ptr] = node.$ref.split("#");
  const d = f ? yaml(`contracts/openapi/${f}`) : doc;
  return resolveRef(d, ptr.split("/").filter(Boolean).reduce((n: any, k: string) => n?.[k], d), f || file);
}
const ops: Op[] = domains.flatMap((dom) => {
  const doc = yaml(`contracts/openapi/${dom}.yaml`);
  return Object.entries<any>(doc.paths ?? {}).flatMap(([path, item]) =>
    METHODS.filter((m) => item[m]?.operationId).map((method) => {
      const responses = item[method].responses ?? {};
      const codes = (re: RegExp) => Object.keys(responses).filter((s) => re.test(s)).map(Number);
      const c2 = codes(/^2\d\d$/), c3 = codes(/^3\d\d$/);
      // Ruling T0C-10.C15: lowest 2xx, else lowest 3xx (303-only callbacks); neither = explicit failure.
      if (!c2.length && !c3.length) throw new Error(`${item[method].operationId}: no 2xx or 3xx response`);
      const status = Math.min(...(c2.length ? c2 : c3));
      const res = resolveRef(doc, responses[String(status)], dom);
      const json = res?.content?.["application/json"];
      const ex = json?.examples ? resolveRef(doc, Object.values<any>(json.examples)[0], dom)?.value : json?.example;
      return { id: item[method].operationId as string, method, path, status, example: ex };
    }));
});

describe("test setup sanity", () => {
  it("finds domains and operations in the spec", () => {
    expect(domains).toContain("core");
    expect(ops.map((o) => o.id)).toEqual(expect.arrayContaining(["getLiveness", "getReadiness"]));
    expect(new Set(ops.map((o) => o.id)).size).toBe(ops.length);
  });
});

describe("AC-0C-4.1 — Prism scripts in root package.json", () => {
  const pkg = JSON.parse(read("package.json"));
  const scripts: Record<string, string> = pkg.scripts ?? {};
  const portOf = (d: string) => Number(/--port[ =](\d+)/.exec(scripts[`mock:${d}`] ?? "")?.[1]);

  it.each(domains)("mock:%s serves its spec with Prism on 127.0.0.1 and a fixed port", (d) => {
    const s = scripts[`mock:${d}`];
    expect(s, `scripts["mock:${d}"]`).toBeTypeOf("string");
    expect(s).toMatch(new RegExp(`prism mock contracts/openapi/${d}\\.yaml(\\s|$)`));
    expect(s).toMatch(/--host[ =]127\.0\.0\.1(\s|$)/); // never 0.0.0.0 / LAN (REQ-SEC-037 spirit)
    expect(portOf(d)).toBeGreaterThanOrEqual(4100);
    expect(portOf(d)).toBeLessThan(4200);
  });
  it("ports are unique per domain", () => {
    const ports = domains.map(portOf);
    expect(new Set(ports).size).toBe(ports.length);
  });
  it("no mock script for a domain that has no spec", () => {
    const extra = Object.keys(scripts).filter((k) => /^mock:/.test(k) && k !== "mock:list").map((k) => k.slice(5));
    expect(extra.filter((d) => !domains.includes(d))).toEqual([]);
  });
  it("mock:list exists", () => expect(scripts["mock:list"]).toBeTypeOf("string"));
  it("Prism is pinned exactly to 5.16.0 (02-CONVENTIONS pins)", () => {
    const v = { ...pkg.dependencies, ...pkg.devDependencies }["@stoplight/prism-cli"];
    expect(v).toBe("5.16.0");
  });
});

describe("AC-0C-4.2 — @lims/fakes/msw package + codegen wiring", () => {
  it("packages/fakes/package.json exposes ./msw and pins msw 3.0.3", () => {
    const p = JSON.parse(read("packages/fakes/package.json"));
    expect(p.name).toBe("@lims/fakes");
    expect(p.exports?.["./msw"]).toBeTruthy();
    expect({ ...p.dependencies, ...p.devDependencies, ...p.peerDependencies }.msw).toBe("3.0.3");
  });
  it("gen-msw output is part of codegen and the committed file is fresh (CI gate 8)", async () => {
    const out = (await mod("tools/codegen/codegen.ts")).generateAll(ROOT) as Record<string, string>;
    const f = "packages/fakes/src/msw/handlers.generated.ts";
    expect(Object.keys(out)).toContain(f);
    expect(out[f]).toBe(read(f));
    // Ruling T0C-05: spec-example datetimes are required content; only comment lines must be timestamp-free.
    expect(out[f]).not.toMatch(/\r|[A-Z]:\\|\/Users\//); // deterministic
    const comments = out[f]!.split("\n").filter((l) => /^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");
    expect(comments).not.toMatch(/\d{4}-\d\d-\d\dT/);
  });
  it("the generated file names every operationId", () => {
    const t = read("packages/fakes/src/msw/handlers.generated.ts");
    for (const o of ops) expect(t, o.id).toContain(o.id);
  });
});

describe("AC-0C-4.2 — handler completeness (every operationId, returns the spec example)", () => {
  let server: any;
  let handlers: unknown[];
  beforeAll(async () => {
    handlers = (await mod("packages/fakes/src/msw/handlers.generated.ts")).handlers;
    server = (await mod("packages/fakes/src/msw/server.ts")).server;
    server.listen({ onUnhandledRequest: "error" });
  });
  afterAll(() => server?.close());

  it("exactly one handler per operationId (no gaps, no extras)", () => {
    expect(Array.isArray(handlers)).toBe(true);
    expect(handlers).toHaveLength(ops.length);
  });

  const url = (p: string) => "http://lims.test" + p.replace(/\{[^}]+\}/g, "0190c1f0-0000-7000-8000-000000000001");
  const init = (o: Op): RequestInit => ({
    method: o.method.toUpperCase(),
    ...(["post", "put", "patch"].includes(o.method)
      ? { headers: { "content-type": "application/json" }, body: "{}" } : {}),
  });

  it.each(ops.map((o) => [o.id, o] as const))("%s → %s", async (_id, o) => {
    const res = await fetch(url(o.path), init(o));
    expect(res.status).toBe(o.status);
    if (o.example !== undefined) {
      expect(res.headers.get("content-type") ?? "").toMatch(/application\/json/);
      expect(await res.json()).toEqual(o.example);
    }
  });

  it("a request with no matching operation is not silently answered (unhandled → error)", async () => {
    await expect(fetch("http://lims.test/v1/does-not-exist")).rejects.toBeTruthy();
  });
  it("a wrong method on a known path is not answered", async () => {
    const o = ops.find((x) => x.method === "get")!;
    await expect(fetch(url(o.path), { method: "DELETE" })).rejects.toBeTruthy();
  });
});
