// Gate-9 item 5 (02-TRD §4.3; CM §5 R3; CV §5.4; AC-0B-6.2): every cross-schema FK in db/migrations points downstream → upstream
// as allowed by db/meta/dag.yaml, and nothing outside billing references billing.
// Usage: node db/tools/check-fk-dag.ts [--root <dir>]   exit 0 = clean, 1 = violations.
import { join } from "node:path";
import { alterTarget, createTable, finish, readSqlDir, readYaml, rootDir } from "./sql-lib.ts";

const root = rootDir();
const allowed: Record<string, string[]> = readYaml(join(root, "db/meta/dag.yaml")).allowed ?? {};
const errs: string[] = [];
for (const { file, stmts } of readSqlDir(root, "db/migrations")) {
  for (const { code } of stmts) {
    const src = createTable(code)?.name ?? alterTarget(code);
    if (!src) continue;
    const from = src.split(".")[0];
    for (const m of code.matchAll(/\bREFERENCES\s+([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)/gi)) {
      const to = m[1].toLowerCase(), tgt = `${to}.${m[2].toLowerCase()}`;
      if (to === from) continue;
      if (to === "billing") errs.push(`${file}: ${src} -> ${tgt}: no FK may reference billing (CV §5.4)`);
      else if (!(allowed[from] ?? []).includes(to)) errs.push(`${file}: ${src} -> ${tgt}: FK direction ${from} -> ${to} not allowed by db/meta/dag.yaml (CM §5 R3)`);
    }
  }
}
finish("check-fk-dag", errs);
