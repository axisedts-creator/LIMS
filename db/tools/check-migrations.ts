// Gate-9 scripted checks on db/migrations/*.sql (02-TRD §4.2 "Forbidden in migrations", §4.3 items 1, 2, 4, 6; AC-0B-6.3).
// Usage: node db/tools/check-migrations.ts [--root <dir>]   exit 0 = clean, 1 = violations (one line each, naming the file).
// Static text analysis only; the from-empty apply (AC-0B-6.1) and the catalog checks run against a DB elsewhere.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { UNCAST_CENTRE, alterTarget, createTable, finish, readSqlDir, rootDir, tablesMeta } from "./sql-lib.ts";

const NAME = /^\d{14}_[a-z][a-z0-9]*(?:_[a-z0-9]+)*__[a-z][a-z0-9]*_[a-z0-9_]+\.sql$/;   // <YYYYMMDDHHMMSS>_<schema>__<verb>_<object>.sql
const BANNED_ROLES = new Set(["public", "anon", "authenticated"]);
const NO_DELETE = new Set(["C", "B", "A"]);
const OPEN_ALLOWED = /^CREATE\s+POLICY\s+platform_staff__select__owner_only\s+ON\s+identity\.platform_staff\s+FOR\s+SELECT\s+TO\s+lims_owner\s+USING\s*\(\s*true\s*\)$/i;   // 08 A10.5
const RECOVERY = /^DROP\s+INDEX\s+CONCURRENTLY\s+IF\s+EXISTS\b/i;   // 03-APP-FLOW recovery file for a failed CONCURRENTLY build

const root = rootDir();
const meta = tablesMeta(root);
const exemptPath = join(root, "db/tests/rls_exempt.txt");
const exemptTxt = new Set((existsSync(exemptPath) ? readFileSync(exemptPath, "utf8") : "").split(/\r?\n/)
  .map((l) => l.replace(/#.*/, "").trim().split(/\s+/)[0]).filter(Boolean));
const rlsExempt = (t: string) => meta[t]?.class === "G" || !!meta[t]?.rls_exempt || exemptTxt.has(t);
const noStrings = (s: string) => s.replace(/'(?:[^']|'')*'/g, "''");
const noLineComments = (s: string) => s.replace(/--[^\n]*/g, " ");

const errs: string[] = [];
for (const { file, text, stmts } of readSqlDir(root, "db/migrations")) {
  const bad = (msg: string) => errs.push(`${file}: ${msg}`);
  if (!NAME.test(file)) bad("file name must be <YYYYMMDDHHMMSS>_<schema>__<verb>_<object>.sql (CV §5.12)");
  const codes = stmts.map((s) => s.code);
  const labelled = /cr-approved-breaking/.test(text);

  // §4.2 first statement / non-transactional CONCURRENTLY file
  if (codes.some((c) => /\bCONCURRENTLY\b/i.test(c))) {
    if (!/^SET\s+ROLE\s+lims_owner$/i.test(codes[0] ?? "")) bad("CONCURRENTLY file is non-transactional: first statement must be `SET ROLE lims_owner;` (not SET LOCAL ROLE)");
    if (codes.length !== 2 || !/^(CREATE\s+(UNIQUE\s+)?INDEX|DROP\s+INDEX)\s+CONCURRENTLY\b/i.test(codes[1] ?? ""))
      bad("CREATE INDEX CONCURRENTLY must be alone in its file: exactly one statement after `SET ROLE lims_owner;`");
  } else if (!/^SET\s+LOCAL\s+ROLE\s+lims_owner$/i.test(codes[0] ?? "")) {
    bad("first statement must be the owner role switch `SET LOCAL ROLE lims_owner;`");
  }

  const created: string[] = [];
  const enabled = new Set<string>(), forced = new Set<string>();
  for (const { code, bodies } of stmts) {
    const full = code + "\n" + bodies.map(noLineComments).join("\n");
    if (/^CREATE\s+TYPE\b[\s\S]*\bAS\s+ENUM\b/i.test(code)) bad("CREATE TYPE … AS ENUM is forbidden (use a coded-set table)");
    if (/\b(USING|WITH\s+CHECK)\s*\(\s*true\s*\)/i.test(code) && !OPEN_ALLOWED.test(code))
      bad("USING (true) / WITH CHECK (true) is forbidden (REQ-SEC-016); only identity.platform_staff__select__owner_only TO lims_owner is allowlisted");
    if (/^(GRANT|CREATE\s+POLICY|ALTER\s+POLICY|ALTER\s+DEFAULT\s+PRIVILEGES)\b/i.test(code))
      for (const m of code.matchAll(/\bTO\s+((?:"?\w+"?\s*,\s*)*"?\w+"?)/gi))
        for (const r of m[1].split(",").map((x) => x.trim().replace(/"/g, "").toLowerCase()))
          if (BANNED_ROLES.has(r)) bad(`grant/policy TO ${r} is forbidden on module tables`);
    if (/^CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b/i.test(code) && /\bSECURITY\s+DEFINER\b/i.test(code) && !/\bSET\s+search_path\s*(=|TO)\s*''/i.test(code))
      bad(`${/FUNCTION\s+([\w.]+)/i.exec(code)?.[1]}: SECURITY DEFINER without SET search_path = ''`);
    if (/\b(DISABLE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY\b/i.test(code)) bad("ALTER TABLE … DISABLE / NO FORCE ROW LEVEL SECURITY is forbidden");
    if (UNCAST_CENTRE.test(full)) bad("uncast centre predicate: use centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) (08 A16.1)");
    if (/\bauth\./i.test(noStrings(full))) bad("reference to the auth schema is forbidden (REQ-SEC-038)");
    if (!labelled && !RECOVERY.test(code) && (/^DROP\b/i.test(code) || (/^ALTER\b/i.test(code) && /\bDROP\b/i.test(code))))
      bad("DROP is allowed only in a CR-approved file carrying the label cr-approved-breaking");

    const t = createTable(code);
    if (t) {
      created.push(t.name);
      for (const c of t.columns)
        if ((c.name === "id" || c.name === "tenant_id") && /\bDEFAULT\b/i.test(c.def)) bad(`${t.name}.${c.name}: DEFAULT on ${c.name} is forbidden`);
      const exc = meta[t.name]?.mandatory_column_exceptions ?? [];
      if (!t.columns.some((c) => c.name === "tenant_id") && !rlsExempt(t.name) && !exc.includes("tenant_id"))
        bad(`${t.name}: table without tenant_id is neither class G nor listed in db/tests/rls_exempt.txt`);
    }
    const a = alterTarget(code);
    if (a) {
      if (/\bENABLE\s+ROW\s+LEVEL\s+SECURITY\b/i.test(code)) enabled.add(a);
      if (/\bFORCE\s+ROW\s+LEVEL\s+SECURITY\b/i.test(code) && !/\bNO\s+FORCE\b/i.test(code)) forced.add(a);
      const d = /\b(?:ALTER\s+COLUMN\s+"?(id|tenant_id)"?\s+SET\s+DEFAULT|ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?(id|tenant_id)"?\s[^,]*\bDEFAULT)\b/i.exec(code);
      if (d) bad(`${a}.${d[1] ?? d[2]}: DEFAULT on ${d[1] ?? d[2]} is forbidden`);
    }
    // CV §5.2: no DELETE to lims_app on class C/B/A
    const g = /^GRANT\s+([\s\S]+?)\s+ON\s+(?:TABLE\s+)?([\s\S]+?)\s+TO\s+([\s\S]+?)(?:\s+WITH\s+GRANT\s+OPTION)?$/i.exec(code);
    if (g && /\b(DELETE|ALL)\b/i.test(g[1]) && /\blims_app\b/i.test(g[3]))
      for (const tbl of g[2].split(",").map((x) => x.trim().toLowerCase()))
        if (NO_DELETE.has(meta[tbl]?.class ?? "")) bad(`${tbl}: GRANT DELETE to lims_app on a class ${meta[tbl]?.class} table is forbidden`);
  }
  // §4.3 item 4: ENABLE + FORCE RLS for every new table, in the same file
  for (const t of created)
    if (!rlsExempt(t) && !(enabled.has(t) && forced.has(t))) bad(`${t}: new table needs ENABLE + FORCE ROW LEVEL SECURITY in the same file`);
}
finish("check-migrations", errs);
