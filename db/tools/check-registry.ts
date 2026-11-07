// Gate-9 items 3 and policy shape (02-TRD §4.1, §4.3; 05-SCHEMA §9 rule 2, 4; 08 A16.1, A17 P-16; REQ-SEC-004).
//  - every table created in db/migrations is in db/meta/tables.yaml with class, centre_scoped, audited, retention, phi_class per column;
//  - every __tenant / __tenant_centre policy of db/policies/*.sql has app.is_staff_or_system() in USING and in WITH CHECK, unless the
//    table is shared_with and has the matching __<actor> policy for every listed actor;
//  - no policy uses the uncast centre predicate.
// Usage: node db/tools/check-registry.ts [--root <dir>]   exit 0 = clean, 1 = violations. Static; the catalog half runs in T0B-08.
import { UNCAST_CENTRE, alterTarget, balanced, createTable, finish, readSqlDir, rootDir, tablesMeta } from "./sql-lib.ts";

const PHI = /^P[0-3]$/;
const ACTORS = new Set(["partner", "portal", "patient"]);
const GUARD = /\bapp\.is_staff_or_system\s*\(\s*\)/i;

const root = rootDir();
const meta = tablesMeta(root);
const errs: string[] = [];

// ---- registry vs migrations
const cols = new Map<string, Set<string>>();
for (const { stmts } of readSqlDir(root, "db/migrations"))
  for (const { code } of stmts) {
    const t = createTable(code);
    if (t) cols.set(t.name, new Set(t.columns.map((c) => c.name)));
    const a = alterTarget(code);
    if (a) for (const m of code.matchAll(/\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?/gi)) cols.get(a)?.add(m[1].toLowerCase());
  }
for (const [t, cs] of cols) {
  const m = meta[t];
  if (!m) { errs.push(`${t}: table not registered in db/meta/tables.yaml`); continue; }
  for (const f of ["class", "centre_scoped", "audited", "retention"] as const)
    if (m[f] === undefined) errs.push(`${t}: tables.yaml entry lacks ${f}`);
  for (const c of cs) if (!PHI.test(m.columns?.[c] ?? "")) errs.push(`${t}.${c}: column lacks phi_class (P0..P3) in tables.yaml`);
  for (const a of m.shared_with ?? []) if (!ACTORS.has(a)) errs.push(`${t}: shared_with value ${a} not in partner|portal|patient`);
}

// ---- policies
type Pol = { name: string; table: string; cmd: string; actor: string; base: string; using: string | null; check: string | null; file: string };
const pols: Pol[] = [];
for (const { file, stmts } of readSqlDir(root, "db/policies"))
  for (const { code } of stmts) {
    const m = /^CREATE\s+POLICY\s+(\w+)\s+ON\s+([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)/i.exec(code);
    if (!m) continue;
    const n = /^(\w+?)__(select|insert|update|delete|all)__(\w+)$/.exec(m[1]);
    const u = /\bUSING\s*\(/i.exec(code), w = /\bWITH\s+CHECK\s*\(/i.exec(code);
    pols.push({
      name: m[1], table: m[2].toLowerCase(), file, base: n?.[1] ?? "", cmd: n?.[2] ?? "", actor: n?.[3] ?? "",
      using: u ? balanced(code, u.index + u[0].length - 1) : null, check: w ? balanced(code, w.index + w[0].length - 1) : null,
    });
  }
const names = new Set(pols.map((p) => `${p.table}|${p.name}`));
for (const p of pols) {
  const at = `${p.file}: ${p.name} on ${p.table}`;
  if (!meta[p.table]) errs.push(`${at}: table not registered in db/meta/tables.yaml`);
  if (UNCAST_CENTRE.test(`${p.using ?? ""} ${p.check ?? ""}`))
    errs.push(`${at}: uncast centre predicate; use = ANY ((SELECT app.current_centre_ids())::uuid[]) (08 A16.1)`);
  if (p.actor !== "tenant" && p.actor !== "tenant_centre") continue;
  const missing = [["USING", p.using], ["WITH CHECK", p.check]].filter(([, s]) => s !== null && !GUARD.test(s as string)).map(([k]) => k);
  if (!missing.length) continue;
  const shared = meta[p.table]?.shared_with ?? [];
  if (!shared.length) {
    errs.push(`${at}: ${missing.join(" and ")} lacks the staff guard (SELECT app.is_staff_or_system()) and the table is not shared_with (08 A17 P-16)`);
    continue;
  }
  for (const a of shared)
    if (!names.has(`${p.table}|${p.base}__${p.cmd}__${a}`))
      errs.push(`${at}: guard-less policy on shared_with table needs actor policy ${p.base}__${p.cmd}__${a} (shared_with ${a}; 08 A17 P-16)`);
}
finish("check-registry", errs);
