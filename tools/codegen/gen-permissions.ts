// tools/codegen/gen-permissions.ts (C0-0C, T0C-05) — 02-TRD §5.3 `gen-permissions` + the three 08 §4.1 CI rules.
// Input: parsed contracts/permissions.yaml. Output: contracts/ports/generated/permissions.ts + db/seeds/001_core__g_permissions.sql.

export type PermissionRuleViolation = { rule: "R1" | "R2" | "R3" | "UNKNOWN"; code: string; message: string };
type Perm = { code: string; privileged?: boolean; roles?: string[]; phase?: string | number };
type Doc = {
  roles?: { code: string }[];
  partner_roles?: { code: string }[];
  platform_roles?: { code: string }[];
  fixed_actor_permissions?: Record<string, unknown>;
  permissions: Perm[];
};

const PLACEHOLDER = /^<(\w+) set>$/;
// 08 A19 D-101: partner self-service; the only staff code allowed in a partner fixed set (partner_admin inherits).
const PARTNER_EXCEPTION = "identity.self.manage";
// LD-01 (2026-11-07): patient self-cancel shares the code with staff; centre scope applies to staff only.
const PATIENT_EXCEPTION = "engagement.booking.cancel";

// Fixed sets flattened to { actor, sub, codes } with `<x set>` placeholders expanded from a sibling set.
// Non-list values (e.g. `system`, declared per worker manifest) carry no codes and are skipped.
export function fixedSets(doc: Doc): { actor: string; sub: string | null; codes: string[] }[] {
  const out: { actor: string; sub: string | null; codes: string[] }[] = [];
  for (const [actor, v] of Object.entries(doc.fixed_actor_permissions ?? {})) {
    if (Array.isArray(v)) out.push({ actor, sub: null, codes: v.map(String) });
    else if (v && typeof v === "object") {
      const group = v as Record<string, unknown>;
      const expand = (list: unknown, seen: string[]): string[] =>
        (Array.isArray(list) ? list.map(String) : []).flatMap((c) => {
          const m = PLACEHOLDER.exec(c);
          if (!m) return [c];
          if (seen.includes(m[1]!) || !Array.isArray(group[m[1]!])) throw new Error(`fixed_actor_permissions.${actor}: bad placeholder ${c}`);
          return expand(group[m[1]!], [...seen, m[1]!]);
        });
      for (const [sub, list] of Object.entries(group)) out.push({ actor, sub, codes: [...new Set(expand(list, [sub]))] });
    }
  }
  return out;
}

export function checkPermissionRules(doc: object, extraGrants: { role: string; code: string }[] = []): PermissionRuleViolation[] {
  const d = doc as Doc;
  const out: PermissionRuleViolation[] = [];
  const tenantRoles = new Set((d.roles ?? []).map((r) => r.code));
  const byCode = new Map(d.permissions.map((p) => [p.code, p]));
  const sets = fixedSets(d);
  const partnerPatientCodes = new Set(sets.filter((s) => s.actor === "partner" || s.actor === "patient").flatMap((s) => s.codes));

  for (const s of sets)
    for (const code of s.codes) {
      const where = `fixed_actor_permissions.${s.actor}${s.sub ? "." + s.sub : ""}`;
      const p = byCode.get(code);
      if (!p) { out.push({ rule: "UNKNOWN", code, message: `${where}: code not in permissions` }); continue; }
      const isStaff = (p.roles ?? []).length > 0;
      // LD-01 / CR-C0-0C-001: patient self-cancel (E36) shares engagement.booking.cancel with staff S4.
      const exempt = (s.actor === "partner" && code === PARTNER_EXCEPTION) || (s.actor === "patient" && code === PATIENT_EXCEPTION);
      if ((s.actor === "partner" || s.actor === "patient") && isStaff && !exempt)
        out.push({ rule: "R3", code, message: `${where}: staff code in a ${s.actor} fixed set` });
    }

  // Grants from the yaml cannot be R1 (they make roles non-empty); extraGrants are effective grants on top (e.g. C2 role editing).
  const grants = [
    ...d.permissions.flatMap((p) => (p.roles ?? []).map((role) => ({ role, code: p.code, yaml: true }))),
    ...extraGrants.map((g) => ({ ...g, yaml: false })),
  ];
  for (const g of grants) {
    if (!tenantRoles.has(g.role)) continue;
    const p = byCode.get(g.code);
    if (!p) { out.push({ rule: "UNKNOWN", code: g.code, message: `grant to ${g.role}: code not in permissions` }); continue; }
    if (!g.yaml && (p.roles ?? []).length === 0)
      out.push({ rule: "R1", code: g.code, message: `roles: [] code granted to tenant role ${g.role}` });
    if (!g.yaml && partnerPatientCodes.has(g.code) && (p.roles ?? []).length === 0)
      out.push({ rule: "R2", code: g.code, message: `partner/patient-only code granted to tenant role ${g.role}` });
  }
  return out;
}

const q = (s: string) => JSON.stringify(s);
const sq = (s: string) => `'${s.replace(/'/g, "''")}'`;
const PHASES = ["1", "1.5", "2", "3"];
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function genPermissions(doc: Doc, header: string, sqlHeader: string): { ts: string; sql: string } {
  // 08 §4.1 rule violations are reported by the CLI (codegen.ts exits 1), not thrown here: outputs stay generatable.
  const perms = [...doc.permissions].sort((a, b) => cmp(a.code, b.code));
  const seen = new Set<string>();
  for (const p of perms) {
    if (seen.has(p.code)) throw new Error(`duplicate permission ${p.code}`);
    seen.add(p.code);
    if (!/^[a-z_]+\.[a-z_]+\.[a-z_]+$/.test(p.code)) throw new Error(`bad permission code ${p.code}`); // 05-SCHEMA g_permissions__code__ck
    if (!PHASES.includes(String(p.phase ?? "1"))) throw new Error(`bad phase for ${p.code}`);
  }
  const roleCodes = [...doc.roles ?? [], ...doc.partner_roles ?? [], ...doc.platform_roles ?? []].map((r) => r.code);
  const grants = Object.fromEntries([...new Set(roleCodes)].sort().map((r) => [r, perms.filter((p) => (p.roles ?? []).includes(r)).map((p) => p.code)]));
  const fixed: Record<string, string[] | Record<string, string[]>> = {};
  for (const s of fixedSets(doc).sort((a, b) => cmp(a.actor + "." + (a.sub ?? ""), b.actor + "." + (b.sub ?? "")))) {
    const codes = [...s.codes].sort();
    if (s.sub === null) fixed[s.actor] = codes;
    else ((fixed[s.actor] ??= {}) as Record<string, string[]>)[s.sub] = codes;
  }
  const list = (xs: string[], ind: string) => xs.length ? `[\n${xs.map((x) => `${ind}  ${q(x)},`).join("\n")}\n${ind}]` : "[]";
  const fixedTs = Object.entries(fixed).map(([actor, v]) => Array.isArray(v)
    ? `  ${actor}: ${list(v, "  ")},`
    : `  ${actor}: {\n${Object.entries(v).map(([sub, c]) => `    ${sub}: ${list(c, "    ")},`).join("\n")}\n  },`).join("\n");

  const ts = `${header}
export type PermissionCode =
${perms.map((p) => `  | ${q(p.code)}`).join("\n")};

export const PERMISSION_CODES: readonly PermissionCode[] = ${list(perms.map((p) => p.code), "")};

export const PRIVILEGED: ReadonlySet<PermissionCode> = new Set([
${perms.filter((p) => p.privileged).map((p) => `  ${q(p.code)},`).join("\n")}
]);

// Default role grants (tenant, partner and platform roles) from permissions[].roles.
export const ROLE_GRANTS: Readonly<Record<string, readonly PermissionCode[]>> = {
${Object.entries(grants).map(([r, c]) => `  ${r}: ${list(c, "  ")},`).join("\n")}
};

// fixed_actor_permissions (08 §4.1) with placeholders expanded; \`system\` is declared per worker manifest (02-CV §2.3).
export const FIXED_ACTOR_PERMISSIONS = {
${fixedTs}
} as const satisfies Record<string, readonly PermissionCode[] | Record<string, readonly PermissionCode[]>>;
`;
  // Class-G seed: owner role (LD-30, LD-38); DO NOTHING so a re-run never rewrites rows (02-TRD §4.6, CR-C0-T0B-09b).
  const sql = `${sqlHeader}
SET LOCAL ROLE lims_owner;

INSERT INTO core.g_permissions (code, module, privileged, phase) VALUES
${perms.map((p) => `  (${sq(p.code)}, ${sq(p.code.split(".")[0]!)}, ${p.privileged ? "true" : "false"}, ${sq(String(p.phase ?? "1"))})`).join(",\n")}
ON CONFLICT (code) DO NOTHING;
`;
  return { ts, sql };
}
