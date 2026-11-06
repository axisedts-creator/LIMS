// T0C-02 / AC-0C-1.2 — contracts/ports/ holds common.ts + the 13 ports of IC §4 (§4.2–§4.11, §4.15–§4.17)
// with the exact signatures, and `tsc --noEmit` passes. Source of truth = spec/program/03-INTERFACE-CATALOG.md §4.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const contractsDir = resolve(here, "..");
const portsDir = join(contractsDir, "ports");
const IC_PATH = resolve(here, "../../spec/program/03-INTERFACE-CATALOG.md");
const BASE_TSCONFIG = resolve(here, "../../tsconfig.base.json");

const PORTS = [
  "CatalogPort", "FrontdeskPort", "BillingPort", "LabPort", "IdentityPort", "ReportingPort", "NotificationPort",
  "PaymentProviderPort", "SmartReportPort", "QualityPort", "BillingCommandPort", "RenderPort", "EngagementPort",
] as const;
const FILES = ["common", ...PORTS]; // IC order: §4.1 then §4.2–§4.11, §4.15–§4.17 (file order below is by name)

/** IC §4 text, CRLF-normalised, from "## 4. Ports" to "## 5. ". */
function icSection4(): string {
  const md = readFileSync(IC_PATH, "utf8").replace(/\r\n/g, "\n");
  const s = md.search(/^## 4\. Ports/m);
  const e = md.search(/^## 5\. /m);
  if (s < 0 || e < 0) throw new Error("IC §4 boundaries not found");
  return md.slice(s, e);
}

/** name (file stem) -> verbatim ts block, keyed by the block's first-line "// contracts/ports/<name>.ts" comment. */
function icBlocks(): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of icSection4().matchAll(/```ts\n([\s\S]*?)\n```/g)) {
    const head = /^\/\/ contracts\/ports\/(\w+)\.ts/.exec(m[1]!);
    if (!head) throw new Error(`IC §4 ts block without path header: ${m[1]!.slice(0, 60)}`);
    out.set(head[1]!, m[1]!);
  }
  return out;
}

/** Split TS source into code (comments removed, string/template literals kept) and comment text. */
function split(src: string): { code: string; comments: string } {
  let code = "", comments = "", i = 0;
  while (i < src.length) {
    const c = src[i]!, n = src[i + 1];
    if (c === "/" && n === "/") {
      const j = src.indexOf("\n", i); const end = j < 0 ? src.length : j;
      comments += src.slice(i, end) + "\n"; i = end;
    } else if (c === "/" && n === "*") {
      const j = src.indexOf("*/", i + 2); const end = j < 0 ? src.length : j + 2;
      comments += src.slice(i, end) + "\n"; i = end; code += " ";
    } else if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      code += src.slice(i, j + 1); i = j + 1;
    } else { code += c; i++; }
  }
  return { code, comments };
}

/** Whitespace-insensitive code form (formatters may re-flow; tokens, order, punctuation may not change). */
const norm = (code: string) => code.replace(/\s+/g, "");

const errorCodes: Set<string> = (() => {
  const doc = parse(readFileSync(join(contractsDir, "errors.yaml"), "utf8")) as { code: string }[];
  return new Set(doc.map((e) => e.code));
})();

/** Error codes named in `@throws` JSDoc text (each from `@throws` to the end of its comment). */
function throwsCodes(comments: string): string[] {
  const found: string[] = [];
  for (const m of comments.matchAll(/@throws([\s\S]*?)(?:\*\/|\n\s*\/\/|$)/g)) {
    for (const t of m[1]!.matchAll(/\b[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\b/g)) if (errorCodes.has(t[0])) found.push(t[0]);
  }
  return found.sort();
}

const methodNames = (code: string) => [...code.matchAll(/^\s+(\w+)\(ctx: RequestContext/gm)].map((m) => m[1]!);

const blocks = icBlocks();
const read = (name: string) => readFileSync(join(portsDir, `${name}.ts`), "utf8").replace(/\r\n/g, "\n");

describe("IC §4 extraction (test harness sanity)", () => {
  it("finds common.ts + the 13 ports, nothing else", () => {
    expect([...blocks.keys()].sort()).toEqual([...FILES].sort());
    expect(blocks.size).toBe(14);
  });
  it("comparator detects a dropped method and a changed type", () => {
    const ic = split(blocks.get("CatalogPort")!).code;
    expect(norm(ic.replace(/\n\s*getTest\(.*\n/, "\n"))).not.toBe(norm(ic));
    expect(norm(ic.replace("Promise<TestDefinition>", "Promise<PanelDefinition>"))).not.toBe(norm(ic));
  });
});

describe("AC-0C-1.2 file set", () => {
  it("contracts/ports/ holds exactly common.ts + the 13 port files at top level (plus generated/)", () => {
    expect(existsSync(portsDir), "contracts/ports/ missing").toBe(true);
    const tops = readdirSync(portsDir, { withFileTypes: true });
    const ts = tops.filter((d) => d.isFile()).map((d) => d.name).sort();
    expect(ts).toEqual(FILES.map((f) => `${f}.ts`).sort());
    const dirs = tops.filter((d) => d.isDirectory()).map((d) => d.name);
    expect(dirs.filter((d) => d !== "generated")).toEqual([]);
  });
});

describe.each(FILES)("%s.ts equals IC §4 block", (name) => {
  const icRaw = blocks.get(name)!;
  it("exists", () => expect(existsSync(join(portsDir, `${name}.ts`)), `contracts/ports/${name}.ts missing`).toBe(true));
  it("code (comments ignored, whitespace-insensitive) is verbatim the IC block", () => {
    const got = split(read(name)).code;
    const want = split(icRaw).code;
    expect(norm(got)).toBe(norm(want));
  });
  it("declares every IC method name (clear failure message)", () => {
    expect(methodNames(split(read(name)).code)).toEqual(methodNames(split(icRaw).code));
  });
  it("keeps the @throws error codes of every method", () => {
    expect(throwsCodes(split(read(name)).comments)).toEqual(throwsCodes(split(icRaw).comments));
  });
});

describe("spot checks on the load-bearing signatures", () => {
  it("common.ts: PortRegistry has all 13 ports, LimsError has the 3-arg constructor", () => {
    const c = norm(split(read("common")).code);
    for (const p of PORTS) expect(c).toContain(norm(`readonly ${p}: import('./${p}').${p};`));
    expect(c).toContain(norm("constructor(readonly code: ErrorCode, readonly safeDetail?: string, readonly fieldErrors?: readonly FieldError[])"));
  });
  it("CatalogPort carries the 08 additions getTaxRate and getPriceListStatus", () => {
    const c = split(read("CatalogPort")).code;
    expect(methodNames(c)).toEqual(expect.arrayContaining(["getTaxRate", "getPriceListStatus", "resolveCommentCodes"]));
    expect(c).toContain("CATALOG_PORT_VERSION");
  });
  it("every port exports its *_PORT_VERSION const", () => {
    for (const p of PORTS) expect(read(p), p).toMatch(/export const [A-Z_]+_PORT_VERSION = \d+ as const;/);
  });
});

describe("tsc --noEmit", () => {
  const tmp = mkdtempSync(join(tmpdir(), "t0c02-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("contracts/ports/*.ts type-checks under tsconfig.base.json (strict, exactOptionalPropertyTypes, verbatimModuleSyntax)", () => {
    expect(existsSync(portsDir), "contracts/ports/ missing").toBe(true);
    let tscJs: string;
    try {
      tscJs = createRequire(join(contractsDir, "package.json")).resolve("typescript/lib/tsc.js");
    } catch {
      throw new Error("`typescript` not resolvable from contracts/ — add it to contracts/package.json devDependencies");
    }
    // Work on a copy so the check is independent of the implementer's tsconfig; ErrorCode comes from T0C-05's
    // generated/error-codes.ts — when that is absent, stub it so T0C-02 is checkable on its own.
    const work = join(tmp, "ports");
    cpSync(portsDir, work, { recursive: true });
    const gen = join(work, "generated", "error-codes.ts");
    if (!existsSync(gen)) {
      mkdirSync(dirname(gen), { recursive: true });
      writeFileSync(gen, "export type ErrorCode = string;\n");
    }
    const cfg = join(tmp, "tsconfig.json");
    writeFileSync(cfg, JSON.stringify({
      extends: BASE_TSCONFIG.replace(/\\/g, "/"),
      compilerOptions: { noEmit: true, module: "ESNext", moduleResolution: "Bundler", types: [], declaration: false, sourceMap: false },
      include: ["ports/**/*.ts"],
    }));
    const r = spawnSync(process.execPath, [tscJs, "-p", cfg, "--pretty", "false"], { encoding: "utf8", timeout: 120_000 });
    expect(r.stdout + r.stderr).toBe("");
    expect(r.status).toBe(0);
  }, 150_000);
});
