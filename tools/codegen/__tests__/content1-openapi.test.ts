// T0C-CONTENT-1 (LD-313, LD-325; founder 2026-11-17 04:57 NPT "do not leave any function", 05:03 blanket authority) — portal content in engagement.yaml
// (ElabAssist "News and Updates", "Slider / Banner Image Upload", "Upload Special Offers", "Contact Us", "Profile Image Upload"), contracts/permissions.yaml + corp_admin pack (2 new codes),
// the migration 20261117130000_engagement__add_portal_content.sql (static checks; behaviour is db/tests/engagement/T0C-CONTENT-1_portal_content.test.sql), generated-client freshness
// and the implementation notes (decision line per ElabAssist function). The brief names tables, columns and rules and gives operations in words, not wire names:
// ASSUMPTIONS (a different choice needs a ruling, not a silent test edit; same style as T0C-MSGDESK-1):
//  - engagement.yaml: exactly 9 new operations (109 -> 118), all tag engagement, x-context tenant, bearerJwt:
//      listPortalContent        GET    /v1/engagement/portal-content                                       engagement.content.read    idem none      200 PortalContentPage        (staff; filters kind, active; cursor + limit)
//      createPortalContent      POST   /v1/engagement/portal-content                                       engagement.content.manage  idem required  201 PortalContent
//      updatePortalContent      PATCH  /v1/engagement/portal-content/{content_id}                          engagement.content.manage  idem optional|required 200 PortalContent
//      deactivatePortalContent  POST   /v1/engagement/portal-content/{content_id}/deactivate               engagement.content.manage  idem optional|required 200 PortalContent  (no DELETE: history stays)
//      reorderPortalContent     POST   /v1/engagement/portal-content/reorder                               engagement.content.manage  idem optional|required 200 PortalContentPage   (body PortalContentReorder {kind, ids[]})
//      listMyPortalContent      GET    /v1/engagement/me/portal-content                                    engagement.self.read       idem none      200 PortalContentPublicPage  (patient app; only active items inside their date window; no staff fields)
//      listProfileImages        GET    /v1/engagement/profile-images                                       engagement.content.read    idem none      200 ProfileImagePage         (filters profile_kind, profile_id = "search by profile")
//      setProfileImage          PUT    /v1/engagement/profile-images/{profile_kind}/{profile_id}           engagement.content.manage  idem optional|required 200 ProfileImage   (upsert, body ProfileImageSet {image_attachment_id})
//      clearProfileImage        DELETE /v1/engagement/profile-images/{profile_kind}/{profile_id}           engagement.content.manage  idem none|optional 204 (the row is deactivated, never deleted: no DELETE grant)
//  - NEW permission codes (LD-313 c allows them for portal content): engagement.content.read and engagement.content.manage, both NOT privileged; the patient read reuses the existing patient code engagement.self.read.
//  - Wire names: PortalContent{id, kind, title, body?, image_attachment_id?, link_url?, starts_on?, ends_on?, sort_order, active|is_active, published_at?, created_by, created_at, updated_at, version},
//    PortalContentPublic{id, kind, title, body?, image_attachment_id?, link_url?, starts_on?, ends_on?, published_at?} (NO created_by, updated_by, tenant_id, version, active, created_at, updated_at),
//    ProfileImage{profile_kind, profile_id, image_attachment_id, active|is_active, updated_at}. kind news | banner | offer | contact; profile_kind doctor | centre | staff.
//  - Rules in the contract: body is a restricted Markdown subset (headings, bold, italic, lists, links only), no raw HTML (no "<"), no image syntax, links https only, maxLength; link_url https only; title plain text;
//    images are references to the existing branding asset resource (uploadBrandingAsset, re-encoded, size and type limited) and the contract adds no upload route.
//  - the implementer's notes are .orchestra/notes/T0C-CONTENT-1-impl.md (convention of every earlier T0C task).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv-draft-04";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { staleFiles } from "../codegen";
import { lintRepo } from "../lint-openapi";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MIG = "20261117130000_engagement__add_portal_content.sql";
const NOTES = join(ROOT, ".orchestra/notes/T0C-CONTENT-1-impl.md");
const load = (rel: string): any => parse(readFileSync(join(ROOT, rel), "utf8"));
const common: any = load("contracts/openapi/_common.yaml");
const registry: any = load("contracts/permissions.yaml");
const packs: any = load("services/api/src/modules/identity/role-packs/role-packs.data.yaml");
const errorsText = readFileSync(join(ROOT, "contracts/errors.yaml"), "utf8");
const METHODS = ["get", "put", "post", "delete", "patch"];
const sortedEq = (a: string[], b: string[]) => expect([...a].sort()).toEqual([...b].sort());
const enumOf = (p: any): string[] => ((p?.enum ?? []) as unknown[]).filter((x): x is string => typeof x === "string");
const refName = (s: any): string => String(s?.$ref ?? "").split("/").pop()!;
const textOf = (...parts: any[]): string => parts.map((p) => JSON.stringify(p ?? "")).join(" ").replace(/\\"/g, '"').replace(/\\n/g, "\n");

type OpSpec = { method: string; path: string; perm: string; idem: string[]; ok: string; schema?: string };
const ENG: Record<string, OpSpec> = {
  listPortalContent: { method: "get", path: "/v1/engagement/portal-content", perm: "engagement.content.read", idem: ["none"], ok: "200", schema: "PortalContentPage" },
  createPortalContent: { method: "post", path: "/v1/engagement/portal-content", perm: "engagement.content.manage", idem: ["required"], ok: "201", schema: "PortalContent" },
  updatePortalContent: { method: "patch", path: "/v1/engagement/portal-content/{content_id}", perm: "engagement.content.manage", idem: ["optional", "required"], ok: "200", schema: "PortalContent" },
  deactivatePortalContent: { method: "post", path: "/v1/engagement/portal-content/{content_id}/deactivate", perm: "engagement.content.manage", idem: ["optional", "required"], ok: "200", schema: "PortalContent" },
  reorderPortalContent: { method: "post", path: "/v1/engagement/portal-content/reorder", perm: "engagement.content.manage", idem: ["optional", "required"], ok: "200", schema: "PortalContentPage" },
  listMyPortalContent: { method: "get", path: "/v1/engagement/me/portal-content", perm: "engagement.self.read", idem: ["none"], ok: "200", schema: "PortalContentPublicPage" },
  listProfileImages: { method: "get", path: "/v1/engagement/profile-images", perm: "engagement.content.read", idem: ["none"], ok: "200", schema: "ProfileImagePage" },
  setProfileImage: { method: "put", path: "/v1/engagement/profile-images/{profile_kind}/{profile_id}", perm: "engagement.content.manage", idem: ["optional", "required"], ok: "200", schema: "ProfileImage" },
  clearProfileImage: { method: "delete", path: "/v1/engagement/profile-images/{profile_kind}/{profile_id}", perm: "engagement.content.manage", idem: ["none", "optional"], ok: "204" },
};
const NEW_PERMS = ["engagement.content.read", "engagement.content.manage"];
const KINDS = ["news", "banner", "offer", "contact"];
const PROFILE_KINDS = ["doctor", "centre", "staff"];
const STAFF_ONLY_FIELDS = ["created_by", "updated_by", "tenant_id", "version", "active", "is_active", "created_at", "updated_at"];
const UUID = "0193c4a0-0000-7000-8000-0000000000aa";
const UUID2 = "0193c4a0-0000-7000-8000-0000000000ab";
const TS = "2026-11-17T10:00:00.000Z";
// the ElabAssist functions of the brief (founder 04:57 NPT list): one decision line each in the implementation notes
const LABELS = ["News and Updates", "rich text editor", "Add", "Slider / Banner Image Upload", "Upload Special Offers", "Contact Us", "Profile Image Upload", "search by profile"];

const doc = load("contracts/openapi/engagement.yaml");
const S: Record<string, any> = doc.components.schemas;
const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
ajv.addSchema({ ...common, id: "_common.yaml" });
ajv.addSchema({ ...doc, id: "engagement.yaml" });
const opOf = (id: string): { method: string; path: string; op: any } | undefined => {
  for (const [path, item] of Object.entries<any>(doc.paths)) for (const m of METHODS) if (item[m]?.operationId === id) return { method: m, path, op: item[m] };
  return undefined;
};
const allOps = (): string[] => Object.values<any>(doc.paths).flatMap((item) => METHODS.filter((m) => item[m]).map((m) => item[m].operationId as string));
const okResp = (id: string, ok: string): any => opOf(id)?.op.responses?.[ok];
const jsonRef = (id: string, ok: string): string => refName(okResp(id, ok)?.content?.["application/json"]?.schema);
const prop = (s: string, f: string): any => S[s]?.properties?.[f] ?? {};
const activeField = (s: string): string => (S[s]?.properties?.active ? "active" : "is_active");
const validator = (name: string) => {
  const v = ajv.getSchema(`engagement.yaml#/components/schemas/${name}`);
  expect(v, `cannot resolve ${name}`).toBeDefined();
  return v!;
};
const reach = (root: string, seen = new Set<string>()): Set<string> => {
  const walk = (n: any) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === "object") {
      if (typeof n.$ref === "string" && n.$ref.startsWith("#/components/schemas/")) {
        const nm = n.$ref.split("/").pop()!;
        if (!seen.has(nm)) { seen.add(nm); walk(S[nm]); }
      }
      Object.values(n).forEach(walk);
    }
  };
  seen.add(root);
  walk(S[root]);
  return seen;
};
const bad = (names: Iterable<string>): string[] => {
  const out: string[] = [];
  const walk = (n: any, at: string) => {
    if (Array.isArray(n)) return n.forEach((x, i) => walk(x, `${at}[${i}]`));
    if (!n || typeof n !== "object") return;
    if (n.type === "number") out.push(`${at}: type number`);
    if (n.properties && n.additionalProperties !== false) out.push(`${at}: object not closed`);
    for (const [k, v] of Object.entries(n)) walk(v, `${at}.${k}`);
  };
  for (const n of names) walk(S[n], n);
  return out;
};
const NEW_SCHEMAS = ["PortalContent", "PortalContentCreate", "PortalContentUpdate", "PortalContentPage", "PortalContentReorder", "PortalContentPublic", "PortalContentPublicPage", "ProfileImage", "ProfileImageSet", "ProfileImagePage"];

describe("T0C-CONTENT-1 contract: lint and additive baseline (done_when 5)", () => {
  it("lintRepo reports no violation for engagement.yaml", async () => {
    const v = (await lintRepo(ROOT)).filter((x) => x.file === "engagement.yaml");
    expect(v, JSON.stringify(v.slice(0, 3))).toEqual([]);
  });
  it("engagement.yaml is additive: 109 operations before, at least 9 new ones now; operationIds unique; old operations keep method, path, permission", () => {
    const ids = allOps();
    expect(ids.length, "109 + 9 portal content operations, at least (the exact total is pinned in boot.test.ts)").toBeGreaterThanOrEqual(118);
    expect(new Set(ids).size, "operationIds unique").toBe(ids.length);
    for (const id of Object.keys(ENG)) expect(opOf(id), `${id} missing`).toBeDefined();
    for (const [id, m, p, perm] of [["listEnquiries", "get", "/v1/engagement/enquiries", "engagement.enquiry.read"], ["replyEnquiry", "post", "/v1/engagement/enquiries/{enquiry_id}/messages", "engagement.enquiry.respond"],
      ["createMyEnquiry", "post", "/v1/engagement/me/enquiries", "engagement.enquiry.create"], ["listBookings", "get", "/v1/engagement/bookings", "engagement.booking.read"],
      ["listBroadcasts", "get", "/v1/engagement/broadcasts", "engagement.broadcast.read"]]) {
      const f = opOf(id)!;
      expect(f, `${id} missing`).toBeDefined();
      expect(`${f.method} ${f.path}`, id).toBe(`${m} ${p}`);
      expect(f.op["x-permission"], id).toBe(perm);
    }
  });
});

describe("T0C-CONTENT-1 contract: operations (done_when 3, 4)", () => {
  for (const [id, n] of Object.entries(ENG)) {
    it(`${id}: ${n.method.toUpperCase()} ${n.path}, ${n.perm}, idempotency ${n.idem.join("|")}, ${n.ok}${n.schema ? ", " + n.schema : ""}, tenant context, error responses, example`, () => {
      const f = opOf(id);
      expect(f, `${id} missing`).toBeDefined();
      const { op } = f!;
      expect(`${f!.method} ${f!.path}`).toBe(`${n.method} ${n.path}`);
      expect(op.tags).toEqual(["engagement"]);
      expect(op["x-permission"]).toBe(n.perm);
      expect(op["x-context"]).toBe("tenant");
      expect(n.idem, `${id} idempotency ${op["x-idempotency"]}`).toContain(op["x-idempotency"]);
      expect(typeof op["x-rate-limit-tier"]).toBe("string");
      expect(op.security).toEqual([{ bearerJwt: [] }]);
      expect(Array.isArray(op["x-error-codes"]), "x-error-codes").toBe(true);
      expect(typeof op.summary).toBe("string");
      expect(op.responses?.[n.ok], `${id} ${n.ok}`).toBeDefined();
      for (const c of ["401", "403", "429", "500"]) expect(op.responses?.[c], `${id} ${c}`).toBeDefined();
      if (n.method !== "get") expect(op.responses?.["400"] ?? op.responses?.["422"], `${id} 400/422`).toBeDefined();
      if (f!.path.includes("{")) expect(op.responses?.["404"], `${id} 404`).toBeDefined();
      if (n.idem.length === 1 && n.idem[0] === "required") expect(JSON.stringify(op.parameters), `${id} needs the Idempotency-Key parameter`).toContain("IdempotencyKey");
      for (const c of (op["x-error-codes"] ?? []) as string[]) expect(errorsText, `${id}: error code ${c} must exist in contracts/errors.yaml`).toContain(c);
      if (n.schema) {
        expect(jsonRef(id, n.ok), `${id} ${n.ok} schema`).toBe(n.schema);
        const ex = Object.entries<any>(okResp(id, n.ok)?.content?.["application/json"]?.examples ?? {});
        expect(ex.length, `${id}: example`).toBeGreaterThan(0);
        const v = ajv.compile({ $ref: `engagement.yaml#/components/schemas/${n.schema}` });
        for (const [k, e] of ex) expect(v(e.value), `${id}/${k}: ${JSON.stringify(v.errors?.[0])}`).toBe(true);
      } else {
        expect(op.responses[n.ok].content, `${id}: ${n.ok} has no body`).toBeUndefined();
      }
    });
  }
  it("a patient app operation lists the app version error like the other /me operations; the staff operations do not", () => {
    expect(opOf("listMyPortalContent")!.op["x-error-codes"]).toContain("engagement.app_version_unsupported");
    expect(opOf("listMyPortalContent")!.op.responses?.["426"], "426").toBeDefined();
    for (const id of Object.keys(ENG).filter((i) => i !== "listMyPortalContent")) expect(opOf(id)!.op["x-error-codes"], id).not.toContain("engagement.app_version_unsupported");
  });
  it("list operations use standard paging: Cursor and Limit parameters, a page object {data, page}; filters are bounded", () => {
    for (const id of ["listPortalContent", "listMyPortalContent", "listProfileImages"]) {
      const params = JSON.stringify(opOf(id)!.op.parameters);
      expect(params, `${id} Cursor`).toContain("components/parameters/Cursor");
      expect(params, `${id} Limit`).toContain("components/parameters/Limit");
    }
    for (const n of ["PortalContentPage", "PortalContentPublicPage", "ProfileImagePage"]) {
      expect(S[n]?.additionalProperties, `${n} closed`).toBe(false);
      expect(S[n].required, n).toEqual(expect.arrayContaining(["data", "page"]));
      expect(S[n].properties.data.type, `${n}.data`).toBe("array");
    }
    const q = (id: string) => (opOf(id)!.op.parameters as any[]).filter((p) => !p.$ref).map((p) => p.name);
    expect(q("listPortalContent")).toEqual(expect.arrayContaining(["kind"]));
    expect(q("listProfileImages")).toEqual(expect.arrayContaining(["profile_kind", "profile_id"]));
    const kindParam = (opOf("listPortalContent")!.op.parameters as any[]).find((p) => p.name === "kind");
    sortedEq(enumOf(kindParam.schema), KINDS);
  });
  it("the public read takes no flag that could widen it: no active, include_inactive, tenant_id or date override parameter", () => {
    const names = (opOf("listMyPortalContent")!.op.parameters as any[]).filter((p) => !p.$ref).map((p) => p.name);
    for (const n of names) expect(n, "public read parameter").toMatch(/^(kind)$/);
    expect(JSON.stringify(opOf("listMyPortalContent")!.op.parameters)).not.toMatch(/include_inactive|tenant_id|"active"|as_of/);
    expect(JSON.stringify(opOf("listMyPortalContent")!.op.requestBody ?? null)).toBe("null");
  });
  it("path parameters: content_id is a uuid; profile_kind is the closed list doctor | centre | staff; profile_id is a uuid", () => {
    const pp = (id: string, name: string) => (opOf(id)!.op.parameters as any[]).find((p) => p.name === name);
    for (const id of ["updatePortalContent", "deactivatePortalContent"]) expect(JSON.stringify(pp(id, "content_id")?.schema), id).toContain("Uuid");
    for (const id of ["setProfileImage", "clearProfileImage"]) {
      sortedEq(enumOf(pp(id, "profile_kind")?.schema), PROFILE_KINDS);
      expect(JSON.stringify(pp(id, "profile_id")?.schema), id).toContain("Uuid");
    }
  });
  it("request bodies: create, update, reorder, set image use the named closed schemas", () => {
    const body = (id: string) => refName(opOf(id)!.op.requestBody?.content?.["application/json"]?.schema);
    expect(body("createPortalContent")).toBe("PortalContentCreate");
    expect(body("updatePortalContent")).toBe("PortalContentUpdate");
    expect(body("reorderPortalContent")).toBe("PortalContentReorder");
    expect(body("setProfileImage")).toBe("ProfileImageSet");
    expect(opOf("deactivatePortalContent")!.op.requestBody, "deactivate has no body").toBeUndefined();
  });
});

describe("T0C-CONTENT-1 contract: permissions (done_when 6)", () => {
  const byCode = new Map<string, any>(registry.permissions.map((p: any) => [p.code, p]));
  it.each(NEW_PERMS)("%s is in contracts/permissions.yaml, not privileged, known roles, tenant_admin holds it", (code) => {
    const p = byCode.get(code);
    expect(p, `${code} missing from contracts/permissions.yaml`).toBeDefined();
    expect(p.privileged).toBe(false);
    const known = new Set(registry.roles.map((r: any) => r.code));
    for (const r of p.roles) expect(known.has(r), `${code} unknown role ${r}`).toBe(true);
    expect(p.roles, `${code} tenant_admin`).toContain("tenant_admin");
    expect(code).toMatch(/^[a-z_]+\.[a-z_]+\.[a-z_]+$/);
  });
  it("the registry kept every older engagement code and added exactly the two; codes unique; the read role set contains the manage role set", () => {
    const eng = registry.permissions.filter((p: any) => p.code.startsWith("engagement.")).map((p: any) => p.code);
    for (const c of ["engagement.booking.read", "engagement.self.read", "engagement.enquiry.respond", "engagement.broadcast.approve", "engagement.settings.manage", ...NEW_PERMS]) expect(eng, `${c} renamed or removed`).toContain(c);
    expect(new Set(eng).size, "codes unique").toBe(eng.length);
    expect(byCode.get("engagement.content.read").roles).toEqual(expect.arrayContaining(byCode.get("engagement.content.manage").roles));
    expect(byCode.get("engagement.enquiry.respond").roles).toEqual(["front_desk"]);
  });
  it("every new operation uses one of the two new codes or the existing patient code engagement.self.read (and only listMyPortalContent uses that one)", () => {
    const used = new Map<string, string[]>();
    for (const id of Object.keys(ENG)) { const k = opOf(id)?.op["x-permission"]; used.set(k, [...(used.get(k) ?? []), id]); }
    sortedEq([...used.keys()], [...NEW_PERMS, "engagement.self.read"]);
    expect(used.get("engagement.self.read")).toEqual(["listMyPortalContent"]);
  });
  it("patients, portal actors, devices and partners get no content code (staff only); the patient set keeps engagement.self.read", () => {
    const f = registry.fixed_actor_permissions;
    for (const code of NEW_PERMS) expect(JSON.stringify([f.patient, f.portal, f.device, f.partner, f.patient_pre_auth, f.queue_display]), code).not.toContain(code);
    expect(f.patient).toContain("engagement.self.read");
  });
  it("corp_admin pack holds both codes, sorted and without duplicates", () => {
    const admin = packs.packs.flatMap((p: any) => p.roles).find((r: any) => r.code === "corp_admin");
    for (const c of NEW_PERMS) expect(admin.permissions, `corp_admin lacks ${c}`).toContain(c);
    expect(new Set(admin.permissions).size).toBe(admin.permissions.length);
    expect(admin.permissions).toEqual([...admin.permissions].sort());
  });
  it("db/seeds/001_core__g_permissions.sql and the generated permission types carry both codes (codegen is the single source)", () => {
    const seed = readFileSync(join(ROOT, "db/seeds/001_core__g_permissions.sql"), "utf8");
    const gen = readFileSync(join(ROOT, "contracts/ports/generated/permissions.ts"), "utf8");
    for (const c of NEW_PERMS) {
      expect(seed, `seed ${c}`).toMatch(new RegExp(`\\('${c.replace(/\./g, "\\.")}', 'engagement', false,`));
      expect(gen, `generated ${c}`).toContain(`"${c}"`);
    }
  });
});

describe("T0C-CONTENT-1 contract: schemas are closed, no floats (done_when 5)", () => {
  it("all new schemas exist and are closed objects", () => {
    for (const n of NEW_SCHEMAS) { expect(S[n], `${n} missing`).toBeDefined(); expect(S[n].type, n).toBe("object"); expect(S[n].additionalProperties, `${n} must be closed`).toBe(false); }
  });
  it("every schema reachable from the new operations and every object inside is closed; none uses type number", () => {
    const names = new Set<string>(NEW_SCHEMAS);
    for (const id of Object.keys(ENG)) {
      const f = opOf(id)!;
      for (const r of Object.values<any>(f.op.responses ?? {})) { const s = r?.content?.["application/json"]?.schema; if (s?.$ref) reach(refName(s), names); }
      for (const m of Object.values<any>(f.op.requestBody?.content ?? {})) if (m.schema?.$ref) reach(refName(m.schema), names);
    }
    const b = bad([...names].filter((n) => S[n]));
    expect(b, b.join(" | ")).toEqual([]);
  });
  it("PortalContent: kind (news | banner | offer | contact), bounded title and body, https link, date window, sort order, active flag, published_at, audit fields", () => {
    const s = S.PortalContent;
    const act = activeField("PortalContent");
    for (const f of ["id", "kind", "title", "sort_order", act, "created_at", "updated_at", "version"]) { expect(s.properties?.[f], `PortalContent.${f}`).toBeDefined(); expect(s.required ?? [], `${f} required`).toContain(f); }
    for (const f of ["body", "image_attachment_id", "link_url", "starts_on", "ends_on", "published_at", "created_by"]) expect(s.properties?.[f], `PortalContent.${f}`).toBeDefined();
    sortedEq(enumOf(prop("PortalContent", "kind")), KINDS);
    expect(prop("PortalContent", act).type).toBe("boolean");
    expect(prop("PortalContent", "sort_order").type).toBe("integer");
    expect(prop("PortalContent", "sort_order").minimum).toBeGreaterThanOrEqual(0);
    expect(typeof prop("PortalContent", "sort_order").maximum).toBe("number");
    expect(JSON.stringify(prop("PortalContent", "image_attachment_id"))).toContain("Uuid");
    for (const f of ["starts_on", "ends_on"]) expect(prop("PortalContent", f).format, f).toBe("date");
    expect(prop("PortalContent", "title").minLength).toBeGreaterThanOrEqual(1);
    expect(prop("PortalContent", "title").maxLength).toBeLessThanOrEqual(200);
    expect(prop("PortalContent", "body").type).toBe("string");
    expect(prop("PortalContent", "body").maxLength, "body has a maximum length").toBeGreaterThanOrEqual(1000);
    expect(prop("PortalContent", "body").maxLength).toBeLessThanOrEqual(20000);
    expect(prop("PortalContent", "link_url").maxLength).toBeLessThanOrEqual(2048);
    expect(String(prop("PortalContent", "link_url").pattern ?? ""), "link_url pattern is https only").toMatch(/https/);
  });
  it("PortalContentPublic carries no staff field: no created_by, updated_by, tenant_id, version, active flag, audit timestamps; keeps what the patient app shows", () => {
    const keys = Object.keys(S.PortalContentPublic.properties);
    for (const f of STAFF_ONLY_FIELDS) expect(keys, `staff field ${f} leaked into PortalContentPublic`).not.toContain(f);
    for (const f of ["id", "kind", "title"]) { expect(keys, f).toContain(f); expect(S.PortalContentPublic.required, f).toContain(f); }
    for (const f of ["body", "image_attachment_id", "link_url"]) expect(keys, f).toContain(f);
    expect(textOf(S.PortalContentPublic)).not.toMatch(/created_by|updated_by|tenant_id/);
    const n = [...reach("PortalContentPublicPage")];
    expect(n.filter((x) => x !== "PortalContentPublicPage" && x !== "PortalContentPublic" && !/^(Page|Cursor|PageInfo)/i.test(x)), "the public page reaches only the public item (and the page object)").toEqual([]);
  });
  it("ProfileImage: profile_kind (doctor | centre | staff), profile_id, image_attachment_id, active flag; ProfileImageSet carries only the attachment id", () => {
    const act = activeField("ProfileImage");
    for (const f of ["profile_kind", "profile_id", "image_attachment_id", act]) { expect(S.ProfileImage.properties?.[f], `ProfileImage.${f}`).toBeDefined(); expect(S.ProfileImage.required, f).toContain(f); }
    sortedEq(enumOf(prop("ProfileImage", "profile_kind")), PROFILE_KINDS);
    expect(JSON.stringify(prop("ProfileImage", "profile_id"))).toContain("Uuid");
    expect(JSON.stringify(prop("ProfileImage", "image_attachment_id"))).toContain("Uuid");
    expect(Object.keys(S.ProfileImageSet.properties)).toEqual(["image_attachment_id"]);
    expect(S.ProfileImageSet.required).toEqual(["image_attachment_id"]);
  });
  it("PortalContentReorder: kind and an ordered list of unique ids with a bound", () => {
    const r = S.PortalContentReorder;
    expect(r.required, "ids required").toContain("ids");
    expect(r.properties.ids.type).toBe("array");
    expect(r.properties.ids.minItems).toBeGreaterThanOrEqual(1);
    expect(r.properties.ids.maxItems, "bounded").toBeLessThanOrEqual(500);
    expect(r.properties.ids.uniqueItems, "an id may appear once").toBe(true);
    expect(JSON.stringify(r.properties.ids.items)).toContain("Uuid");
    sortedEq(enumOf(r.properties.kind), KINDS);
  });
});

describe("T0C-CONTENT-1 contract: restricted Markdown and https links are enforced by the schema (done_when 2) — adversarial inputs", () => {
  const base = { kind: "news", title: "Synthetic news (SYNTHETIC)" };
  const MD_OK = ["# Heading\n\nSome **bold** and *italic* and _more_ text.\n\n- one\n- two\n\n1. first\n2. second\n\n[Visit](https://example.org/path?q=1&r=2)", "Plain text with no markup.", "## Second level\n\n* item *with* emphasis"];
  const MD_BAD: [string, string][] = [
    ["script tag", "<script>alert(1)</script>"], ["bold tag", "<b>x</b>"], ["img with handler", "<img src=x onerror=alert(1)>"], ["iframe", "text <iframe src=\"https://example.org\"></iframe>"],
    ["autolink in angle brackets", "<https://example.org>"], ["javascript link", "[x](javascript:alert(1))"], ["mixed case javascript link", "[x](JaVaScRiPt:alert(1))"], ["http link", "[x](http://example.org)"],
    ["data link", "[x](data:text/html;base64,AAAA)"], ["protocol relative link", "[x](//evil.example/a)"], ["relative link", "[x](/admin)"], ["mailto link", "[x](mailto:a@example.org)"],
    ["reference definition with javascript", "[1]\n\n[1]: javascript:alert(1)"], ["reference definition with http", "[1]: http://example.org"], ["image syntax (not in the subset)", "![x](https://example.org/a.png)"],
    ["entity-encoded javascript scheme", "[x](&#106;avascript:alert(1))"],
  ];
  it.each(["PortalContentCreate", "PortalContentUpdate"])("%s accepts the subset and rejects raw HTML, non-https links, image syntax and reference definitions", (name) => {
    const v = validator(name);
    const wrap = (b: string) => (name === "PortalContentCreate" ? { ...base, body: b } : { body: b });
    for (const b of MD_OK) expect(v(wrap(b)), `${name} rejected a good body ${JSON.stringify(b.slice(0, 30))}: ${JSON.stringify(v.errors?.[0])}`).toBe(true);
    for (const [why, b] of MD_BAD) expect(v(wrap(b)), `${name} accepted a bad body (${why}): ${JSON.stringify(b)}`).toBe(false);
  });
  it("the body maximum length is enforced: exactly the maximum is accepted, one more is rejected; an empty title is rejected", () => {
    const v = validator("PortalContentCreate");
    const max = prop("PortalContentCreate", "body").maxLength as number;
    expect(typeof max, "PortalContentCreate.body.maxLength").toBe("number");
    expect(v({ ...base, body: "a".repeat(max) }), JSON.stringify(v.errors?.[0])).toBe(true);
    expect(v({ ...base, body: "a".repeat(max + 1) })).toBe(false);
    expect(v({ ...base, title: "" })).toBe(false);
    expect(v({ ...base, title: "t".repeat(201) })).toBe(false);
  });
  it("title is plain text: markup characters are rejected", () => {
    const v = validator("PortalContentCreate");
    for (const t of ["<b>Sale</b>", "<script>x</script>", "Offer <i>now</i>"]) expect(v({ ...base, title: t }), t).toBe(false);
  });
  it("link_url is https only: javascript, data, http, ftp, protocol relative, empty and over-long values are rejected; a normal https URL is accepted", () => {
    const v = validator("PortalContentCreate");
    expect(v({ ...base, link_url: "https://example.org/offers?id=7" }), JSON.stringify(v.errors?.[0])).toBe(true);
    for (const u of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,x", "http://example.org", "ftp://example.org/a", "//example.org/a", "", " https://example.org", "https://example.org/" + "a".repeat(2100)])
      expect(v({ ...base, link_url: u }), `accepted link_url ${JSON.stringify(u.slice(0, 40))}`).toBe(false);
  });
  it("unknown fields, an unknown kind, a date that is not a date and a negative sort_order are rejected (closed schema, AB-5)", () => {
    const v = validator("PortalContentCreate");
    expect(v({ ...base, tenant_id: UUID })).toBe(false);
    expect(v({ ...base, created_by: UUID })).toBe(false);
    expect(v({ ...base, kind: "popup" })).toBe(false);
    expect(v({ ...base, sort_order: -1 })).toBe(false);
    expect(v({ ...base, sort_order: 1.5 })).toBe(false);
    expect(v({ ...base, image_attachment_id: "not-a-uuid" })).toBe(false);
    for (const k of KINDS) expect(v({ ...base, kind: k }), k).toBe(true);
    expect(v({ ...base, starts_on: "2026-12-01", ends_on: "2026-12-31", image_attachment_id: UUID, sort_order: 3 }), JSON.stringify(v.errors?.[0])).toBe(true);
  });
  it("PortalContentUpdate is a closed partial of the create fields; ProfileImageSet rejects a missing or malformed attachment id", () => {
    const u = validator("PortalContentUpdate");
    expect(u({ tenant_id: UUID })).toBe(false);
    expect(u({ kind: "popup" })).toBe(false);
    expect(u({ body: "<script>alert(1)</script>" }), "the Markdown rule holds on update too").toBe(false);
    expect(u({ title: "New title" }), JSON.stringify(u.errors?.[0])).toBe(true);
    const p = validator("ProfileImageSet");
    expect(p({ image_attachment_id: UUID }), JSON.stringify(p.errors?.[0])).toBe(true);
    expect(p({})).toBe(false);
    expect(p({ image_attachment_id: "x" })).toBe(false);
    expect(p({ image_attachment_id: UUID, profile_id: UUID2 })).toBe(false);
  });
  it("the rules are written into the contract text: Markdown subset, no raw HTML, https only, a closed subset, maximum length", () => {
    const t = textOf(S.PortalContent, S.PortalContentCreate, opOf("createPortalContent")!.op.description, opOf("createPortalContent")!.op.summary, opOf("updatePortalContent")!.op.description);
    expect(t).toMatch(/markdown/i);
    expect(t, "no raw HTML").toMatch(/no raw html|raw html is (not allowed|rejected)|html is rejected/i);
    expect(t, "https only").toMatch(/https only|only https|https:\/\/ only/i);
    expect(t, "the subset is listed").toMatch(/heading/i);
    expect(t).toMatch(/bold/i);
    expect(t).toMatch(/italic/i);
    expect(t).toMatch(/list/i);
    expect(t, "the subset is closed: no images, no scripts").toMatch(/script|image/i);
  });
});

describe("T0C-CONTENT-1 contract: public read, deactivate, reorder, images are stated in the contract (done_when 3, 4)", () => {
  it("listMyPortalContent says: only active items, inside their starts_on / ends_on window, no staff fields", () => {
    const f = opOf("listMyPortalContent")!;
    const t = textOf(f.op.description, f.op.summary, S.PortalContentPublic, S.PortalContentPublicPage);
    expect(t).toMatch(/active/i);
    expect(t, "date window").toMatch(/starts_on/);
    expect(t).toMatch(/ends_on/);
    expect(t).toMatch(/window|between|inside|within/i);
    expect(t, "no staff fields").toMatch(/no staff|staff fields|staff-only|without staff/i);
  });
  it("deactivatePortalContent says the row stays (no delete); reorderPortalContent says the order is set by the list position and one kind at a time", () => {
    expect(textOf(opOf("deactivatePortalContent")!.op.description, opOf("deactivatePortalContent")!.op.summary)).toMatch(/not deleted|never deleted|stays|history|inactive/i);
    expect(textOf(opOf("reorderPortalContent")!.op.description, opOf("reorderPortalContent")!.op.summary, S.PortalContentReorder)).toMatch(/order|position|sort_order/i);
    expect(opOf("clearProfileImage")!.method).toBe("delete");
    expect(textOf(opOf("clearProfileImage")!.op.description, opOf("clearProfileImage")!.op.summary)).toMatch(/deactivat|stays|history|not deleted|keeps/i);
  });
  it("images reuse the branding upload path: image_attachment_id points at the branding asset resource (uploadBrandingAsset, re-encoded, size and type limited) and no new upload route is added", () => {
    const t = textOf(prop("PortalContent", "image_attachment_id"), prop("PortalContentCreate", "image_attachment_id"), prop("ProfileImageSet", "image_attachment_id"), S.ProfileImageSet,
      opOf("createPortalContent")!.op.description, opOf("setProfileImage")!.op.description);
    expect(t, "names the existing resource").toMatch(/branding/i);
    expect(t, "names the existing operation").toMatch(/uploadBrandingAsset|branding-assets/);
    expect(t, "no new upload route").toMatch(/no new upload|no upload route|reuses?/i);
    for (const [path, item] of Object.entries<any>(doc.paths)) {
      if (!/portal-content|profile-images/.test(path)) continue;
      expect(path, "no upload path").not.toMatch(/upload|image-upload|assets/i);
      for (const m of METHODS) if (item[m]) {
        expect(item[m]["x-upload"], `${path} ${m} must not be an upload operation`).toBeUndefined();
        expect(JSON.stringify(item[m].requestBody ?? {}), `${path} ${m}`).not.toMatch(/multipart|binary|image\/(png|jpeg)/);
      }
    }
  });
});

describe("T0C-CONTENT-1 generated clients (codegen is fresh)", () => {
  it("generated clients, MSW handlers, route and permission types are fresh (codegen --check)", () => {
    expect(staleFiles(ROOT)).toEqual([]);
  }, 120_000);
});

describe("T0C-CONTENT-1 migration file (static; behaviour in the pgTAP suite) (done_when 1, 5, 6)", () => {
  const path = join(ROOT, "db/migrations", MIG);
  const text = existsSync(path) ? readFileSync(path, "utf8").replace(/\r\n/g, "\n") : "";
  const code = text.split("\n").filter((l) => !/^\s*--/.test(l)).map((l) => l.replace(/--.*$/, "")).join("\n");
  const comments = text.split("\n").filter((l) => /^\s*--/.test(l)).join("\n");
  const TABLES = ["portal_content", "profile_image"];

  it("exists, is the only 20261117130000 migration, runs as lims_owner", () => {
    expect(existsSync(path), `db/migrations/${MIG} missing`).toBe(true);
    const all = readdirSync(join(ROOT, "db/migrations")).filter((f) => f.endsWith(".sql")).sort();
    expect(all.filter((f) => f.startsWith("20261117130000"))).toEqual([MIG]);
    expect(code).toMatch(/SET LOCAL ROLE lims_owner/);
  });
  it("creates both tables in the engagement schema with IF NOT EXISTS, tenant_id, created_at, created_by, RLS enabled and forced, a tenant select policy guarded by pg_policy", () => {
    for (const t of TABLES) {
      expect(code, `engagement.${t}`).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS engagement\\.${t}\\b`, "i"));
      expect(code, `${t} ENABLE RLS`).toMatch(new RegExp(`ALTER TABLE engagement\\.${t}\\s+ENABLE ROW LEVEL SECURITY`, "i"));
      expect(code, `${t} FORCE RLS`).toMatch(new RegExp(`ALTER TABLE engagement\\.${t}\\s+FORCE ROW LEVEL SECURITY`, "i"));
      expect(code, `${t} tenant select policy`).toMatch(new RegExp(`CREATE POLICY ${t}__select__\\w* ON engagement\\.${t} FOR SELECT`, "i"));
      const block = code.slice(code.search(new RegExp(`CREATE TABLE IF NOT EXISTS engagement\\.${t}\\b`, "i")));
      expect(block.slice(0, 2600), `${t} has tenant_id`).toMatch(/tenant_id\s+uuid\s+NOT NULL/i);
      expect(block.slice(0, 2600), `${t} has created_at`).toMatch(/created_at\s+timestamptz\s+NOT NULL DEFAULT now\(\)/i);
      expect(block.slice(0, 2600), `${t} has created_by`).toMatch(/created_by\s+uuid\s+NOT NULL/i);
      expect(block.slice(0, 2600), `${t} has an active flag`).toMatch(/\b(is_)?active\s+boolean\s+NOT NULL/i);
    }
    expect((code.match(/CREATE TABLE(?! IF NOT EXISTS)/gi) ?? []).length, "every CREATE TABLE is IF NOT EXISTS").toBe(0);
    for (const m of code.matchAll(/CREATE POLICY (\w+)/gi)) expect(code, `policy ${m[1]} must be guarded by pg_policy`).toMatch(new RegExp(`pg_policy[^;]*${m[1]}`, "i"));
  });
  it("history is never deleted: no DELETE grant, no DELETE policy; the app role gets SELECT, INSERT, UPDATE", () => {
    expect(code).not.toMatch(/GRANT[^;]*\bDELETE\b/i);
    expect(code).not.toMatch(/FOR DELETE/i);
    for (const t of TABLES) expect(code, `${t} grant`).toMatch(new RegExp(`GRANT SELECT, INSERT, UPDATE ON engagement\\.${t} TO lims_app`, "i"));
  });
  it("patient actors read only active content: a select policy on portal_content names the patient actor type and the active flag; no policy lets a patient or partner write or read profile_image", () => {
    expect(code).toMatch(/portal_content[\s\S]{0,900}'patient'/i);
    expect(code).toMatch(/portal_content[\s\S]{0,900}\b(is_)?active\b/i);
    expect(code, "date window in the policy").toMatch(/starts_on[\s\S]{0,200}current_date|current_date[\s\S]{0,200}starts_on/i);
    expect(code, "patients never write").not.toMatch(/FOR (INSERT|UPDATE)[^;]*'patient'/i);
    expect(code, "profile_image has no patient policy").not.toMatch(/ON engagement\.profile_image[^;]*'patient'/i);
    expect(code).toMatch(/current_actor_type\(\)\)?\s+IN\s+\('user',\s*'system'\)/i);
  });
  it("is additive and idempotent: no data statement, no drop, no type change, no policy change on existing tables, guarded ADD CONSTRAINT and indexes", () => {
    expect(code.length, "migration missing or empty").toBeGreaterThan(0);
    expect(code).not.toMatch(/\b(TRUNCATE|DELETE\s+FROM|INSERT\s+INTO|UPDATE\s+\S+\s+SET|REVOKE|DROP\s+\w+|ALTER\s+COLUMN)\b/i);
    expect(code).not.toMatch(/ALTER\s+TABLE\s+\S+\s+(RENAME|OWNER)/i);
    expect(code).not.toMatch(/DISABLE\s+ROW|NO\s+FORCE|ALTER\s+POLICY|\bCREATE\s+TYPE\b|\bAS\s+ENUM\b/i);
    expect(code, "no change to identity.branding_assets").not.toMatch(/ALTER\s+TABLE\s+identity\./i);
    for (const m of code.matchAll(/CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF NOT EXISTS)/gi)) throw new Error(`unguarded CREATE INDEX near ${m.index}`);
    for (const m of code.matchAll(/ADD\s+CONSTRAINT/gi)) expect(code.slice(Math.max(0, m.index! - 1500), m.index), "ADD CONSTRAINT must sit in a DO block that checks pg_constraint first").toMatch(/DO\s+\$[a-z_]*\$[\s\S]*pg_constraint/i);
    expect(code).not.toMatch(/CREATE (OR REPLACE )?FUNCTION[\s\S]{0,400}SECURITY DEFINER(?![\s\S]{0,200}search_path\s*=\s*'')/i);
  });
  it("value checks in the table: kind, profile_kind, https link, body without markup characters and bounded, date window order, one profile image row per profile, the attachment is a branding asset of the same tenant", () => {
    for (const v of [...KINDS, ...PROFILE_KINDS]) expect(code, `a check names ${v}`).toContain(`'${v}'`);
    expect(code, "https only in the table too").toMatch(/link_url\s*~\s*'\^https:\/\/|link_url\s+LIKE\s+'https:\/\//i);
    expect(code, "bounded body").toMatch(/char_length\(body\)\s*<=\s*\d+|length\(body\)\s*<=\s*\d+/i);
    expect(code, "no raw HTML in the table either").toMatch(/body\s*!~\s*'[^']*<|position\('<'\s+IN\s+body\)\s*=\s*0|body\s+NOT\s+LIKE\s+'%<%'/i);
    expect(code, "date window order").toMatch(/ends_on\s*>=\s*starts_on/i);
    expect(code, "one row per profile").toMatch(/UNIQUE\s*\(\s*tenant_id,\s*profile_kind,\s*profile_id\s*\)|UNIQUE INDEX[^;]*profile_image[^;]*\(tenant_id,\s*profile_kind,\s*profile_id\)/i);
    expect(code, "composite tenant FK to the branding asset (portal_content)").toMatch(/FOREIGN KEY \(tenant_id, image_attachment_id\) REFERENCES identity\.branding_assets \(tenant_id, id\)/i);
    expect((code.match(/REFERENCES identity\.branding_assets \(tenant_id, id\)/gi) ?? []).length, "both tables reference the branding asset").toBeGreaterThanOrEqual(2);
  });
  it("comments: LD-313, down note, no data rewrite, push-cloud, every table named", () => {
    expect(comments).toMatch(/LD-313/);
    expect(comments).toMatch(/\bdown\b/i);
    expect(comments).toMatch(/DROP TABLE/i);
    expect(comments).toMatch(/no data rewrite|does not rewrite|no rewrite|additive/i);
    expect(comments).toMatch(/push-cloud/i);
    for (const t of TABLES) expect(comments, `comments name ${t}`).toContain(t);
  });
  it("db/meta/tables.yaml registers both tables; db/policies/engagement.sql carries their policies", () => {
    const meta = readFileSync(join(ROOT, "db/meta/tables.yaml"), "utf8");
    const eng = readFileSync(join(ROOT, "db/policies/engagement.sql"), "utf8");
    for (const t of TABLES) { expect(meta, `engagement.${t}`).toContain(`"engagement.${t}"`); expect(eng, t).toMatch(new RegExp(`${t}__select__\\w*`)); }
  });
});

describe("T0C-CONTENT-1 implementation notes: decision line per ElabAssist function, permissions, founder steps (done_when 6)", () => {
  const t = existsSync(NOTES) ? readFileSync(NOTES, "utf8") : "";
  const lines = t.split("\n");
  const decisionLine = (label: string) => lines.find((x) => {
    const s = x.replace(/^[\s|*\-•>`_#]+/, "").toLowerCase();
    const l = label.toLowerCase();
    if (!s.startsWith(l)) return false;
    const rest = s.slice(l.length).replace(/^[*`_\s]+/, "");
    return (rest === "" || /^[—–\-:|=(]/.test(rest)) && /already present|added|not added|deliberately not/i.test(x);
  });
  it("notes exist, name the migration, say the cloud migration is a founder step (push-cloud), list the 9 pending operation ids, the T0B task, LD-313 and LD-325", () => {
    expect(existsSync(NOTES), ".orchestra/notes/T0C-CONTENT-1-impl.md missing").toBe(true);
    expect(t).toContain(MIG);
    expect(t).toMatch(/push-cloud/i);
    expect(t).toMatch(/founder/i);
    expect(t).toMatch(/pendingOperations/);
    for (const id of Object.keys(ENG)) expect(t, id).toContain(id);
    expect(t).toMatch(/T0B-CONTENT-1/);
    expect(t).toMatch(/LD-313/);
    expect(t).toMatch(/LD-325/);
  });
  it("every ElabAssist function of the brief has one decision line: already present (field named), added (field named) or not added (reason)", () => {
    expect(t.length, "impl notes missing").toBeGreaterThan(0);
    const missing = LABELS.filter((l) => !decisionLine(l));
    expect(missing, `functions without a decision line: ${missing.join(" | ")}`).toEqual([]);
  });
  it("'not added' decisions carry a reason", () => {
    const badLines = lines.filter((x) => /deliberately not added|not added/i.test(x) && !/because|reason|why|\bsince\b|—|: .{12,}/i.test(x));
    expect(badLines, `not-added lines without a reason: ${badLines.slice(0, 3).join(" || ")}`).toEqual([]);
  });
  it("lists both new permission codes, says neither is privileged, names the corp_admin pack and the role pack re-apply as a founder step", () => {
    for (const c of NEW_PERMS) expect(t, c).toContain(c);
    expect(t).toMatch(/not privileged|non-privileged|none (of them )?(is |are )?privileged/i);
    expect(t).toMatch(/corp_admin/);
    expect(t).toMatch(/re-?apply[^\n]*role pack|role pack[^\n]*re-?apply/i);
  });
  it("records the decisions a reader must know: Markdown subset instead of raw HTML (LD-313 d), images reuse the branding upload path and which branding asset kind they use, how a patient fetches the image, no service or web change", () => {
    expect(t).toMatch(/markdown/i);
    expect(t).toMatch(/raw html|rich text/i);
    expect(t).toMatch(/uploadBrandingAsset|branding upload|branding asset/i);
    expect(t, "the notes say which branding asset kind a portal image uses (the table allows logo, letterhead_header, letterhead_footer, signature)").toMatch(/kind[^\n]*(logo|letterhead)|(logo|letterhead)[^\n]*kind/i);
    expect(t, "the notes say how the patient app reads the image").toMatch(/patient[^\n]*(image|content|asset)[^\n]*(read|fetch|download|route)|(read|fetch|download)[^\n]*patient[^\n]*image/i);
    expect(t).toMatch(/no (service|handler|web)/i);
  });
});
