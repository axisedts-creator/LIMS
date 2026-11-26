// tools/codegen/check-port-consumers.ts (C0-0C) — 08 A19 P-46 (01-CM §5.1): "A chunk TRD may call a port only if
// its chunk appears [in the 03-IC §4.x heading consumer list] ... The C0 port-manifest check fails a call from a
// non-listed module."
// Usage: node tools/codegen/check-port-consumers.ts [repoRoot]   (exit 1 listing every call from a non-listed module)
// A module may use `ports.<X>Port` when it owns the port (PORT_MODULES) or is in PORT_CONSUMERS[<X>Port]
// (contracts/ports/generated/port-consumers.ts, generated from the 03-IC §4.x headings).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./check-access-actions.ts";
import { PORT_MODULES } from "./lint-openapi.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
// Module code lives in these two trees (first path segment below = module name). core/ is C0, not a module.
const MODULE_ROOTS = ["services/api/src/modules", "services/worker/src/jobs"];
const USE = /\bports\??\.(\w+Port)\b|\bports\??\.?\[\s*['"`](\w+Port)['"`]\s*\]/g;
const SKIP = /(^|[\\/])(node_modules|dist|__tests__|__fixtures__)([\\/]|$)|\.test\.ts$|\.d\.ts$/;

export type Finding = { file: string; line: number; module: string; port: string; why: string };

function readPortConsumers(rootDir: string): Record<string, string[]> {
  const t = readFileSync(join(rootDir, "contracts/ports/generated/port-consumers.ts"), "utf8");
  const body = t.split("PORT_CONSUMERS")[1] ?? "";
  return Object.fromEntries([...body.matchAll(/^\s*([A-Za-z]+Port):\s*\[([^\]]*)\]/gm)]
    .map(([, port, list]) => [port!, [...list!.matchAll(/"([a-z]+)"/g)].map((m) => m[1]!)]));
}

// ponytail: text scan for `ports.<X>Port` / `ports['<X>Port']`, no TS parser. A port object passed on under
// another name is not followed; the runtime guard (T0D-07, port_consumer_not_listed) covers that.
export function checkPortConsumers(rootDir: string): Finding[] {
  const consumers = readPortConsumers(rootDir);
  if (!Object.keys(consumers).length) throw new Error("PORT_CONSUMERS not found in contracts/ports/generated/port-consumers.ts");
  const out: Finding[] = [];
  for (const root of MODULE_ROOTS) {
    const base = join(rootDir, root);
    if (!existsSync(base)) continue;
    for (const rel of (readdirSync(base, { recursive: true }) as string[]).sort()) {
      if (!rel.endsWith(".ts") || SKIP.test(rel)) continue;
      const parts = rel.split(/[\\/]/);
      if (parts.length < 2) continue; // a file directly under the root belongs to no module
      const module = parts[0]!;
      const src = stripComments(readFileSync(join(base, rel), "utf8"));
      for (const m of src.matchAll(USE)) {
        const port = (m[1] ?? m[2])!;
        const why = !(port in consumers) ? "is not a port of PORT_CONSUMERS"
          : PORT_MODULES[port] === module || consumers[port]!.includes(module) ? "" : `does not list module '${module}' as a consumer`;
        if (why) out.push({ file: `${root}/${rel.replace(/\\/g, "/")}`, line: src.slice(0, m.index).split("\n").length, module, port, why });
      }
    }
  }
  return out;
}

// Known uses from a non-listed module, reported and not yet resolved. Each entry is printed as a warning on every
// run; an entry that no longer occurs in the code is stale and fails the check. Anything not listed here still fails.
export const PENDING: readonly { file: string; module: string; port: string }[] = [
  // Owner decision 2026-11-26 (PR 9): reported, not yet resolved; the runtime guard in services/api/src/core/ports/registry.ts
  // applies the same rule, so this call path needs either a PORT_CONSUMERS entry or removal.
  { file: "services/api/src/modules/billing/service/release.service.ts", module: "billing", port: "FrontdeskPort" },
];

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const all = checkPortConsumers(resolve(process.argv[2] ?? join(HERE, "../..")));
  const hits = (p: (typeof PENDING)[number]) => all.filter((b) => b.file === p.file && b.module === p.module && b.port === p.port);
  const bad = all.filter((b) => !PENDING.some((p) => hits(p).includes(b)));
  const stale = PENDING.filter((p) => !hits(p).length);
  for (const p of PENDING) for (const b of hits(p)) console.warn(`warning: ${b.file}:${b.line}: ${b.port} ${b.why} (PENDING, owner decision 2026-11-26: not yet resolved)`);
  for (const p of stale) console.error(`${p.file}: PENDING entry ${p.module} -> ${p.port} no longer occurs in the code: remove the stale exception`);
  for (const b of bad) console.error(`${b.file}:${b.line}: ${b.port} ${b.why} (03-IC §4.x heading / PORT_CONSUMERS; 08 A19 P-46)`);
  if (bad.length) console.error(`check-port-consumers: ${bad.length} port use(s) from a non-listed module`);
  process.exit(bad.length || stale.length ? 1 : 0);
}
