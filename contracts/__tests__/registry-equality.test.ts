// T0C-03 / AC-0C-1.3 — contracts/{errors,routes,permissions}.yaml must equal the fenced YAML
// blocks of IC §8, §7, §11 entry for entry. Source of truth = spec/program/03-INTERFACE-CATALOG.md.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const contractsDir = resolve(here, "..");
const IC_PATH = resolve(here, "../../spec/program/03-INTERFACE-CATALOG.md");

type Entry = Record<string, unknown>;

/** Strict parse: duplicate map keys are errors (IC §7 says "CI parses the file with a YAML parser"). */
const strictParse = (src: string, what: string): any => {
  try {
    return parse(src, { strict: true, uniqueKeys: true });
  } catch (e) {
    throw new Error(`${what} is not strict YAML: ${(e as Error).message}`);
  }
};

/** The fenced ```yaml blocks inside IC "## <n>. ..." (up to the next "## "). */
function icBlocks(section: number): string[] {
  const md = readFileSync(IC_PATH, "utf8").replace(/\r\n/g, "\n");
  const start = md.search(new RegExp(`^## ${section}\\. `, "m"));
  if (start < 0) throw new Error(`IC §${section} heading not found`);
  const rest = md.slice(start + 3);
  const next = rest.search(/^## /m);
  const body = next < 0 ? rest : rest.slice(0, next);
  return [...body.matchAll(/```yaml\n([\s\S]*?)\n```/g)].map((m) => m[1]);
}

function icDoc(section: number): any {
  const blocks = icBlocks(section);
  expect(blocks.length, `IC §${section} must hold exactly one yaml block`).toBe(1);
  return strictParse(blocks[0], `IC §${section} block`);
}

function contractDoc(file: string): any {
  const p = resolve(contractsDir, file);
  expect(existsSync(p), `contracts/${file} must exist`).toBe(true);
  return strictParse(readFileSync(p, "utf8"), `contracts/${file}`);
}

/** Entry-by-entry diff of two lists keyed by `key`; returns human-readable problems. */
function diffByKey(expected: Entry[], actual: Entry[], key: string): string[] {
  const out: string[] = [];
  const a = new Map(actual.map((e) => [String(e[key]), e]));
  const e = new Map(expected.map((x) => [String(x[key]), x]));
  for (const [k, v] of e) {
    if (!a.has(k)) out.push(`missing ${key}=${k}`);
    else if (JSON.stringify(sortKeys(v)) !== JSON.stringify(sortKeys(a.get(k)))) {
      out.push(`differs ${key}=${k}: IC=${JSON.stringify(v)} file=${JSON.stringify(a.get(k))}`);
    }
  }
  for (const k of a.keys()) if (!e.has(k)) out.push(`extra ${key}=${k} (not in IC)`);
  return out;
}

function sortKeys(v: any): any {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  }
  return v;
}

function dupes(xs: string[]): string[] {
  return xs.filter((x, i) => xs.indexOf(x) !== i);
}

describe("IC source blocks are parseable (guards the test itself)", () => {
  it("IC §7, §8, §11 each hold one strict-YAML block with plausible size", () => {
    expect(icDoc(8).length).toBeGreaterThan(100);
    expect(icDoc(7).routes.length).toBeGreaterThan(60);
    expect(icDoc(11).permissions.length).toBeGreaterThan(150);
  });
});

describe("AC-0C-1.3 errors.yaml == IC §8", () => {
  it("equals IC §8 entry for entry (same codes, order, fields)", () => {
    const ic: Entry[] = icDoc(8);
    const file: Entry[] = contractDoc("errors.yaml");
    expect(Array.isArray(file), "errors.yaml root must be a list").toBe(true);
    expect(diffByKey(ic, file, "code")).toEqual([]);
    expect(file.map((e) => e.code)).toEqual(ic.map((e) => e.code)); // order preserved
    expect(file).toEqual(ic);
  });

  it("codes are unique; http in 400..599; owner is a chunk id; title non-empty", () => {
    const file: Entry[] = contractDoc("errors.yaml");
    expect(dupes(file.map((e) => String(e.code)))).toEqual([]);
    for (const e of file) {
      expect(String(e.code)).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
      expect(e.http as number).toBeGreaterThanOrEqual(400);
      expect(e.http as number).toBeLessThanOrEqual(599);
      expect(String(e.owner)).toMatch(/^C\d+$/);
      expect(String(e.title).length, `title of ${e.code}`).toBeGreaterThan(0);
    }
  });
});

describe("AC-0C-1.3 routes.yaml == IC §7", () => {
  it("equals IC §7 entry for entry (version, origins, fallbacks, routes)", () => {
    const ic = icDoc(7);
    const file = contractDoc("routes.yaml");
    expect(file.version).toBe(1);
    expect(sortKeys(file.origins)).toEqual(sortKeys(ic.origins));
    expect(file.fallbacks).toEqual(ic.fallbacks);
    expect(diffByKey(ic.routes, file.routes, "id")).toEqual([]);
    expect(file.routes.map((r: Entry) => r.id)).toEqual(ic.routes.map((r: Entry) => r.id));
    expect(file).toEqual(ic);
  });

  it("route ids unique; origins and fallbacks resolve", () => {
    const f = contractDoc("routes.yaml");
    const ids: string[] = f.routes.map((r: Entry) => r.id);
    expect(dupes(ids)).toEqual([]);
    for (const r of f.routes) expect(Object.keys(f.origins)).toContain(r.origin);
    // IC §7: `fallbacks:` is its own top-level list (not route ids); per-route `fallback:` must be a member of it.
    expect(dupes(f.fallbacks)).toEqual([]);
    for (const r of f.routes as Entry[]) if (r.fallback) expect(f.fallbacks).toContain(r.fallback);
  });

  it("every route permission exists in permissions.yaml (IC §11 CI rule)", () => {
    const perms = new Set<string>(contractDoc("permissions.yaml").permissions.map((p: Entry) => p.code));
    const missing = contractDoc("routes.yaml")
      .routes.filter((r: Entry) => r.permission && !perms.has(String(r.permission)))
      .map((r: Entry) => `${r.id} -> ${r.permission}`);
    expect(missing).toEqual([]);
  });

  // 07-SECURITY / REQ-SEC-098: params are UUIDs or opaque tokens, never PHI.
  it("no route path param carries PHI (name, phone, barcode, registration number, email, mrn)", () => {
    const phi = /(name|phone|mobile|barcode|registration|reg_?no|mrn|email|dob|address)/i;
    const bad: string[] = [];
    for (const r of contractDoc("routes.yaml").routes as Entry[]) {
      for (const m of String(r.path).matchAll(/\{(\w+)\}/g)) if (phi.test(m[1])) bad.push(`${r.id}:${m[1]}`);
    }
    expect(bad).toEqual([]);
  });

  it("every path with {param} is a string that starts with / (strict-YAML rule, IC §7)", () => {
    for (const r of contractDoc("routes.yaml").routes as Entry[]) {
      expect(typeof r.path).toBe("string");
      expect(String(r.path).startsWith("/")).toBe(true);
    }
  });

  it("display_token routes are never nav entries; token routes keep their rate-limit tier", () => {
    const routes: Entry[] = contractDoc("routes.yaml").routes;
    const display = routes.filter((r) => r.auth === "display_token");
    expect(display.length).toBeGreaterThan(0);
    for (const r of display) expect(r.nav, r.id as string).toBe(false);
    const byId = new Map(routes.map((r) => [r.id, r]));
    expect(byId.get("portal.report_link")).toMatchObject({ path: "/r/{link_token}", auth: "link_token+otp", rate_limit_tier: "report_download" });
    expect(byId.get("portal.qr_verify")).toMatchObject({ path: "/v/{qr_token}", auth: "public", rate_limit_tier: "qr_verify" });
  });
});

describe("AC-0C-1.3 permissions.yaml == IC §11", () => {
  it("equals IC §11 entry for entry (version, roles, partner_roles, platform_roles, fixed_actor_permissions, permissions)", () => {
    const ic = icDoc(11);
    const file = contractDoc("permissions.yaml");
    expect(file.version).toBe(1);
    expect(Object.keys(file).sort()).toEqual(Object.keys(ic).sort());
    for (const k of ["roles", "partner_roles", "platform_roles"]) {
      expect(diffByKey(ic[k], file[k], "code"), k).toEqual([]);
    }
    expect(sortKeys(file.fixed_actor_permissions)).toEqual(sortKeys(ic.fixed_actor_permissions));
    expect(diffByKey(ic.permissions, file.permissions, "code")).toEqual([]);
    expect(file.permissions.map((p: Entry) => p.code)).toEqual(ic.permissions.map((p: Entry) => p.code));
    expect(file).toEqual(ic);
  });

  it("permission codes unique and match ^[a-z_]+\\.[a-z_]+\\.[a-z_]+$ (IC §11 CI rule)", () => {
    const codes: string[] = contractDoc("permissions.yaml").permissions.map((p: Entry) => p.code);
    expect(dupes(codes)).toEqual([]);
    expect(codes.filter((c) => !/^[a-z_]+\.[a-z_]+\.[a-z_]+$/.test(c))).toEqual([]);
  });

  // 07-SECURITY: platform.* never grantable to tenant/partner roles.
  it("platform.* codes are granted only to platform_roles", () => {
    const f = contractDoc("permissions.yaml");
    const platformRoles = new Set<string>(f.platform_roles.map((r: Entry) => r.code));
    const bad = f.permissions
      .filter((p: Entry) => String(p.code).startsWith("platform."))
      .flatMap((p: Entry) => (p.roles as string[]).filter((r) => !platformRoles.has(r)).map((r) => `${p.code}->${r}`));
    expect(bad).toEqual([]);
  });

  it("privileged is boolean and roles is an array on every entry", () => {
    for (const p of contractDoc("permissions.yaml").permissions as Entry[]) {
      expect(typeof p.privileged, p.code as string).toBe("boolean");
      expect(Array.isArray(p.roles), p.code as string).toBe(true);
    }
  });

  it("fixed-actor permission codes all exist in the registry (system set is declarative, skipped)", () => {
    const f = contractDoc("permissions.yaml");
    const known = new Set<string>(f.permissions.map((p: Entry) => p.code));
    const flat = (v: any): string[] =>
      Array.isArray(v) ? v.filter((x) => typeof x === "string") : Object.values(v ?? {}).flatMap(flat);
    const { system: _s, ...fixed } = f.fixed_actor_permissions;
    const missing = flat(fixed).filter((c) => !c.startsWith("<") && !known.has(c));
    expect(missing).toEqual([]);
  });
});
