// T0D-12d — generated route files carry the 20 LD-112 rows (committed files; freshness vs. generateAll is codegen.test.ts "codegen-fresh").
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const NEW = [
  "staff.admin.me", "staff.admin.users", "staff.admin.user_new", "staff.admin.roles", "staff.admin.branches", "staff.admin.centres",
  "staff.admin.settings", "staff.admin.sessions", "staff.admin.audit", "staff.admin.access_log", "staff.admin.exports",
  "staff.admin.support_access", "staff.admin.access_review", "staff.platform.home", "staff.platform.tenants", "staff.platform.ird",
  "staff.platform.support_sessions", "staff.platform.dead_letters", "staff.platform.staff", "staff.platform.auth_events",
  // LD-130
  "staff.smartreport.summaries", "staff.smartreport.library", "staff.smartreport.wording",
  "staff.quality.status", "staff.quality.runs", "staff.quality.lj_chart", "staff.quality.observations", "staff.quality.setup",
  "staff.quality.autoverify", "staff.quality.tat_alerts", "staff.quality.settings",
];
const doc: any = parse(read("contracts/routes.yaml"));
const routes: any[] = doc.routes;
const origins = Object.keys(doc.origins);

describe("LD-112 generated route files", () => {
  const ts = read("packages/shared-ts/src/routes/generated.ts");
  const dart = read("packages/shared-dart/lib/src/routes.g.dart");

  it("generated.ts has every new id with origin, owner, path and permission from routes.yaml", () => {
    for (const id of NEW) {
      const r = routes.find((x) => x.id === id);
      expect(r, `routes.yaml ${id}`).toBeDefined();
      const block = `  "${id}": {\n    "origin": "staff_web",\n    "owner": "${r.owner}",\n    "path": "${r.path}",\n    "permission": "${r.permission}"\n  }`;
      expect(ts, id).toContain(block);
    }
  });

  it("routes.g.dart has every new id in the path map and the origin map", () => {
    for (const id of NEW) {
      const r = routes.find((x) => x.id === id);
      expect(r, `routes.yaml ${id}`).toBeDefined();
      expect(dart, `${id} path`).toContain(`  '${id}': '${r.path}',`);
      expect(dart, `${id} origin`).toContain(`  '${id}': 'staff_web',`);
    }
  });

  it("both files list exactly the routes.yaml ids (no stale or extra entry)", () => {
    // the file also holds ROUTE_ORIGINS keys at the same indent; those are not routes
    const tsIds = [...ts.matchAll(/^ {2}"([a-z0-9_.]+)": \{$/gm)].map((m) => m[1]).filter((k) => !origins.includes(k)).sort();
    expect(tsIds).toEqual(routes.map((r) => r.id).sort());
    const dartPathIds = [...dart.matchAll(/^ {2}'([a-z0-9_.]+)': '\//gm)].map((m) => m[1]);
    for (const r of routes) if (r.origin === "staff_web") expect(dartPathIds, r.id).toContain(r.id);
  });
});
