// T0C-10.C9 / AC-0C-1.4, AC-0C-1.5 — contracts/openapi/quality.yaml (C9 transcription of spec/chunks/C9-quality-engine/02-TRD.md §5.0–§5.10, §7.10, §8.2, §8.6, §12.1; LD-103).
// Checks: (1) exists, openapi 3.0.3 first; (2) repo lint (T0C-04 lintRepo) clean for quality.yaml; (3) AC-0C-1.5 negatives on a temp copy;
// (4) quality = TRD §5 tables (54 operations #1–#54), method+path under /v1/quality, x-permission (one code), bearerJwt, x-idempotency, tier general,
//     success statuses, specific + common error codes (§5.0, §5.9), Idempotency-Key on R rows, If-Match on versioned actions;
// (5) shape pins: query params, enums, bounds, x-coded-set without enum, QcPlanParams (§5.3), RuleSetDefinition (§8.2), DTOs (§5.10), LjChartDto (§7.10),
//     SimulationReportDto (§8.6), settings (§12.1), no PHI / tenant_id in any schema;
// (6) "Prism smoke" offline: examples validate (ajv), every JSON 2xx has an example, examples synthetic; (7) package.json `mock:quality` script.
// Not testable here: Prism actually serving the file (prism not installed), generated-client freshness (codegen-fresh suite), runtime behaviour (state machines, access log, phase gate).
// Assumptions (TRD silent or ambiguous; each is also in the notes file):
//  - §5.0 "errors every operation may return" are pinned on EVERY op: validation_failed, auth.unauthenticated|token_invalid|token_expired, auth.forbidden|account_locked, not_found,
//    rate_limited, internal, dependency_unavailable, plus common.feature_disabled (phase gate, §5.0 last bullet);
//  - If-Match (header + common.version_conflict + common.precondition_required) is pinned only on rows whose Request column says `If-Match`; rows without it must not list
//    precondition_required and take no If-Match header (version_conflict is tolerated on other mutations, "Mutations add 409");
//  - Idempotency: R rows pin header + three IDEM codes; O rows pin x-idempotency optional and no key-required code; – rows pin x-idempotency none and no header;
//  - auth.mfa_required exactly on the permission `quality.autoverify.manage` (privileged in permissions.yaml: #37 #39 #40 #41 #43 #44 #45), nowhere else;
//  - "Every operation's x-error-codes lists exactly the codes in its row plus §5.0" is pinned as: nothing outside (§5.0 ∪ row extras ∪ idem/if-match/mfa ∪ invalid_cursor on paged lists);
//  - every "list" response is the page envelope {data, page}; #34 and #48 add generated_at; #53 is {data} only; every paged list takes cursor + limit (max 200, default 50, §5.0);
//  - a bare TRD response (no status code) pins "some 2xx"; `201` rows pin 201;
//  - DTO key sets are pinned exactly (TRD §5.10 field lists); only fields marked `?` in the TRD are pinned optional, and `id` pinned required (no-null rule leaves other
//    unmarked-but-absent-able fields, e.g. ControlIdMapDto.control_lot_raw, to the implementer);
//  - #15 response = QcPlanDto + `warnings`, #16 = QcPlanDto + `versions` (allOf or a dedicated schema; the pin is on the response's properties);
//  - #37 "exactly one of copy_from_version_id / definition" is expressed with oneOf (OAS 3.0 has no other way); the pin is that both names appear and neither is top-level required;
//  - #52 body: the §12.1 mutable keys with their ranges; `required` is not pinned.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv-draft-04";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { lintRepo } from "../lint-openapi";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const TRD = join(ROOT, "spec/chunks/C9-quality-engine/02-TRD.md");
const FILE = join(ROOT, "contracts/openapi/quality.yaml");
const common: any = parse(readFileSync(join(ROOT, "contracts/openapi/_common.yaml"), "utf8"));
const permissions: any = parse(readFileSync(join(ROOT, "contracts/permissions.yaml"), "utf8"));
const PRIVILEGED = new Set<string>((permissions.permissions ?? []).filter((p: any) => p.privileged).map((p: any) => p.code));
const METHODS = ["get", "put", "post", "delete", "patch"];
const name = "quality";
const PFX = "/v1/quality";

const VC = "common.version_conflict", PRE = "common.precondition_required", MFA = "auth.mfa_required", IMM = "common.immutable_record";
const IDEM = ["common.idempotency_key_required", "common.idempotency_key_reused", "common.idempotency_in_progress"];
const BASE = ["common.validation_failed", "auth.unauthenticated", "auth.token_invalid", "auth.token_expired", "auth.forbidden", "auth.account_locked", "common.not_found",
  "common.rate_limited", "common.internal", "common.dependency_unavailable", "common.feature_disabled"];
const CURSOR = "common.invalid_cursor";
const DUP = "quality.code_duplicate", EXP = "quality.lot_expired", EVAL = "quality.qc_run_already_evaluated", RSI = "quality.rule_set_invalid", RST = "quality.rule_set_invalid_transition";

const RD = "quality.qc_run.read", MG = "quality.qc.manage", AM = "quality.autoverify.manage", RV = "quality.qc_run.review", AR = "quality.autoverify.read";
const TR = "quality.tat_alert.read", TA = "quality.tat_alert.ack", CM = "quality.config.manage";

type Spec = { row: string; id: string; method: string; path: string; perm: string; idem: "none" | "optional" | "required"; status: number[]; err: string[]; im: boolean; paged?: boolean };
const N = "none" as const, O = "optional" as const, R = "required" as const;
const mk = (row: number, id: string, method: string, path: string, perm: string, idem: Spec["idem"], status: number[], err: string[], o: Partial<Pick<Spec, "im" | "paged">> = {}): Spec =>
  ({ row: String(row), id, method, path, perm, idem, status, err, im: false, ...o });
const IM = { im: true }, L = { paged: true };
const M = "/control-materials/{material_id}", P = "/qc-plans/{plan_id}", T_ = "/qc-targets/{target_id}", RUN = "/qc-runs/{qc_run_id}", V = "/autoverify/versions/{version_id}", TI = "/tat-alerts/{tat_item_id}";

const SPECS: Spec[] = [
  mk(1, "listControlMaterials", "GET", "/control-materials", RD, N, [200], [], L),
  mk(2, "createControlMaterial", "POST", "/control-materials", MG, R, [201], [DUP, ...IDEM]),
  mk(3, "getControlMaterial", "GET", M, RD, N, [200], []),
  mk(4, "updateControlMaterial", "PATCH", M, MG, N, [200], [VC, PRE], IM),
  mk(5, "deactivateControlMaterial", "POST", `${M}/deactivate`, MG, O, [200], [VC, PRE], IM),
  mk(6, "createControlLevel", "POST", `${M}/levels`, MG, R, [201], [DUP, ...IDEM]),
  mk(7, "updateControlLevel", "PATCH", "/control-levels/{level_id}", MG, N, [200], [VC, PRE], IM),
  mk(8, "createControlLot", "POST", "/control-levels/{level_id}/lots", MG, R, [201], [DUP, EXP, ...IDEM]),
  mk(9, "listControlLots", "GET", "/control-lots", RD, N, [200], [], L),
  mk(10, "updateControlLot", "PATCH", "/control-lots/{lot_id}", MG, N, [200], [EXP, VC, PRE], IM),
  mk(11, "listControlIdMaps", "GET", "/control-id-maps", RD, N, [200], [], L),
  mk(12, "createControlIdMap", "POST", "/control-id-maps", MG, R, [201], [DUP, EXP, ...IDEM]),
  mk(13, "deactivateControlIdMap", "POST", "/control-id-maps/{map_id}/deactivate", MG, O, [200], [VC, PRE], IM),
  mk(14, "listQcPlans", "GET", "/qc-plans", RD, N, [200], [], L),
  mk(15, "createQcPlan", "POST", "/qc-plans", MG, R, [201], [DUP, ...IDEM]),
  mk(16, "getQcPlan", "GET", P, RD, N, [200], []),
  mk(17, "createQcPlanVersion", "POST", `${P}/versions`, MG, R, [200], [...IDEM, VC, PRE], IM),
  mk(18, "activateQcPlan", "POST", `${P}/activate`, MG, O, [200], ["quality.qc_target_missing", VC, PRE], IM),
  mk(19, "deactivateQcPlan", "POST", `${P}/deactivate`, MG, O, [200], [VC, PRE], IM),
  mk(20, "listQcTargets", "GET", "/qc-targets", RD, N, [200], [], L),
  mk(21, "createQcTarget", "POST", "/qc-targets", MG, R, [201], [EXP, ...IDEM]),
  mk(22, "establishQcTarget", "POST", "/qc-targets/establish", MG, R, [201], ["quality.insufficient_qc_data", ...IDEM]),
  mk(23, "activateQcTarget", "POST", `${T_}/activate`, MG, O, [200], [IMM, VC, PRE], IM),
  mk(24, "retireQcTarget", "POST", `${T_}/retire`, MG, O, [200], [IMM, VC, PRE], IM),
  mk(25, "discardQcTarget", "POST", `${T_}/discard`, MG, O, [200], [IMM, VC, PRE], IM),
  mk(26, "listQcObservations", "GET", "/qc-observations", RD, N, [200], [], L),
  mk(27, "excludeQcObservation", "POST", "/qc-observations/{observation_id}/exclude", MG, O, [200], [EVAL, VC, PRE], IM),
  mk(28, "listQcRuns", "GET", "/qc-runs", RD, N, [200], [], L),
  mk(29, "getQcRun", "GET", RUN, RD, N, [200], []),
  mk(30, "evaluateQcRunNow", "POST", `${RUN}/evaluate`, RV, R, [200], [EVAL, ...IDEM, VC, PRE], IM),
  mk(31, "recordCorrectiveAction", "POST", `${RUN}/corrective-actions`, RV, R, [201], [IMM, ...IDEM]),
  mk(32, "closeQcRun", "POST", `${RUN}/close`, RV, R, [200], ["quality.corrective_action_required", "quality.rerun_required", IMM, ...IDEM, VC, PRE], IM),
  mk(33, "acknowledgeQcRun", "POST", `${RUN}/acknowledge`, RV, R, [201], [IMM, ...IDEM]),
  mk(34, "getQcStatusBoard", "GET", "/qc-status", RD, N, [200], [], L),
  mk(35, "getLeveyJenningsChart", "GET", "/lj-chart", RD, N, [200], []),
  mk(36, "getAutoverifyRuleSet", "GET", "/autoverify/rule-set", AR, N, [200], []),
  mk(37, "createAutoverifyVersion", "POST", "/autoverify/versions", AM, R, [201], [RSI, ...IDEM]),
  mk(38, "getAutoverifyVersion", "GET", V, AR, N, [200], []),
  mk(39, "replaceAutoverifyDraft", "PUT", V, AM, N, [200], [RSI, RST, VC, PRE], IM),
  mk(40, "startAutoverifySimulation", "POST", `${V}/start-simulation`, AM, O, [200], [RST, VC, PRE], IM),
  mk(41, "stopAutoverifySimulation", "POST", `${V}/stop-simulation`, AM, O, [200], [RST, VC, PRE], IM),
  mk(42, "getAutoverifySimulationReport", "GET", `${V}/simulation-report`, AR, N, [200], []),
  mk(43, "activateAutoverifyVersion", "POST", `${V}/activate`, AM, O, [200], ["quality.simulation_incomplete", "quality.self_activation_forbidden", RST, VC, PRE], IM),
  mk(44, "retireAutoverifyVersion", "POST", `${V}/retire`, AM, O, [200], [RST, VC, PRE], IM),
  mk(45, "discardAutoverifyDraft", "POST", `${V}/discard`, AM, O, [200], [RST, VC, PRE], IM),
  mk(46, "listAutoverifyDecisions", "GET", "/autoverify/decisions", AR, N, [200], [], L),
  mk(47, "getAutoverifyDecision", "GET", "/autoverify/decisions/{decision_id}", AR, N, [200], []),
  mk(48, "listTatAlerts", "GET", "/tat-alerts", TR, N, [200], [], L),
  mk(49, "getTatAlert", "GET", TI, TR, N, [200], []),
  mk(50, "acknowledgeTatAlert", "POST", `${TI}/acknowledge`, TA, R, [200], [IMM, ...IDEM, VC, PRE], IM),
  mk(51, "getQualitySettings", "GET", "/settings", RD, N, [200], []),
  mk(52, "updateQualitySettings", "PUT", "/settings", CM, N, [200], [VC, PRE], IM),
  mk(53, "listQualityCodedSet", "GET", "/coded-sets/{set_name}", RD, N, [200], []),
  mk(54, "upsertQualityCode", "PUT", "/coded-sets/{set_name}/codes/{code}", CM, O, [200], []),
];
const TOTAL = 54;

// ---- §5.10 DTOs: "?" marks optional (TRD "field?")
const DTO: Record<string, string[]> = {
  ControlMaterialDto: ["id", "version", "code", "name", "manufacturer", "matrix", "is_active", "levels", "lots_expiring_30d", "created_at"],
  ControlLevelDto: ["id", "version", "material_id", "level_code", "display_name", "sort_order", "is_active", "lots?"],
  ControlLotDto: ["id", "version", "level_id", "material_id", "lot_no", "expires_on", "is_expired", "is_active"],
  ControlIdMapDto: ["id", "version", "instrument_id", "instrument_label?", "control_id_raw", "control_lot_raw", "lot_id", "is_active"],
  QcPlanDto: ["id", "version", "instrument_id", "instrument_label?", "test_id", "analyte_id", "analyte_code", "analyte_name", "unit_code", "decimals", "status", "current_version_no", "params",
    "rule_set_preview", "effective_from"],
  QcTargetDto: ["id", "version", "plan_id", "lot_id", "level_id", "mean", "sd", "cv_pct", "unit_code", "source", "basis?", "status", "effective_from", "effective_to", "note",
    "created_by_display", "activated_by_display"],
  QcObservationDto: ["id", "version", "plan_id?", "instrument_id", "analyte_id?", "level_id?", "lot_id?", "control_id_raw", "control_lot_raw", "control_level_raw", "value", "unit_code",
    "observed_at", "received_at", "observed_at_basis", "source", "status", "qc_run_id?", "z", "target_id?", "excluded?"],
  QcRunSummaryDto: ["id", "version", "plan_id", "instrument_id", "analyte_id", "run_at", "status", "outcome", "is_complete", "observation_count", "controls_per_run", "rule_mode",
    "warning_rules", "rules_violated", "needs_action", "needs_action_reason?", "closed_at"],
  CorrectiveActionDto: ["id", "qc_run_id", "action_code", "action_display", "description", "performed_at", "performed_by_display", "created_at"],
  QcRunReviewDto: ["id", "qc_run_id", "kind", "comment?", "reviewed_by_display", "created_at"],
  QcStatusRowDto: ["plan_id", "instrument_id", "instrument_label?", "analyte_id", "analyte_code", "status", "last_in_control_run_at?", "current_run_id?", "violated_rules", "open_rejected_run_ids",
    "qc_overdue", "patient_results_since_last_qc", "last_patient_result_at?"],
  AutoverifyRuleSetDto: ["id", "version", "active_version_id?", "simulating_version_id?", "versions"],
  AutoverifyVersionDto: ["id", "rule_set_id", "version_no", "version", "status", "definition", "rule_count", "created_at", "created_by_display", "simulation_started_at?",
    "simulation_stopped_at?", "activated_at?", "activated_by_display?", "retired_at?"],
  AutoverifyDecisionDto: ["id", "decided_at", "mode", "decision", "reasons", "result_id", "analyte_id", "instrument_id?", "version_id?", "matched_rule_key?", "qc_status", "qc_run_id?", "inputs?"],
  TatAlertDto: ["tat_item_id", "version", "order_id", "order_item_id", "test_id", "test_code", "department_id", "specimen_id", "centre_id", "priority", "segment", "segment_label",
    "start_basis", "target_seconds", "started_at", "elapsed_seconds", "pct_of_target", "alert_level", "acknowledged_level?", "acknowledged_at?", "acknowledged_by_display?", "state"],
  QualitySettingsDto: ["version", "tat_alerts_enabled", "tat_warn_pct", "tat_escalate_pct", "tat_orphan_close_hours", "target_min_points", "sim_min_days", "sim_min_decisions",
    "reprocess_window_days", "default_plan_params", "activated_at", "updated_at", "updated_by_display", "westgard_mode", "auto_verification_enabled"],
  SimulationReportDto: ["version_id", "started_at", "days_running", "decisions", "would_allow", "would_deny", "deny_by_reason", "allow_later_manually_verified", "allow_not_verified_yet",
    "live_comparison?", "sample"],
  LjChartDto: ["plan", "view", "series", "truncated"],
};
const QCRUN_EXTRA = ["plan_version_no", "observations", "rule_detail", "hold", "corrective_actions", "reviews", "evaluated_at", "evaluated_by"];
const TATDETAIL_EXTRA = ["restart_count", "first_verified_at", "stopped_at", "stop_source", "level_events", "acknowledgements"];
const PLAN_PARAMS = ["controls_per_run", "composition", "mean_rule", "two_two_s_across_runs", "count_rules_across_materials", "exclude_rejected_runs_from_history", "run_window_minutes",
  "qc_validity_hours", "hold_lookback_hours"];
const SETTINGS_KEYS = ["tat_alerts_enabled", "tat_warn_pct", "tat_escalate_pct", "tat_orphan_close_hours", "target_min_points", "sim_min_days", "sim_min_decisions", "reprocess_window_days",
  "default_plan_params"];
// responses: operationId -> DTO component name (single object) / list item name ({data, page})
const ONE: Record<string, string> = { createControlMaterial: "ControlMaterialDto", getControlMaterial: "ControlMaterialDto", updateControlMaterial: "ControlMaterialDto",
  deactivateControlMaterial: "ControlMaterialDto", createControlLevel: "ControlLevelDto", updateControlLevel: "ControlLevelDto", createControlLot: "ControlLotDto",
  updateControlLot: "ControlLotDto", createControlIdMap: "ControlIdMapDto", deactivateControlIdMap: "ControlIdMapDto", createQcPlan: "QcPlanDto", getQcPlan: "QcPlanDto",
  createQcPlanVersion: "QcPlanDto", activateQcPlan: "QcPlanDto", deactivateQcPlan: "QcPlanDto", createQcTarget: "QcTargetDto", establishQcTarget: "QcTargetDto",
  activateQcTarget: "QcTargetDto", retireQcTarget: "QcTargetDto", discardQcTarget: "QcTargetDto", excludeQcObservation: "QcObservationDto", getQcRun: "QcRunDto",
  evaluateQcRunNow: "QcRunDto", closeQcRun: "QcRunDto", recordCorrectiveAction: "CorrectiveActionDto", acknowledgeQcRun: "QcRunReviewDto", getLeveyJenningsChart: "LjChartDto",
  getAutoverifyRuleSet: "AutoverifyRuleSetDto", createAutoverifyVersion: "AutoverifyVersionDto", getAutoverifyVersion: "AutoverifyVersionDto",
  replaceAutoverifyDraft: "AutoverifyVersionDto", startAutoverifySimulation: "AutoverifyVersionDto", stopAutoverifySimulation: "AutoverifyVersionDto",
  getAutoverifySimulationReport: "SimulationReportDto", activateAutoverifyVersion: "AutoverifyVersionDto", retireAutoverifyVersion: "AutoverifyVersionDto",
  discardAutoverifyDraft: "AutoverifyVersionDto", getAutoverifyDecision: "AutoverifyDecisionDto", getTatAlert: "TatAlertDetailDto", acknowledgeTatAlert: "TatAlertDto",
  getQualitySettings: "QualitySettingsDto", updateQualitySettings: "QualitySettingsDto" };
const PAGED: Record<string, string> = { listControlMaterials: "ControlMaterialDto", listControlLots: "ControlLotDto", listControlIdMaps: "ControlIdMapDto", listQcPlans: "QcPlanDto",
  listQcTargets: "QcTargetDto", listQcObservations: "QcObservationDto", listQcRuns: "QcRunSummaryDto", getQcStatusBoard: "QcStatusRowDto", listAutoverifyDecisions: "AutoverifyDecisionDto",
  listTatAlerts: "TatAlertDto" };
const WITH_GENERATED_AT = ["getQcStatusBoard", "listTatAlerts"];
const PHI_FIELDS = ["patient_name", "full_name", "barcode", "registration_no", "phone", "phone_e164", "email", "birth_date", "birth_on"];

const tmps: string[] = [];
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("quality.yaml (T0C-10.C9)", () => {
  const text = existsSync(FILE) ? readFileSync(FILE, "utf8") : "";
  const doc: any = text ? parse(text) : { paths: {}, components: {} };
  const ops: Record<string, { method: string; path: string; op: any }> = {};
  for (const [path, item] of Object.entries<any>(doc.paths ?? {}))
    for (const m of METHODS) if (item?.[m]) ops[item[m].operationId] = { method: m.toUpperCase(), path, op: item[m] };

  const deref = (n: any): any => {
    if (!n?.$ref) return n;
    const [file, ptr] = n.$ref.split("#");
    let cur: any = file === "_common.yaml" ? common : doc;
    for (const k of ptr.split("/").slice(1)) cur = cur?.[k.replace(/~1/g, "/").replace(/~0/g, "~")];
    return deref(cur);
  };
  const props = (s: any): Record<string, any> => {
    const n = deref(s) ?? {};
    return Object.assign({}, ...(n.allOf ?? []).map(props), n.properties ?? {});
  };
  const reqd = (s: any): string[] => {
    const n = deref(s) ?? {};
    return [...(n.required ?? []), ...(n.allOf ?? []).flatMap(reqd)];
  };
  const keys = (s: any) => Object.keys(props(s));
  const sorted = (s: any) => keys(s).sort();
  const schema = (n: string) => doc.components?.schemas?.[n];
  const prop = (n: string, f: string) => deref(props(schema(n))[f]);
  const bodySchema = (id: string) => deref(ops[id]?.op.requestBody?.content?.["application/json"]?.schema);
  const bp = (id: string, f: string) => deref(props(bodySchema(id))[f]);
  const rawBp = (id: string, f: string) => props(bodySchema(id))[f];
  const params = (id: string) => (ops[id]?.op.parameters ?? []).map(deref);
  const param = (id: string, pname: string) => params(id).find((q: any) => q?.name === pname);
  const pschema = (id: string, pname: string) => deref(param(id, pname)?.schema);
  const names = (id: string, where = "query") => params(id).filter((q: any) => q?.in === where).map((q: any) => q.name);
  const okResp = (id: string, code?: string) => {
    const e = Object.entries<any>(ops[id].op.responses).find(([c]) => (code ? c === code : /^2/.test(c)));
    expect(e, `${id}: no ${code ?? "2xx"} response`).toBeDefined();
    return deref(e![1]);
  };
  const okSchema = (id: string, code?: string) => deref(okResp(id, code).content?.["application/json"]?.schema);
  const has = (id: string) => expect(ops[id], `${id} missing`).toBeDefined();
  const ex = () => expect(existsSync(FILE), "contracts/openapi/quality.yaml missing").toBe(true);
  const T = (title: string, fn: () => void) => it(title, () => { ex(); fn(); });
  const coded = (s: any, set: string) => {
    expect(s?.["x-coded-set"], "x-coded-set").toBe(`quality.${set}`);
    expect(s.enum, "coded-set field must not declare enum").toBeUndefined();
  };
  const item = (s: any) => deref(deref(s).items);
  const enumIs = (s: any, want: unknown[]) => expect([...(s?.enum ?? [])].sort(), `enum of ${JSON.stringify(s)}`).toEqual([...want].sort());
  const int = (s: any, min: number | undefined, max: number | undefined) => expect([s?.type, s?.minimum, s?.maximum]).toEqual(["integer", min, max]);
  const len = (s: any, min: number | undefined, max: number) => expect([s?.minLength, s?.maxLength]).toEqual([min, max]);
  const walk = (s: any, fn: (n: any) => void, seen = new Set<any>()) => {
    const n = deref(s);
    if (!n || typeof n !== "object" || seen.has(n)) return;
    seen.add(n);
    fn(n);
    for (const a of [...(n.allOf ?? []), ...(n.oneOf ?? []), ...(n.anyOf ?? [])]) walk(a, fn, seen);
    for (const q of Object.values(n.properties ?? {})) walk(q, fn, seen);
    if (n.items) walk(n.items, fn, seen);
  };
  const allKeys = (s: any) => { const out = new Set<string>(); walk(s, (n) => Object.keys(n.properties ?? {}).forEach((k) => out.add(k))); return [...out]; };
  const dtoReq = (f: string[]) => f.filter((x) => !x.endsWith("?"));
  const dtoOpt = (f: string[]) => f.filter((x) => x.endsWith("?")).map((x) => x.slice(0, -1));
  const dtoKeys = (f: string[]) => f.map((x) => x.replace(/\?$/, "")).sort();
  const shape = (s: any, fields: string[], label: string) => {
    expect(s, `${label} schema missing`).toBeDefined();
    expect(sorted(s), `${label} fields`).toEqual(dtoKeys(fields));
    if (fields.includes("id")) expect(reqd(s), `${label} required`).toContain("id");
    for (const o of dtoOpt(fields)) expect(reqd(s), `${label}.${o} optional`).not.toContain(o);
  };
  const dataOf = (id: string) => item(props(okSchema(id)).data);
  const req = (id: string, ...f: string[]) => f.forEach((x) => expect(param(id, x)?.required, `${id}?${x} required`).toBe(true));
  const opt = (id: string, ...f: string[]) => f.forEach((x) => { expect(param(id, x), `${id}?${x}`).toBeDefined(); expect(param(id, x).required, `${id}?${x} optional`).not.toBe(true); });
  const r = (id: string) => [...reqd(bodySchema(id))].sort();
  const isUuid = (s: any) => expect(s?.format).toBe("uuid");
  const uuids = (id: string, ...p: string[]) => p.forEach((x) => isUuid(pschema(id, x)));
  const bools = (id: string, ...p: string[]) => p.forEach((x) => expect(pschema(id, x)?.type, `${id}?${x}`).toBe("boolean"));
  const dts = (id: string, ...p: string[]) => p.forEach((x) => expect(pschema(id, x)?.format, `${id}?${x}`).toBe("date-time"));
  const emptyBody = (id: string) => { const b = bodySchema(id); expect(keys(b), id).toEqual([]); expect(b.additionalProperties, id).toBe(false); };
  const bodyInts = (id: string, f: string, min: number, max: number) => int(bp(id, f), min, max);

  describe("exists and is OAS 3.0.3 (AC-0C-1.4)", () => {
    it("file exists", () => expect(existsSync(FILE), "contracts/openapi/quality.yaml missing").toBe(true));
    it("first non-comment line is `openapi: 3.0.3`", () => {
      const first = text.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith("#"));
      expect(first?.trim()).toBe("openapi: 3.0.3");
    });
    it("info.title and version present; no `nullable: true` (no null on the wire, CV §4.2)", () => {
      expect(typeof doc.info?.title).toBe("string");
      expect(typeof doc.info?.version).toBe("string");
      expect(text.length, "empty").toBeGreaterThan(0);
      expect(text).not.toMatch(/nullable:\s*true/);
    });
    it("the LD-103 decision is cited in a comment", () => expect(text).toMatch(/LD-103/));
  });

  describe("repo spec lint is green (AC-0C-1.4, rules 1–8)", () => {
    it("lintRepo reports no violation", async () => {
      ex();
      const v = (await lintRepo(ROOT)).filter((x) => x.file === name);
      expect(v, v.map((x) => `[rule ${x.rule}] ${x.message}`).join("\n")).toEqual([]);
    });
  });

  describe("lint actually checks this file (AC-0C-1.5 negative)", () => {
    const mutate = async (fn: (d: any) => void) => {
      ex();
      const dir = mkdtempSync(join(tmpdir(), "c9-quality-lint-"));
      tmps.push(dir);
      cpSync(join(ROOT, "contracts"), join(dir, "contracts"), { recursive: true, filter: (s) => !s.includes("node_modules") });
      const d = parse(readFileSync(FILE, "utf8"));
      fn(d);
      writeFileSync(join(dir, "contracts/openapi/quality.yaml"), stringify(d, { aliasDuplicateObjects: false }));
      return (await lintRepo(dir)).filter((x) => x.file === name);
    };
    const firstOp = (d: any, pred: (o: any) => boolean) =>
      Object.values<any>(d.paths).flatMap((q) => METHODS.map((m) => q[m]).filter(Boolean)).find(pred);

    it("x-permission not in permissions.yaml fails", async () => {
      const v = await mutate((d) => { firstOp(d, (o) => "x-permission" in o)["x-permission"] = "quality.no_such.permission"; });
      expect(v.some((x) => x.rule === "4" && /x-permission/.test(x.message))).toBe(true);
    });
    it("x-error-codes entry not in errors.yaml fails", async () => {
      const v = await mutate((d) => { firstOp(d, (o) => Array.isArray(o["x-error-codes"]))["x-error-codes"].push("quality.no_such_error"); });
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
    it("an operation with both x-permission and x-public fails (exactly one)", async () => {
      const v = await mutate((d) => { firstOp(d, (o) => "x-permission" in o)["x-public"] = "bogus public justification text"; });
      expect(v.some((x) => x.rule === "4" && /exactly one/.test(x.message))).toBe(true);
    });
    it("a coded-set field that also declares enum fails (rule 6)", async () => {
      const v = await mutate((d) => {
        const s = Object.values<any>(d.components?.schemas ?? {}).flatMap((x: any) => Object.values<any>(x?.properties ?? {})).find((x) => "x-coded-set" in x);
        s.enum = ["a"];
      });
      expect(v.some((x) => x.rule === "6")).toBe(true);
    });
  });

  describe("quality equals 02-TRD §5 (no missing, no extra operations)", () => {
    it(`${TOTAL} operations; table rows unique; file has exactly these`, () => {
      expect(SPECS.length).toBe(TOTAL);
      expect(new Set(SPECS.map((s) => s.id)).size).toBe(TOTAL);
      expect(new Set(SPECS.map((s) => s.row)).size).toBe(TOTAL);
      expect(Object.keys(ops).sort()).toEqual(SPECS.map((s) => s.id).sort());
    });
    it("TRD drift guard: §5.1–5.8 rows = test rows (row number, operationId, first permission)", () => {
      const all = readFileSync(TRD, "utf8").split("\n");
      const start = all.findIndex((l) => l.startsWith("### 5.1 "));
      const end = all.findIndex((l, k) => k > start && l.startsWith("### 5.9 "));
      expect(start).toBeGreaterThanOrEqual(0);
      const rows = new Map<string, { id: string; perm: string }>();
      for (const l of all.slice(start, end)) {
        const c = l.split("|");
        const row = (c[1] ?? "").trim();
        if (!/^\d+$/.test(row)) continue;
        rows.set(row, { id: /`([a-z][A-Za-z0-9]+)`/.exec(c[3] ?? "")![1], perm: /(quality\.[a-z_.]+)/.exec(c[4] ?? "")![1] });
      }
      expect([...rows.keys()].sort(), "row numbers").toEqual(SPECS.map((s) => s.row).sort());
      for (const s of SPECS) expect(rows.get(s.row), `#${s.row}`).toEqual({ id: s.id, perm: s.perm });
    });
    T("every path is /v1/quality/… with tags [quality]; every path param is a required `*_id` uuid or set_name/code; no PHI query params", () => {
      expect(Object.keys(doc.paths ?? {}).length, "no paths").toBeGreaterThan(0);
      for (const [q, it_] of Object.entries<any>(doc.paths ?? {})) {
        expect(q.startsWith(`${PFX}/`), q).toBe(true);
        for (const m of METHODS) if (it_[m]) expect(it_[m].tags, `${m} ${q}`).toEqual([name]);
      }
      for (const id of Object.keys(ops))
        for (const q of params(id)) if (q?.in === "query") expect(PHI_FIELDS, `${id}?${q.name}`).not.toContain(q.name);
    });
  });

  describe.each(SPECS)("#$row $id", (s) => {
    const o = ops[s.id]?.op;
    it("exists at the TRD method + path", () => {
      has(s.id);
      expect(`${ops[s.id].method} ${ops[s.id].path}`).toBe(`${s.method} ${PFX}${s.path}`);
    });
    it("has tags, summary, x-idempotency (TRD Idem), x-rate-limit-tier general, x-error-codes", () => {
      has(s.id);
      expect(o.tags).toEqual([name]);
      expect(typeof o.summary).toBe("string");
      expect(o["x-idempotency"]).toBe(s.idem);
      expect(o["x-rate-limit-tier"]).toBe("general");
      expect(Array.isArray(o["x-error-codes"])).toBe(true);
    });
    it(`x-permission = ${s.perm} (one code), never x-public; security bearerJwt; tenant context only`, () => {
      has(s.id);
      expect(o["x-permission"]).toBe(s.perm);
      expect(o["x-public"]).toBeUndefined();
      expect(o.security).toEqual([{ bearerJwt: [] }]);
      expect([undefined, "tenant"]).toContain(o["x-context"]);
    });
    it("success response status(es)", () => {
      has(s.id);
      const codes = Object.keys(o.responses ?? {});
      for (const c of s.status) expect(codes, `want ${c}`).toContain(String(c));
      expect(codes.some((c) => /^2/.test(c)), "some 2xx").toBe(true);
    });
    it("lists §5.0 common codes (incl. feature_disabled) + the TRD row's specific codes; mfa only on privileged; nothing outside §5.0 ∪ row", () => {
      has(s.id);
      const got: string[] = o["x-error-codes"];
      for (const c of [...BASE, ...s.err]) expect(got, c).toContain(c);
      if (PRIVILEGED.has(s.perm)) expect(got, "privileged permission").toContain(MFA);
      else expect(got, "non-privileged op").not.toContain(MFA);
      if (s.idem !== "required") expect(got, "idempotency key code on non-R op").not.toContain("common.idempotency_key_required");
      if (!s.im) expect(got, "no If-Match on this op").not.toContain(PRE);
      const allowed = new Set([...BASE, ...s.err, ...(PRIVILEGED.has(s.perm) ? [MFA] : []), ...(s.paged ? [CURSOR] : []), ...(s.method !== "GET" ? [VC] : [])]);
      expect(got.filter((c) => !allowed.has(c)), "x-error-codes outside §5.0 ∪ row (§5.9: exactly)").toEqual([]);
    });
    it("Idempotency-Key header where x-idempotency required, none where none; If-Match exactly on rows whose Request says If-Match", () => {
      has(s.id);
      const ps = JSON.stringify(o.parameters ?? []);
      if (s.idem === "required") expect(ps).toMatch(/IdempotencyKey|Idempotency-Key/);
      if (s.idem === "none") expect(ps).not.toMatch(/IdempotencyKey|Idempotency-Key/);
      if (s.im) expect(ps).toMatch(/IfMatch|If-Match/);
      else expect(ps).not.toMatch(/IfMatch|If-Match/);
    });
    it("declares 403 (permission, mfa/feature_disabled) and 404 responses; 409 on mutations with specific 409 codes", () => {
      has(s.id);
      const codes = Object.keys(o.responses ?? {});
      for (const c of ["400", "401", "403", "404", "429", "500", "503"]) expect(codes, c).toContain(c);
      if (s.im) for (const c of ["409", "428"]) expect(codes, c).toContain(c);
      if (s.idem === "required") for (const c of ["400", "409", "422"]) expect(codes, c).toContain(c);
    });
    if (s.paged)
      it("takes cursor + limit (max 200, default 50)", () => {
        has(s.id);
        const ps = JSON.stringify(o.parameters ?? []);
        expect(ps).toMatch(/cursor|Cursor/);
        expect(ps).toMatch(/limit|Limit/);
        const lim = pschema(s.id, "limit");
        expect([lim?.maximum, lim?.default]).toEqual([200, 50]);
      });
  });

  describe("query and path parameters (TRD §5.1–5.8)", () => {
    T("#1 listControlMaterials: is_active (default true), q ≤40, sort enum", () => {
      const s = "listControlMaterials";
      opt(s, "is_active", "q", "sort");
      expect([pschema(s, "is_active").type, pschema(s, "is_active").default]).toEqual(["boolean", true]);
      expect(pschema(s, "q").maxLength).toBe(40);
      enumIs(pschema(s, "sort"), ["code", "-created_at"]);
    });
    T("#9 listControlLots params and sort enum", () => {
      const s = "listControlLots";
      opt(s, "material_id", "level_id", "is_active", "expires_on_to", "sort");
      uuids(s, "material_id", "level_id");
      bools(s, "is_active");
      expect(pschema(s, "expires_on_to").format).toBe("date");
      enumIs(pschema(s, "sort"), ["expires_on", "-created_at"]);
    });
    T("#11 listControlIdMaps / #14 listQcPlans / #20 listQcTargets filters", () => {
      opt("listControlIdMaps", "instrument_id", "lot_id", "is_active");
      uuids("listControlIdMaps", "instrument_id", "lot_id");
      bools("listControlIdMaps", "is_active");
      opt("listQcPlans", "instrument_id", "analyte_id", "status");
      uuids("listQcPlans", "instrument_id", "analyte_id");
      enumIs(pschema("listQcPlans", "status"), ["active", "inactive"]);
      opt("listQcTargets", "plan_id", "lot_id", "status");
      uuids("listQcTargets", "plan_id", "lot_id");
      expect(pschema("listQcTargets", "status").type).toBe("string"); // csv of draft|active|superseded|retired|discarded
    });
    T("#26 listQcObservations params, date-time bounds, sort enum", () => {
      const s = "listQcObservations";
      opt(s, "plan_id", "instrument_id", "analyte_id", "level_id", "lot_id", "status", "observed_at_from", "observed_at_to", "sort");
      uuids(s, "plan_id", "instrument_id", "analyte_id", "level_id", "lot_id");
      dts(s, "observed_at_from", "observed_at_to");
      expect(pschema(s, "status").type).toBe("string");
      enumIs(pschema(s, "sort"), ["-observed_at", "observed_at"]);
    });
    T("#28 listQcRuns params, needs_action boolean, sort enum -run_at only", () => {
      const s = "listQcRuns";
      opt(s, "plan_id", "instrument_id", "analyte_id", "status", "outcome", "needs_action", "run_at_from", "run_at_to", "sort");
      uuids(s, "plan_id", "instrument_id", "analyte_id");
      bools(s, "needs_action");
      dts(s, "run_at_from", "run_at_to");
      for (const f of ["status", "outcome"]) expect(pschema(s, f).type, f).toBe("string");
      enumIs(pschema(s, "sort"), ["-run_at"]);
    });
    T("#34 getQcStatusBoard: instrument_id uuid, status csv, overdue_only boolean", () => {
      const s = "getQcStatusBoard";
      opt(s, "instrument_id", "status", "overdue_only");
      uuids(s, "instrument_id");
      bools(s, "overdue_only");
    });
    T("#35 getLeveyJenningsChart: plan_id + observed_at_from/to required; view enum default level; level_id/lot_id optional", () => {
      const s = "getLeveyJenningsChart";
      req(s, "plan_id", "observed_at_from", "observed_at_to");
      opt(s, "view", "level_id", "lot_id");
      uuids(s, "plan_id", "level_id", "lot_id");
      dts(s, "observed_at_from", "observed_at_to");
      enumIs(pschema(s, "view"), ["level", "z"]);
      expect(pschema(s, "view").default).toBe("level");
    });
    T("#42 sample_limit integer 0..200 default 50", () => {
      const q = pschema("getAutoverifySimulationReport", "sample_limit");
      int(q, 0, 200);
      expect(q.default).toBe(50);
    });
    T("#46 listAutoverifyDecisions: decided_at_from/to required; mode/decision enums; sort -decided_at", () => {
      const s = "listAutoverifyDecisions";
      req(s, "decided_at_from", "decided_at_to");
      opt(s, "result_id", "analyte_id", "instrument_id", "version_id", "mode", "decision", "reason", "sort");
      uuids(s, "result_id", "analyte_id", "instrument_id", "version_id");
      dts(s, "decided_at_from", "decided_at_to");
      enumIs(pschema(s, "mode"), ["live", "shadow"]);
      enumIs(pschema(s, "decision"), ["allow", "deny"]);
      enumIs(pschema(s, "sort"), ["-decided_at"]);
    });
    T("#48 listTatAlerts: level csv, acknowledged boolean, segment/priority enums, sort enum", () => {
      const s = "listTatAlerts";
      opt(s, "level", "acknowledged", "segment", "department_id", "centre_id", "priority", "sort");
      expect(pschema(s, "level").type).toBe("string");
      bools(s, "acknowledged");
      uuids(s, "department_id", "centre_id");
      enumIs(pschema(s, "segment"), ["within_lab", "total"]);
      enumIs(pschema(s, "priority"), ["routine", "urgent"]);
      enumIs(pschema(s, "sort"), ["-alert_level_rank", "-pct_of_target", "started_at"]);
    });
    T("#53/#54 set_name path enum = corrective_actions | exclusion_reasons; #54 `code` path param", () => {
      enumIs(pschema("listQualityCodedSet", "set_name"), ["corrective_actions", "exclusion_reasons"]);
      enumIs(pschema("upsertQualityCode", "set_name"), ["corrective_actions", "exclusion_reasons"]);
      expect(param("upsertQualityCode", "code")?.in).toBe("path");
    });
    T("path ids (`*_id`) are required uuids; every path parameter is required", () => {
      for (const id of Object.keys(ops))
        for (const q of params(id).filter((x: any) => x?.in === "path")) {
          expect(q.required, `${id}:${q.name}`).toBe(true);
          if (/_id$/.test(q.name)) isUuid(deref(q.schema));
        }
    });
  });

  describe("request bodies (TRD §5.1–5.8)", () => {
    T("#2 createControlMaterial: code pattern, name 1..120, manufacturer ≤120, matrix ≤60, levels 1..6 {level_code, display_name, sort_order}", () => {
      const s = "createControlMaterial";
      expect(bp(s, "code").pattern).toBe("^[A-Z0-9_-]{2,32}$");
      len(bp(s, "name"), 1, 120);
      expect(bp(s, "manufacturer").maxLength).toBe(120);
      expect(bp(s, "matrix").maxLength).toBe(60);
      const lv = bp(s, "levels");
      expect([lv.type, lv.minItems, lv.maxItems]).toEqual(["array", 1, 6]);
      expect(Object.keys(props(item(lv))).sort()).toEqual(["display_name", "level_code", "sort_order"]);
      expect(reqd(item(lv)).sort()).toEqual(["display_name", "level_code", "sort_order"]);
      expect(deref(props(item(lv)).level_code).pattern).toBe("^[A-Za-z0-9]{1,16}$");
      len(deref(props(item(lv)).display_name), 1, 60);
      int(deref(props(item(lv)).sort_order), 0, 99);
      expect(r(s)).toEqual(["code", "levels", "name"]);
    });
    T("#4 updateControlMaterial: name, manufacturer, matrix, unset ∈ {manufacturer, matrix}[]; nothing required", () => {
      const s = "updateControlMaterial";
      expect(sorted(bodySchema(s))).toEqual(["manufacturer", "matrix", "name", "unset"]);
      enumIs(item(bp(s, "unset")), ["manufacturer", "matrix"]);
      expect(bp(s, "unset").type).toBe("array");
      expect(r(s)).toEqual([]);
    });
    T("#5 #13 #18 #25 #40 #41 #45: empty object body (additionalProperties false)", () => {
      for (const id of ["deactivateControlMaterial", "deactivateControlIdMap", "activateQcPlan", "discardQcTarget", "startAutoverifySimulation", "stopAutoverifySimulation", "discardAutoverifyDraft"])
        emptyBody(id);
    });
    T("#6 createControlLevel: level_code pattern, display_name 1..60, sort_order 0..99 (all required); #7 updateControlLevel: display_name, sort_order, is_active", () => {
      const s = "createControlLevel";
      expect(bp(s, "level_code").pattern).toBe("^[A-Za-z0-9]{1,16}$");
      len(bp(s, "display_name"), 1, 60);
      int(bp(s, "sort_order"), 0, 99);
      expect(r(s)).toEqual(["display_name", "level_code", "sort_order"]);
      expect(sorted(bodySchema("updateControlLevel"))).toEqual(["display_name", "is_active", "sort_order"]);
      expect(r("updateControlLevel")).toEqual([]);
    });
    T("#8 createControlLot: lot_no = DB control_lots__lot__ck pattern (verbatim), expires_on date; #10 updateControlLot: expires_on?, is_active?", () => {
      const s = "createControlLot";
      expect(bp(s, "lot_no").pattern).toBe("^[\\x21-\\x7E]([\\x20-\\x7E]{0,62}[\\x21-\\x7E])?$");
      expect(bp(s, "expires_on").format).toBe("date");
      expect(r(s)).toEqual(["expires_on", "lot_no"]);
      expect(sorted(bodySchema("updateControlLot"))).toEqual(["expires_on", "is_active"]);
      expect(bp("updateControlLot", "expires_on").format).toBe("date");
      expect(r("updateControlLot")).toEqual([]);
    });
    T("#12 createControlIdMap: instrument_id, lot_id uuid; control_id_raw 1..64; control_lot_raw 1..64 optional", () => {
      const s = "createControlIdMap";
      isUuid(bp(s, "instrument_id"));
      isUuid(bp(s, "lot_id"));
      len(bp(s, "control_id_raw"), 1, 64);
      len(bp(s, "control_lot_raw"), 1, 64);
      expect(r(s)).toEqual(["control_id_raw", "instrument_id", "lot_id"]);
    });
    T("#15 createQcPlan: instrument_id, test_id, analyte_id uuid, params QcPlanParams — all required; 201 carries `warnings` ⊆ {instrument_code_unmapped}", () => {
      const s = "createQcPlan";
      for (const f of ["instrument_id", "test_id", "analyte_id"]) isUuid(bp(s, f));
      expect(JSON.stringify(rawBp(s, "params"))).toContain("QcPlanParams");
      expect(r(s)).toEqual(["analyte_id", "instrument_id", "params", "test_id"]);
      const w = deref(props(okSchema(s, "201")).warnings);
      expect(w?.type).toBe("array");
      enumIs(item(w), ["instrument_code_unmapped"]);
    });
    T("#16 getQcPlan response carries versions[]; #17 createQcPlanVersion: params QcPlanParams + change_reason 1..500 required", () => {
      expect(keys(okSchema("getQcPlan"))).toEqual(expect.arrayContaining([...dtoKeys(DTO.QcPlanDto), "versions"]));
      expect(deref(props(okSchema("getQcPlan")).versions).type).toBe("array");
      const s = "createQcPlanVersion";
      expect(JSON.stringify(rawBp(s, "params"))).toContain("QcPlanParams");
      len(bp(s, "change_reason"), 1, 500);
      expect(r(s)).toEqual(["change_reason", "params"]);
    });
    T("#19 deactivateQcPlan / #24 retireQcTarget / #44 retireAutoverifyVersion: reason 1..500 required", () => {
      for (const s of ["deactivateQcPlan", "retireQcTarget", "retireAutoverifyVersion"]) {
        len(bp(s, "reason"), 1, 500);
        expect(r(s), s).toEqual(["reason"]);
      }
    });
    T("#21 createQcTarget: plan_id, lot_id uuid; mean, sd DecimalString; unit_code Code; source enum [manufacturer]; note ≤500", () => {
      const s = "createQcTarget";
      isUuid(bp(s, "plan_id"));
      isUuid(bp(s, "lot_id"));
      for (const f of ["mean", "sd", "unit_code"]) expect(JSON.stringify(rawBp(s, f)), f).toMatch(/DecimalString|Code|"type":"string"/);
      expect(JSON.stringify(rawBp(s, "mean"))).toContain("DecimalString");
      expect(JSON.stringify(rawBp(s, "sd"))).toContain("DecimalString");
      enumIs(bp(s, "source"), ["manufacturer"]);
      expect(bp(s, "note").maxLength).toBe(500);
      expect(r(s)).toEqual(["lot_id", "mean", "plan_id", "sd", "source", "unit_code"]);
    });
    T("#22 establishQcTarget: plan_id, lot_id, observed_at_from/to required; include/exclude uuid[] ≤500", () => {
      const s = "establishQcTarget";
      expect(sorted(bodySchema(s))).toEqual(["exclude_observation_ids", "include_observation_ids", "lot_id", "observed_at_from", "observed_at_to", "plan_id"]);
      expect(r(s)).toEqual(["lot_id", "observed_at_from", "observed_at_to", "plan_id"]);
      for (const f of ["observed_at_from", "observed_at_to"]) expect(bp(s, f).format, f).toBe("date-time");
      for (const f of ["include_observation_ids", "exclude_observation_ids"]) {
        expect([bp(s, f).type, bp(s, f).maxItems], f).toEqual(["array", 500]);
        isUuid(item(bp(s, f)));
      }
    });
    T("#23 activateQcTarget: effective_from date-time optional", () => {
      expect(sorted(bodySchema("activateQcTarget"))).toEqual(["effective_from"]);
      expect(bp("activateQcTarget", "effective_from").format).toBe("date-time");
      expect(r("activateQcTarget")).toEqual([]);
    });
    T("#27 excludeQcObservation: reason_code coded quality.exclusion_reasons (no enum) required, comment ≤500", () => {
      const s = "excludeQcObservation";
      coded(bp(s, "reason_code"), "exclusion_reasons");
      expect(bp(s, "comment").maxLength).toBe(500);
      expect(r(s)).toEqual(["reason_code"]);
    });
    T("#30 evaluateQcRunNow / #32 closeQcRun: comment ≤500 optional; #33 acknowledgeQcRun: comment 1..500 required", () => {
      for (const s of ["evaluateQcRunNow", "closeQcRun"]) {
        expect(bp(s, "comment").maxLength, s).toBe(500);
        expect(r(s), s).toEqual([]);
      }
      len(bp("acknowledgeQcRun", "comment"), 1, 500);
      expect(r("acknowledgeQcRun")).toEqual(["comment"]);
    });
    T("#31 recordCorrectiveAction: action_code coded quality.corrective_actions (no enum), description 1..1000, performed_at date-time; all required", () => {
      const s = "recordCorrectiveAction";
      coded(bp(s, "action_code"), "corrective_actions");
      len(bp(s, "description"), 1, 1000);
      expect(bp(s, "performed_at").format).toBe("date-time");
      expect(r(s)).toEqual(["action_code", "description", "performed_at"]);
    });
    T("#37 createAutoverifyVersion: copy_from_version_id uuid / definition RuleSetDefinition, exactly one (oneOf), neither top-level required", () => {
      const b = bodySchema("createAutoverifyVersion");
      expect(Object.keys({ ...props(b), ...Object.assign({}, ...(b.oneOf ?? []).map((v: any) => props(v))) }).sort()).toEqual(["copy_from_version_id", "definition"]);
      expect(r("createAutoverifyVersion")).toEqual([]);
      expect(Array.isArray(b.oneOf), "exactly one → oneOf").toBe(true);
      expect(JSON.stringify(b)).toContain("RuleSetDefinition");
      const cp = Object.values<any>({ ...props(b), ...Object.assign({}, ...(b.oneOf ?? []).map((v: any) => props(v))) }).find((x: any) => deref(x)?.format === "uuid");
      expect(cp, "copy_from_version_id uuid").toBeDefined();
    });
    T("#39 replaceAutoverifyDraft: definition RuleSetDefinition required", () => {
      expect(JSON.stringify(rawBp("replaceAutoverifyDraft", "definition"))).toContain("RuleSetDefinition");
      expect(r("replaceAutoverifyDraft")).toEqual(["definition"]);
    });
    T("#43 activateAutoverifyVersion: confirmation_text enum [ACTIVATE] required; 403 declared (self_activation_forbidden)", () => {
      const s = "activateAutoverifyVersion";
      enumIs(bp(s, "confirmation_text"), ["ACTIVATE"]);
      expect(r(s)).toEqual(["confirmation_text"]);
      expect(Object.keys(ops[s].op.responses)).toContain("403");
    });
    T("#50 acknowledgeTatAlert: note ≤500 optional", () => {
      expect(bp("acknowledgeTatAlert", "note").maxLength).toBe(500);
      expect(r("acknowledgeTatAlert")).toEqual([]);
    });
    T("#52 updateQualitySettings: the §12.1 mutable keys + ranges (read-only westgard_mode / auto_verification_enabled / version not accepted)", () => {
      const s = "updateQualitySettings";
      expect(sorted(bodySchema(s))).toEqual([...SETTINGS_KEYS].sort());
      bodyInts(s, "tat_warn_pct", 50, 99);
      bodyInts(s, "tat_escalate_pct", 101, 1000);
      bodyInts(s, "tat_orphan_close_hours", 1, 720);
      bodyInts(s, "target_min_points", 2, 500);
      bodyInts(s, "sim_min_days", 1, 90);
      bodyInts(s, "sim_min_decisions", 10, 100000);
      bodyInts(s, "reprocess_window_days", 1, 30);
      expect(bp(s, "tat_alerts_enabled").type).toBe("boolean");
      expect(bodySchema(s).additionalProperties).toBe(false);
    });
    T("#54 upsertQualityCode: display 1..120, sort_order 0..999, is_active boolean (all required); response = coded-set row", () => {
      const s = "upsertQualityCode";
      len(bp(s, "display"), 1, 120);
      bodyInts(s, "sort_order", 0, 999);
      expect(bp(s, "is_active").type).toBe("boolean");
      expect(r(s)).toEqual(["display", "is_active", "sort_order"]);
      expect(sorted(okSchema(s))).toEqual(["code", "display", "is_active", "sort_order", "source"]);
    });
    T("no request body anywhere carries tenant_id / membership_id / created_by (identity comes from the token)", () => {
      for (const id of Object.keys(ops).filter((x) => ops[x].op.requestBody))
        walk(bodySchema(id), (n) => { for (const k of ["tenant_id", "membership_id", "created_by"]) expect(Object.keys(n.properties ?? {}), `${id}.${k}`).not.toContain(k); });
    });
  });

  describe("QcPlanParams (§5.3), RuleSetDefinition (§8.2)", () => {
    T("QcPlanParams fields, required, ranges, defaults", () => {
      const s = schema("QcPlanParams");
      expect(s, "QcPlanParams").toBeDefined();
      expect(sorted(s)).toEqual([...PLAN_PARAMS].sort());
      expect(reqd(s).sort()).toEqual(["composition", "controls_per_run"]);
      enumIs(prop("QcPlanParams", "controls_per_run"), [2, 3, 4]);
      const c = prop("QcPlanParams", "composition");
      expect([c.type, c.minItems, c.maxItems]).toEqual(["array", 1, 4]);
      expect(Object.keys(props(item(c))).sort()).toEqual(["count", "level_id"]);
      expect(reqd(item(c)).sort()).toEqual(["count", "level_id"]);
      isUuid(deref(props(item(c)).level_id));
      int(deref(props(item(c)).count), 1, 4);
      enumIs(prop("QcPlanParams", "mean_rule"), ["8x", "10x", "12x", "6x", "9x"]);
      for (const f of ["two_two_s_across_runs", "count_rules_across_materials", "exclude_rejected_runs_from_history"]) {
        expect(prop("QcPlanParams", f).type, f).toBe("boolean");
        expect(prop("QcPlanParams", f).default, `${f} default`).toBe(true);
      }
      int(prop("QcPlanParams", "run_window_minutes"), 5, 240);
      int(prop("QcPlanParams", "qc_validity_hours"), 1, 168);
      int(prop("QcPlanParams", "hold_lookback_hours"), 1, 168);
      expect(prop("QcPlanParams", "run_window_minutes").default).toBe(30);
      expect(prop("QcPlanParams", "qc_validity_hours").default).toBe(24);
      expect(prop("QcPlanParams", "hold_lookback_hours").default).toBe(24);
      expect(s.additionalProperties).toBe(false);
    });
    T("RuleSetDefinition: schema_version 1, rules ≤2000; rule fields, key pattern, limits, flags, bounds (additionalProperties false everywhere)", () => {
      const s = schema("RuleSetDefinition");
      expect(s, "RuleSetDefinition").toBeDefined();
      expect(sorted(s)).toEqual(["rules", "schema_version"]);
      expect(reqd(s).sort()).toEqual(["rules", "schema_version"]);
      expect(s.additionalProperties).toBe(false);
      const sv = prop("RuleSetDefinition", "schema_version");
      expect(sv.enum ?? [sv.const]).toEqual([1]);
      const rules = prop("RuleSetDefinition", "rules");
      expect([rules.type, rules.maxItems]).toEqual(["array", 2000]);
      const rule = item(rules);
      expect(Object.keys(props(rule)).sort()).toEqual(["allowed_range_flags", "analyte_id", "enabled", "instrument_flags_allowed", "instrument_id", "key", "limits", "note",
        "qc_allow_warning", "test_id"]);
      expect(reqd(rule)).toEqual(expect.arrayContaining(["key", "test_id", "analyte_id"]));
      expect(reqd(rule)).not.toContain("instrument_id");
      expect(rule.additionalProperties).toBe(false);
      expect(deref(props(rule).key).pattern).toBe("^[A-Za-z0-9_-]{1,40}$");
      for (const f of ["test_id", "analyte_id", "instrument_id"]) isUuid(deref(props(rule)[f]));
      const lim = deref(props(rule).limits);
      expect(Object.keys(props(lim)).sort()).toEqual(["high", "low"]);
      expect(lim.additionalProperties).toBe(false);
      expect(JSON.stringify(props(lim).low)).toContain("DecimalString");
      expect(JSON.stringify(props(lim).high)).toContain("DecimalString");
      const fl = deref(props(rule).allowed_range_flags);
      expect([fl.type, fl.minItems]).toEqual(["array", 1]);
      enumIs(item(fl), ["N", "L", "H"]);
      const ifl = deref(props(rule).instrument_flags_allowed);
      expect([ifl.type, ifl.maxItems, item(ifl).maxLength]).toEqual(["array", 20, 16]);
      expect(deref(props(rule).note).maxLength).toBe(200);
      for (const f of ["enabled", "qc_allow_warning"]) expect(deref(props(rule)[f]).type, f).toBe("boolean");
    });
  });

  describe("DTO components (TRD §5.10, §7.10, §8.6, §12.1)", () => {
    for (const [n, f] of Object.entries(DTO)) T(`${n} fields and required set`, () => shape(schema(n), f, n));
    T("QcRunDto = QcRunSummaryDto + the §5.10 extras; hold optional", () => {
      const s = schema("QcRunDto");
      expect(s, "QcRunDto").toBeDefined();
      expect(sorted(s)).toEqual([...dtoKeys(DTO.QcRunSummaryDto), ...QCRUN_EXTRA].sort());
      expect(reqd(s)).not.toContain("hold");
      expect(reqd(s)).toEqual(expect.arrayContaining(["id", "observations", "corrective_actions", "reviews"]));
      expect(JSON.stringify(props(s).observations)).toContain("QcObservationDto");
      const ob = item(props(s).observations);
      expect(keys(ob)).toEqual(expect.arrayContaining([...dtoKeys(DTO.QcObservationDto), "rule_hits"]));
    });
    T("TatAlertDetailDto = TatAlertDto + the §5.10 extras", () => {
      const s = schema("TatAlertDetailDto");
      expect(s, "TatAlertDetailDto").toBeDefined();
      expect(sorted(s)).toEqual([...dtoKeys(DTO.TatAlertDto), ...TATDETAIL_EXTRA].sort());
      for (const f of ["first_verified_at", "stopped_at", "stop_source"]) expect(reqd(s), f).not.toContain(f);
      const ev = item(props(s).level_events), ak = item(props(s).acknowledgements);
      expect(Object.keys(props(ev)).sort()).toEqual(["elapsed_seconds", "level", "raised_at", "restart_no"]);
      expect(Object.keys(props(ak)).sort()).toEqual(["acknowledged_by_display", "created_at", "level", "note"]);
      expect(reqd(ak)).not.toContain("note");
    });
    T("enums: plan/target/run/review/status-board/version/decision/TAT values", () => {
      enumIs(prop("QcPlanDto", "status"), ["active", "inactive"]);
      enumIs(prop("QcTargetDto", "status"), ["draft", "active", "superseded", "retired", "discarded"]);
      enumIs(prop("QcTargetDto", "source"), ["manufacturer", "established"]);
      enumIs(prop("QcObservationDto", "observed_at_basis"), ["instrument", "server"]);
      enumIs(prop("QcObservationDto", "source"), ["instrument", "manual"]);
      enumIs(prop("QcRunSummaryDto", "status"), ["collecting", "evaluated", "closed"]);
      enumIs(prop("QcRunSummaryDto", "outcome"), ["accepted", "accepted_warning", "incomplete", "rejected"]);
      enumIs(prop("QcRunSummaryDto", "needs_action_reason"), ["corrective_action", "rerun"]);
      enumIs(prop("QcRunReviewDto", "kind"), ["acknowledge", "evaluate_now", "close"]);
      enumIs(prop("QcStatusRowDto", "status"), ["in_control", "warning", "out_of_control", "no_qc_data"]);
      enumIs(prop("AutoverifyVersionDto", "status"), ["draft", "simulating", "stopped", "active", "retired", "discarded"]);
      enumIs(prop("AutoverifyDecisionDto", "mode"), ["live", "shadow"]);
      enumIs(prop("AutoverifyDecisionDto", "decision"), ["allow", "deny"]);
      enumIs(prop("TatAlertDto", "segment"), ["within_lab", "total"]);
      enumIs(prop("TatAlertDto", "priority"), ["routine", "urgent"]);
      enumIs(prop("TatAlertDto", "start_basis"), ["specimen_received_at", "registered_at", "specimen_ordered_at"]);
      enumIs(prop("TatAlertDto", "state"), ["not_started", "running", "stopped", "cancelled", "orphan_closed"]);
    });
    T("AutoverifyRuleSetDto.versions ≤200 items; AutoverifyDecisionDto.inputs (detail only, optional) = the §5.10 six fields", () => {
      const v = prop("AutoverifyRuleSetDto", "versions");
      expect([v.type, v.maxItems]).toEqual(["array", 200]);
      expect(Object.keys(props(item(v))).sort()).toEqual(["activated_at", "activated_by_display", "created_at", "created_by_display", "id", "retired_at", "rule_count",
        "simulation_started_at", "simulation_stopped_at", "status", "version_no"]);
      const inp = prop("AutoverifyDecisionDto", "inputs");
      expect(Object.keys(props(inp)).sort()).toEqual(["delta_check_failed", "instrument_flags", "is_critical", "range_flag", "resulted_at", "value_numeric"]);
      expect(reqd(inp)).toEqual(expect.arrayContaining(["delta_check_failed", "is_critical", "instrument_flags", "resulted_at"]));
      for (const f of ["value_numeric", "range_flag"]) expect(reqd(inp), f).not.toContain(f);
    });
    T("QualitySettingsDto: §12.1 keys + version, activated_at, updated_at, updated_by_display, read-only westgard_mode / auto_verification_enabled (boolean)", () => {
      expect(prop("QualitySettingsDto", "auto_verification_enabled").type).toBe("boolean");
      expect(prop("QualitySettingsDto", "tat_alerts_enabled").type).toBe("boolean");
      expect(JSON.stringify(props(schema("QualitySettingsDto")).default_plan_params)).toContain("QcPlanParams");
    });
    T("SimulationReportDto: deny_by_reason is a counts map; live_comparison {both_allow, live_only_allow, shadow_only_allow}; sample item fields", () => {
      const s = "SimulationReportDto";
      expect(prop(s, "deny_by_reason").type).toBe("object");
      const lc = prop(s, "live_comparison");
      expect(Object.keys(props(lc)).sort()).toEqual(["both_allow", "live_only_allow", "shadow_only_allow"]);
      expect(reqd(lc).sort()).toEqual(["both_allow", "live_only_allow", "shadow_only_allow"]);
      const sm = item(prop(s, "sample"));
      expect(Object.keys(props(sm)).sort()).toEqual(["analyte_id", "decided_at", "decision_id", "live_decision", "manually_verified_at", "order_id", "result_id", "shadow_decision",
        "shadow_reasons"]);
      for (const f of ["order_id", "live_decision", "manually_verified_at"]) expect(reqd(sm), f).not.toContain(f);
      enumIs(deref(props(sm).shadow_decision), ["allow", "deny"]);
      enumIs(deref(props(sm).live_decision), ["allow", "deny"]);
    });
    T("LjChartDto: plan, series[], points, targets; view / point status / target source enums; truncated boolean", () => {
      const s = "LjChartDto";
      const plan = prop(s, "plan");
      expect(Object.keys(props(plan)).sort()).toEqual(["analyte_code", "analyte_id", "decimals", "id", "instrument_id", "unit_code"]);
      expect(reqd(plan)).not.toContain("unit_code");
      enumIs(prop(s, "view"), ["level", "z"]);
      expect(prop(s, "truncated").type).toBe("boolean");
      const se = item(prop(s, "series"));
      expect(Object.keys(props(se)).sort()).toEqual(["level_code", "level_id", "lot_id", "lot_no", "points", "targets"]);
      const pt = item(props(se).points);
      expect(Object.keys(props(pt)).sort()).toEqual(["observation_id", "observed_at", "qc_run_id", "rule_hits", "status", "value", "z"]);
      for (const f of ["z", "qc_run_id"]) expect(reqd(pt), f).not.toContain(f);
      enumIs(deref(props(pt).status), ["accepted", "warning", "rejected", "excluded", "unevaluated", "collecting"]);
      const tg = item(props(se).targets);
      expect(Object.keys(props(tg)).sort()).toEqual(["effective_from", "effective_to", "mean", "sd", "source", "target_id"]);
      expect(reqd(tg)).not.toContain("effective_to");
      enumIs(deref(props(tg).source), ["manufacturer", "established"]);
    });
    T("page responses {data, page}; #34/#48 add generated_at; #53 {data} only; item shapes reference the named DTO", () => {
      for (const [id, dto] of Object.entries(PAGED)) {
        expect(sorted(okSchema(id)), id).toEqual(WITH_GENERATED_AT.includes(id) ? ["data", "generated_at", "page"] : ["data", "page"]);
        expect(JSON.stringify(props(okSchema(id)).data), id).toContain(dto);
      }
      expect(sorted(okSchema("listQualityCodedSet"))).toEqual(["data"]);
      const row = dataOf("listQualityCodedSet");
      expect(Object.keys(props(row)).sort()).toEqual(["code", "display", "is_active", "sort_order", "source"]);
      expect(reqd(row).sort()).toEqual(["code", "display", "is_active", "sort_order", "source"]);
      enumIs(deref(props(row).source), ["global", "tenant"]);
    });
    T("single-object responses reference the named DTO", () => {
      for (const [id, dto] of Object.entries(ONE)) {
        const resp = Object.entries<any>(ops[id].op.responses).filter(([c]) => /^2/.test(c)).map(([, v]) => JSON.stringify(deref(v).content?.["application/json"]?.schema ?? {}));
        expect(resp.some((x) => x.includes(dto)), `${id} → ${dto}`).toBe(true);
      }
    });
    T("no schema exposes tenant_id, patient name, barcode, registration number or phone (§5.10: C9 holds none)", () => {
      for (const n of Object.keys(doc.components?.schemas ?? {}))
        walk(schema(n), (x) => {
          expect(Object.keys(x.properties ?? {}), `${n}.tenant_id`).not.toContain("tenant_id");
          for (const f of PHI_FIELDS) expect(Object.keys(x.properties ?? {}), `${n}.${f}`).not.toContain(f);
        });
    });
  });

  describe("synthetic examples and offline 'Prism smoke' (AC-0C-1.4)", () => {
    const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
    ajv.addSchema({ ...common, id: "_common.yaml" });
    ajv.addSchema({ ...doc, id: "quality.yaml" });
    const esc = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
    const check = (ptr: string, example: unknown) => {
      const validate = ajv.getSchema(`quality.yaml#${ptr}`);
      expect(validate, `cannot resolve ${ptr}`).toBeDefined();
      expect(validate!(example), `${ptr}: ${JSON.stringify(validate!.errors?.[0])}`).toBe(true);
    };
    const exampleValues = (): unknown[] => {
      const out: unknown[] = [];
      const w = (x: any) => {
        if (Array.isArray(x)) x.forEach(w);
        else if (x && typeof x === "object") {
          for (const [k, v] of Object.entries<any>(x)) {
            if (k === "example") out.push(v);
            else if (k === "examples" && v && typeof v === "object") for (const e of Object.values<any>(v)) out.push(e?.value);
            else w(v);
          }
        }
      };
      w(doc);
      return out;
    };
    it("every JSON request/response example matches its schema; at least one per JSON-bearing operation", () => {
      ex();
      let n = 0;
      for (const { method, path, op } of Object.values(ops)) {
        const base = `/paths/${esc(path)}/${method.toLowerCase()}`;
        const media: [string, any][] = [];
        const rb = op.requestBody;
        if (rb?.content?.["application/json"]) media.push([`${base}/requestBody/content/application~1json`, rb.content["application/json"]]);
        for (const [code, r0] of Object.entries<any>(op.responses ?? {}))
          if (!r0.$ref && r0.content?.["application/json"]) media.push([`${base}/responses/${code}/content/application~1json`, r0.content["application/json"]]);
        for (const [q, m] of media)
          for (const [k, e] of Object.entries<any>(m.examples ?? {})) {
            if (m.schema) check(`${q}/schema`, e.value);
            n++;
            expect(k.length).toBeGreaterThan(0);
          }
      }
      expect(n).toBeGreaterThanOrEqual(50);
    });
    it("every operation with a JSON 2xx response has an example Prism can serve; #2 #15 #37 requests carry one example", () => {
      ex();
      expect(Object.keys(ops).length).toBe(TOTAL);
      for (const s of SPECS) {
        const { op, path, method } = ops[s.id];
        const two = Object.entries<any>(op.responses ?? {}).filter(([c]) => /^2/.test(c));
        expect(two.length, `${method} ${path}: no 2xx`).toBeGreaterThan(0);
        for (const [c, r0] of two) {
          const j = deref(r0).content?.["application/json"];
          if (j) expect(Object.keys(j.examples ?? {}).length, `${method} ${path} ${c}: no example`).toBeGreaterThan(0);
        }
      }
      for (const id of ["createControlMaterial", "createQcPlan", "createAutoverifyVersion"])
        expect(Object.keys(ops[id].op.requestBody?.content?.["application/json"]?.examples ?? {}).length, id).toBeGreaterThan(0);
    });
    it("examples are synthetic: no e-mail, no Nepali-mobile-shaped number, no Windows/user paths, no live-looking token or IP", () => {
      ex();
      const vals = exampleValues();
      expect(vals.length, "no examples at all").toBeGreaterThan(0);
      const blob = JSON.stringify(vals);
      expect(blob).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
      expect(blob).not.toMatch(/(?<!\d)(?:\+?977[-\s]?)?9[678]\d{8}(?!\d)/);
      expect(blob).not.toMatch(/[A-Z]:\\\\|\/Users\/|\/home\//);
      expect(blob, "no JWT-shaped value").not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./);
      for (const ip of blob.match(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g) ?? [])
        expect(ip, `non-documentation IP ${ip}`).toMatch(/^(192\.0\.2|198\.51\.100|203\.0\.113)\./);
    });
  });

  describe("mock script (wave-1 convention)", () => {
    it("package.json has `mock:quality` = prism mock contracts/openapi/quality.yaml on a port no other mock uses", () => {
      const scripts: Record<string, string> = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts;
      const mine = scripts["mock:quality"];
      expect(mine, "mock:quality script missing").toBeDefined();
      const m = /^prism mock contracts\/openapi\/quality\.yaml --host 127\.0\.0\.1 --port (\d+)$/.exec(mine);
      expect(m, mine).not.toBeNull();
      const ports = Object.entries(scripts).filter(([k]) => k.startsWith("mock:") && k !== "mock:quality" && k !== "mock:list")
        .map(([, v]) => /--port (\d+)/.exec(v)?.[1]);
      expect(ports).not.toContain(m![1]);
    });
  });
});
