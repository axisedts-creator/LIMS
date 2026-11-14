// T0C-05 / AC-0C-2.1 — generators (02-TRD §5.3) + 08 §4.1 permission CI rules.
// Contract the implementation must satisfy (names are mine; behaviour is from 02-TRD §5.3):
//   tools/codegen/codegen.ts exports
//     generateAll(rootDir: string): Record<string, string>   // POSIX repo-relative path -> file text; pure, no clock/cwd/abs-path use
//     writeAll(rootDir: string): void                        // writes generateAll() output to disk
//   tools/codegen/codegen.ts run as a CLI (`pnpm codegen` = tsx tools/codegen/codegen.ts): writes outputs;
//     with `--check` writes nothing, exits non-zero listing stale/missing files (CI gate 8 `codegen-fresh`).
//   tools/codegen/gen-permissions.ts exports
//     checkPermissionRules(doc: object, extraGrants?: {role: string; code: string}[]): {rule: "R1"|"R2"|"R3"; code: string; message: string}[]
//       doc = parsed contracts/permissions.yaml; extraGrants = effective tenant-role grants added on top of the yaml
//       (e.g. via C2 role editing). R1: roles:[] code granted to a tenant role. R2: partner-only/patient-only code
//       granted to a tenant role. R3: staff code (non-empty roles) in a partner/patient fixed set, except
//       identity.self.manage in partner.partner_member (08 A19 D-101).
//   Generated files (paths from 02-TRD §5.3): see REQUIRED below.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const yaml = (p: string) => parse(read(p)) as any;

const IC = read("spec/program/03-INTERFACE-CATALOG.md");

async function codegen(): Promise<{ generateAll(r: string): Record<string, string>; writeAll(r: string): void }> {
  return import(pathToFileURL(join(ROOT, "tools/codegen/codegen.ts")).href);
}
async function permMod(): Promise<{ checkPermissionRules(d: object, g?: { role: string; code: string }[]): { rule: string; code: string; message: string }[] }> {
  return import(pathToFileURL(join(ROOT, "tools/codegen/gen-permissions.ts")).href);
}

const REQUIRED = [
  "contracts/ports/generated/error-codes.ts",
  "contracts/ports/generated/permissions.ts",
  "contracts/ports/generated/access-actions.ts",
  "contracts/ports/generated/port-consumers.ts",
  "contracts/ports/generated/events.ts",
  "db/seeds/001_core__g_permissions.sql",
  "db/seeds/003_audit__g_cs_access_actions.sql",
  "packages/api-client-ts/src/core.ts",
  "packages/api-client-ts/src/client.ts",
  "packages/api-client-ts/src/server/operations.ts",
  "packages/shared-ts/src/routes/generated.ts",
  "packages/shared-dart/lib/src/error_codes.g.dart",
];

// ---- spec-derived expectations ----
const errorCodes: { code: string; http: number }[] = yaml("contracts/errors.yaml");
const perms = yaml("contracts/permissions.yaml");
const permCodes: string[] = perms.permissions.map((p: any) => p.code);
const privileged: string[] = perms.permissions.filter((p: any) => p.privileged).map((p: any) => p.code);
const specNames = readdirSync(join(ROOT, "contracts/openapi")).filter((f) => !f.startsWith("_") && f.endsWith(".yaml"));
const operationIds: string[] = specNames.flatMap((f) => {
  const d = yaml(`contracts/openapi/${f}`);
  return Object.values(d.paths ?? {}).flatMap((item: any) =>
    Object.values(item).map((op: any) => op?.operationId).filter(Boolean));
});
const routeIds: string[] = yaml("contracts/routes.yaml").routes.map((r: any) => r.id);
const eventFiles = readdirSync(join(ROOT, "contracts/events")).filter((f) => !f.startsWith("_") && f.endsWith(".v1.schema.json"));
const eventTypes = eventFiles.map((f) => f.replace(/\.schema\.json$/, "")); // e.g. lab.result.approved.v1

function accessActionsFromIC(): string[] {
  const s = IC.indexOf("### 13.1 Access-log action codes");
  const m = /```yaml\n([\s\S]*?)\n```/.exec(IC.slice(s))!;
  return (parse(m[1]!) as string[]).map(String);
}
function portHeadings(): { port: string; consumerChunks: string[]; all: boolean }[] {
  const out: { port: string; consumerChunks: string[]; all: boolean }[] = [];
  for (const m of IC.matchAll(/^### 4\.\d+ `(\w+Port)` — (.*)$/gm)) {
    const c = /consumers?:?\s+([^—(]*?)(?:\s*\(|\s+—|$)/.exec(m[2]!.replace(/owner C\d+ \(`\w+`\);?\s*/, ""));
    const txt = c?.[1] ?? "";
    out.push({ port: m[1]!, consumerChunks: [...new Set(txt.match(/C\d+/g) ?? [])], all: /\ball\b/.test(txt) });
  }
  return out;
}

describe("generateAll — determinism and freshness (AC-0C-2.1)", () => {
  it("produces every required output", async () => {
    const out = (await codegen()).generateAll(ROOT);
    for (const p of REQUIRED) expect(Object.keys(out), p).toContain(p);
    expect(Object.keys(out).some((p) => p.startsWith("packages/api-client-dart/") && p.endsWith(".dart"))).toBe(true);
    expect(Object.keys(out).some((p) => p.endsWith("routes.g.dart"))).toBe(true);
  });

  it("double run is byte-equal, also from another cwd", async () => {
    const g = await codegen();
    const a = g.generateAll(ROOT);
    const cwd = process.cwd();
    process.chdir(resolve(ROOT, "tools"));
    let b: Record<string, string>;
    try { b = g.generateAll(ROOT); } finally { process.chdir(cwd); }
    expect(Object.keys(b)).toEqual(Object.keys(a));
    for (const k of Object.keys(a)) expect(Buffer.from(b[k]!)).toEqual(Buffer.from(a[k]!));
  });

  it("output has stable key order, LF endings, trailing newline, no timestamps or absolute paths", async () => {
    const out = (await codegen()).generateAll(ROOT);
    const keys = Object.keys(out);
    expect(keys).toEqual([...keys].sort());
    for (const [k, v] of Object.entries(out)) {
      expect(v.includes("\r"), `${k} has CR`).toBe(false);
      expect(v.endsWith("\n"), `${k} no trailing newline`).toBe(true);
      // Ruling T0C-05: handlers.generated.ts inlines spec-example IsoUtc values (AC-0C-4.2); determinism proven by rerun equality.
      // Elsewhere, no timestamps; in the handlers file, none on comment lines.
      const scan = k === "packages/fakes/src/msw/handlers.generated.ts"
        ? v.split("\n").filter((l) => /^\s*(\/\/|\/\*|\*)/.test(l)).join("\n")
        : v;
      expect(/\d{4}-\d\d-\d\d[T ]\d\d:\d\d/.test(scan), `${k} has a timestamp`).toBe(false);
      expect(v.includes(ROOT) || v.includes(ROOT.replace(/\\/g, "/")), `${k} leaks abs path`).toBe(false);
    }
  });

  it("committed outputs equal generated output (codegen-fresh, CI gate 8)", async () => {
    const out = (await codegen()).generateAll(ROOT);
    for (const [k, v] of Object.entries(out)) {
      expect(existsSync(join(ROOT, k)), `${k} not committed`).toBe(true);
      expect(read(k), `${k} stale`).toBe(v);
    }
  });

  it("CLI --check exits 0 when fresh and writes nothing", () => {
    const r = spawnSync("npx", ["tsx", "tools/codegen/codegen.ts", "--check"], { cwd: ROOT, encoding: "utf8", shell: true });
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });
});

describe("generated content", () => {
  it("error-codes.ts: every errors.yaml code in ErrorCode union + ERROR_META with http", async () => {
    const t = (await codegen()).generateAll(ROOT)["contracts/ports/generated/error-codes.ts"]!;
    expect(t).toMatch(/export type ErrorCode\b/);
    expect(t).toContain("ERROR_META");
    for (const e of errorCodes) expect(t, e.code).toContain(`"${e.code}"`);
  });

  it("error_codes.g.dart lists every code", async () => {
    const t = (await codegen()).generateAll(ROOT)["packages/shared-dart/lib/src/error_codes.g.dart"]!;
    for (const e of errorCodes) expect(t, e.code).toContain(e.code);
  });

  it("permissions.ts: PermissionCode, PRIVILEGED, role grants, FIXED_ACTOR_PERMISSIONS", async () => {
    const t = (await codegen()).generateAll(ROOT)["contracts/ports/generated/permissions.ts"]!;
    expect(t).toMatch(/export type PermissionCode\b/);
    for (const n of ["PRIVILEGED", "FIXED_ACTOR_PERMISSIONS"]) expect(t).toContain(n);
    for (const c of permCodes) expect(t, c).toContain(`"${c}"`);
    const priv = /PRIVILEGED[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(t);
    expect(priv, "PRIVILEGED must be `new Set([...])`").not.toBeNull();
    for (const c of privileged) expect(priv![1], c).toContain(`"${c}"`);
    expect(permCodes.length).toBeGreaterThan(50);
    // fixed sets: partner_admin expanded (<partner_member set> placeholder must not leak)
    expect(t).not.toContain("<partner_member set>");
    expect(t).toContain("bridge_agent");
    expect(t).toContain("partner_admin");
  });

  it("001 seed SQL: one idempotent row per permission code", async () => {
    const t = (await codegen()).generateAll(ROOT)["db/seeds/001_core__g_permissions.sql"]!;
    expect(t.toUpperCase()).toContain("ON CONFLICT");
    expect(t).toMatch(/core\.g_permissions/);
    for (const c of permCodes) expect(t, c).toContain(`'${c}'`);
  });

  it("access-actions: IC §13.1 block ∪ base list, regex-valid, in TS and seed SQL", async () => {
    const out = (await codegen()).generateAll(ROOT);
    const ts = out["contracts/ports/generated/access-actions.ts"]!;
    const sql = out["db/seeds/003_audit__g_cs_access_actions.sql"]!;
    const codes = accessActionsFromIC();
    expect(codes.length).toBeGreaterThan(20);
    expect(ts).toMatch(/export type AccessAction\b/);
    expect(sql.toUpperCase()).toContain("ON CONFLICT");
    for (const c of [...codes, "data.export", "role.change", "session.revoke"]) {
      expect(ts, c).toContain(`"${c}"`);
      expect(sql, c).toContain(`'${c}'`);
    }
    for (const m of sql.matchAll(/^\s*\(?\s*'([a-z_.]+)'\s*,/gm)) expect(m[1]).toMatch(/^[a-z_]+\.[a-z_]+$/);
    expect(sql).not.toContain("tenant_egress_ip.change"); // removed by 08 A1
  });

  it("port-consumers: all 13 ports; consumer lists cover IC §4.x headings", async () => {
    const t = (await codegen()).generateAll(ROOT)["contracts/ports/generated/port-consumers.ts"]!;
    expect(t).toMatch(/export const PORT_CONSUMERS\b/);
    const heads = portHeadings();
    expect(heads.map((h) => h.port).sort()).toEqual([
      "BillingCommandPort", "BillingPort", "CatalogPort", "EngagementPort", "FrontdeskPort", "IdentityPort", "LabPort",
      "NotificationPort", "PaymentProviderPort", "QualityPort", "RenderPort", "ReportingPort", "SmartReportPort",
    ]);
    const entry = (p: string) => new RegExp(`${p}\\s*:\\s*\\[([^\\]]*)\\]`).exec(t)?.[1];
    for (const h of heads) {
      const list = entry(h.port);
      expect(list, `${h.port} missing`).toBeDefined();
      const n = (list!.match(/"/g) ?? []).length / 2;
      if (h.all) expect(n).toBeGreaterThan(10);
      else expect(n, h.port).toBeGreaterThanOrEqual(h.consumerChunks.length);
    }
    expect(entry("QualityPort")).toMatch(/"lab"/);            // consumer C5 only
    expect(entry("BillingCommandPort")).toMatch(/"frontdesk"/); // 'frontdesk' only
    expect(entry("SmartReportPort")).toMatch(/"reporting"/);   // C6 only
  });

  it("events.ts: EventType union, EventPayload, EVENT_PRODUCERS, EVENT_CONSUMERS", async () => {
    const t = (await codegen()).generateAll(ROOT)["contracts/ports/generated/events.ts"]!;
    for (const n of ["EventType", "EventPayload", "EVENT_PRODUCERS", "EVENT_CONSUMERS"]) expect(t).toContain(n);
    expect(eventTypes.length).toBeGreaterThanOrEqual(25);
    for (const e of eventTypes) expect(t, e).toContain(`"${e}"`);
    expect(t).not.toContain('"_envelope'); // underscore schemas are not event types
  });

  it("api-client-ts: client factory + Operations map has every operationId", async () => {
    const out = (await codegen()).generateAll(ROOT);
    const client = out["packages/api-client-ts/src/client.ts"]!;
    expect(client).toContain("createApiClient");
    expect(client).toContain("baseUrl");
    expect(client).toContain("fetch");
    const ops = out["packages/api-client-ts/src/server/operations.ts"]!;
    expect(ops).toContain("Operations");
    expect(operationIds.length).toBeGreaterThan(0);
    for (const id of operationIds) expect(ops, id).toContain(id);
  });

  it("routes: every routes.yaml id in generated TS and a Dart routes.g.dart", async () => {
    const out = (await codegen()).generateAll(ROOT);
    const ts = out["packages/shared-ts/src/routes/generated.ts"]!;
    const dartKey = Object.keys(out).find((k) => k.endsWith("routes.g.dart"))!;
    for (const id of routeIds) {
      expect(ts, id).toContain(id);
      expect(out[dartKey]!, id).toContain(id);
    }
  });
});

describe("checkPermissionRules — 08 §4.1 CI rules (TRD §5.3 gen-permissions)", () => {
  const base = () => ({
    version: 1,
    roles: [{ code: "front_desk" }, { code: "tenant_admin" }],
    partner_roles: [{ code: "partner_member" }, { code: "partner_admin" }],
    fixed_actor_permissions: {
      device: { bridge_agent: ["instruments.ingest.submit"] },
      portal: ["reporting.portal.view"],
      patient: ["engagement.self.read"],
      partner: { partner_member: ["partners.order.read", "identity.self.manage"], partner_admin: ["<partner_member set>", "partners.referrer.manage"] },
    },
    permissions: [
      { code: "frontdesk.order.read", privileged: false, roles: ["front_desk"] },
      { code: "identity.self.manage", privileged: false, roles: ["front_desk", "tenant_admin"] },
      { code: "instruments.ingest.submit", privileged: false, roles: [] },
      { code: "reporting.portal.view", privileged: false, roles: [] },
      { code: "engagement.self.read", privileged: false, roles: [] },
      { code: "partners.order.read", privileged: false, roles: [] },
      { code: "partners.referrer.manage", privileged: false, roles: [] },
    ],
  });

  it("real contracts/permissions.yaml has no violations", async () => {
    expect((await permMod()).checkPermissionRules(perms)).toEqual([]);
  });

  it("clean fixture (incl. identity.self.manage exception) has no violations", async () => {
    expect((await permMod()).checkPermissionRules(base())).toEqual([]);
  });

  it("R1: roles:[] code granted to a tenant role", async () => {
    const v = (await permMod()).checkPermissionRules(base(), [{ role: "front_desk", code: "instruments.ingest.submit" }]);
    expect(v.some((x) => x.rule === "R1" && x.code === "instruments.ingest.submit")).toBe(true);
  });

  it("R1 also via the yaml itself: roles:[] code listed with a tenant role", async () => {
    const d = base();
    d.permissions[2] = { code: "instruments.ingest.submit", privileged: false, roles: ["tenant_admin"] };
    // now a staff code sitting in a device set is not an R3 case (device is not partner/patient) -> no R3, but grant is legitimate
    expect((await permMod()).checkPermissionRules(d).some((x) => x.rule === "R3")).toBe(false);
  });

  it("R2: partner-only / patient-only code granted to a tenant role", async () => {
    const m = await permMod();
    for (const code of ["partners.order.read", "engagement.self.read"]) {
      const v = m.checkPermissionRules(base(), [{ role: "tenant_admin", code }]);
      expect(v.some((x) => x.code === code && (x.rule === "R1" || x.rule === "R2")), code).toBe(true);
    }
  });

  it("R3: staff code in a patient or partner fixed set", async () => {
    const m = await permMod();
    const p = base(); p.fixed_actor_permissions.patient.push("frontdesk.order.read");
    expect(m.checkPermissionRules(p).some((x) => x.rule === "R3" && x.code === "frontdesk.order.read")).toBe(true);
    const q = base(); q.fixed_actor_permissions.partner.partner_member.push("frontdesk.order.read");
    expect(m.checkPermissionRules(q).some((x) => x.rule === "R3" && x.code === "frontdesk.order.read")).toBe(true);
  });

  it("R3 exception is exactly identity.self.manage in partner_member (and inherited by partner_admin)", async () => {
    const m = await permMod();
    const ok = base(); ok.fixed_actor_permissions.partner.partner_admin.push("identity.self.manage");
    expect(m.checkPermissionRules(ok)).toEqual([]);
    const bad = base(); bad.fixed_actor_permissions.patient.push("identity.self.manage"); // exception is partner-only
    expect(m.checkPermissionRules(bad).some((x) => x.rule === "R3" && x.code === "identity.self.manage")).toBe(true);
  });

  it("unknown code in a fixed set is reported, not silently ignored", async () => {
    const d = base(); d.fixed_actor_permissions.portal.push("no.such.code");
    expect((await permMod()).checkPermissionRules(d).some((x) => x.code === "no.such.code")).toBe(true);
  });
});

describe("@lims/contracts package surface (LD-03, review T0C-05 items 1-2)", () => {
  it("package.json is @lims/contracts and exports ./ports/common + ./ports/generated/error-codes to existing files", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "contracts/package.json"), "utf8"));
    expect(pkg.name).toBe("@lims/contracts");
    for (const sub of ["./ports/common", "./ports/generated/error-codes"]) {
      const target = pkg.exports?.[sub];
      expect(target, `exports["${sub}"]`).toBeTruthy();
      const file = typeof target === "string" ? target : (target.import ?? target.default ?? target.types);
      expect(existsSync(join(ROOT, "contracts", file)), `${sub} -> ${file}`).toBe(true);
    }
  });

  it("LimsError loads under Node type stripping (no TS parameter properties) and keeps fields", () => {
    const url = pathToFileURL(join(ROOT, "contracts/ports/common.ts")).href;
    const script =
      `const m = await import(${JSON.stringify(url)});` +
      `const e = new m.LimsError('X', 'd', [{path:'p',code:'X',message:'m'}]);` +
      `if (e.code !== 'X' || e.safeDetail !== 'd' || e.fieldErrors.length !== 1 || e.message !== 'X') process.exit(3);`;
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { encoding: "utf8" });
    expect(r.stderr + r.stdout).not.toMatch(/ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX/);
    expect(r.status).toBe(0);
  });
});
