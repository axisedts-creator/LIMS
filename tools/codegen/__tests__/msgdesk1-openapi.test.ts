// T0C-MSGDESK-1 (LD-321, LD-325; founder 2026-11-17 09:18 NPT priority order, 09:19 offline rule) — broadcast messages to an audience (engagement.yaml) and partner message to lab tickets (partners.yaml)
// (ElabAssist "Messages" and "Message To Laboratory"), contracts/permissions.yaml + corp_admin pack (5 new codes), the migration 20261117240000_engagement__add_broadcast_and_tickets.sql
// (static checks; behaviour is db/tests/engagement/T0C-MSGDESK-1_broadcast_and_tickets.test.sql), generated-client freshness and the implementation notes (FIELD MAP, offline classification).
// ASSUMPTIONS (the brief names tables, operations in words and rules, not every wire name; a different choice needs a ruling, not a silent test edit; same style as T0C-PRICETOOLS-1):
//  - engagement.yaml: exactly 11 new operations (98 -> 109), all tag engagement, x-context tenant, staff side:
//      listBroadcastTemplates        GET   /v1/engagement/broadcast-templates                                   engagement.broadcast.read     idem none      200 BroadcastTemplatePage
//      createBroadcastTemplate       POST  /v1/engagement/broadcast-templates                                   engagement.broadcast.manage   idem required  201 BroadcastTemplate
//      updateBroadcastTemplate       PATCH /v1/engagement/broadcast-templates/{template_id}                     engagement.broadcast.manage   idem optional|required 200 BroadcastTemplate
//      deactivateBroadcastTemplate   POST  /v1/engagement/broadcast-templates/{template_id}/deactivate          engagement.broadcast.manage   idem optional|required 200 BroadcastTemplate
//      createBroadcast               POST  /v1/engagement/broadcasts                                            engagement.broadcast.manage   idem required  201 Broadcast (status draft, nothing sent)
//      previewBroadcastAudience      POST  /v1/engagement/broadcast-audience-previews                           engagement.broadcast.manage   idem none      200 BroadcastAudiencePreview (count + masked sample, sends nothing)
//      requestBroadcastApproval      POST  /v1/engagement/broadcasts/{broadcast_id}/request-approval            engagement.broadcast.manage   idem required  200 Broadcast (pending_approval)
//      approveBroadcast              POST  /v1/engagement/broadcasts/{broadcast_id}/approve                     engagement.broadcast.approve  idem required  200 Broadcast (approved; PRIVILEGED code -> MFA)
//      cancelBroadcast               POST  /v1/engagement/broadcasts/{broadcast_id}/cancel                      engagement.broadcast.manage   idem required  200 Broadcast (cancelled)
//      listBroadcasts                GET   /v1/engagement/broadcasts                                            engagement.broadcast.read     idem none      200 BroadcastPage
//      listBroadcastRecipients       GET   /v1/engagement/broadcasts/{broadcast_id}/recipients                  engagement.broadcast.read     idem none      200 BroadcastRecipientPage (per recipient status, masked address)
//  - partners.yaml: exactly 10 new operations (68 -> 78), all tag partners, x-context tenant. Lab side under /v1/partners/admin/tickets, partner side under /v1/partners/me/tickets:
//      createPartnerTicket POST /admin/tickets (manage, required, 201) | listPartnerTickets GET /admin/tickets (read) | getPartnerTicket GET /admin/tickets/{ticket_id} (read) | replyPartnerTicket POST /admin/tickets/{ticket_id}/messages (manage, required, 201)
//      closePartnerTicket POST /admin/tickets/{ticket_id}/close (manage, required, 200) | reopenPartnerTicket POST /admin/tickets/{ticket_id}/reopen (manage, required, 200)
//      listMyPartnerTickets GET /me/tickets (read) | createMyPartnerTicket POST /me/tickets (manage, required, 201) | getMyPartnerTicket GET /me/tickets/{ticket_id} (read) | replyMyPartnerTicket POST /me/tickets/{ticket_id}/messages (manage, required, 201)
//    ("create a ticket ... list and get for the lab side, list own tickets and reply for the partner side" + brief point 5 "partner users get ticket create and reply for their own tickets"; the partner side also gets get-own so a thread can be read.)
//  - Permissions: exactly the five codes of the brief; the partner actor (partner_member, partner_admin) gets partners.ticket.read and partners.ticket.manage in fixed_actor_permissions and may only reach /me/ operations;
//    the contract text of every /admin/ ticket operation says staff only and every /me/ operation says own tickets only (the partner actor is bound by the database policy, tests in the pgTAP suite).
//  - Error codes: the ones an operation lists must exist in contracts/errors.yaml (additive; new engagement.broadcast_* / partners.ticket_* codes are allowed, none renamed or removed). Required ones are matched by meaning (regex), not by exact name.
//  - Money does not occur. Statuses: template channel sms | whatsapp | email; broadcast draft | pending_approval | approved | sending | sent | cancelled; recipient queued | sent | failed | skipped; ticket new | replied | closed;
//    message sender_kind partner | lab; audience party kinds laboratory | franchise | client | lab_user (ElabAssist audience list: Laboratory, Franchise, Client, Lab User).
//  - Wire names: Broadcast{id, template_id, audience_filter, status, recipient_count, opted_out_count, requested_by, approved_by?, created_at, updated_at, version}, BroadcastRecipient{id, broadcast_id, party_kind, party_id, channel_address (MASKED),
//    status, outbox_id?}, PartnerTicket{id, party_kind, party_id, subject, status, created_by, created_at, updated_at, version, last_message_at?}, PartnerTicketMessage{id, ticket_id, sender_kind, body, created_by, created_at}.
//  - the implementer's notes are .orchestra/notes/T0C-MSGDESK-1-impl.md (convention of every earlier T0C task).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv-draft-04";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { staleFiles } from "../codegen";
import { lintRepo } from "../lint-openapi";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MIG = "20261117240000_engagement__add_broadcast_and_tickets.sql";
const NOTES = join(ROOT, ".orchestra/notes/T0C-MSGDESK-1-impl.md");
const load = (rel: string): any => parse(readFileSync(join(ROOT, rel), "utf8"));
const common: any = load("contracts/openapi/_common.yaml");
const registry: any = load("contracts/permissions.yaml");
const packs: any = load("services/api/src/modules/identity/role-packs/role-packs.data.yaml");
const errorsText = readFileSync(join(ROOT, "contracts/errors.yaml"), "utf8");
const METHODS = ["get", "put", "post", "delete", "patch"];
const sortedEq = (a: string[], b: string[]) => expect([...a].sort()).toEqual([...b].sort());
const enumOf = (p: any): string[] => ((p?.enum ?? []) as unknown[]).filter((x): x is string => typeof x === "string");
const refName = (s: any): string => String(s?.$ref ?? "").split("/").pop()!;
const isUuid = (p: any) => JSON.stringify(p).includes("Uuid");
const textOf = (...parts: any[]): string => parts.map((p) => JSON.stringify(p ?? "")).join(" ").replace(/\\"/g, '"');

type OpSpec = { method: string; path: string; perm: string; idem: string[]; ok: string; schema?: string };
const ENG: Record<string, OpSpec> = {
  listBroadcastTemplates: { method: "get", path: "/v1/engagement/broadcast-templates", perm: "engagement.broadcast.read", idem: ["none"], ok: "200", schema: "BroadcastTemplatePage" },
  createBroadcastTemplate: { method: "post", path: "/v1/engagement/broadcast-templates", perm: "engagement.broadcast.manage", idem: ["required"], ok: "201", schema: "BroadcastTemplate" },
  updateBroadcastTemplate: { method: "patch", path: "/v1/engagement/broadcast-templates/{template_id}", perm: "engagement.broadcast.manage", idem: ["optional", "required"], ok: "200", schema: "BroadcastTemplate" },
  deactivateBroadcastTemplate: { method: "post", path: "/v1/engagement/broadcast-templates/{template_id}/deactivate", perm: "engagement.broadcast.manage", idem: ["optional", "required"], ok: "200", schema: "BroadcastTemplate" },
  createBroadcast: { method: "post", path: "/v1/engagement/broadcasts", perm: "engagement.broadcast.manage", idem: ["required"], ok: "201", schema: "Broadcast" },
  previewBroadcastAudience: { method: "post", path: "/v1/engagement/broadcast-audience-previews", perm: "engagement.broadcast.manage", idem: ["none"], ok: "200", schema: "BroadcastAudiencePreview" },
  requestBroadcastApproval: { method: "post", path: "/v1/engagement/broadcasts/{broadcast_id}/request-approval", perm: "engagement.broadcast.manage", idem: ["required"], ok: "200", schema: "Broadcast" },
  approveBroadcast: { method: "post", path: "/v1/engagement/broadcasts/{broadcast_id}/approve", perm: "engagement.broadcast.approve", idem: ["required"], ok: "200", schema: "Broadcast" },
  cancelBroadcast: { method: "post", path: "/v1/engagement/broadcasts/{broadcast_id}/cancel", perm: "engagement.broadcast.manage", idem: ["required"], ok: "200", schema: "Broadcast" },
  listBroadcasts: { method: "get", path: "/v1/engagement/broadcasts", perm: "engagement.broadcast.read", idem: ["none"], ok: "200", schema: "BroadcastPage" },
  listBroadcastRecipients: { method: "get", path: "/v1/engagement/broadcasts/{broadcast_id}/recipients", perm: "engagement.broadcast.read", idem: ["none"], ok: "200", schema: "BroadcastRecipientPage" },
};
const PAR: Record<string, OpSpec> = {
  createPartnerTicket: { method: "post", path: "/v1/partners/admin/tickets", perm: "partners.ticket.manage", idem: ["required"], ok: "201", schema: "PartnerTicket" },
  listPartnerTickets: { method: "get", path: "/v1/partners/admin/tickets", perm: "partners.ticket.read", idem: ["none"], ok: "200", schema: "PartnerTicketPage" },
  getPartnerTicket: { method: "get", path: "/v1/partners/admin/tickets/{ticket_id}", perm: "partners.ticket.read", idem: ["none"], ok: "200", schema: "PartnerTicketDetail" },
  replyPartnerTicket: { method: "post", path: "/v1/partners/admin/tickets/{ticket_id}/messages", perm: "partners.ticket.manage", idem: ["required"], ok: "201", schema: "PartnerTicketMessage" },
  closePartnerTicket: { method: "post", path: "/v1/partners/admin/tickets/{ticket_id}/close", perm: "partners.ticket.manage", idem: ["required"], ok: "200", schema: "PartnerTicket" },
  reopenPartnerTicket: { method: "post", path: "/v1/partners/admin/tickets/{ticket_id}/reopen", perm: "partners.ticket.manage", idem: ["required"], ok: "200", schema: "PartnerTicket" },
  listMyPartnerTickets: { method: "get", path: "/v1/partners/me/tickets", perm: "partners.ticket.read", idem: ["none"], ok: "200", schema: "PartnerTicketPage" },
  createMyPartnerTicket: { method: "post", path: "/v1/partners/me/tickets", perm: "partners.ticket.manage", idem: ["required"], ok: "201", schema: "PartnerTicket" },
  getMyPartnerTicket: { method: "get", path: "/v1/partners/me/tickets/{ticket_id}", perm: "partners.ticket.read", idem: ["none"], ok: "200", schema: "PartnerTicketDetail" },
  replyMyPartnerTicket: { method: "post", path: "/v1/partners/me/tickets/{ticket_id}/messages", perm: "partners.ticket.manage", idem: ["required"], ok: "201", schema: "PartnerTicketMessage" },
};
const PERMS: Record<string, { privileged: boolean }> = {
  "engagement.broadcast.read": { privileged: false }, "engagement.broadcast.manage": { privileged: false }, "engagement.broadcast.approve": { privileged: true },
  "partners.ticket.read": { privileged: false }, "partners.ticket.manage": { privileged: false },
};
const OLD_ENG_PERMS = ["engagement.booking.read", "engagement.booking.manage", "engagement.self.read", "engagement.booking.create", "engagement.booking.cancel", "engagement.auth.challenge", "engagement.self.manage", "engagement.link.redeem",
  "engagement.payment.create", "engagement.enquiry.create", "engagement.queue.board_read", "engagement.slot.manage", "engagement.bookable_item.manage", "engagement.queue.operate", "engagement.queue.manage", "engagement.link.issue",
  "engagement.link.read", "engagement.link.revoke", "engagement.reminder.read", "engagement.reminder.manage", "engagement.membership.read", "engagement.membership.enrol", "engagement.membership_plan.manage", "engagement.enquiry.read",
  "engagement.enquiry.respond", "engagement.settings.manage"];
const OLD_PARTNER_PERMS = ["partners.partner.manage", "partners.order.read", "partners.manifest.submit", "partners.report.read", "partners.statement.read", "partners.price_list.read", "partners.partner.read", "partners.manifest.receive",
  "partners.pickup.manage", "partners.referrer.map", "partners.pickup.request", "partners.referrer.read", "partners.referrer.manage", "partners.partner_user.manage"];
const CHANNELS = ["sms", "whatsapp", "email"];
const B_STATUS = ["draft", "pending_approval", "approved", "sending", "sent", "cancelled"];
const R_STATUS = ["queued", "sent", "failed", "skipped"];
const T_STATUS = ["new", "replied", "closed"];
const PARTY_KINDS = ["laboratory", "franchise", "client", "lab_user"];
const UUID = "0193c4a0-0000-7000-8000-0000000000aa";
const UUID2 = "0193c4a0-0000-7000-8000-0000000000ab";
const TS = "2026-11-17T10:00:00.000Z";

// the ElabAssist labels of the Messages and Message To Laboratory records (C:/LIMS-state/elabassist-other-20261117.md): one decision line each (done_when 1)
const LABELS = [
  "Template Name", "Message Title", "Message Subject", "rich text body", "file attachment", "Create New Template", "Laboratory", "Franchise", "Client", "Lab User", "check all", "Send", "Cancel", "Log page",
  "Message To Laboratory", "Status New", "Status Replied", "Status Close", "Collection Center", "Affiliation", "Dates", "Create Message",
];

type Ctx = { name: string; file: string; doc: any; S: Record<string, any>; ajv: any };
const mk = (name: string): Ctx => {
  const file = `contracts/openapi/${name}.yaml`;
  const doc = load(file);
  const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
  ajv.addSchema({ ...common, id: "_common.yaml" });
  ajv.addSchema({ ...doc, id: `${name}.yaml` });
  return { name, file, doc, S: doc.components.schemas, ajv };
};
const E = mk("engagement");
const P = mk("partners");
const opOf = (c: Ctx, id: string): { method: string; path: string; op: any } | undefined => {
  for (const [path, item] of Object.entries<any>(c.doc.paths)) for (const m of METHODS) if (item[m]?.operationId === id) return { method: m, path, op: item[m] };
  return undefined;
};
const allOps = (c: Ctx): string[] => Object.values<any>(c.doc.paths).flatMap((item) => METHODS.filter((m) => item[m]).map((m) => item[m].operationId as string));
const okResp = (c: Ctx, id: string, ok: string): any => opOf(c, id)?.op.responses?.[ok];
const jsonRef = (c: Ctx, id: string, ok: string): string => refName(okResp(c, id, ok)?.content?.["application/json"]?.schema);
const prop = (c: Ctx, s: string, f: string): any => c.S[s]?.properties?.[f] ?? {};
const validator = (c: Ctx, name: string) => {
  const v = c.ajv.getSchema(`${c.name}.yaml#/components/schemas/${name}`);
  expect(v, `cannot resolve ${name}`).toBeDefined();
  return v!;
};
const reach = (c: Ctx, root: string, seen = new Set<string>()): Set<string> => {
  const walk = (n: any) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === "object") {
      if (typeof n.$ref === "string" && n.$ref.startsWith("#/components/schemas/")) {
        const nm = n.$ref.split("/").pop()!;
        if (!seen.has(nm)) { seen.add(nm); walk(c.S[nm]); }
      }
      Object.values(n).forEach(walk);
    }
  };
  seen.add(root);
  walk(c.S[root]);
  return seen;
};
const bad = (c: Ctx, names: Iterable<string>): string[] => {
  const out: string[] = [];
  const walk = (n: any, at: string) => {
    if (Array.isArray(n)) return n.forEach((x, i) => walk(x, `${at}[${i}]`));
    if (!n || typeof n !== "object") return;
    if (n.type === "number") out.push(`${at}: type number`);
    if (n.properties && n.additionalProperties !== false) out.push(`${at}: object not closed`);
    for (const [k, v] of Object.entries(n)) walk(v, `${at}.${k}`);
  };
  for (const n of names) walk(c.S[n], n);
  return out;
};

const NEW_SCHEMAS: Record<string, string[]> = {
  engagement: ["BroadcastPlaceholder", "BroadcastTemplate", "BroadcastTemplateCreate", "BroadcastTemplateUpdate", "BroadcastTemplatePage", "BroadcastAudienceFilter", "Broadcast", "BroadcastCreate", "BroadcastPage",
    "BroadcastAudiencePreviewRequest", "BroadcastAudiencePreview", "BroadcastRecipient", "BroadcastRecipientPage"],
  partners: ["PartnerTicket", "PartnerTicketCreate", "PartnerTicketDetail", "PartnerTicketPage", "PartnerTicketMessage", "PartnerTicketReply", "PartnerTicketAdminCreate"],
};

describe("T0C-MSGDESK-1 contract: lint and additive baseline", () => {
  it("lintRepo reports no violation for engagement.yaml and partners.yaml", async () => {
    const v = (await lintRepo(ROOT)).filter((x) => x.file === "engagement.yaml" || x.file === "partners.yaml");
    expect(v, JSON.stringify(v.slice(0, 3))).toEqual([]);
  });
  it("engagement.yaml is additive: 98 operations before, exactly 11 new ones now; old operations keep method, path, permission", () => {
    const ids = allOps(E);
    expect(ids.length, "98 + 11 broadcast operations").toBe(109);
    expect(new Set(ids).size).toBe(109);
    for (const id of Object.keys(ENG)) expect(opOf(E, id), `${id} missing`).toBeDefined();
    for (const [id, m, p, perm] of [["listEnquiries", "get", "/v1/engagement/enquiries", "engagement.enquiry.read"], ["replyEnquiry", "post", "/v1/engagement/enquiries/{enquiry_id}/messages", "engagement.enquiry.respond"],
      ["createMyEnquiry", "post", "/v1/engagement/me/enquiries", "engagement.enquiry.create"], ["listBookings", "get", "/v1/engagement/bookings", "engagement.booking.read"]]) {
      const f = opOf(E, id)!;
      expect(f, `${id} missing`).toBeDefined();
      expect(`${f.method} ${f.path}`, id).toBe(`${m} ${p}`);
      expect(f.op["x-permission"], id).toBe(perm);
    }
  });
  it("partners.yaml is additive: 68 operations before, exactly 10 new ones now; old operations keep method, path, permission", () => {
    const ids = allOps(P);
    expect(ids.length, "68 + 10 ticket operations").toBe(78);
    expect(new Set(ids).size).toBe(78);
    for (const id of Object.keys(PAR)) expect(opOf(P, id), `${id} missing`).toBeDefined();
    for (const [id, m, p, perm] of [["createManifest", "post", "/v1/partners/manifests", "partners.manifest.submit"], ["listPartnerOrders", "get", "/v1/partners/orders", "partners.order.read"],
      ["createPickupRequest", "post", "/v1/partners/pickup-requests", "partners.pickup.request"], ["listPartnerStatements", "get", "/v1/partners/statements", "partners.statement.read"]]) {
      const f = opOf(P, id)!;
      expect(f, `${id} missing`).toBeDefined();
      expect(`${f.method} ${f.path}`, id).toBe(`${m} ${p}`);
      expect(f.op["x-permission"], id).toBe(perm);
    }
  });
});

for (const [ctx, ops] of [[E, ENG], [P, PAR]] as [Ctx, Record<string, OpSpec>][]) {
  describe(`T0C-MSGDESK-1 contract: ${ctx.name}.yaml operations (done_when 3, 5)`, () => {
    for (const [id, n] of Object.entries(ops)) {
      it(`${id}: ${n.method.toUpperCase()} ${n.path}, ${n.perm}, idempotency ${n.idem.join("|")}, ${n.ok}, ${n.schema}, tenant context, error responses`, () => {
        const f = opOf(ctx, id);
        expect(f, `${id} missing`).toBeDefined();
        const { op } = f!;
        expect(`${f!.method} ${f!.path}`).toBe(`${n.method} ${n.path}`);
        expect(op.tags).toEqual([ctx.name]);
        expect(op["x-permission"]).toBe(n.perm);
        expect(op["x-context"]).toBe("tenant");
        expect(n.idem, `${id} idempotency ${op["x-idempotency"]}`).toContain(op["x-idempotency"]);
        expect(typeof op["x-rate-limit-tier"]).toBe("string");
        expect(op.security).toEqual([{ bearerJwt: [] }]);
        expect(Array.isArray(op["x-error-codes"]), "x-error-codes").toBe(true);
        expect(typeof op.summary).toBe("string");
        expect(jsonRef(ctx, id, n.ok), `${id} ${n.ok} schema`).toBe(n.schema);
        for (const c of ["401", "403", "429", "500"]) expect(op.responses?.[c], `${id} ${c}`).toBeDefined();
        if (n.method !== "get" || f!.path.includes("{")) expect(op.responses?.["400"] ?? op.responses?.["422"], `${id} 400/422`).toBeDefined();
        if (n.idem.length === 1 && n.idem[0] === "required") expect(JSON.stringify(op.parameters), `${id} needs the Idempotency-Key parameter`).toContain("IdempotencyKey");
        if (f!.path.includes("{")) expect(op.responses?.["404"], `${id} 404`).toBeDefined();
        for (const c of (op["x-error-codes"] ?? []) as string[]) expect(errorsText, `${id}: error code ${c} must exist in contracts/errors.yaml`).toContain(c);
        const ex = Object.entries<any>(okResp(ctx, id, n.ok)?.content?.["application/json"]?.examples ?? {});
        expect(ex.length, `${id}: example`).toBeGreaterThan(0);
        const v = ctx.ajv.compile({ $ref: `${ctx.name}.yaml#/components/schemas/${n.schema}` });
        for (const [k, e] of ex) expect(v(e.value), `${id}/${k}: ${JSON.stringify(v.errors?.[0])}`).toBe(true);
      });
    }
  });
}

describe("T0C-MSGDESK-1 contract: permissions (done_when 5)", () => {
  const byCode = new Map<string, any>(registry.permissions.map((p: any) => [p.code, p]));
  it.each(Object.entries(PERMS))("%s is in contracts/permissions.yaml with the privileged flag and known roles; tenant_admin holds it", (code, want) => {
    const p = byCode.get(code);
    expect(p, `${code} missing from contracts/permissions.yaml`).toBeDefined();
    expect(p.privileged).toBe(want.privileged);
    const known = new Set(registry.roles.map((r: any) => r.code));
    for (const r of p.roles) expect(known.has(r), `${code} unknown role ${r}`).toBe(true);
    expect(p.roles, `${code} tenant_admin`).toContain("tenant_admin");
    expect(code).toMatch(/^[a-z_]+\.[a-z_]+\.[a-z_]+$/);
  });
  it("the registry grew by exactly the five codes: no engagement or partners code was renamed, removed or added besides them", () => {
    const eng = registry.permissions.filter((p: any) => p.code.startsWith("engagement.")).map((p: any) => p.code);
    const par = registry.permissions.filter((p: any) => p.code.startsWith("partners.")).map((p: any) => p.code);
    sortedEq(eng, [...OLD_ENG_PERMS, "engagement.broadcast.read", "engagement.broadcast.manage", "engagement.broadcast.approve"]);
    sortedEq(par, [...OLD_PARTNER_PERMS, "partners.ticket.read", "partners.ticket.manage"]);
    expect(byCode.get("engagement.enquiry.respond").roles).toEqual(["front_desk"]);
    expect(byCode.get("partners.partner.manage").privileged).toBe(true);
  });
  it("the approve code is the only privileged one of the five and sits on approveBroadcast alone; every operation uses one of the five", () => {
    const used = new Map<string, string[]>();
    for (const [c, ops] of [[E, ENG], [P, PAR]] as [Ctx, Record<string, OpSpec>][]) for (const id of Object.keys(ops)) { const k = opOf(c, id)?.op["x-permission"]; used.set(k, [...(used.get(k) ?? []), id]); }
    sortedEq([...used.keys()], Object.keys(PERMS));
    expect(used.get("engagement.broadcast.approve")).toEqual(["approveBroadcast"]);
    for (const [code, p] of Object.entries(PERMS)) expect(byCode.get(code).privileged, code).toBe(p.privileged);
    expect(opOf(E, "approveBroadcast")!.op["x-error-codes"], "a privileged operation lists the MFA error").toContain("auth.mfa_required");
  });
  it("the staff roles that run the desk hold the read and manage codes; the approver is a different, senior role (not front_desk)", () => {
    expect(byCode.get("engagement.broadcast.manage").roles.length).toBeGreaterThan(0);
    expect(byCode.get("engagement.broadcast.read").roles).toEqual(expect.arrayContaining(byCode.get("engagement.broadcast.manage").roles));
    expect(byCode.get("engagement.broadcast.approve").roles).not.toContain("front_desk");
    expect(byCode.get("partners.ticket.read").roles).toEqual(expect.arrayContaining(byCode.get("partners.ticket.manage").roles));
  });
  it("partner actors (partner_member and partner_admin by inheritance) get ticket read and manage; patients, devices and portal actors get no new code", () => {
    const rawText = readFileSync(join(ROOT, "contracts/permissions.yaml"), "utf8");
    const partner = registry.fixed_actor_permissions.partner;
    const member: string[] = partner.partner_member;
    expect(member).toContain("partners.ticket.read");
    expect(member).toContain("partners.ticket.manage");
    expect(JSON.stringify(partner.partner_admin)).toMatch(/partner_member set/);
    expect(member).not.toContain("engagement.broadcast.read");
    for (const code of Object.keys(PERMS).filter((c) => !c.startsWith("partners.")))
      expect(JSON.stringify([registry.fixed_actor_permissions.patient, registry.fixed_actor_permissions.portal, registry.fixed_actor_permissions.device, member]), code).not.toContain(code);
    expect(rawText).not.toMatch(/partners\.ticket\.(close|reply|create)/);
  });
  it("corp_admin pack holds all five codes, sorted and without duplicates; the pack's other lists never gain them by accident", () => {
    const admin = packs.packs.flatMap((p: any) => p.roles).find((r: any) => r.code === "corp_admin");
    for (const c of Object.keys(PERMS)) expect(admin.permissions, `corp_admin lacks ${c}`).toContain(c);
    expect(new Set(admin.permissions).size).toBe(admin.permissions.length);
    expect(admin.permissions).toEqual([...admin.permissions].sort());
  });
  it("db/seeds/001_core__g_permissions.sql and the generated permission types carry the five codes (codegen is the single source)", () => {
    const seed = readFileSync(join(ROOT, "db/seeds/001_core__g_permissions.sql"), "utf8");
    const gen = readFileSync(join(ROOT, "contracts/ports/generated/permissions.ts"), "utf8");
    for (const [c, p] of Object.entries(PERMS)) {
      expect(seed, `seed ${c}`).toMatch(new RegExp(`\\('${c.replace(/\./g, "\\.")}', '${c.split(".")[0]}', ${p.privileged},`));
      expect(gen, `generated ${c}`).toContain(`"${c}"`);
    }
  });
});

describe("T0C-MSGDESK-1 contract: engagement schemas are closed, no floats, no secret (done_when 2, 6)", () => {
  it("all new engagement schemas exist and are closed objects (BroadcastPlaceholder is an enum)", () => {
    for (const n of NEW_SCHEMAS.engagement) {
      expect(E.S[n], `${n} missing`).toBeDefined();
      if (n === "BroadcastPlaceholder") continue;
      expect(E.S[n].type, n).toBe("object");
      expect(E.S[n].additionalProperties, `${n} must be closed`).toBe(false);
    }
  });
  it("every schema reachable from the new operations and every object inside is closed; none uses type number", () => {
    const names = new Set<string>(NEW_SCHEMAS.engagement);
    for (const id of Object.keys(ENG)) {
      const f = opOf(E, id)!;
      for (const r of Object.values<any>(f.op.responses ?? {})) { const s = r?.content?.["application/json"]?.schema; if (s?.$ref) reach(E, refName(s), names); }
      for (const m of Object.values<any>(f.op.requestBody?.content ?? {})) if (m.schema?.$ref) reach(E, refName(m.schema), names);
    }
    const b = bad(E, [...names].filter((n) => E.S[n]));
    expect(b, b.join(" | ")).toEqual([]);
  });
  it("BroadcastPlaceholder is a closed enum of snake_case names; BroadcastTemplate: name, channel (sms | whatsapp | email), body with the closed placeholder list, active flag, timestamps", () => {
    const ph = enumOf(E.S.BroadcastPlaceholder);
    expect(ph.length, "a closed list of placeholders").toBeGreaterThanOrEqual(2);
    expect(ph.length).toBeLessThanOrEqual(20);
    for (const p of ph) expect(p).toMatch(/^[a-z][a-z_]*$/);
    const s = E.S.BroadcastTemplate;
    for (const f of ["id", "name", "channel", "body", "is_active", "created_at", "updated_at"]) { expect(s.properties?.[f], `BroadcastTemplate.${f}`).toBeDefined(); expect(s.required ?? [], `${f} required`).toContain(f); }
    sortedEq(enumOf(prop(E, "BroadcastTemplate", "channel")), CHANNELS);
    expect(prop(E, "BroadcastTemplate", "is_active").type).toBe("boolean");
    for (const f of ["name", "body"]) { expect(prop(E, "BroadcastTemplate", f).type).toBe("string"); expect(prop(E, "BroadcastTemplate", f).minLength).toBeGreaterThanOrEqual(1); expect(typeof prop(E, "BroadcastTemplate", f).maxLength).toBe("number"); }
    expect(prop(E, "BroadcastTemplate", "placeholders").type, "the placeholders used by the body, derived").toBe("array");
    expect(refName(prop(E, "BroadcastTemplate", "placeholders").items)).toBe("BroadcastPlaceholder");
    const text = textOf(E.S.BroadcastTemplate, E.S.BroadcastTemplateCreate, opOf(E, "createBroadcastTemplate")!.op.description, opOf(E, "createBroadcastTemplate")!.op.summary);
    expect(text, "the closed placeholder rule is written into the contract").toMatch(/closed list/i);
    expect(text).toMatch(/placeholders?/i);
    expect(text, "an unknown placeholder is rejected").toMatch(/unknown placeholder|not in the (closed )?list|rejected/i);
    const v = validator(E, "BroadcastTemplateCreate");
    expect(v({ name: "Eid greeting (SYNTHETIC)", channel: "sms", body: `Dear {{${ph[0]}}}, closed on Friday.` }), JSON.stringify(v.errors?.[0])).toBe(true);
    for (const bad2 of [{ channel: "telegram" }, { name: "" }, { body: "" }, { extra: 1 }, { is_active: "yes" }]) expect(v({ name: "T", channel: "sms", body: "x", ...bad2 }), `accepted ${JSON.stringify(bad2)}`).toBe(false);
    expect(v({ channel: "sms", body: "x" }), "name required").toBe(false);
    const up = validator(E, "BroadcastTemplateUpdate");
    expect(up({ body: "New text" })).toBe(true);
    expect(up({ channel: "fax" })).toBe(false);
    expect(E.S.BroadcastTemplateUpdate.required ?? []).toEqual([]);
  });
  it("BroadcastAudienceFilter is closed: party kinds (laboratory | franchise | client | lab_user), city, priority, active only; nothing else (no free query, no SQL text)", () => {
    const f = E.S.BroadcastAudienceFilter;
    expect(f.additionalProperties).toBe(false);
    sortedEq(Object.keys(f.properties), ["party_kinds", "city", "priority", "active_only"]);
    expect(f.required ?? [], "all four are optional narrowing choices, but at least one party kind is required").toEqual(["party_kinds"]);
    const pk = prop(E, "BroadcastAudienceFilter", "party_kinds");
    expect(pk.type).toBe("array");
    expect(pk.uniqueItems).toBe(true);
    expect(pk.minItems).toBeGreaterThanOrEqual(1);
    sortedEq(enumOf(pk.items?.$ref ? E.S[refName(pk.items)] : pk.items), PARTY_KINDS);
    expect(prop(E, "BroadcastAudienceFilter", "city")).toMatchObject({ type: "string" });
    expect(typeof prop(E, "BroadcastAudienceFilter", "city").maxLength).toBe("number");
    expect(prop(E, "BroadcastAudienceFilter", "active_only").type).toBe("boolean");
    const v = validator(E, "BroadcastAudienceFilter");
    expect(v({ party_kinds: ["franchise", "client"] }), JSON.stringify(v.errors?.[0])).toBe(true);
    expect(v({ party_kinds: PARTY_KINDS, city: "Kathmandu", active_only: true })).toBe(true);
    for (const bad2 of [{ party_kinds: [] }, { party_kinds: ["patient"] }, { party_kinds: ["client", "client"] }, { party_kinds: ["client"], city: 5 }, { party_kinds: ["client"], where: "1=1" }, { party_kinds: ["client"], active_only: "true" }])
      expect(v(bad2), `accepted ${JSON.stringify(bad2)}`).toBe(false);
    expect(v({}), "party_kinds is required").toBe(false);
  });
  it("Broadcast: template, filter, six statuses, recipient and opted out counts (0..5000), requested_by, optional approved_by, version; BroadcastCreate and the preview request take template and filter only", () => {
    const s = E.S.Broadcast;
    for (const f of ["id", "template_id", "audience_filter", "status", "recipient_count", "opted_out_count", "requested_by", "created_at", "updated_at", "version"]) { expect(s.properties?.[f], `Broadcast.${f}`).toBeDefined(); expect(s.required ?? [], `${f} required`).toContain(f); }
    expect(s.properties.approved_by, "approved_by").toBeDefined();
    expect(s.required ?? [], "approved_by is empty until approval").not.toContain("approved_by");
    sortedEq(enumOf(prop(E, "Broadcast", "status")), B_STATUS);
    expect(refName(prop(E, "Broadcast", "audience_filter"))).toBe("BroadcastAudienceFilter");
    expect(prop(E, "Broadcast", "recipient_count")).toMatchObject({ type: "integer", minimum: 0, maximum: 5000 });
    expect(prop(E, "Broadcast", "opted_out_count")).toMatchObject({ type: "integer", minimum: 0 });
    for (const f of ["id", "template_id", "requested_by", "approved_by"]) expect(isUuid(prop(E, "Broadcast", f)), f).toBe(true);
    sortedEq(E.S.BroadcastCreate.required, ["template_id", "audience_filter"]);
    sortedEq(Object.keys(E.S.BroadcastCreate.properties), ["template_id", "audience_filter"]);
    expect(Object.keys(E.S.BroadcastCreate.properties), "status, counts and approver are never client input").not.toEqual(expect.arrayContaining(["status"]));
    sortedEq(E.S.BroadcastAudiencePreviewRequest.required, ["audience_filter"]);
    const v = validator(E, "Broadcast");
    const ok = { id: UUID, template_id: UUID2, audience_filter: { party_kinds: ["client"] }, status: "draft", recipient_count: 12, opted_out_count: 1, requested_by: UUID, created_at: TS, updated_at: TS, version: 1 };
    expect(v(ok), JSON.stringify(v.errors?.[0])).toBe(true);
    for (const bad2 of [{ status: "queued" }, { recipient_count: 5001 }, { recipient_count: -1 }, { opted_out_count: -1 }, { recipient_count: 1.5 }, { requested_by: "me" }, { sent_count: 1 }]) expect(v({ ...ok, ...bad2 }), `accepted ${JSON.stringify(bad2)}`).toBe(false);
    const c = validator(E, "BroadcastCreate");
    expect(c({ template_id: UUID, audience_filter: { party_kinds: ["lab_user"] } })).toBe(true);
    for (const bad2 of [{ status: "approved" }, { recipient_count: 1 }, { approved_by: UUID }, { requested_by: UUID }]) expect(c({ template_id: UUID, audience_filter: { party_kinds: ["lab_user"] }, ...bad2 }), `accepted ${JSON.stringify(bad2)}`).toBe(false);
  });
  it("BroadcastAudiencePreview: counts and a masked sample of at most 20 rows; BroadcastRecipient: party, MASKED channel_address, four statuses, optional outbox_id", () => {
    const s = E.S.BroadcastAudiencePreview;
    for (const f of ["recipient_count", "opted_out_count", "sample"]) { expect(s.properties?.[f], f).toBeDefined(); expect(s.required ?? [], f).toContain(f); }
    expect(prop(E, "BroadcastAudiencePreview", "recipient_count")).toMatchObject({ type: "integer", minimum: 0 });
    expect(prop(E, "BroadcastAudiencePreview", "opted_out_count")).toMatchObject({ type: "integer", minimum: 0 });
    const sample = prop(E, "BroadcastAudiencePreview", "sample");
    expect(sample.type).toBe("array");
    expect(sample.maxItems, "a sample, not the whole audience").toBeLessThanOrEqual(20);
    expect(JSON.stringify(sample), "a sample row is a recipient with a masked address").toMatch(/BroadcastRecipient|channel_address/);
    expect(textOf(s, opOf(E, "previewBroadcastAudience")!.op.description, opOf(E, "previewBroadcastAudience")!.op.summary)).toMatch(/sends? nothing|nothing is sent|does not send|no message is (sent|queued)/i);
    const r = E.S.BroadcastRecipient;
    for (const f of ["id", "broadcast_id", "party_kind", "party_id", "channel_address", "status"]) { expect(r.properties?.[f], `BroadcastRecipient.${f}`).toBeDefined(); expect(r.required ?? [], `${f} required`).toContain(f); }
    expect(r.properties.outbox_id, "outbox_id").toBeDefined();
    expect(r.required ?? []).not.toContain("outbox_id");
    sortedEq(enumOf(prop(E, "BroadcastRecipient", "status")), R_STATUS);
    sortedEq(enumOf(prop(E, "BroadcastRecipient", "party_kind").$ref ? E.S[refName(prop(E, "BroadcastRecipient", "party_kind"))] : prop(E, "BroadcastRecipient", "party_kind")), PARTY_KINDS);
    for (const f of ["id", "broadcast_id", "party_id", "outbox_id"]) expect(isUuid(prop(E, "BroadcastRecipient", f)), f).toBe(true);
    expect(textOf(prop(E, "BroadcastRecipient", "channel_address")), "the schema says the address is masked on read").toMatch(/masked/i);
    const v = validator(E, "BroadcastRecipient");
    const ok = { id: UUID, broadcast_id: UUID2, party_kind: "client", party_id: UUID, channel_address: "98******12", status: "queued" };
    expect(v(ok), JSON.stringify(v.errors?.[0])).toBe(true);
    for (const bad2 of [{ status: "delivered" }, { party_kind: "patient" }, { extra: 1 }]) expect(v({ ...ok, ...bad2 }), `accepted ${JSON.stringify(bad2)}`).toBe(false);
  });
  it("pages follow the {data, page} convention and are bounded", () => {
    for (const [pg, item] of [["BroadcastTemplatePage", "BroadcastTemplate"], ["BroadcastPage", "Broadcast"], ["BroadcastRecipientPage", "BroadcastRecipient"]] as const) {
      sortedEq(E.S[pg].required, ["data", "page"]);
      expect(E.S[pg].properties.data.type).toBe("array");
      expect(typeof E.S[pg].properties.data.maxItems).toBe("number");
      expect(refName(E.S[pg].properties.data.items)).toBe(item);
      expect(JSON.stringify(E.S[pg].properties.page)).toContain("PageInfo");
    }
    const names = (id: string) => (opOf(E, id)!.op.parameters as any[]).map((p) => p.name ?? p.$ref?.split("/").pop());
    for (const id of ["listBroadcastTemplates", "listBroadcasts", "listBroadcastRecipients"]) for (const n of ["Cursor", "Limit"]) expect(names(id), `${id} ${n}`).toContain(n);
    for (const n of ["status"]) expect(names("listBroadcasts")).toContain(n);
    for (const n of ["status"]) expect(names("listBroadcastRecipients")).toContain(n);
  });
});

describe("T0C-MSGDESK-1 contract: broadcast rules are written into the contract text (done_when 4)", () => {
  const all = (): string => textOf(opOf(E, "createBroadcast")?.op, opOf(E, "requestBroadcastApproval")?.op, opOf(E, "approveBroadcast")?.op, opOf(E, "cancelBroadcast")?.op, opOf(E, "previewBroadcastAudience")?.op,
    E.S.Broadcast, E.S.BroadcastRecipient, E.S.BroadcastAudiencePreview, E.S.BroadcastCreate);
  const rule = (name: string, re: RegExp) => it(`rule: ${name}`, () => expect(all(), `contract text must say: ${name}`).toMatch(re));
  rule("sending needs a second person to approve", /second person/i);
  rule("the approver is not the requester", /approver (is|must be|may)[^.]{0,40}not[^.]{0,40}requester|not the requester|different (person )?from the requester|requester (can|may|could) not approve/i);
  rule("recipients who opted out are skipped", /opt(ed)?[- ]?outs?[^.]{0,80}skipp|skipp[^.]{0,80}opt(ed)?[- ]?out/i);
  rule("and counted", /opted_out_count|counted/i);
  rule("refused when no provider is configured", /no (message )?provider[^.]{0,60}configured|provider[^.]{0,40}(is )?not configured|refused[^.]{0,60}provider/i);
  rule("at most 5000 recipients per broadcast", /5000 recipients/i);
  rule("one outbox row per recipient", /one outbox row per recipient/i);
  rule("with an idempotency key", /idempotency key/i);
  rule("a retry never double sends", /never double[- ]?sends?|no double send|never sends? (twice|a message twice)|retry[^.]{0,60}(never|not)[^.]{0,40}(twice|double)/i);
  rule("real sending uses the provider already configured and approved by the founder; this contract only queues through the outbox", /outbox/i);
  it("createBroadcast and previewBroadcastAudience refuse a filter that matches more than 5000 recipients; approveBroadcast lists the self approval and no provider refusals by meaning", () => {
    const code = (id: string, re: RegExp) => ((opOf(E, id)!.op["x-error-codes"] ?? []) as string[]).some((c) => re.test(c));
    expect(code("createBroadcast", /broadcast_(too_many|recipient_limit|limit)|recipient_limit|too_many_recipients/), "createBroadcast: too many recipients").toBe(true);
    expect(code("approveBroadcast", /broadcast_(approver|self|same)|approver_must_differ|self_approv/), "approveBroadcast: approver is the requester").toBe(true);
    expect(code("approveBroadcast", /provider/), "approveBroadcast: no provider configured").toBe(true);
    expect(code("approveBroadcast", /invalid_transition|broadcast_state|not_pending/), "approveBroadcast: wrong state").toBe(true);
    for (const id of ["requestBroadcastApproval", "cancelBroadcast"]) expect(code(id, /invalid_transition|broadcast_state|not_/), `${id}: wrong state`).toBe(true);
    expect(opOf(E, "approveBroadcast")!.op.responses?.["409"] ?? opOf(E, "approveBroadcast")!.op.responses?.["422"], "409 or 422 for the refusals").toBeDefined();
  });
  it("a broadcast moves draft -> pending_approval -> approved -> sending -> sent, or to cancelled before sending; the operation text names the allowed source status", () => {
    expect(textOf(opOf(E, "requestBroadcastApproval")!.op)).toMatch(/draft/i);
    expect(textOf(opOf(E, "approveBroadcast")!.op)).toMatch(/pending_approval/);
    expect(textOf(opOf(E, "cancelBroadcast")!.op)).toMatch(/draft|pending_approval|approved/);
    expect(textOf(opOf(E, "cancelBroadcast")!.op)).toMatch(/sending|sent/i);
  });
});

describe("T0C-MSGDESK-1 contract: partners schemas and ticket rules (done_when 2, 3, 4, 6)", () => {
  it("all new partners schemas exist and are closed objects; every reachable schema is closed; none uses type number", () => {
    for (const n of NEW_SCHEMAS.partners) { expect(P.S[n], `${n} missing`).toBeDefined(); expect(P.S[n].type, n).toBe("object"); expect(P.S[n].additionalProperties, `${n} must be closed`).toBe(false); }
    const names = new Set<string>(NEW_SCHEMAS.partners);
    for (const id of Object.keys(PAR)) {
      const f = opOf(P, id)!;
      for (const r of Object.values<any>(f.op.responses ?? {})) { const s = r?.content?.["application/json"]?.schema; if (s?.$ref) reach(P, refName(s), names); }
      for (const m of Object.values<any>(f.op.requestBody?.content ?? {})) if (m.schema?.$ref) reach(P, refName(m.schema), names);
    }
    const b = bad(P, [...names].filter((n) => P.S[n]));
    expect(b, b.join(" | ")).toEqual([]);
  });
  it("PartnerTicket: party kind and id, subject, status new | replied | closed, created_by, timestamps, version", () => {
    const s = P.S.PartnerTicket;
    for (const f of ["id", "party_kind", "party_id", "subject", "status", "created_by", "created_at", "updated_at", "version"]) { expect(s.properties?.[f], `PartnerTicket.${f}`).toBeDefined(); expect(s.required ?? [], `${f} required`).toContain(f); }
    sortedEq(enumOf(prop(P, "PartnerTicket", "status")), T_STATUS);
    expect(prop(P, "PartnerTicket", "subject")).toMatchObject({ type: "string", minLength: 1 });
    expect(typeof prop(P, "PartnerTicket", "subject").maxLength).toBe("number");
    for (const f of ["id", "party_id", "created_by"]) expect(isUuid(prop(P, "PartnerTicket", f)), f).toBe(true);
    expect(enumOf(prop(P, "PartnerTicket", "party_kind")).length + (prop(P, "PartnerTicket", "party_kind").$ref ? 1 : 0), "party_kind is a closed list").toBeGreaterThan(0);
    const v = validator(P, "PartnerTicket");
    const ok = { id: UUID, party_kind: "partner", party_id: UUID2, subject: "Report delay (SYNTHETIC)", status: "new", created_by: UUID, created_at: TS, updated_at: TS, version: 1 };
    expect(v(ok), JSON.stringify(v.errors?.[0])).toBe(true);
    for (const bad2 of [{ status: "open" }, { subject: "" }, { party_kind: "bogus" }, { extra: 1 }, { party_id: "x" }]) expect(v({ ...ok, ...bad2 }), `accepted ${JSON.stringify(bad2)}`).toBe(false);
  });
  it("PartnerTicketMessage: ticket, sender_kind partner | lab, body, created_by, created_at; PartnerTicketDetail carries the ticket and its messages; create and reply inputs are closed and small", () => {
    const m = P.S.PartnerTicketMessage;
    for (const f of ["id", "ticket_id", "sender_kind", "body", "created_by", "created_at"]) { expect(m.properties?.[f], `PartnerTicketMessage.${f}`).toBeDefined(); expect(m.required ?? [], `${f} required`).toContain(f); }
    sortedEq(enumOf(prop(P, "PartnerTicketMessage", "sender_kind")), ["partner", "lab"]);
    expect(prop(P, "PartnerTicketMessage", "body")).toMatchObject({ type: "string", minLength: 1 });
    expect(typeof prop(P, "PartnerTicketMessage", "body").maxLength).toBe("number");
    const d = P.S.PartnerTicketDetail;
    expect(JSON.stringify(d)).toContain("PartnerTicket");
    expect(d.properties.messages?.type).toBe("array");
    expect(refName(d.properties.messages.items)).toBe("PartnerTicketMessage");
    expect(typeof d.properties.messages.maxItems).toBe("number");
    sortedEq(P.S.PartnerTicketReply.required, ["body"]);
    expect(Object.keys(P.S.PartnerTicketReply.properties), "sender_kind is derived from the actor, never client input").not.toContain("sender_kind");
    sortedEq(P.S.PartnerTicketCreate.required, ["subject", "body"]);
    for (const f of ["party_id", "party_kind", "status", "created_by", "sender_kind"]) expect(Object.keys(P.S.PartnerTicketCreate.properties), `partner create must not carry ${f} (taken from the partner session)`).not.toContain(f);
    expect(P.S.PartnerTicketAdminCreate.required, "lab side names the party").toEqual(expect.arrayContaining(["party_kind", "party_id", "subject", "body"]));
    const c = validator(P, "PartnerTicketCreate");
    expect(c({ subject: "Need sample pickup (SYNTHETIC)", body: "Please call." })).toBe(true);
    for (const bad2 of [{ subject: "" }, { body: "" }, { party_id: UUID }, { status: "closed" }]) expect(c({ subject: "S", body: "B", ...bad2 }), `accepted ${JSON.stringify(bad2)}`).toBe(false);
    const r = validator(P, "PartnerTicketReply");
    expect(r({ body: "Thanks" })).toBe(true);
    expect(r({ body: "Thanks", sender_kind: "lab" })).toBe(false);
    expect(r({ body: "" })).toBe(false);
    const pg = P.S.PartnerTicketPage;
    sortedEq(pg.required, ["data", "page"]);
    expect(refName(pg.properties.data.items)).toBe("PartnerTicket");
    expect(JSON.stringify(pg.properties.page)).toContain("PageInfo");
  });
  it("list parameters: lab side filters status, party_kind, party_id, dates; partner side filters status; both page", () => {
    const names = (id: string) => (opOf(P, id)!.op.parameters as any[]).map((p) => p.name ?? p.$ref?.split("/").pop());
    for (const n of ["status", "Cursor", "Limit"]) { expect(names("listPartnerTickets"), n).toContain(n); expect(names("listMyPartnerTickets"), n).toContain(n); }
    for (const n of ["party_id", "created_from", "created_to"]) expect(names("listPartnerTickets"), `lab list ${n}`).toContain(n);
    const st = (opOf(P, "listPartnerTickets")!.op.parameters as any[]).find((p) => p.name === "status");
    sortedEq(enumOf(st.schema?.$ref ? P.S[refName(st.schema)] : st.schema), T_STATUS);
    expect(names("listMyPartnerTickets"), "own tickets: no party filter (the session decides)").not.toContain("party_id");
  });
  it("ticket rules in the text: staff only /admin/, own tickets only /me/, reply moves new to replied, close and reopen, a closed ticket takes no reply, replies may queue offline", () => {
    for (const id of ["createPartnerTicket", "listPartnerTickets", "getPartnerTicket", "replyPartnerTicket", "closePartnerTicket", "reopenPartnerTicket"]) {
      const f = opOf(P, id)!;
      expect(f.path, id).toContain("/v1/partners/admin/tickets");
      expect(textOf(f.op.summary, f.op.description), `${id}: staff only`).toMatch(/staff|lab side|lab user/i);
    }
    for (const id of ["listMyPartnerTickets", "createMyPartnerTicket", "getMyPartnerTicket", "replyMyPartnerTicket"]) {
      const f = opOf(P, id)!;
      expect(f.path, id).toContain("/v1/partners/me/tickets");
      expect(textOf(f.op.summary, f.op.description), `${id}: own tickets only`).toMatch(/own (partner )?tickets?|own partner|only (the )?(partner'?s? )?own|your own/i);
    }
    for (const id of ["getMyPartnerTicket", "replyMyPartnerTicket"]) expect(opOf(P, id)!.op.responses?.["404"], `${id}: another partner's ticket answers 404, not 403`).toBeDefined();
    expect(textOf(opOf(P, "replyPartnerTicket")!.op), "a lab reply sets replied").toMatch(/replied/);
    expect(textOf(opOf(P, "closePartnerTicket")!.op)).toMatch(/closed/);
    expect(textOf(opOf(P, "reopenPartnerTicket")!.op)).toMatch(/new|replied|reopen/i);
    expect(((opOf(P, "replyMyPartnerTicket")!.op["x-error-codes"] ?? []) as string[]).some((c) => /ticket_(closed|invalid_transition)|invalid_transition/.test(c)), "reply to a closed ticket is refused").toBe(true);
    expect(((opOf(P, "closePartnerTicket")!.op["x-error-codes"] ?? []) as string[]).some((c) => /ticket_(closed|invalid_transition)|invalid_transition/.test(c)), "closing a closed ticket is refused").toBe(true);
    const t = textOf(opOf(P, "replyMyPartnerTicket")!.op, P.S.PartnerTicketReply);
    expect(t, "offline: a reply may be queued on the device and sent later; the Idempotency-Key makes the replay safe").toMatch(/offline|queued/i);
    expect(t).toMatch(/idempotency/i);
  });
});

describe("T0C-MSGDESK-1 generated clients (codegen is fresh)", () => {
  it("generated clients, MSW handlers, route and permission types are fresh (codegen --check)", () => {
    expect(staleFiles(ROOT)).toEqual([]);
  }, 120_000);
});

describe("T0C-MSGDESK-1 migration file (static; behaviour in the pgTAP suite) (done_when 2, 7)", () => {
  const path = join(ROOT, "db/migrations", MIG);
  const text = existsSync(path) ? readFileSync(path, "utf8").replace(/\r\n/g, "\n") : "";
  const code = text.split("\n").filter((l) => !/^\s*--/.test(l)).map((l) => l.replace(/--.*$/, "")).join("\n");
  const comments = text.split("\n").filter((l) => /^\s*--/.test(l)).join("\n");
  const TABLES: [string, string][] = [["engagement", "broadcast_template"], ["engagement", "broadcast"], ["engagement", "broadcast_recipient"], ["partners", "partner_ticket"], ["partners", "partner_ticket_message"]];

  it("exists, is the only 20261117240000 migration, is newer than the PRICETOOLS migration, runs as lims_owner", () => {
    expect(existsSync(path), `db/migrations/${MIG} missing`).toBe(true);
    const all = readdirSync(join(ROOT, "db/migrations")).filter((f) => f.endsWith(".sql")).sort();
    expect(all.filter((f) => f.startsWith("20261117240000"))).toEqual([MIG]);
    expect(all.indexOf(MIG)).toBeGreaterThan(all.indexOf("20261117200000_catalog__add_price_list_tools.sql"));
    expect(code).toMatch(/SET LOCAL ROLE lims_owner/);
  });
  it("creates the five tables with IF NOT EXISTS, tenant_id, created_at, RLS enabled and forced, tenant policies guarded by pg_policy", () => {
    for (const [s, t] of TABLES) {
      expect(code, `${s}.${t}`).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${s}\\.${t}\\b`, "i"));
      expect(code, `${t} ENABLE RLS`).toMatch(new RegExp(`ALTER TABLE ${s}\\.${t}\\s+ENABLE ROW LEVEL SECURITY`, "i"));
      expect(code, `${t} FORCE RLS`).toMatch(new RegExp(`ALTER TABLE ${s}\\.${t}\\s+FORCE ROW LEVEL SECURITY`, "i"));
      expect(code, `${t} tenant select policy`).toMatch(new RegExp(`CREATE POLICY ${t}__select__\\w*tenant\\w* ON ${s}\\.${t} FOR SELECT`, "i"));
      const block = code.slice(code.search(new RegExp(`CREATE TABLE IF NOT EXISTS ${s}\\.${t}\\b`, "i")));
      expect(block.slice(0, 2600), `${t} has tenant_id`).toMatch(/tenant_id\s+uuid\s+NOT NULL/i);
      expect(block.slice(0, 2600), `${t} has created_at`).toMatch(/created_at\s+timestamptz\s+NOT NULL DEFAULT now\(\)/i);
      expect(block.slice(0, 2600), `${t} has created_by`).toMatch(/created_by\s+uuid\s+NOT NULL/i);
    }
    for (const t of ["broadcast_template", "broadcast", "partner_ticket"]) expect(code.slice(code.search(new RegExp(`CREATE TABLE IF NOT EXISTS \\w+\\.${t}\\b`, "i")))
      .slice(0, 2600), `${t} has updated_at`).toMatch(/updated_at\s+timestamptz\s+NOT NULL DEFAULT now\(\)/i);
    expect((code.match(/CREATE TABLE(?! IF NOT EXISTS)/gi) ?? []).length, "every CREATE TABLE is IF NOT EXISTS").toBe(0);
    for (const m of code.matchAll(/CREATE POLICY (\w+)/gi)) expect(code, `policy ${m[1]} must be guarded by pg_policy`).toMatch(new RegExp(`pg_policy[^;]*${m[1]}`, "i"));
    expect(code).not.toMatch(/GRANT[^;]*\bDELETE\b/i);
    expect(code, "history is never deleted: no DELETE policy").not.toMatch(/FOR DELETE/i);
    expect(code).toMatch(/GRANT SELECT, INSERT, UPDATE ON engagement\.broadcast TO lims_app/i);
    expect(code, "recipient rows move queued -> sent/failed/skipped").toMatch(/GRANT SELECT, INSERT, UPDATE ON engagement\.broadcast_recipient TO lims_app/i);
    expect(code, "ticket messages are append only").toMatch(/GRANT SELECT, INSERT ON partners\.partner_ticket_message TO lims_app/i);
    expect(code).not.toMatch(/partner_ticket_message__update/i);
  });
  it("partner actors reach only their own tickets: partner policies on partner_ticket and partner_ticket_message use app.current_partner_id(); staff policies are user or system only", () => {
    expect(code).toMatch(/partner_ticket[\s\S]{0,400}app\.current_partner_id\(\)/i);
    expect(code).toMatch(/partner_ticket_message[\s\S]{0,600}app\.current_partner_id\(\)/i);
    expect(code).toMatch(/current_actor_type\(\)\)?\s*=\s*'partner'/i);
    expect(code).toMatch(/current_actor_type\(\)\)?\s+IN\s+\('user',\s*'system'\)/i);
    expect(code, "broadcast tables are staff only: no partner or patient policy").not.toMatch(/ON engagement\.broadcast\w* FOR \w+ TO lims_app[\s\S]{0,300}'(partner|patient)'/i);
  });
  it("is additive and idempotent: no data statement, no drop, no type change, no policy change on existing tables, guarded ADD CONSTRAINT", () => {
    expect(code.length, "migration missing or empty").toBeGreaterThan(0);
    expect(code).not.toMatch(/\b(TRUNCATE|DELETE\s+FROM|INSERT\s+INTO|UPDATE\s+\S+\s+SET|REVOKE|DROP\s+\w+|ALTER\s+COLUMN)\b/i);
    expect(code).not.toMatch(/ALTER\s+TABLE\s+\S+\s+(RENAME|OWNER)/i);
    expect(code).not.toMatch(/DISABLE\s+ROW|NO\s+FORCE|ALTER\s+POLICY|\bCREATE\s+TYPE\b|\bAS\s+ENUM\b/i);
    for (const m of code.matchAll(/CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF NOT EXISTS)/gi)) throw new Error(`unguarded CREATE INDEX near ${m.index}`);
    for (const m of code.matchAll(/ADD\s+CONSTRAINT/gi)) expect(code.slice(Math.max(0, m.index! - 1500), m.index), "ADD CONSTRAINT must sit in a DO block that checks pg_constraint first").toMatch(/DO\s+\$[a-z_]*\$[\s\S]*pg_constraint/i);
    expect(code).not.toMatch(/CREATE (OR REPLACE )?FUNCTION[\s\S]{0,400}SECURITY DEFINER(?![\s\S]{0,200}search_path\s*=\s*'')/i);
  });
  it("value checks: channel, broadcast status, recipient status, party kind, ticket status, sender kind, name and body not empty, recipient_count 0..5000, one recipient per party per broadcast, one outbox row per recipient", () => {
    for (const v of [...CHANNELS, ...B_STATUS, ...R_STATUS, ...T_STATUS, ...PARTY_KINDS, "partner", "lab"]) expect(code, `a check names ${v}`).toContain(`'${v}'`);
    expect(code).toMatch(/recipient_count\s+BETWEEN\s+0\s+AND\s+5000|recipient_count\s*>=\s*0[\s\S]{0,60}recipient_count\s*<=\s*5000/i);
    expect(code).toMatch(/opted_out_count\s*>=\s*0|opted_out_count\s+BETWEEN\s+0/i);
    expect(code, "approver differs from requester, enforced in the table too").toMatch(/approved_by\s*<>\s*requested_by|approved_by\s+IS\s+DISTINCT\s+FROM\s+requested_by|requested_by\s*<>\s*approved_by/i);
    expect(code, "composite tenant FKs").toMatch(/FOREIGN KEY \(tenant_id, template_id\) REFERENCES engagement\.broadcast_template \(tenant_id, id\)/i);
    expect(code).toMatch(/FOREIGN KEY \(tenant_id, broadcast_id\) REFERENCES engagement\.broadcast \(tenant_id, id\)/i);
    expect(code).toMatch(/FOREIGN KEY \(tenant_id, ticket_id\) REFERENCES partners\.partner_ticket \(tenant_id, id\)/i);
    expect(code, "a party appears once per broadcast").toMatch(/UNIQUE\s*\(\s*tenant_id,\s*broadcast_id,\s*party_kind,\s*party_id\s*\)|UNIQUE INDEX[^;]*broadcast_recipient[^;]*\(tenant_id,\s*broadcast_id,\s*party_kind,\s*party_id\)/i);
    expect(code, "one outbox row per recipient: outbox_id is unique when set").toMatch(/UNIQUE[^;]*outbox_id|outbox_id[^;]*UNIQUE/i);
  });
  it("comments: LD-321, down note, no data rewrite, push-cloud, every table named", () => {
    expect(comments).toMatch(/LD-321/);
    expect(comments).toMatch(/\bdown\b/i);
    expect(comments).toMatch(/DROP TABLE/i);
    expect(comments).toMatch(/no data rewrite|does not rewrite|no rewrite|additive/i);
    expect(comments).toMatch(/push-cloud/i);
    for (const [, t] of TABLES) expect(comments, `comments name ${t}`).toContain(t);
  });
  it("db/meta/tables.yaml registers the five tables; db/policies/engagement.sql and db/policies/partners.sql carry their policies", () => {
    const meta = readFileSync(join(ROOT, "db/meta/tables.yaml"), "utf8");
    for (const [s, t] of TABLES) expect(meta, `${s}.${t}`).toContain(`"${s}.${t}"`);
    const eng = readFileSync(join(ROOT, "db/policies/engagement.sql"), "utf8");
    const par = readFileSync(join(ROOT, "db/policies/partners.sql"), "utf8");
    for (const t of ["broadcast_template", "broadcast", "broadcast_recipient"]) expect(eng, t).toMatch(new RegExp(`${t}__select__\\w*tenant`));
    for (const t of ["partner_ticket", "partner_ticket_message"]) expect(par, t).toMatch(new RegExp(`${t}__select__\\w*`));
    expect(par).toMatch(/partner_ticket__select__partner/);
  });
});

describe("T0C-MSGDESK-1 implementation notes: FIELD MAP, permissions, offline rule, founder steps (done_when 1, 7)", () => {
  const t = existsSync(NOTES) ? readFileSync(NOTES, "utf8") : "";
  const lines = t.split("\n");
  const decisionLine = (label: string) => lines.find((x) => {
    const s = x.replace(/^[\s|*\-•>`_#]+/, "").toLowerCase();
    const l = label.toLowerCase();
    if (!s.startsWith(l)) return false;
    const rest = s.slice(l.length).replace(/^[*`_\s]+/, "");
    return (rest === "" || /^[—–\-:|=(]/.test(rest)) && /already present|added|not added|deliberately not/i.test(x);
  });
  it("notes exist, name the migration, say the cloud migration is a founder step (push-cloud), list the 21 pending operation ids, the T0B task, LD-321", () => {
    expect(existsSync(NOTES), ".orchestra/notes/T0C-MSGDESK-1-impl.md missing").toBe(true);
    expect(t).toContain(MIG);
    expect(t).toMatch(/push-cloud/i);
    expect(t).toMatch(/founder/i);
    expect(t).toMatch(/pendingOperations/);
    for (const id of [...Object.keys(ENG), ...Object.keys(PAR)]) expect(t, id).toContain(id);
    expect(t).toMatch(/T0B-MSGDESK-1/);
    expect(t).toMatch(/LD-321/);
    expect(t).toMatch(/LD-325/);
  });
  it("every ElabAssist label of Messages and Message To Laboratory has one decision line: already present (field named), added (field named) or not added (reason)", () => {
    expect(t.length, "impl notes missing").toBeGreaterThan(0);
    const missing = LABELS.filter((l) => !decisionLine(l));
    expect(missing, `labels without a decision line: ${missing.join(" | ")}`).toEqual([]);
  });
  it("'not added' decisions carry a reason", () => {
    const badLines = lines.filter((x) => /deliberately not added|not added/i.test(x) && !/because|reason|why|\bsince\b|—|: .{12,}/i.test(x));
    expect(badLines, `not-added lines without a reason: ${badLines.slice(0, 3).join(" || ")}`).toEqual([]);
  });
  it("lists every new permission code (5) and says the approve code is privileged; names the corp_admin pack and the role pack re-apply as a founder step", () => {
    for (const c of Object.keys(PERMS)) expect(t, c).toContain(c);
    expect(t).toMatch(/engagement\.broadcast\.approve[^\n]*privileged|privileged[^\n]*engagement\.broadcast\.approve/i);
    expect(t).toMatch(/corp_admin/);
    expect(t).toMatch(/re-?apply[^\n]*role pack|role pack[^\n]*re-?apply/i);
  });
  it("gives the offline classification (founder 09:19): a ticket reply may be queued offline; broadcasts and approvals are online only", () => {
    expect(t).toMatch(/09:19/);
    expect(t).toMatch(/offline/i);
    expect(t).toMatch(/online only|online-only/i);
    expect(t).toMatch(/(ticket )?repl(y|ies)[^\n]*(queued|queue)[^\n]*offline|offline[^\n]*(ticket )?repl(y|ies)[^\n]*queued|queued offline/i);
    for (const w of ["broadcast", "approval"]) expect(t.toLowerCase(), `offline note names ${w}`).toContain(w);
  });
  it("records what stays with the founder: a provider must be configured and approved before any send, no real sending in this task, no service or web change, rs-c2 untouched", () => {
    expect(t).toMatch(/provider[^\n]*(configured|approved)|(configured|approved)[^\n]*provider/i);
    expect(t).toMatch(/no (service|handler)/i);
    expect(t).toMatch(/outbox/i);
    expect(t).toMatch(/apps\/web\/src\/features\/admin|rs-c2/i);
  });
});
