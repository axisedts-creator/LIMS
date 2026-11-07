// Shared static-analysis helpers for the gate-9 checks (02-TRD §4.1–§4.3). No DB, no dependencies.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Stmt = { code: string; bodies: string[] };
export type SqlFile = { file: string; text: string; stmts: Stmt[] };
export type TableMeta = {
  class?: string; centre_scoped?: boolean; audited?: boolean; retention?: string;
  columns?: Record<string, string>; shared_with?: string[]; mandatory_column_exceptions?: string[]; rls_exempt?: string;
};

/** `--root <dir>` or the repo root. */
export function rootDir(): string {
  const i = process.argv.indexOf("--root");
  if (i > 0 && process.argv[i + 1]) return resolve(process.argv[i + 1]);
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

/** db/meta/*.yaml are written in the JSON subset of YAML 1.2 plus full-line `#` comments [CONV: no YAML dependency]. */
export function readYaml(path: string): any {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8").split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join("\n").trim();
  return text ? JSON.parse(text) : {};
}

export function tablesMeta(root: string): Record<string, TableMeta> {
  return readYaml(join(root, "db/meta/tables.yaml")).tables ?? {};
}

/** Statements with comments removed and dollar-quoted bodies replaced by `$$`; bodies kept apart. */
export function splitSql(text: string): Stmt[] {
  const out: Stmt[] = [];
  let code = "";
  let bodies: string[] = [];
  let i = 0;
  const flush = () => { if (code.trim()) out.push({ code: code.trim(), bodies }); code = ""; bodies = []; };
  while (i < text.length) {
    const c = text[i];
    const two = text.slice(i, i + 2);
    if (two === "--") { const e = text.indexOf("\n", i); i = e < 0 ? text.length : e; code += " "; continue; }
    if (two === "/*") { const e = text.indexOf("*/", i + 2); i = e < 0 ? text.length : e + 2; code += " "; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < text.length) { if (text[j] === c) { if (text[j + 1] === c) { j += 2; continue; } break; } j++; }
      code += text.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i));
      if (m) {
        const e = text.indexOf(m[0], i + m[0].length);
        const end = e < 0 ? text.length : e;
        bodies.push(text.slice(i + m[0].length, end));
        code += "$$"; i = end + m[0].length; continue;
      }
    }
    if (c === ";") { flush(); i++; continue; }
    code += c; i++;
  }
  flush();
  return out;
}

export function readSqlDir(root: string, sub: string): SqlFile[] {
  const dir = join(root, sub);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()
    .map((file) => { const text = readFileSync(join(dir, file), "utf8"); return { file, text, stmts: splitSql(text) }; });
}

/** Text of the balanced (...) group starting at `open` (index of "("), without the outer parens. */
export function balanced(s: string, open: number): string {
  let d = 0;
  for (let j = open; j < s.length; j++) {
    if (s[j] === "'") { j = s.indexOf("'", j + 1); if (j < 0) break; continue; }
    if (s[j] === "(") d++;
    else if (s[j] === ")" && --d === 0) return s.slice(open + 1, j);
  }
  return s.slice(open + 1);
}

/** Top-level comma split (ignores commas inside parens and quotes). */
export function splitTop(s: string): string[] {
  const parts: string[] = [];
  let d = 0, cur = "", q = "";
  for (const ch of s) {
    if (q) { if (ch === q) q = ""; cur += ch; continue; }
    if (ch === "'" || ch === '"') q = ch;
    else if (ch === "(") d++;
    else if (ch === ")") d--;
    else if (ch === "," && d === 0) { parts.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

const TABLE_ITEM_KEYWORDS = /^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE|LIKE)\b/i;

/** CREATE TABLE <schema>.<table> (...) → name + column definitions. */
export function createTable(code: string): { name: string; columns: { name: string; def: string }[] } | null {
  const m = /^CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)\s*\(/i.exec(code);
  if (!m) return null;
  const columns = splitTop(balanced(code, m[0].length - 1))
    .filter((it) => it && !TABLE_ITEM_KEYWORDS.test(it))
    .map((def) => ({ name: def.split(/\s+/)[0].replace(/"/g, "").toLowerCase(), def }));
  return { name: m[1].toLowerCase(), columns };
}

/** ALTER TABLE <schema>.<table> ... → table name. */
export function alterTarget(code: string): string | null {
  const m = /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)/i.exec(code);
  return m ? m[1].toLowerCase() : null;
}

/** 08 A16.1: `(SELECT app.current_centre_ids())` not followed by `::uuid[]`; also the pg_policies-deparsed
 *  form `( SELECT app.current_centre_ids() AS current_centre_ids)` and its cast `((…))::uuid[]`. */
export const UNCAST_CENTRE = /\(\s*SELECT\s+app\.current_centre_ids\s*\(\s*\)(?:\s+AS\s+\w+)?\s*\)(?!(?:\s*\))*\s*::\s*uuid\s*\[\s*\])/i;

/** Print violations; exit 1 if any, else 0. */
export function finish(tool: string, errs: string[]): never {
  for (const e of errs) console.error(`${tool}: ${e}`);
  if (!errs.length) console.log(`${tool}: ok`);
  process.exit(errs.length ? 1 : 0);
}
