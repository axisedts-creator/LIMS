// T0C-VERLEVEL-1 (LD-316, LD-318 follow-up (4), LD-335; founder 2026-11-17 08:39 NPT "verification level 1 2 3") — contracts/openapi/lab.yaml verification policy + sign-off chain,
// the 3 new error codes, the 2 new permission codes, the migration 20261117150000_lab__add_verification_policy_and_signoffs.sql (static; behaviour is
// db/tests/lab/T0C-VERLEVEL-1_verification_levels.test.sql), generated-client freshness and the implementation notes.
// ASSUMPTIONS (the brief names operations, tables and codes, not every wire name; a different choice needs a ruling, not a silent test edit; same style as T0C-PRICETOOLS-1):
//  - Exactly 3 new operations (55 -> 58), no other, none removes or changes an existing one:
//      listVerificationPolicies  GET  /v1/lab/verification-policies            lab.verification_policy.read    idem none      200 JSON {data: VerificationPolicy[]}
//      upsertVerificationPolicy  PUT  /v1/lab/verification-policies            lab.verification_policy.manage  idem optional|required  200 VerificationPolicy; body VerificationPolicyUpsert (no DELETE method anywhere: deactivate with active false)
//      getResultSignoffs         GET  /v1/lab/results/{result_id}/signoffs     lab.result.read                 idem none      200 JSON {data: ResultSignoff[]} (the chain, ordered by version then seq)
//  - Wire names: VerificationPolicy {id, scope, department_id?, test_id?, required_verifiers 1..3, require_pathologist, allow_enterer_verify, active, updated_at, version?}; the upsert body has the same business fields
//    (no id, no tenant_id); ResultSignoff {result_version, seq 1..3, action verify|approve, signer_display_name, signer_title?, signer_role_code, signer_is_pathologist, signer_registration_no?, signed_at};
//    the signature asset reference is a storage id and is NOT exposed.
//  - Additive optional fields signoff_count (0..3), signoff_required (1..3), next_step (enum containing verify and approve) on ResultDto (= response of verifyResult, approveResult and the rows of the queue);
//    no required list of any existing schema changes.
//  - 3 new error codes in contracts/errors.yaml (owner C5, http 403 or 409): lab.verifier_not_distinct, lab.enterer_cannot_verify, lab.pathologist_required; added to x-error-codes of
//    verifyResult / bulkVerifyResults (first two) and approveResult / bulkApproveResults (all three); the old lab.self_approval_forbidden and lab.result_invalid_transition stay.
//  - 2 new permission codes (registry roles: read -> lab_technologist, pathologist, lab_manager; manage -> lab_manager, privileged true); corp_admin pack gets both (services/api tests pin it).
//  - Per LD-325 / LD-335 the 3 new operationIds are added to pendingOperations of the lab manifest (pinned in services/api/.../lab/__tests__/contract/verlevel1.pending.test.ts), NOT handled here.
//  - the implementer's notes are .orchestra/notes/T0C-VERLEVEL-1-impl.md (convention of every earlier T0C task).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv-draft-04";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { staleFiles } from "../codegen";
import { lintRepo } from "../lint-openapi";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const FILE = join(ROOT, "contracts/openapi/lab.yaml");
const MIG = "20261117150000_lab__add_verification_policy_and_signoffs.sql";
const NOTES = join(ROOT, ".orchestra/notes/T0C-VERLEVEL-1-impl.md");
const doc: any = parse(readFileSync(FILE, "utf8"));
const common: any = parse(readFileSync(join(ROOT, "contracts/openapi/_common.yaml"), "utf8"));
const S = doc.components.schemas as Record<string, any>;
const P = (name: string, f: string): any => S[name]?.properties?.[f] ?? {};
const enumOf = (p: any): string[] => ((p?.enum ?? []) as unknown[]).filter((x): x is string => typeof x === "string");
const refName = (s: any): string => String(s?.$ref ?? "").split("/").pop()!;
const METHODS = ["get", "put", "post", "delete", "patch"];
const sortedEq = (a: string[], b: string[]) => expect([...a].sort()).toEqual([...b].sort());

const NEW_OPS: Record<string, { method: string; path: string; perm: string; idem: string[]; item: string }> = {
  listVerificationPolicies: { method: "get", path: "/v1/lab/verification-policies", perm: "lab.verification_policy.read", idem: ["none"], item: "VerificationPolicy" },
  upsertVerificationPolicy: { method: "put", path: "/v1/lab/verification-policies", perm: "lab.verification_policy.manage", idem: ["optional", "required"], item: "" },
  getResultSignoffs: { method: "get", path: "/v1/lab/results/{result_id}/signoffs", perm: "lab.result.read", idem: ["none"], item: "ResultSignoff" },
};
const OLD_OPS: Record<string, { method: string; path: string; perm: string }> = {
  verifyResult: { method: "post", path: "/v1/lab/results/{result_id}/verify", perm: "lab.result.verify" },
  bulkVerifyResults: { method: "post", path: "/v1/lab/results/bulk-verify", perm: "lab.result.verify" },
  approveResult: { method: "post", path: "/v1/lab/results/{result_id}/approve", perm: "lab.result.approve" },
  bulkApproveResults: { method: "post", path: "/v1/lab/results/bulk-approve", perm: "lab.result.approve" },
  amendResult: { method: "post", path: "/v1/lab/results/{result_id}/amend", perm: "lab.result.amend" },
  listVerificationQueue: { method: "get", path: "/v1/lab/verification-queue", perm: "lab.result.read" },
  getResult: { method: "get", path: "/v1/lab/results/{result_id}", perm: "lab.result.read" },
};
const NEW_ERRORS = ["lab.verifier_not_distinct", "lab.enterer_cannot_verify", "lab.pathologist_required"];
const OLD_ERRORS = ["lab.self_approval_forbidden", "lab.result_invalid_transition"];

const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
ajv.addSchema({ ...common, id: "_common.yaml" });
ajv.addSchema({ ...doc, id: "lab.yaml" });
const validator = (name: string) => {
  const v = ajv.getSchema(`lab.yaml#/components/schemas/${name}`);
  expect(v, `cannot resolve ${name}`).toBeDefined();
  return v!;
};
const opOf = (id: string): { method: string; path: string; op: any } | undefined => {
  for (const [path, item] of Object.entries<any>(doc.paths)) for (const m of METHODS) if (item[m]?.operationId === id) return { method: m, path, op: item[m] };
  return undefined;
};
const needOp = (id: string) => { const f = opOf(id); expect(f, id + " missing").toBeDefined(); return f!; };
const allOps = (): string[] => Object.values<any>(doc.paths).flatMap((item) => METHODS.filter((m) => item[m]).map((m) => item[m].operationId as string));
const okSchemaName = (id: string): string => refName(opOf(id)?.op.responses?.["200"]?.content?.["application/json"]?.schema);
const resolveProps = (name: string): Record<string, any> => S[name]?.properties ?? {};
const textOf = (...parts: any[]): string => parts.map((p) => JSON.stringify(p ?? "")).join(" ").replace(/\\"/g, '"');
const UUID = "0193c4a0-0000-7000-8000-0000000000aa";
const UUID2 = "0193c4a0-0000-7000-8000-0000000000ab";

describe("T0C-VERLEVEL-1 contract: lab.yaml lint and additive baseline", () => {
  it("lintRepo reports no violation for lab.yaml", async () => {
    const v = (await lintRepo(ROOT)).filter((x) => x.file === "lab.yaml");
    expect(v, JSON.stringify(v.slice(0, 3))).toEqual([]);
  });

  it("is additive: 55 operations before, exactly 3 new now; the six operations of the brief keep method, path and permission", () => {
    const ids = allOps();
    expect(ids.length, "55 + 3 verification level operations").toBe(58);
    expect(new Set(ids).size).toBe(58);
    for (const id of Object.keys(NEW_OPS)) expect(opOf(id), `${id} missing`).toBeDefined();
    for (const [id, o] of Object.entries(OLD_OPS)) {
      const f = opOf(id);
      expect(f, `${id} missing`).toBeDefined();
      expect(`${f!.method} ${f!.path}`, id).toBe(`${o.method} ${o.path}`);
      expect(f!.op["x-permission"], `${id} permission`).toBe(o.perm);
    }
  });

  it("the required lists of the existing result schemas are unchanged (the new fields are optional)", () => {
    sortedEq(S.ResultDto.required, ["id", "version", "order_id", "order_item_id", "test_id", "analyte_id", "analyte_code", "status", "origin", "range_unavailable_age_unknown", "critical", "on_hold",
      "qc_review_required", "unit_mismatch", "current_version_no"]);
    sortedEq(S.VerificationQueueItem.required, ["result", "registration_no", "patient_display", "priority"]);
    sortedEq(enumOf(P("ResultDto", "status")).filter((x) => ["pending", "resulted", "verified", "approved", "cancelled"].includes(x)), ["pending", "resulted", "verified", "approved", "cancelled"]);
  });
});

describe("T0C-VERLEVEL-1 contract: the three operations (done_when 5)", () => {
  for (const [id, n] of Object.entries(NEW_OPS)) {
    it(`${id}: ${n.method.toUpperCase()} ${n.path}, ${n.perm}, tenant context, error codes, standard error responses`, () => {
      const f = opOf(id);
      expect(f, `${id} missing`).toBeDefined();
      const { op } = f!;
      expect(`${f!.method} ${f!.path}`).toBe(`${n.method} ${n.path}`);
      expect(op.tags).toEqual(["lab"]);
      expect(op["x-permission"]).toBe(n.perm);
      expect(op["x-context"]).toBe("tenant");
      expect(n.idem, `${id} idempotency ${op["x-idempotency"]}`).toContain(op["x-idempotency"]);
      expect(typeof op["x-rate-limit-tier"]).toBe("string");
      expect(op.security).toEqual([{ bearerJwt: [] }]);
      expect(Array.isArray(op["x-error-codes"]), "x-error-codes").toBe(true);
      expect(typeof op.summary).toBe("string");
      expect(op.responses?.["200"], `${id} 200 response`).toBeDefined();
      for (const c of ["400", "401", "403", "429", "500"]) expect(op.responses?.[c], `${id} ${c}`).toBeDefined();
      if (f!.path.includes("{")) expect(op.responses?.["404"], `${id} 404`).toBeDefined();
    });
  }

  it("there is no DELETE on the policy path: a policy is deactivated with active false, never deleted", () => {
    expect(doc.paths["/v1/lab/verification-policies"]?.delete).toBeUndefined();
    expect(textOf(needOp("upsertVerificationPolicy").op.summary, needOp("upsertVerificationPolicy").op.description)).toMatch(/deactivat/i);
    expect(textOf(needOp("upsertVerificationPolicy").op.summary, needOp("upsertVerificationPolicy").op.description)).toMatch(/never delete|not delete|no delete/i);
  });

  it("the two list operations answer {data: [...]} of VerificationPolicy / ResultSignoff", () => {
    for (const id of ["listVerificationPolicies", "getResultSignoffs"]) {
      const w = S[okSchemaName(id)];
      expect(w, `${id} response schema`).toBeDefined();
      expect(w.properties?.data?.type, `${id} data is an array`).toBe("array");
      expect(refName(w.properties.data.items), id).toBe(NEW_OPS[id].item);
      expect(typeof w.properties.data.maxItems, `${id} bounded array`).toBe("number");
    }
  });

  it("upsertVerificationPolicy takes a closed VerificationPolicyUpsert body and answers a VerificationPolicy", () => {
    const { op } = needOp("upsertVerificationPolicy");
    expect(Object.keys(op.requestBody?.content ?? {})).toEqual(["application/json"]);
    expect(refName(op.requestBody.content["application/json"].schema)).toBe("VerificationPolicyUpsert");
    expect(op.requestBody.required).toBe(true);
    expect(okSchemaName("upsertVerificationPolicy")).toBe("VerificationPolicy");
    expect(S.VerificationPolicyUpsert?.additionalProperties).toBe(false);
  });

  it("getResultSignoffs has the result id as a path Uuid and the chain description says order, signer snapshot and that only pathologist sign-offs print as signatures", () => {
    const { op } = needOp("getResultSignoffs");
    const p = (op.parameters ?? []).find((x: any) => x.name === "result_id");
    expect(p?.in).toBe("path");
    expect(JSON.stringify(p.schema)).toContain("Uuid");
    const t = textOf(op.summary, op.description, S.ResultSignoff).toLowerCase();
    for (const w of ["snapshot", "append"]) expect(t, `text names "${w}"`).toContain(w);
  });

  it("only the existing and the two new permission codes are used by the three operations", () => {
    for (const id of Object.keys(NEW_OPS)) expect(["lab.verification_policy.read", "lab.verification_policy.manage", "lab.result.read"]).toContain(needOp(id).op["x-permission"]);
  });
});

describe("T0C-VERLEVEL-1 contract: schemas", () => {
  it("VerificationPolicy: closed, level 1..3, scope enum lab | department | test, boolean flags, no tenant_id", () => {
    const s = S.VerificationPolicy;
    expect(s, "VerificationPolicy").toBeDefined();
    expect(s.additionalProperties).toBe(false);
    for (const f of ["id", "scope", "required_verifiers", "require_pathologist", "allow_enterer_verify", "active"]) expect(s.required, `${f} required`).toContain(f);
    sortedEq(enumOf(P("VerificationPolicy", "scope")), ["lab", "department", "test"]);
    expect(P("VerificationPolicy", "required_verifiers")).toMatchObject({ type: "integer", minimum: 1, maximum: 3 });
    for (const f of ["require_pathologist", "allow_enterer_verify", "active"]) expect(P("VerificationPolicy", f).type, f).toBe("boolean");
    for (const f of ["department_id", "test_id"]) expect(JSON.stringify(P("VerificationPolicy", f)), f).toContain("Uuid");
    expect(Object.keys(resolveProps("VerificationPolicy"))).not.toContain("tenant_id");
    expect(textOf(s)).not.toMatch(/"type":"number"/);
  });

  it("VerificationPolicyUpsert: the same business fields, no id, no tenant_id, required scope + required_verifiers", () => {
    const s = S.VerificationPolicyUpsert;
    expect(s, "VerificationPolicyUpsert").toBeDefined();
    const keys = Object.keys(s.properties ?? {});
    for (const f of ["scope", "department_id", "test_id", "required_verifiers", "require_pathologist", "allow_enterer_verify", "active"]) expect(keys, f).toContain(f);
    for (const f of ["id", "tenant_id", "created_by", "updated_by"]) expect(keys, `${f} must not be sent by the client`).not.toContain(f);
    for (const f of ["scope", "required_verifiers"]) expect(s.required, f).toContain(f);
    expect(P("VerificationPolicyUpsert", "required_verifiers")).toMatchObject({ type: "integer", minimum: 1, maximum: 3 });
    sortedEq(enumOf(P("VerificationPolicyUpsert", "scope")), ["lab", "department", "test"]);
  });

  it("the policy schemas reject level 0 and 4, an unknown scope, an unknown field", () => {
    const ok = { scope: "lab", required_verifiers: 2, require_pathologist: true, allow_enterer_verify: false, active: true };
    const v = validator("VerificationPolicyUpsert");
    expect(v(ok), JSON.stringify(v.errors?.[0])).toBe(true);
    expect(v({ scope: "department", department_id: UUID, required_verifiers: 3 })).toBe(true);
    expect(v({ scope: "test", test_id: UUID2, required_verifiers: 1, require_pathologist: false, allow_enterer_verify: true })).toBe(true);
    for (const bad of [{ required_verifiers: 0 }, { required_verifiers: 4 }, { required_verifiers: 2.5 }, { scope: "ward" }, { tenant_id: UUID }, { require_pathologist: "yes" }]) expect(v({ ...ok, ...bad }), `accepted ${JSON.stringify(bad)}`).toBe(false);
  });

  it("ResultSignoff: closed; required seq, action, signer name, role, pathologist flag, time; seq 1..3; action verify | approve; no signature asset id, no tenant_id", () => {
    const s = S.ResultSignoff;
    expect(s, "ResultSignoff").toBeDefined();
    expect(s.additionalProperties).toBe(false);
    for (const f of ["result_version", "seq", "action", "signer_display_name", "signer_role_code", "signer_is_pathologist", "signed_at"]) expect(s.required, `${f} required`).toContain(f);
    expect(Object.keys(resolveProps("ResultSignoff")), "signer title").toContain("signer_title");
    expect(P("ResultSignoff", "seq")).toMatchObject({ type: "integer", minimum: 1, maximum: 3 });
    sortedEq(enumOf(P("ResultSignoff", "action")), ["verify", "approve"]);
    expect(P("ResultSignoff", "signer_is_pathologist").type).toBe("boolean");
    for (const f of ["signer_signature_asset_id", "tenant_id"]) expect(Object.keys(resolveProps("ResultSignoff")), `${f} must not be exposed`).not.toContain(f);
    const base = { result_version: 1, seq: 1, action: "verify", signer_display_name: "Synthetic Tech", signer_role_code: "lab_technologist", signer_is_pathologist: false, signed_at: "2026-11-17T04:00:00.000Z" };
    const v = validator("ResultSignoff");
    expect(v(base), JSON.stringify(v.errors?.[0])).toBe(true);
    for (const bad of [{ seq: 0 }, { seq: 4 }, { action: "reject" }, { result_version: 0 }, { signer_is_pathologist: "no" }, { signature: "x" }]) expect(v({ ...base, ...bad }), `accepted ${JSON.stringify(bad)}`).toBe(false);
  });

  it("ResultDto gains optional signoff_count 0..3, signoff_required 1..3 and next_step (enum with verify and approve); the queue rows reach them through result", () => {
    expect(P("ResultDto", "signoff_count")).toMatchObject({ type: "integer", minimum: 0, maximum: 3 });
    expect(P("ResultDto", "signoff_required")).toMatchObject({ type: "integer", minimum: 1, maximum: 3 });
    const ns = enumOf(P("ResultDto", "next_step"));
    expect(ns).toContain("verify");
    expect(ns).toContain("approve");
    for (const f of ["signoff_count", "signoff_required", "next_step"]) expect(S.ResultDto.required, `${f} must stay optional (additive)`).not.toContain(f);
    expect(refName(P("VerificationQueueItem", "result"))).toBe("ResultDto");
    expect(okSchemaName("verifyResult")).toBe("ResultDto");
    expect(okSchemaName("approveResult")).toBe("ResultDto");
  });

  it("no new schema carries a float (counts and levels are integers)", () => {
    for (const n of ["VerificationPolicy", "VerificationPolicyUpsert", "ResultSignoff"]) expect(textOf(S[n]), n).not.toMatch(/"type":"number"/);
  });
});

describe("T0C-VERLEVEL-1 contract: error codes (done_when 5)", () => {
  const errs: any[] = parse(readFileSync(join(ROOT, "contracts/errors.yaml"), "utf8"));
  it("the three new codes are in contracts/errors.yaml: owner C5, http 403 or 409, title and meaning", () => {
    for (const c of NEW_ERRORS) {
      const e = errs.find((x) => x.code === c);
      expect(e, `${c} in errors.yaml`).toBeDefined();
      expect(e.owner).toBe("C5");
      expect([403, 409]).toContain(e.http);
      expect(String(e.title).length).toBeGreaterThan(0);
      expect(String(e.meaning ?? "").length, `${c} meaning`).toBeGreaterThan(0);
    }
    for (const c of OLD_ERRORS) expect(errs.find((x) => x.code === c), `${c} stays`).toBeDefined();
  });
  it("verifyResult and bulkVerifyResults list verifier_not_distinct and enterer_cannot_verify; approveResult and bulkApproveResults list all three; old codes stay", () => {
    for (const id of ["verifyResult", "bulkVerifyResults"]) {
      const c: string[] = needOp(id).op["x-error-codes"];
      for (const e of NEW_ERRORS.slice(0, 2)) expect(c, `${id} ${e}`).toContain(e);
      expect(c, `${id} old code`).toContain("lab.result_invalid_transition");
    }
    for (const id of ["approveResult", "bulkApproveResults"]) {
      const c: string[] = needOp(id).op["x-error-codes"];
      for (const e of NEW_ERRORS) expect(c, `${id} ${e}`).toContain(e);
      for (const e of OLD_ERRORS) expect(c, `${id} old code ${e}`).toContain(e);
    }
  });
  it("the three operations only use codes that exist in errors.yaml", () => {
    for (const id of Object.keys(NEW_OPS)) for (const c of needOp(id).op["x-error-codes"] as string[]) expect(errs.some((x) => x.code === c), `${id}: ${c}`).toBe(true);
  });
  it("the new rule is written into the contract text: different people, enterer, pathologist, level 1 2 3", () => {
    const t = textOf(needOp("verifyResult").op, needOp("approveResult").op, S.VerificationPolicy, S.VerificationPolicyUpsert).toLowerCase();
    for (const w of ["different", "enterer", "pathologist", "level"]) expect(t, `contract text names "${w}"`).toContain(w);
  });
});

describe("T0C-VERLEVEL-1 contract: examples (done_when 5 'synthetic examples')", () => {
  const examplesOf = (id: string): any[] => Object.values<any>(opOf(id)?.op.responses?.["200"]?.content?.["application/json"]?.examples ?? {}).map((e) => e.value);
  it("each of the three operations has a 200 example that validates against its schema", () => {
    for (const id of Object.keys(NEW_OPS)) {
      const ex = examplesOf(id);
      expect(ex.length, `${id}: example`).toBeGreaterThan(0);
      const v = ajv.compile({ $ref: `lab.yaml#/components/schemas/${okSchemaName(id)}` });
      for (const e of ex) expect(v(e), `${id}: ${JSON.stringify(v.errors?.[0])}`).toBe(true);
    }
  });
  it("the signoff chain example shows a technologist (is_pathologist false) then a pathologist (is_pathologist true) with seq 1 and 2", () => {
    const ex = examplesOf("getResultSignoffs").flatMap((e: any) => e.data as any[]);
    expect(ex.some((x) => x.seq === 1 && x.action === "verify" && x.signer_is_pathologist === false)).toBe(true);
    expect(ex.some((x) => x.seq === 2 && x.action === "approve" && x.signer_is_pathologist === true)).toBe(true);
  });
  it("the policy list example shows the default: scope lab, level 2, pathologist required, enterer may not verify", () => {
    const ex = examplesOf("listVerificationPolicies").flatMap((e: any) => e.data as any[]);
    expect(ex.some((x) => x.scope === "lab" && x.required_verifiers === 2 && x.require_pathologist === true && x.allow_enterer_verify === false && x.active === true)).toBe(true);
  });
  it("the verifyResult and approveResult 200 examples carry signoff_count, signoff_required and next_step and still validate", () => {
    for (const id of ["verifyResult", "approveResult"]) {
      const ex = examplesOf(id);
      expect(ex.length).toBeGreaterThan(0);
      expect(ex.some((e) => Number.isInteger(e.signoff_count) && Number.isInteger(e.signoff_required) && typeof e.next_step === "string"), `${id} example shows the new fields`).toBe(true);
      const v = validator("ResultDto");
      for (const e of ex) expect(v(e), `${id}: ${JSON.stringify(v.errors?.[0])}`).toBe(true);
    }
  });
  it("the upsert request example validates", () => {
    const ex = Object.values<any>(needOp("upsertVerificationPolicy").op.requestBody.content["application/json"].examples ?? {});
    expect(ex.length).toBeGreaterThan(0);
    for (const e of ex) expect(validator("VerificationPolicyUpsert")(e.value)).toBe(true);
  });
});

describe("T0C-VERLEVEL-1 permissions (done_when 6)", () => {
  const reg: any[] = (parse(readFileSync(join(ROOT, "contracts/permissions.yaml"), "utf8")) as any).permissions;
  const get = (c: string) => reg.find((p) => p.code === c);
  it("lab.verification_policy.read is for every lab role; lab.verification_policy.manage is privileged and for lab_manager", () => {
    const r = get("lab.verification_policy.read");
    const m = get("lab.verification_policy.manage");
    expect(r, "read code").toBeDefined();
    expect(m, "manage code").toBeDefined();
    for (const role of ["lab_technologist", "pathologist", "lab_manager"]) expect(r.roles, `read ${role}`).toContain(role);
    expect(m.roles).toContain("lab_manager");
    expect(m.privileged, "changing who may sign off is a privileged action").toBe(true);
    expect(r.privileged).toBe(false);
  });
  it("no existing code was renamed or removed (spot check of the sign-off codes) and the 2 new codes are not platform codes", () => {
    for (const c of ["lab.result.read", "lab.result.verify", "lab.result.approve", "lab.result.amend", "lab.config.manage"]) expect(get(c), c).toBeDefined();
    for (const c of ["lab.verification_policy.read", "lab.verification_policy.manage"]) expect((get(c)?.roles ?? []).filter((r: string) => r.startsWith("platform_"))).toEqual([]);
  });
});

describe("T0C-VERLEVEL-1 generated clients (codegen is fresh)", () => {
  it("generated clients and MSW handlers are fresh (codegen --check)", () => {
    expect(staleFiles(ROOT)).toEqual([]);
  }, 120_000);
});

describe("T0C-VERLEVEL-1 migration file (static; behaviour in the pgTAP suite) (done_when 2, 3, 4, 7)", () => {
  const path = join(ROOT, "db/migrations", MIG);
  const text = existsSync(path) ? readFileSync(path, "utf8").replace(/\r\n/g, "\n") : "";
  const code = text.split("\n").filter((l) => !/^\s*--/.test(l)).map((l) => l.replace(/--.*$/, "")).join("\n");
  const comments = text.split("\n").filter((l) => /^\s*--/.test(l)).join("\n");

  it("exists, is the only 20261117150000 migration, runs as lims_owner", () => {
    expect(existsSync(path), `db/migrations/${MIG} missing`).toBe(true);
    const all = readdirSync(join(ROOT, "db/migrations")).filter((f) => f.endsWith(".sql")).sort();
    expect(all.filter((f) => f.startsWith("20261117150000"))).toEqual([MIG]);
    expect(code).toMatch(/SET LOCAL ROLE lims_owner/);
  });
  it("creates both tables IF NOT EXISTS with tenant_id, RLS enabled and forced, a SELECT and an INSERT policy each, every policy guarded by pg_policy", () => {
    for (const t of ["verification_policy", "result_signoff"]) {
      expect(code, t).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS lab\\.${t}\\b`, "i"));
      expect(code, `${t} ENABLE RLS`).toMatch(new RegExp(`ALTER TABLE lab\\.${t}\\s+ENABLE ROW LEVEL SECURITY`, "i"));
      expect(code, `${t} FORCE RLS`).toMatch(new RegExp(`ALTER TABLE lab\\.${t}\\s+FORCE ROW LEVEL SECURITY`, "i"));
      expect(code, `${t} select policy`).toMatch(new RegExp(`CREATE POLICY ${t}__select__tenant ON lab\\.${t} FOR SELECT`, "i"));
      expect(code, `${t} insert policy`).toMatch(new RegExp(`CREATE POLICY ${t}__insert__tenant ON lab\\.${t} FOR INSERT`, "i"));
      const block = code.slice(code.search(new RegExp(`CREATE TABLE IF NOT EXISTS lab\\.${t}\\b`, "i")));
      expect(block.slice(0, 3000), `${t} has tenant_id`).toMatch(/tenant_id\s+uuid\s+NOT NULL/i);
    }
    expect((code.match(/CREATE TABLE(?! IF NOT EXISTS)/gi) ?? []).length, "every CREATE TABLE is IF NOT EXISTS").toBe(0);
    for (const m of code.matchAll(/CREATE POLICY (\w+)/gi)) expect(code, `policy ${m[1]} must be guarded by pg_policy`).toMatch(new RegExp(`pg_policy[^;]*${m[1]}`, "i"));
  });
  it("result_signoff is append only: SELECT and INSERT only, no UPDATE or DELETE policy; the policy table has no DELETE grant", () => {
    expect(code).toMatch(/GRANT SELECT, INSERT ON lab\.result_signoff TO lims_app/i);
    expect(code).not.toMatch(/result_signoff__(update|delete)/i);
    expect(code).not.toMatch(/GRANT[^;]*\b(UPDATE|DELETE|TRUNCATE|ALL)\b[^;]*lab\.result_signoff/i);
    expect(code).toMatch(/GRANT SELECT, INSERT, UPDATE ON lab\.verification_policy TO lims_app/i);
    expect(code).not.toMatch(/GRANT[^;]*\b(DELETE|TRUNCATE|ALL)\b[^;]*lab\.verification_policy/i);
  });
  it("value checks: scope list, level 1..3, seq 1..3, action list, the two unique rules, the active-only unique rule, composite tenant FK", () => {
    for (const v of ["lab", "department", "test", "verify", "approve"]) expect(code, `check names ${v}`).toContain(`'${v}'`);
    expect(code).toMatch(/required_verifiers\s+BETWEEN\s+1\s+AND\s+3|required_verifiers\s*>=\s*1[\s\S]{0,60}required_verifiers\s*<=\s*3/i);
    expect(code).toMatch(/seq\s+BETWEEN\s+1\s+AND\s+3|seq\s*>=\s*1[\s\S]{0,60}seq\s*<=\s*3/i);
    expect(code).toMatch(/UNIQUE\s*\(\s*result_id\s*,\s*result_version\s*,\s*seq\s*\)/i);
    expect(code).toMatch(/UNIQUE\s*\(\s*result_id\s*,\s*result_version\s*,\s*signer_user_id\s*\)/i);
    expect(code, "at most one ACTIVE row per target").toMatch(/UNIQUE\s+INDEX[^;]*lab\.verification_policy[^;]*WHERE\s+active|EXCLUDE\s+USING[^;]*WHERE\s*\(?\s*active/i);
    expect(code).toMatch(/FOREIGN KEY \(tenant_id, result_id\) REFERENCES lab\.results \(tenant_id, id\)/i);
  });
  it("adds signoff_required and signoff_count to lab.results with ADD COLUMN IF NOT EXISTS (smallint, count NOT NULL DEFAULT 0) and backfills with UPDATE statuses verified and approved", () => {
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS\s+"?signoff_required"?\s+smallint/i);
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS\s+"?signoff_count"?\s+smallint\s+NOT NULL\s+DEFAULT\s+0/i);
    expect(code, "backfill statement").toMatch(/UPDATE\s+lab\.results/i);
    expect(code).toMatch(/'verified'/);
    expect(code).toMatch(/'approved'/);
    for (const m of code.matchAll(/ADD\s+COLUMN\s+IF NOT EXISTS\s+"?(\w+)"?\s+([^,;]*)/gi)) if (/\bNOT\s+NULL\b/i.test(m[2])) expect(m[2], `column ${m[1]}: NOT NULL needs a DEFAULT`).toMatch(/\bDEFAULT\b/i);
  });
  it("the result lock function keeps protecting approved rows: lab.enforce_result_lock is still defined (or untouched) and the migration neither drops the trigger nor disables RLS", () => {
    expect(code).not.toMatch(/DROP\s+TRIGGER\s+(IF EXISTS\s+)?results__lock/i);
    expect(code).not.toMatch(/DISABLE\s+ROW|NO\s+FORCE|DISABLE\s+TRIGGER\s+(ALL|USER)\b/i);
    expect(code).not.toMatch(/\b(TRUNCATE|DELETE\s+FROM|DROP\s+TABLE|DROP\s+COLUMN|DROP\s+SCHEMA|DROP\s+POLICY)\b/i);
    expect(code).not.toMatch(/ALTER\s+COLUMN|ALTER\s+TABLE\s+\S+\s+(RENAME|OWNER)/i);
  });
  it("the default lab policy is seeded in the migration or in a db/seeds file (level 2, pathologist required, enterer not allowed)", () => {
    const seeds = readdirSync(join(ROOT, "db/seeds")).filter((f) => f.endsWith(".sql")).map((f) => readFileSync(join(ROOT, "db/seeds", f), "utf8")).join("\n");
    const hay = code + "\n" + seeds;
    expect(hay).toMatch(/INSERT\s+INTO\s+lab\.verification_policy/i);
    expect(hay).toMatch(/ON CONFLICT[^;]*DO NOTHING|WHERE\s+NOT\s+EXISTS/i);
  });
  it("comments: LD-316, down note, backfill rule, push-cloud, tables and columns named", () => {
    expect(comments).toMatch(/LD-316/);
    expect(comments).toMatch(/\bdown\b/i);
    expect(comments).toMatch(/DROP TABLE/i);
    expect(comments).toMatch(/DROP COLUMN/i);
    expect(comments).toMatch(/backfill/i);
    expect(comments).toMatch(/push-cloud/i);
    for (const w of ["verification_policy", "result_signoff", "signoff_required", "signoff_count"]) expect(comments, `comments name ${w}`).toContain(w);
  });
  it("db/meta/tables.yaml registers both tables and db/policies/lab.sql carries their policies", () => {
    const meta = readFileSync(join(ROOT, "db/meta/tables.yaml"), "utf8");
    for (const t of ["lab.verification_policy", "lab.result_signoff"]) expect(meta, t).toContain(`"${t}"`);
    const line = meta.split("\n").find((l) => l.includes('"lab.results"')) ?? "";
    if (/"columns"/.test(line)) for (const f of ["signoff_required", "signoff_count"]) expect(line, `tables.yaml lab.results column ${f}`).toContain(`"${f}"`);
    const pol = readFileSync(join(ROOT, "db/policies/lab.sql"), "utf8");
    for (const t of ["verification_policy", "result_signoff"]) expect(pol, t).toContain(`${t}__select__tenant`);
    expect(pol).not.toMatch(/result_signoff__(update|delete)/i);
  });
});

describe("T0C-VERLEVEL-1 implementation notes (done_when 1)", () => {
  const t = existsSync(NOTES) ? readFileSync(NOTES, "utf8") : "";
  it("notes exist, name the migration, push-cloud as a founder step, the 3 pending ids, T0B-VERLEVEL-1, LD-316, and flag the lead interpretation for the founder audit", () => {
    expect(existsSync(NOTES), ".orchestra/notes/T0C-VERLEVEL-1-impl.md missing").toBe(true);
    expect(t).toContain(MIG);
    expect(t).toMatch(/push-cloud/i);
    expect(t).toMatch(/founder/i);
    expect(t).toMatch(/pendingOperations/);
    for (const id of Object.keys(NEW_OPS)) expect(t, id).toContain(id);
    expect(t).toMatch(/T0B-VERLEVEL-1/);
    expect(t).toMatch(/LD-316/);
    expect(t).toMatch(/audit/i);
  });
  it("records what the current contract and tables say: the five states, verifier and approver columns, the two existing error codes, the six operations read", () => {
    for (const s of ["pending", "resulted", "verified", "approved", "cancelled"]) expect(t, `state ${s}`).toContain(s);
    for (const c of ["verified_by_membership_id", "approved_by_membership_id", "lab.self_approval_forbidden", "lab.result_invalid_transition"]) expect(t, c).toContain(c);
    for (const o of ["verifyResult", "bulkVerifyResults", "approveResult", "bulkApproveResults", "amendResult", "listVerificationQueue"]) expect(t, o).toContain(o);
  });
  it("states the two things the contract alone cannot decide: legacy approved results have no chain rows (empty chain, count 2 by backfill) and the result lock must let an amendment reset the counters", () => {
    expect(t).toMatch(/legacy|existing (approved )?results?|backfill/i);
    expect(t).toMatch(/chain/i);
    expect(t).toMatch(/enforce_result_lock|result lock/i);
  });
  it("records auto verify and print rules as out of scope here (LD-319 (3) auto_verify_when_in_normal_range, signature printing = PRINTCFG) and the 'no service or web change' limit", () => {
    expect(t).toMatch(/auto_verify|auto verify|auto-verify/i);
    expect(t).toMatch(/PRINTCFG/);
    expect(t).toMatch(/no (service|handler)|no web/i);
    expect(t).toMatch(/apps\/web\/src\/features\/admin|rs-c2/i);
  });
});
