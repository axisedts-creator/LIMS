// tools/codegen/check-access-actions.ts (C0-0C) — 08 A13 P-3 (02-CV §10.2 "Audit", 03-IC §13.1):
// "Every `action` must exist in 03-IC §13.1 / the C0 seed. CI (C0-0C) fails a string-literal `action:` in
// `services/**` that is not in `audit.g_cs_access_actions`."
// Usage: node tools/codegen/check-access-actions.ts [repoRoot]   (exit 1 listing every unregistered action)
// Registered set = the seed input of gen-access-actions.ts (C0 base list + 03-IC §13.1); `pnpm codegen --check` keeps the SQL seed equal to it.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { C0_BASE_ACCESS_ACTIONS, accessActionsFromIC } from "./gen-access-actions.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const LITERAL = /\baction:\s*(['"`])([^'"`\n]*)\1/g;
const CODE = /^[a-z_]+\.[a-z_]+$/; // g_cs_access_actions__code__ck
const SKIP = /(^|[\\/])(node_modules|dist|__tests__|__fixtures__)([\\/]|$)|\.test\.ts$|\.d\.ts$/;

/** The `{ ... }` literal that starts at `open` (index of `{`), by brace counting. */
function objectAt(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

/** Comments blanked out (same length, so offsets and line numbers hold). `://` is kept: it is a URL, not a comment. */
export const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/[^\n]*/g, (c) => c.replace(/[^\n]/g, " "));

export type Finding = { file: string; line: number; action: string };

// ponytail: text scan, no TS parser. `action:` is also used for things that are not access-log codes
// (state machine steps, audit_log verbs), so a literal is checked when it is (a) inside an `.access({ ... })`
// call or (b) shaped like an access code (`<entity>.<verb>`) anywhere. Not seen: an object built elsewhere with a
// non-code-shaped action and passed as a variable, and a template with `${...}` (not a string literal; the
// access_log FK refuses an unknown code at run time). Use a TS AST walk if that ever matters.
export function checkAccessActions(rootDir: string): Finding[] {
  const known = new Set<string>([...C0_BASE_ACCESS_ACTIONS,
    ...accessActionsFromIC(readFileSync(join(rootDir, "spec/program/03-INTERFACE-CATALOG.md"), "utf8").replace(/\r\n/g, "\n"))]);
  const base = join(rootDir, "services");
  const out: Finding[] = [];
  for (const rel of (readdirSync(base, { recursive: true }) as string[]).sort()) {
    if (!rel.endsWith(".ts") || SKIP.test(rel)) continue;
    const src = stripComments(readFileSync(join(base, rel), "utf8"));
    const inAccess: [number, number][] = [...src.matchAll(/\.access\(\s*\{/g)].map((m) => {
      const open = m.index + m[0].length - 1;
      return [open, open + objectAt(src, open).length];
    });
    for (const m of src.matchAll(LITERAL)) {
      const action = m[2]!;
      if (action.includes("${")) continue;
      const checked = CODE.test(action) || inAccess.some(([s, e]) => m.index > s && m.index < e);
      if (checked && !known.has(action)) {
        out.push({ file: `services/${rel.replace(/\\/g, "/")}`, line: src.slice(0, m.index).split("\n").length, action });
      }
    }
  }
  return out;
}

// Known unregistered actions waiting for a CR. Each entry is printed as a warning on every run; an entry that no
// longer occurs in the code is stale and fails the check. Anything not listed here still fails.
export const PENDING_CR: readonly { file: string; action: string; cr: string }[] = [
  // CR .orchestra/cr/T0B-PARTYSET-1.md: remove when the CR registers the action.
  { file: "services/api/src/modules/partners/service/partyset.service.ts", action: "party_id_number.reveal", cr: ".orchestra/cr/T0B-PARTYSET-1.md" },
];

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const all = checkAccessActions(resolve(process.argv[2] ?? join(HERE, "../..")));
  const hits = (p: (typeof PENDING_CR)[number]) => all.filter((b) => b.file === p.file && b.action === p.action);
  const bad = all.filter((b) => !PENDING_CR.some((p) => hits(p).includes(b)));
  const stale = PENDING_CR.filter((p) => !hits(p).length);
  for (const p of PENDING_CR) for (const b of hits(p)) console.warn(`warning: ${b.file}:${b.line}: access action '${b.action}' is not registered yet (PENDING_CR, ${p.cr})`);
  for (const p of stale) console.error(`${p.file}: PENDING_CR entry '${p.action}' no longer occurs in the code: remove the stale exception`);
  for (const b of bad) console.error(`${b.file}:${b.line}: access action '${b.action}' is not in audit.g_cs_access_actions (03-IC §13.1 / C0 seed; 08 A13 P-3)`);
  if (bad.length) console.error(`check-access-actions: ${bad.length} unregistered action literal(s)`);
  process.exit(bad.length || stale.length ? 1 : 0);
}
