// tools/codegen/gen-probe-manifest.ts (C0-0C, CI gate 10) — 02-TRD §5.3 probe manifest + coverage gate.
// A19.1 (AB-25) device/staff_mobile boundary on non-agent ops; CR-C3-008 pending.json skip list.
// Usage: tsx gen-probe-manifest.ts [--root <dir>] [--check]   (writes <root>/tools/codegen/out/probe-manifest.json)
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export type ProbeOperation = {
  operationId: string;
  method: string;
  path: string;
  security: string[];
  pathParams: string[];
  bodyIdFields: string[];
  bulkIdArrays: string[];
  deviceBoundary: { applies: boolean; deviceToken: boolean; staffMobile: boolean; expectStatus: [401, 403] };
};
export type ProbeManifest = { operations: ProbeOperation[] };

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
const AGENT_PREFIX = "/v1/instruments/agent/";
const isObj = (x: unknown): x is Record<string, any> => typeof x === "object" && x !== null && !Array.isArray(x);

export function buildProbeManifest(files: { name: string; text: string }[]): ProbeManifest {
  const docs = new Map(files.map((f) => [f.name, parse(f.text) as Record<string, any>]));
  // Resolves `#/ptr` (within `file`) or `other.yaml#/ptr`; follows chained refs, cycle-safe.
  const deref = (x: unknown, file: string, seen = new Set<string>()): [unknown, string] => {
    if (!isObj(x) || typeof x.$ref !== "string") return [x, file];
    const [f, ptr = ""] = x.$ref.split("#");
    const target = f || file;
    const key = `${target}#${ptr}`;
    if (seen.has(key)) return [undefined, target];
    seen.add(key);
    let node: unknown = docs.get(target);
    for (const seg of ptr.split("/").filter(Boolean)) node = isObj(node) ? node[seg.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined;
    return deref(node, target, seen);
  };
  const schemes = (sec: unknown) =>
    Array.isArray(sec) ? [...new Set(sec.flatMap((r) => (isObj(r) ? Object.keys(r) : [])))] : undefined;

  const ops: ProbeOperation[] = [];
  const where = new Map<string, string>();
  for (const [name, doc] of docs) {
    if (!isObj(doc) || !isObj(doc.paths)) continue;
    const docSec = schemes(doc.security) ?? [];
    for (const [path, item] of Object.entries(doc.paths)) {
      if (!isObj(item)) continue;
      for (const method of METHODS) {
        const op = item[method];
        if (!isObj(op) || typeof op.operationId !== "string") continue;
        const id = op.operationId;
        if (where.has(id)) throw new Error(`duplicate operationId ${id} (${where.get(id)}, ${name} ${method} ${path})`);
        where.set(id, `${name} ${method} ${path}`);
        const security = schemes(op.security) ?? docSec;
        const [rb, rbFile] = deref(op.requestBody, name);
        const media = isObj(rb) && isObj(rb.content) ? rb.content["application/json"] : undefined;
        const [schema] = isObj(media) ? deref(media.schema, rbFile) : [undefined];
        const props = isObj(schema) && isObj(schema.properties) ? Object.entries(schema.properties) : [];
        const applies = !path.startsWith(AGENT_PREFIX);
        ops.push({
          operationId: id,
          method,
          path,
          security,
          pathParams: [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!),
          bodyIdFields: props.map(([k]) => k).filter((k) => k === "id" || k.endsWith("_id")),
          bulkIdArrays: props.filter(([k, v]) => k.endsWith("_ids") && isObj(v) && v.type === "array").map(([k]) => k),
          deviceBoundary: {
            applies,
            deviceToken: applies && !security.includes("queueDisplayToken"),
            staffMobile: applies,
            expectStatus: [401, 403],
          },
        });
      }
    }
  }
  ops.sort((a, b) => (a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0));
  return { operations: ops };
}

export function probeTags(src: string): string[] {
  return [...src.matchAll(/^[ \t]*\/\/[ \t]*@probe[ \t]+([A-Za-z0-9_]+)[ \t]*$/gm)].map((m) => m[1]!);
}

export function checkProbeCoverage(manifest: ProbeManifest, tagged: string[], pending: string[]): { uncovered: string[] } {
  const ok = new Set([...tagged, ...pending]);
  return { uncovered: manifest.operations.map((o) => o.operationId).filter((id) => !ok.has(id)) };
}

// Every <root>/**/__tests__/probes/ dir, node_modules and .git skipped.
function probeDirs(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === "node_modules" || e.name === ".git") continue;
    const p = join(dir, e.name);
    if (e.name === "probes" && dir.endsWith("__tests__")) out.push(p);
    probeDirs(p, out);
  }
  return out;
}

function main(argv: string[]): number {
  const i = argv.indexOf("--root");
  const root = resolve(i >= 0 ? argv[i + 1]! : join(dirname(fileURLToPath(import.meta.url)), "../.."));
  const specDir = join(root, "contracts/openapi");
  const files = readdirSync(specDir).filter((f) => f.endsWith(".yaml")).map((f) => ({ name: f, text: readFileSync(join(specDir, f), "utf8") }));
  const manifest = buildProbeManifest(files);
  const outDir = join(root, "tools/codegen/out");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "probe-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  const tagged: string[] = [];
  const pending: string[] = [];
  for (const d of probeDirs(root)) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (!e.isFile()) continue;
      const p = join(d, e.name);
      if (e.name === "pending.json") {
        let list: unknown;
        try { list = JSON.parse(readFileSync(p, "utf8")); } catch { list = undefined; }
        if (!Array.isArray(list) || !list.every((x) => typeof x === "string")) {
          console.error(`gate 10: malformed ${p} (must be a JSON array of operationIds)`);
          return 2;
        }
        pending.push(...list);
      } else tagged.push(...probeTags(readFileSync(p, "utf8")));
    }
  }
  if (!argv.includes("--check")) return 0;
  const { uncovered } = checkProbeCoverage(manifest, tagged, pending);
  if (uncovered.length === 0) return 0;
  console.error(`gate 10: ${uncovered.length} operation(s) without a probe test:\n${uncovered.map((u) => `  ${u}`).join("\n")}`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
