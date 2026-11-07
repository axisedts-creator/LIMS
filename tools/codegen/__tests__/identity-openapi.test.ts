// T0C-10.C2 / AC-0C-1.4, AC-0C-1.5 — contracts/openapi/identity.yaml (C2 transcription of 02-TRD §5).
// Source of truth: spec/chunks/C2-identity-admin/02-TRD.md §5.1–§5.10 (operationId, method, path, permission, idem, tier)
// and §5 conventions (x-context, x-edge-exposure, tier default `general`).
// Checks: (1) file exists, openapi 3.0.3 first; (2) repo lint (T0C-04 lintRepo) is clean for identity.yaml;
// (3) AC-0C-1.5 negative: bad x-permission / error code in a copy of identity.yaml fails lint;
// (4) inventory = TRD table, no more, no less; (5) per-operation extensions; (6) "Prism smoke" offline: every JSON
// example validates against its schema (what Prism serves/validates) and each operation has a 2xx example (or is 204/CSV).
// Not testable here: Prism actually serving the file (prism not installed; mock wiring is T0C-08's mocks.test.ts).
// Assumption (TRD silent): `revokePlatformSession` idem is "none" in the TRD row but it is a POST action (convention says
// `optional`); its idem is NOT pinned here — lint then requires an `E4 ` justification (LD-10) if it stays `none`.
// LD-10 / LD-11 (lead decisions 2026-11-07, binding): P-8 gains exemptions E3 (read-only POST) and E4 (pre-auth/session op,
// not replayable); lint rule 7 exempts `tenant_id` in request bodies of `x-context: platform` operations only.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv-draft-04";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { lintRepo } from "../lint-openapi";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const FILE = join(ROOT, "contracts/openapi/identity.yaml");
const PFX = "/v1/identity";
const TRD = join(ROOT, "spec/chunks/C2-identity-admin/02-TRD.md");

// id  METHOD  path  permission|public  idem(-=unpinned)  tier
const TABLE = `
loginStaff POST /auth/login public none login
verifyMfaChallenge POST /auth/mfa/verify public none login
startMfaEnrolment POST /auth/mfa/enrolment public none login
completeMfaEnrolment POST /auth/mfa/enrolment/{factor_id}/verify public none login
resolveSession POST /auth/session/resolve public none general
logoutSession POST /auth/logout public none general
requestPasswordRecovery POST /auth/password/recover public none login
confirmEmailToken POST /auth/token/confirm public none login
setPasswordFromSetup POST /auth/password/set public none login
loginPartner POST /auth/partner/login public none login
resolvePatientSession POST /auth/patient/session/resolve public none general
logoutPatientSession POST /auth/patient/session/logout public none general
openMobileSession POST /mobile/sessions public none login
refreshMobileSession POST /mobile/sessions/refresh public none general
logoutMobileSession POST /mobile/sessions/logout public none general
getMe GET /me identity.self.manage none general
changeOwnPassword POST /me/password identity.self.manage none login
listOwnSessions GET /me/sessions identity.self.manage none general
revokeOwnSession POST /me/sessions/{session_id}/revoke identity.self.manage optional general
listOwnMfaFactors GET /me/mfa-factors identity.self.manage none general
removeOwnMfaFactor POST /me/mfa-factors/{factor_id}/remove identity.self.manage optional general
listUsers GET /users identity.user.read none general
searchUsers POST /users/search identity.user.read none general
inviteUser POST /users identity.user.manage required general
getUser GET /users/{membership_id} identity.user.read none general
updateUser PATCH /users/{membership_id} identity.user.manage optional general
setUserRoles PUT /users/{membership_id}/roles identity.role.manage optional general
setUserCentreScope PUT /users/{membership_id}/centre-scope identity.user.manage optional general
lockUser POST /users/{membership_id}/lock identity.user.manage optional general
unlockUser POST /users/{membership_id}/unlock identity.user.manage optional general
deactivateUser POST /users/{membership_id}/deactivate identity.user.manage optional general
reactivateUser POST /users/{membership_id}/reactivate identity.user.manage optional general
resendInvitation POST /users/{membership_id}/resend-invitation identity.user.manage optional general
resetUserMfa POST /users/{membership_id}/reset-mfa identity.user.manage optional general
revokeUserSessions POST /users/{membership_id}/revoke-sessions identity.session.revoke optional general
uploadUserSignature POST /users/{membership_id}/signature identity.user.manage required general
listPermissions GET /permissions identity.user.read none general
listRoles GET /roles identity.user.read none general
createRole POST /roles identity.role.manage required general
getRole GET /roles/{role_id} identity.user.read none general
updateRole PUT /roles/{role_id} identity.role.manage optional general
deactivateRole POST /roles/{role_id}/deactivate identity.role.manage optional general
listBranches GET /branches identity.user.read none general
createBranch POST /branches identity.centre.manage required general
updateBranch PATCH /branches/{branch_id} identity.centre.manage optional general
deactivateBranch POST /branches/{branch_id}/deactivate identity.centre.manage optional general
reactivateBranch POST /branches/{branch_id}/reactivate identity.centre.manage optional general
listCentres GET /centres identity.centre.read none general
createCentre POST /centres identity.centre.manage required general
updateCentre PATCH /centres/{centre_id} identity.centre.manage optional general
deactivateCentre POST /centres/{centre_id}/deactivate identity.centre.manage optional general
reactivateCentre POST /centres/{centre_id}/reactivate identity.centre.manage optional general
getSettings GET /settings identity.settings.manage none general
updateSettings PATCH /settings identity.settings.manage optional general
uploadBrandingAsset POST /settings/branding-assets identity.settings.manage required general
getBrandingAssetContent GET /settings/branding-assets/{asset_id}/content identity.settings.manage none general
listFeatureFlags GET /feature-flags identity.settings.manage none general
setTenantFeatureFlag PUT /feature-flags/{flag_code} identity.settings.manage optional general
listOwnIrdAnnexes GET /ird-annexes identity.settings.manage none general
listSessions GET /sessions identity.session.revoke none general
revokeSession POST /sessions/{session_id}/revoke identity.session.revoke optional general
listTenantSupportSessions GET /support-sessions audit.log.read none general
approveSupportSession POST /support-sessions/{support_session_id}/approve identity.settings.manage optional general
denySupportSession POST /support-sessions/{support_session_id}/deny identity.settings.manage optional general
revokeSupportSession POST /support-sessions/{support_session_id}/revoke identity.settings.manage optional general
listAuditEntries GET /audit-entries audit.log.read none general
getAuditEntry GET /audit-entries/{audit_id} audit.log.read none general
listAccessLogEntries GET /access-log-entries audit.log.read none general
listAuthEvents GET /auth-events audit.log.read none general
createAuditExport POST /audit-exports audit.log.export required general
listAuditExports GET /audit-exports audit.log.export none general
getAuditExport GET /audit-exports/{export_id} audit.log.export none general
downloadAuditExport GET /audit-exports/{export_id}/file audit.log.export none general
listAdminNotices GET /notices identity.user.read none general
dismissAdminNotice POST /notices/{notice_id}/dismiss identity.user.read optional general
listAccessReviews GET /access-reviews identity.user.read none general
recordAccessReview POST /access-reviews identity.user.manage required general
listTenants GET /platform/tenants platform.tenant.read none general
provisionTenant POST /platform/tenants platform.tenant.manage required general
getTenant GET /platform/tenants/{tenant_id} platform.tenant.read none general
updateTenant PATCH /platform/tenants/{tenant_id} platform.tenant.manage optional general
activateTenant POST /platform/tenants/{tenant_id}/activate platform.tenant.manage optional general
suspendTenant POST /platform/tenants/{tenant_id}/suspend platform.tenant.manage optional general
reactivateTenant POST /platform/tenants/{tenant_id}/reactivate platform.tenant.manage optional general
terminateTenant POST /platform/tenants/{tenant_id}/terminate platform.tenant.manage optional general
getTenantSettingsAsPlatform GET /platform/tenants/{tenant_id}/settings platform.tenant.read none general
updateTenantSettingsAsPlatform PATCH /platform/tenants/{tenant_id}/settings platform.tenant.manage optional general
setFeatureFlagAsPlatform PUT /platform/tenants/{tenant_id}/feature-flags/{flag_code} platform.tenant.manage optional general
inviteTenantAdmin POST /platform/tenants/{tenant_id}/admin-invitations platform.tenant.manage required general
listPlatformIrdAnnexes GET /platform/ird-annexes platform.tenant.read none general
createPlatformIrdAnnex POST /platform/ird-annexes platform.tenant.manage required general
updateIrdAnnex PATCH /platform/ird-annexes/{record_id} platform.tenant.manage optional general
transitionIrdAnnex POST /platform/ird-annexes/{record_id}/transition platform.tenant.manage optional general
uploadIrdAnnexDocument POST /platform/ird-annexes/{record_id}/documents platform.tenant.manage required general
downloadIrdAnnexDocument GET /platform/ird-annexes/{record_id}/documents/{document_id}/content platform.tenant.read none general
openSupportSession POST /platform/support-sessions platform.support_session.open required general
activateSupportSession POST /platform/support-sessions/{support_session_id}/activate platform.support_session.open optional general
endSupportSession POST /platform/support-sessions/{support_session_id}/end platform.support_session.open optional general
listPlatformSupportSessions GET /platform/support-sessions platform.tenant.read none general
listDeadLetters GET /platform/dead-letters platform.dead_letter.manage none general
getDeadLetter GET /platform/dead-letters/{dead_letter_id} platform.dead_letter.manage none general
replayDeadLetter POST /platform/dead-letters/{dead_letter_id}/replay platform.dead_letter.manage optional general
discardDeadLetter POST /platform/dead-letters/{dead_letter_id}/discard platform.dead_letter.manage optional general
listPlatformStaff GET /platform/staff platform.staff.manage none general
invitePlatformStaff POST /platform/staff platform.staff.manage required general
updatePlatformStaff PATCH /platform/staff/{platform_staff_id} platform.staff.manage optional general
deactivatePlatformStaff POST /platform/staff/{platform_staff_id}/deactivate platform.staff.manage optional general
resetPlatformStaffMfa POST /platform/staff/{platform_staff_id}/reset-mfa platform.staff.manage optional general
listPlatformSessions GET /platform/sessions platform.staff.manage none general
revokePlatformSession POST /platform/sessions/{session_id}/revoke platform.staff.manage - general
listPlatformAuthEvents GET /platform/auth-events platform.tenant.read none general
`;
type Row = { id: string; method: string; path: string; perm: string; idem: string; tier: string };
const ROWS: Row[] = TABLE.trim().split("\n").map((l) => {
  const [id, method, path, perm, idem, tier] = l.trim().split(/\s+/);
  return { id, method, path: PFX + path, perm, idem, tier };
});

// Error codes the TRD names per operation ("Errors (beyond common)" column); must appear in x-error-codes.
const ERRORS: Record<string, string[]> = {
  loginStaff: ["auth.login_failed", "auth.step_up_required", "auth.account_locked", "identity.membership_inactive", "identity.tenant_suspended"],
  loginPartner: ["auth.login_failed"],
  verifyMfaChallenge: ["auth.mfa_invalid", "common.version_conflict"],
  completeMfaEnrolment: ["auth.mfa_invalid"],
  confirmEmailToken: ["auth.reset_token_invalid", "auth.invite_invalid"],
  setPasswordFromSetup: ["auth.password_policy_violation", "auth.password_breached"],
  refreshMobileSession: ["auth.session_expired"],
  resolvePatientSession: ["auth.session_expired"],
  openMobileSession: ["auth.login_failed", "auth.forbidden"],
  inviteUser: ["identity.user_exists", "identity.role_unknown", "identity.centre_inactive"],
  setUserRoles: ["identity.role_unknown", "identity.last_admin_protected"],
  setUserCentreScope: ["identity.centre_inactive"],
  lockUser: ["identity.last_admin_protected", "identity.self_action_forbidden"],
  deactivateUser: ["identity.last_admin_protected", "identity.self_action_forbidden"],
  resendInvitation: ["common.version_conflict"],
  resetUserMfa: ["identity.self_action_forbidden"],
  uploadUserSignature: ["common.payload_too_large", "common.unsupported_media_type", "common.upload_quarantined"],
  createRole: ["identity.code_duplicate"],
  updateRole: ["identity.last_admin_protected"],
  deactivateRole: ["identity.last_admin_protected", "common.version_conflict"],
  createBranch: ["identity.code_duplicate"],
  deactivateBranch: ["identity.centre_inactive"],
  createCentre: ["identity.code_duplicate", "identity.centre_inactive"],
  updateSettings: ["identity.setting_out_of_range", "auth.forbidden"],
  uploadBrandingAsset: ["common.payload_too_large", "common.unsupported_media_type", "common.upload_quarantined"],
  getBrandingAssetContent: ["common.upload_quarantined"],
  setTenantFeatureFlag: ["auth.forbidden"],
  revokeSession: ["identity.self_action_forbidden"],
  createAuditExport: ["identity.export_too_large", "common.rate_limited"],
  provisionTenant: ["identity.code_duplicate", "identity.setting_out_of_range"],
  activateTenant: ["identity.tenant_not_ready"],
  updateTenantSettingsAsPlatform: ["identity.setting_out_of_range"],
  inviteTenantAdmin: ["identity.user_exists"],
  transitionIrdAnnex: ["identity.annex_invalid_transition"],
  uploadIrdAnnexDocument: ["common.payload_too_large", "common.unsupported_media_type", "common.upload_quarantined"],
  downloadIrdAnnexDocument: ["common.upload_quarantined"],
  openSupportSession: ["auth.forbidden", "identity.tenant_suspended"],
  activateSupportSession: ["common.version_conflict"],
  listDeadLetters: ["common.validation_failed"],
  replayDeadLetter: ["common.version_conflict"],
  discardDeadLetter: ["common.version_conflict"],
  invitePlatformStaff: ["identity.user_exists"],
  updatePlatformStaff: ["identity.last_admin_protected"],
  deactivatePlatformStaff: ["identity.last_admin_protected", "identity.self_action_forbidden"],
  resetPlatformStaffMfa: ["identity.self_action_forbidden"],
  revokePlatformSession: ["identity.self_action_forbidden"],
};

const EDGE_PUBLIC = ["resolvePatientSession", "logoutPatientSession", "openMobileSession", "refreshMobileSession", "logoutMobileSession"];
const BFF_SESSION = ["verifyMfaChallenge", "startMfaEnrolment", "completeMfaEnrolment", "resolveSession", "logoutSession", "setPasswordFromSetup"];
const NO_SECURITY = ["loginStaff", "loginPartner", "requestPasswordRecovery", "confirmEmailToken"];
const UPLOADS = ["uploadUserSignature", "uploadBrandingAsset", "uploadIrdAnnexDocument"];
// cursor-paginated lists (TRD §5 conventions: cursor, limit ≤ 200, default 50)
const PAGED = ["listUsers", "listOwnSessions", "listSessions", "listAuditEntries", "listAccessLogEntries", "listAuthEvents", "listTenants",
  "listAuditExports", "listPlatformSupportSessions", "listPlatformAuthEvents"];

const text = existsSync(FILE) ? readFileSync(FILE, "utf8") : "";
const doc: any = text ? parse(text) : { paths: {}, components: {} };
const METHODS = ["get", "put", "post", "delete", "patch"];
const ops: Record<string, { method: string; path: string; op: any }> = {};
for (const [path, item] of Object.entries<any>(doc.paths ?? {}))
  for (const m of METHODS) if (item?.[m]) ops[item[m].operationId] = { method: m.toUpperCase(), path, op: item[m] };

const tmps: string[] = [];
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("identity.yaml exists and is OAS 3.0.3 (AC-0C-1.4)", () => {
  it("file exists", () => expect(existsSync(FILE), "contracts/openapi/identity.yaml missing").toBe(true));
  it("first non-comment line is `openapi: 3.0.3`", () => {
    const first = text.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith("#"));
    expect(first?.trim()).toBe("openapi: 3.0.3");
  });
  it("info.title and version present", () => {
    expect(typeof doc.info?.title).toBe("string");
    expect(typeof doc.info?.version).toBe("string");
  });
});

describe("repo spec lint is green for identity.yaml (AC-0C-1.4, rules 1–8, AB-20)", () => {
  it("lintRepo reports no violation in identity.yaml", async () => {
    expect(existsSync(FILE)).toBe(true);
    const v = (await lintRepo(ROOT)).filter((x) => x.file === "identity");
    expect(v, v.map((x) => `[rule ${x.rule}] ${x.message}`).join("\n")).toEqual([]);
  });
});

describe("lint actually checks identity.yaml (AC-0C-1.5 negative)", () => {
  // copy contracts/ into a temp root, mutate identity.yaml there, run lintRepo on it
  const mutate = async (fn: (d: any) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "c2-lint-"));
    tmps.push(dir);
    cpSync(join(ROOT, "contracts"), join(dir, "contracts"), { recursive: true, filter: (s) => !s.includes("node_modules") });
    const d = parse(readFileSync(FILE, "utf8"));
    fn(d);
    writeFileSync(join(dir, "contracts/openapi/identity.yaml"), stringify(d, { aliasDuplicateObjects: false }));
    return (await lintRepo(dir)).filter((x) => x.file === "identity");
  };
  const firstOp = (d: any, pred: (o: any) => boolean) =>
    Object.values<any>(d.paths).flatMap((p) => METHODS.map((m) => p[m]).filter(Boolean)).find(pred);

  it("x-permission not in permissions.yaml fails", async () => {
    const v = await mutate((d) => { firstOp(d, (o) => "x-permission" in o)["x-permission"] = "identity.no_such.permission"; });
    expect(v.some((x) => x.rule === "4" && /x-permission/.test(x.message))).toBe(true);
  });
  it("x-error-codes entry not in errors.yaml fails", async () => {
    const v = await mutate((d) => { firstOp(d, (o) => Array.isArray(o["x-error-codes"]))["x-error-codes"].push("identity.no_such_error"); });
    expect(v.some((x) => x.rule === "4" && /error code/.test(x.message))).toBe(true);
  });
  it("object schema without additionalProperties:false fails", async () => {
    const v = await mutate((d) => {
      const s = Object.values<any>(d.components?.schemas ?? {}).find((x) => x?.type === "object" && x.additionalProperties === false);
      delete s.additionalProperties;
    });
    expect(v.some((x) => x.rule === "3")).toBe(true);
  });
  it("operation without x-rate-limit-tier fails", async () => {
    const v = await mutate((d) => { delete firstOp(d, (o) => "x-rate-limit-tier" in o)["x-rate-limit-tier"]; });
    expect(v.some((x) => x.rule === "4" && /x-rate-limit-tier/.test(x.message))).toBe(true);
  });
});

describe("inventory equals 02-TRD §5 (no missing, no extra operations)", () => {
  it("every §5 operationId in the TRD is in identity.yaml and vice versa", () => {
    const lines = readFileSync(TRD, "utf8").split("\n");
    const start = lines.findIndex((l) => l.startsWith("## 5. Endpoints"));
    const end = lines.findIndex((l, i) => i > start && l.startsWith("## 6."));
    const fromTrd = new Set<string>();
    for (const l of lines.slice(start, end))
      if (l.startsWith("| `")) for (const m of l.split("|")[1].matchAll(/`([a-z][A-Za-z0-9]+)`/g)) fromTrd.add(m[1]);
    expect(fromTrd.size).toBeGreaterThan(100);
    expect(ROWS.map((r) => r.id).sort(), "test table drifted from TRD").toEqual([...fromTrd].sort());
    expect(Object.keys(ops).sort()).toEqual([...fromTrd].sort());
  });
});

describe.each(ROWS)("$id", (r) => {
  const o = ops[r.id]?.op;
  it("exists at the TRD method + path", () => {
    expect(ops[r.id], `${r.id} missing`).toBeDefined();
    expect(`${ops[r.id].method} ${ops[r.id].path}`).toBe(`${r.method} ${r.path}`);
  });
  it("has tags [identity], summary, x-idempotency, x-rate-limit-tier, x-error-codes", () => {
    expect(o.tags).toEqual(["identity"]);
    expect(typeof o.summary).toBe("string");
    expect(Array.isArray(o["x-error-codes"])).toBe(true);
    expect(o["x-rate-limit-tier"]).toBe(r.tier);
    if (r.idem !== "-") expect(o["x-idempotency"]).toBe(r.idem);
  });
  it(r.perm === "public" ? "is x-public (justified), no x-permission" : `x-permission = ${r.perm}, no x-public`, () => {
    if (r.perm === "public") {
      expect(typeof o["x-public"]).toBe("string");
      expect(o["x-public"].trim().length).toBeGreaterThan(0);
      expect(o["x-permission"]).toBeUndefined();
    } else {
      expect(o["x-permission"]).toBe(r.perm);
      expect(o["x-public"]).toBeUndefined();
    }
  });
  it("x-context follows TRD §5 (identity_auth §5.1, platform §5.10, else tenant/absent)", () => {
    const auth = r.perm === "public";
    const platform = r.path.startsWith(`${PFX}/platform/`);
    if (auth) expect(o["x-context"]).toBe("identity_auth");
    else if (platform) expect(o["x-context"]).toBe("platform");
    else expect([undefined, "tenant"]).toContain(o["x-context"]);
  });
  it("security matches TRD (none / bffSession / bearerJwt)", () => {
    if (NO_SECURITY.includes(r.id)) expect(o.security).toEqual([]);
    else if (BFF_SESSION.includes(r.id)) expect(o.security).toEqual([{ bffSession: [] }]);
    else if (r.perm !== "public") expect(o.security).toEqual([{ bearerJwt: [] }]);
  });
  it("x-edge-exposure: public only for patient/mobile pre-auth ops, internal elsewhere under /auth", () => {
    if (EDGE_PUBLIC.includes(r.id)) expect(o["x-edge-exposure"]).toBe("public");
    else expect([undefined, "internal"]).toContain(o["x-edge-exposure"]);
    if (r.path.startsWith(`${PFX}/auth/`) && !EDGE_PUBLIC.includes(r.id)) expect([undefined, "internal"]).toContain(o["x-edge-exposure"]);
  });
  it("lists the TRD error codes", () => {
    for (const c of ERRORS[r.id] ?? []) expect(o["x-error-codes"], c).toContain(c);
  });
  it("state-creating POST (idem required) and PATCH/PUT/POST actions declare If-Match or key header as the convention needs", () => {
    const params = JSON.stringify(o.parameters ?? []);
    if (r.idem === "required") expect(params).toMatch(/IdempotencyKey/);
    // versioned updates/actions on a resource id: If-Match (TRD §5 conventions); pre-auth, creates and non-resource ops excluded
    const versioned = ["PATCH", "PUT"].includes(r.method) && /\{[a-z_]+\}/.test(r.path) && !r.path.includes("/feature-flags/");
    if (versioned) expect(params).toMatch(/IfMatch/);
  });
});

// LD-10 (2026-11-07): P-8 justification prefixes. Each idem:none POST carries the HONEST one — never E1/E2 falsely.
// E1 = 2xx body carries a secret/token shown once; E3 = read-only POST; E4 = pre-auth/session op, response not replayable.
const E1_OPS = ["loginStaff", "loginPartner", "confirmEmailToken", "openMobileSession", "refreshMobileSession", "resolveSession",
  "resolvePatientSession", "startMfaEnrolment"];
const E3_OPS = ["searchUsers"];
const E4_OPS = ["verifyMfaChallenge", "completeMfaEnrolment", "logoutSession", "logoutPatientSession", "logoutMobileSession",
  "requestPasswordRecovery", "setPasswordFromSetup", "changeOwnPassword"];
describe("P-8 x-idempotency-justification prefixes (LD-10)", () => {
  const just = (id: string) => String(ops[id]?.op?.["x-idempotency-justification"] ?? "");
  it.each(E1_OPS)("%s: E1 (secret/token in response)", (id) => expect(just(id)).toMatch(/^E1 \S/));
  it.each(E3_OPS)("%s: E3 (read-only POST)", (id) => expect(just(id)).toMatch(/^E3 \S/));
  it.each(E4_OPS)("%s: E4 (pre-auth/session, not replayable)", (id) => expect(just(id)).toMatch(/^E4 \S/));
  it("revokePlatformSession: if idem none then E4 (TRD/CV conflict; idem not pinned)", () => {
    const o = ops.revokePlatformSession?.op;
    expect(o, "revokePlatformSession missing").toBeDefined();
    if (o["x-idempotency"] === "none") expect(just("revokePlatformSession")).toMatch(/^E4 \S/);
  });
  it("every POST with idem none has an E1/E3/E4 justification, and the three lists cover all of them", () => {
    const noneIds = Object.entries(ops).filter(([, v]) => v.method === "POST" && v.op["x-idempotency"] === "none").map(([k]) => k);
    const covered = new Set([...E1_OPS, ...E3_OPS, ...E4_OPS, "revokePlatformSession"]);
    for (const id of noneIds) {
      expect(covered.has(id), `${id}: idem none but not in LD-10 lists`).toBe(true);
      expect(just(id), id).toMatch(/^E[134] \S/);
    }
  });
  it("no E2 anywhere (no patient OTP request POST in C2)", () => {
    for (const [id] of Object.entries(ops)) expect(just(id), id).not.toMatch(/^E2 /);
  });
  it("E1 claimed only for ops whose success response can carry a secret/token (not read-only / not logout)", () => {
    for (const id of [...E3_OPS, ...E4_OPS]) expect(just(id), id).not.toMatch(/^E[12] /);
  });
});

describe("rule 7 / LD-11 — tenant_id in request body only for x-context: platform", () => {
  const props = (b: any): string[] => {
    const s = b?.content?.["application/json"]?.schema;
    const resolved = s?.$ref ? doc.components?.schemas?.[String(s.$ref).split("/").pop()!] : s;
    return Object.keys(resolved?.properties ?? {});
  };
  it("openSupportSession (platform) takes tenant_id in its body", () => {
    const o = ops.openSupportSession?.op;
    expect(o["x-context"]).toBe("platform");
    expect(props(o.requestBody)).toContain("tenant_id");
  });
  it("no non-platform operation declares tenant_id/created_by/updated_by in its request body", () => {
    for (const [id, v] of Object.entries(ops)) {
      if (v.op["x-context"] === "platform") continue;
      const b = v.op.requestBody?.$ref ? doc.components?.requestBodies?.[String(v.op.requestBody.$ref).split("/").pop()!] : v.op.requestBody;
      for (const f of ["tenant_id", "created_by", "updated_by"]) expect(props(b), `${id} body has ${f}`).not.toContain(f);
    }
  });
  it("platform ops never take created_by/updated_by in bodies (exemption is tenant_id only)", () => {
    for (const [id, v] of Object.entries(ops)) {
      if (v.op["x-context"] !== "platform") continue;
      for (const f of ["created_by", "updated_by"]) expect(props(v.op.requestBody), `${id} body has ${f}`).not.toContain(f);
    }
  });
});

describe("shape pins from TRD §5", () => {
  it("upload operations are multipart/form-data with x-upload", () => {
    for (const id of UPLOADS) {
      expect(Object.keys(ops[id].op.requestBody?.content ?? {}), id).toContain("multipart/form-data");
      expect(Array.isArray(ops[id].op["x-upload"]), id).toBe(true);
    }
  });
  it("list operations take cursor + limit (≤ 200, default 50)", () => {
    for (const id of PAGED) {
      const ps = JSON.stringify(ops[id].op.parameters ?? []);
      expect(ps, id).toMatch(/cursor|Cursor/);
      expect(ps, id).toMatch(/limit|Limit/);
    }
  });
  it("downloadAuditExport: text/csv with attachment + nosniff + no-store headers (08 A13 P-2)", () => {
    const r200 = ops.downloadAuditExport.op.responses["200"];
    expect(Object.keys(r200.content)).toContain("text/csv");
    const h = Object.keys(r200.headers ?? {}).map((x) => x.toLowerCase());
    expect(h).toEqual(expect.arrayContaining(["content-disposition", "x-content-type-options", "cache-control"]));
  });
  it("dismissAdminNotice returns 204; createAuditExport 202; recordAccessReview 201", () => {
    expect(Object.keys(ops.dismissAdminNotice.op.responses)).toContain("204");
    expect(Object.keys(ops.createAuditExport.op.responses)).toContain("202");
    expect(Object.keys(ops.recordAccessReview.op.responses)).toContain("201");
  });
  it("SessionState enums match TRD §5.1", () => {
    const s = doc.components?.schemas?.SessionState;
    expect(s?.properties?.kind?.enum).toEqual(["tenant_staff", "platform", "partner", "patient", "staff_mobile"]);
    expect(s?.properties?.state?.enum).toEqual(["password_setup", "mfa_pending", "mfa_enrolment_required", "active"]);
    expect(s?.properties?.aal?.enum).toEqual(["aal1", "aal2"]);
  });
  it("login request: password 1–128 chars, email ≤ 254; MFA code pattern ^[0-9]{6}$", () => {
    const body = (id: string) => {
      const rb = ops[id].op.requestBody;
      const sch = rb.content["application/json"].schema;
      const ref = sch.$ref?.split("/").pop();
      return ref ? doc.components.schemas[ref] : sch;
    };
    const l = body("loginStaff").properties;
    expect(l.password.minLength).toBe(1);
    expect(l.password.maxLength).toBe(128);
    expect(l.email.maxLength).toBe(254);
    expect(body("verifyMfaChallenge").properties.code.pattern).toBe("^[0-9]{6}$");
  });
});

// ---------- "Prism smoke", offline: examples validate against their schemas ----------
describe("examples validate against their schemas; each operation has a servable example (Prism smoke)", () => {
  const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
  const common = parse(readFileSync(join(ROOT, "contracts/openapi/_common.yaml"), "utf8"));
  ajv.addSchema({ ...common, id: "_common.yaml" });
  ajv.addSchema({ ...doc, id: "identity.yaml" });
  const esc = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
  const check = (ptr: string, example: unknown) => {
    const validate = ajv.getSchema(`identity.yaml#${ptr}`);
    expect(validate, `cannot resolve ${ptr}`).toBeDefined();
    expect(validate!(example), `${ptr}: ${JSON.stringify(validate!.errors?.[0])}`).toBe(true);
  };
  it("every JSON request/response example matches its schema", () => {
    let n = 0;
    for (const { method, path, op } of Object.values(ops)) {
      const base = `/paths/${esc(path)}/${method.toLowerCase()}`;
      const media: [string, any][] = [];
      const rb = op.requestBody;
      if (rb?.content?.["application/json"]) media.push([`${base}/requestBody/content/application~1json`, rb.content["application/json"]]);
      for (const [code, r] of Object.entries<any>(op.responses ?? {}))
        if (!r.$ref && r.content?.["application/json"]) media.push([`${base}/responses/${code}/content/application~1json`, r.content["application/json"]]);
      for (const [p, m] of media)
        for (const [k, e] of Object.entries<any>(m.examples ?? {})) {
          if (m.schema) check(`${p}/schema`, e.value);
          n++;
          expect(k.length).toBeGreaterThan(0);
        }
    }
    expect(n).toBeGreaterThan(100);
  });
  it("every operation has a 2xx response; JSON ones carry an example Prism can serve", () => {
    for (const { op, path, method } of Object.values(ops)) {
      const two = Object.entries<any>(op.responses ?? {}).filter(([c]) => /^2/.test(c));
      expect(two.length, `${method} ${path}: no 2xx`).toBeGreaterThan(0);
      for (const [c, r] of two) {
        const j = r.content?.["application/json"];
        if (j) expect(Object.keys(j.examples ?? {}).length, `${method} ${path} ${c}: no example`).toBeGreaterThan(0);
        else if (c !== "204" && !r.$ref) expect(Object.keys(r.content ?? {}).length, `${method} ${path} ${c}: no content`).toBeGreaterThan(0);
      }
    }
  });
});
