// T0D-12d — LD-112 (20 staff_web rows for the C2 admin/platform screens) + LD-115 (inventory.yaml local schema Code -> InventoryCodedSetEntry).
// AC-0C-1.3: registry-equality (contracts/__tests__/registry-equality.test.ts) stays the gate for IC §7 equality; these tests pin the
// LD-112 slice (ids, paths, owner, permission, order, position, comment line) and "no other route changed", and the LD-115 rename.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8").replace(/\r\n/g, "\n");
const routes: any[] = parse(read("contracts/routes.yaml"), { strict: true, uniqueKeys: true }).routes;
const perms = new Set<string>((parse(read("contracts/permissions.yaml")) as any).permissions.map((p: any) => p.code));

// LD-112, verbatim from the lead decision (same order).
const LD112: Array<[string, string, string]> = [
  ["staff.admin.me", "/admin/me", "identity.self.manage"],
  ["staff.admin.users", "/admin/users", "identity.user.read"],
  ["staff.admin.user_new", "/admin/users/new", "identity.user.manage"],
  ["staff.admin.roles", "/admin/roles", "identity.user.read"],
  ["staff.admin.branches", "/admin/branches", "identity.user.read"],
  ["staff.admin.centres", "/admin/centres", "identity.centre.read"],
  ["staff.admin.settings", "/admin/settings", "identity.settings.manage"],
  ["staff.admin.sessions", "/admin/sessions", "identity.session.revoke"],
  ["staff.admin.audit", "/admin/audit", "audit.log.read"],
  ["staff.admin.access_log", "/admin/access-log", "audit.log.read"],
  ["staff.admin.exports", "/admin/exports", "audit.log.export"],
  ["staff.admin.support_access", "/admin/support-access", "audit.log.read"],
  ["staff.admin.access_review", "/admin/access-review", "identity.user.read"],
  ["staff.platform.home", "/platform", "platform.tenant.read"],
  ["staff.platform.tenants", "/platform/tenants", "platform.tenant.read"],
  ["staff.platform.ird", "/platform/ird", "platform.tenant.read"],
  ["staff.platform.support_sessions", "/platform/support-sessions", "platform.tenant.read"],
  ["staff.platform.dead_letters", "/platform/dead-letters", "platform.dead_letter.manage"],
  ["staff.platform.staff", "/platform/staff", "platform.staff.manage"],
  ["staff.platform.auth_events", "/platform/auth-events", "platform.tenant.read"],
];
// LD-130 (scope widened to 11 more rows), verbatim from IC §7: [id, path, owner, permission]
const LD130_SMARTREPORT: Array<[string, string, string, string]> = [
  ["staff.smartreport.summaries", "/smartreport/summaries", "C14", "smartreport.summary.read"],
  ["staff.smartreport.library", "/smartreport/library", "C14", "smartreport.template.manage"],
  ["staff.smartreport.wording", "/smartreport/wording", "C14", "smartreport.template.manage"],
];
const LD130_QUALITY: Array<[string, string, string, string]> = [
  ["staff.quality.status", "/quality", "C9", "quality.qc_run.read"],
  ["staff.quality.runs", "/quality/runs", "C9", "quality.qc_run.read"],
  ["staff.quality.lj_chart", "/quality/lj", "C9", "quality.qc_run.read"],
  ["staff.quality.observations", "/quality/observations", "C9", "quality.qc_run.read"],
  ["staff.quality.setup", "/quality/setup/materials", "C9", "quality.qc_run.read"],
  ["staff.quality.autoverify", "/quality/autoverify", "C9", "quality.autoverify.read"],
  ["staff.quality.tat_alerts", "/quality/tat-alerts", "C9", "quality.tat_alert.read"],
  ["staff.quality.settings", "/quality/settings", "C9", "quality.qc_run.read"],
];
const BASELINE_ROUTE_COUNT = 143; // contracts/routes.yaml before T0D-12d
const BASELINE_INVENTORY_SCHEMA_COUNT = 47; // components.schemas in inventory.yaml before T0D-12d (Code swapped for InventoryCodedSetEntry)

describe("LD-112: 20 staff_web rows in contracts/routes.yaml", () => {
  it("has exactly 20 LD-112 rows; 174 routes in total (143 + 20 + 11 LD-130, no other route added)", () => {
    expect(LD112).toHaveLength(20);
    expect(LD130_SMARTREPORT).toHaveLength(3);
    expect(LD130_QUALITY).toHaveLength(8);
    expect(routes).toHaveLength(BASELINE_ROUTE_COUNT + 20 + 11);
  });

  it("each row has the LD-112 id, path, permission, origin staff_web, owner C2", () => {
    const byId = new Map(routes.map((r) => [r.id, r]));
    for (const [id, path, permission] of LD112) {
      expect(byId.get(id), `missing ${id}`).toEqual({ id, origin: "staff_web", path, owner: "C2", permission });
    }
  });

  it("the rows follow staff.platform.dead_letter directly, contiguous, in LD-112 order", () => {
    const ids = routes.map((r) => r.id);
    const at = ids.indexOf("staff.platform.dead_letter");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(ids.slice(at + 1, at + 21)).toEqual(LD112.map(([id]) => id));
  });

  it("the row after the 20 is staff.quality.qc_run (nothing wedged in, nothing reordered)", () => {
    const ids = routes.map((r) => r.id);
    expect(ids[ids.indexOf("staff.platform.dead_letter") + 21]).toBe("staff.quality.qc_run");
  });

  it("the raw file carries the LD-112 comment line right before staff.admin.me, after the dead_letter row", () => {
    const lines = read("contracts/routes.yaml").split("\n");
    const me = lines.findIndex((l) => l.includes("id: staff.admin.me,"));
    expect(me).toBeGreaterThan(1);
    expect(lines[me - 1]).toMatch(/^\s*#.*LD-112/);
    expect(lines[me - 2]).toContain("id: staff.platform.dead_letter,");
  });

  it("no parameterised row and no role-editor row among the new rows", () => {
    for (const [id, path] of LD112) {
      expect(path, id).not.toMatch(/[{}]/);
      expect(id, id).not.toMatch(/role_edit|roles\.(new|edit)/);
    }
  });

  it("every new permission exists in permissions.yaml; (origin, path) is unique across all routes", () => {
    for (const [id, , p] of LD112) expect(perms.has(p), `${id}: ${p}`).toBe(true);
    const paths = routes.map((r) => `${r.origin} ${r.path}`);
    expect(paths.filter((p, i) => paths.indexOf(p) !== i)).toEqual([]);
  });

  it("the existing C2 parameterised rows are untouched", () => {
    const by = new Map(routes.map((r) => [r.id, r]));
    expect(by.get("staff.admin.user")).toEqual({ id: "staff.admin.user", origin: "staff_web", path: "/admin/users/{membership_id}", owner: "C2", permission: "identity.user.read" });
    expect(by.get("staff.admin.audit_entry")).toEqual({ id: "staff.admin.audit_entry", origin: "staff_web", path: "/admin/audit/{audit_id}", owner: "C2", permission: "audit.log.read" });
    expect(by.get("staff.platform.tenant")).toEqual({ id: "staff.platform.tenant", origin: "staff_web", path: "/platform/tenants/{tenant_id}", owner: "C2", permission: "platform.tenant.read" });
    expect(by.get("staff.platform.dead_letter")).toEqual({ id: "staff.platform.dead_letter", origin: "staff_web", path: "/platform/dead-letters/{dead_letter_id}", owner: "C2", permission: "platform.dead_letter.manage" });
  });
});

describe("LD-130: 3 smartreport + 8 quality staff_web rows (CR-C14-T18a, CR-C9-T01)", () => {
  const ids = routes.map((r) => r.id);
  const check = (after: string, rows: Array<[string, string, string, string]>, comment: RegExp) => {
    const at = ids.indexOf(after);
    expect(at, `${after} present`).toBeGreaterThanOrEqual(0);
    expect(ids.slice(at + 1, at + 1 + rows.length)).toEqual(rows.map(([id]) => id));
    const byId = new Map(routes.map((r) => [r.id, r]));
    for (const [id, path, owner, permission] of rows) {
      expect(byId.get(id), `missing ${id}`).toEqual({ id, origin: "staff_web", path, owner, permission });
      expect(perms.has(permission), `${id}: ${permission}`).toBe(true);
      expect(path, id).not.toMatch(/[{}]/);
    }
    const lines = read("contracts/routes.yaml").split("\n");
    const first = lines.findIndex((l) => l.includes(`id: ${rows[0][0]},`));
    expect(lines[first - 1]).toMatch(comment);
  };

  it("smartreport rows sit right after staff.smartreport.summary, in catalog order, with an LD-130 comment line", () => {
    check("staff.smartreport.summary", LD130_SMARTREPORT, /^\s*#.*LD-130/);
  });

  it("quality rows sit right after staff.quality.qc_run, in catalog order, with an LD-130 comment line", () => {
    check("staff.quality.qc_run", LD130_QUALITY, /^\s*#.*LD-130/);
  });

  it("qc_run and summary stay the only parameterised rows of their families", () => {
    expect(routes.filter((r) => /^staff\.quality\./.test(r.id) && /[{}]/.test(r.path)).map((r) => r.id)).toEqual(["staff.quality.qc_run"]);
    expect(routes.filter((r) => /^staff\.smartreport\./.test(r.id) && /[{}]/.test(r.path)).map((r) => r.id)).toEqual(["staff.smartreport.summary"]);
  });
});

describe("LD-115 / CR-C12-T01b: inventory.yaml local schema Code renamed to InventoryCodedSetEntry", () => {
  const raw = read("contracts/openapi/inventory.yaml");
  const inv: any = parse(raw);
  const schemas = inv.components.schemas;

  it("no local components.schemas.Code remains (it collided with the _common.yaml string Code)", () => {
    expect(schemas.Code).toBeUndefined();
  });

  it("InventoryCodedSetEntry is the former object schema: same wire shape", () => {
    const s = schemas.InventoryCodedSetEntry;
    expect(s, "components.schemas.InventoryCodedSetEntry").toBeDefined();
    expect(s.type).toBe("object");
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toEqual(["code", "display", "is_active"]);
    expect(Object.keys(s.properties)).toEqual(expect.arrayContaining(["code", "display", "reason_group", "uom_kind"]));
    expect(s.properties.code).toEqual({ type: "string", maxLength: 32, pattern: "^[A-Za-z0-9_]{1,32}$" });
    expect(s.properties.display).toEqual({ type: "string", maxLength: 80 });
    expect(s.properties.reason_group.enum).toHaveLength(11);
  });

  it("listInventoryCodedSet items and putInventoryTenantCode 200 point at InventoryCodedSetEntry", () => {
    const find = (id: string): any => {
      for (const item of Object.values<any>(inv.paths)) for (const op of Object.values<any>(item)) if (op?.operationId === id) return op;
      throw new Error(`operation ${id} not found`);
    };
    const list = find("listInventoryCodedSet").responses["200"].content["application/json"].schema;
    expect(list.properties.data.items).toEqual({ $ref: "#/components/schemas/InventoryCodedSetEntry" });
    const put = find("putInventoryTenantCode").responses["200"].content["application/json"].schema;
    expect(put).toEqual({ $ref: "#/components/schemas/InventoryCodedSetEntry" });
  });

  it("no $ref to #/components/schemas/Code is left in the file; every local schema $ref resolves", () => {
    expect(raw).not.toMatch(/#\/components\/schemas\/Code["'\s]/);
    for (const m of raw.matchAll(/\$ref:\s*["']?#\/components\/schemas\/([A-Za-z0-9_]+)/g)) {
      expect(schemas[m[1]], `dangling $ref ${m[1]}`).toBeDefined();
    }
  });

  it("nothing else renamed: schema count unchanged (Code swapped for exactly one new name)", () => {
    expect(Object.keys(schemas)).toHaveLength(BASELINE_INVENTORY_SCHEMA_COUNT);
  });
});
