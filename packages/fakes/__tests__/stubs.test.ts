// T0C-07 — phase stubs (CR-C0-010 / 08 R9 / TRD §9): minimal, no seed/failNext/data, only "feature off" outcomes, never "allow".
import { describe, expect, it } from "vitest";
import { SOME_ID, STUB_PORTS, T_A, ctxFor, expectLims, portMethods } from "./helpers";

const loaders = import.meta.glob("../src/stubs/*.ts") as Record<string, () => Promise<any>>;
const stub = async (p: string): Promise<any> => {
  const load = loaders[`../src/stubs/${p}.stub.ts`];
  if (!load) throw new Error(`src/stubs/${p}.stub.ts missing`);
  const mod = await load();
  const f = mod[`create${p}Stub`];
  if (typeof f !== "function") throw new Error(`create${p}Stub not exported`);
  return f();
};
const NOW = "2026-11-05T04:15:00.000Z";
const user = () => ctxFor(T_A, "user");
const sys = () => ctxFor(T_A, "system");

describe.each(STUB_PORTS)("%s stub: shape", (port) => {
  it("implements every port method and none of the fake controls (no seeding, no failure injection, no data)", async () => {
    const s = await stub(port);
    for (const m of portMethods(port)) expect(typeof s[m], m).toBe("function");
    for (const c of ["failNext", "latency", "calls", "reset", "seed", "fixtures"]) expect(s[c], `stub must not expose ${c}`).toBeUndefined();
  });
});

describe("QualityPort stub = IC §4.11 Phase-1 behaviour", () => {
  it("canAutoVerify always denies with feature_disabled, whatever the (even perfect) result context", async () => {
    const s = await stub("QualityPort");
    const base = { resultId: SOME_ID, analyteId: SOME_ID, instrumentFlags: [] as string[], deltaCheckFailed: false, isCritical: false, resultedAt: NOW };
    for (const rc of [base, { ...base, rangeFlag: "N" }, { ...base, instrumentId: SOME_ID, valueNumeric: "5.0" }, { ...base, isCritical: true }, { ...base, deltaCheckFailed: true }]) {
      for (const ctx of [user(), sys(), ctxFor(T_A, "device")]) {
        const r = await s.canAutoVerify(ctx, rc);
        expect(r.decision).toBe("deny");
        expect(r.reasons).toContain("feature_disabled");
      }
    }
  });
  it("qcStatusFor → no_qc_data (no runs, no currentRunId)", async () => {
    const r = await (await stub("QualityPort")).qcStatusFor(user(), { instrumentId: SOME_ID, analyteId: SOME_ID, at: NOW });
    expect(r.status).toBe("no_qc_data");
    expect(r.currentRunId).toBeUndefined();
    expect(r.lastInControlRunAt).toBeUndefined();
  });
});

describe("SmartReportPort stub", () => {
  it("buildSummary throws smartreport.feature_disabled (never summary_not_ready, D-111), for every actor type", async () => {
    const s = await stub("SmartReportPort");
    for (const a of ["user", "system"]) {
      await expectLims(() => s.buildSummary(ctxFor(T_A, a), { orderId: SOME_ID, version: 1 }), "smartreport.feature_disabled");
    }
  });
});

describe("PaymentProviderPort stub", () => {
  const inputs: Record<string, unknown> = {
    createIntent: { orderId: SOME_ID, gateway: "esewa", idempotencyKey: "k-1", returnUrl: "https://app.example.com/r", cancelUrl: "https://app.example.com/c" },
    verify: { intentId: SOME_ID },
    refund: { intentId: SOME_ID, amount: { amountPaisa: 100, currency: "NPR" }, reasonCode: "x", idempotencyKey: "k-2", approvalId: SOME_ID },
    getIntent: { intentId: SOME_ID },
    cancelIntent: { intentId: SOME_ID, reasonCode: "x" },
  };
  it("covers every method of the port (guards this table)", () => {
    expect(Object.keys(inputs).sort()).toEqual(portMethods("PaymentProviderPort").sort());
  });
  it.each(Object.keys(inputs))("%s throws payments.gateway_not_available", async (m) => {
    const s = await stub("PaymentProviderPort");
    await expectLims(() => s[m](user(), inputs[m]), "payments.gateway_not_available");
  });
});

describe("EngagementPort stub", () => {
  it("getActiveMembership → undefined", async () => {
    const s = await stub("EngagementPort");
    await expect(s.getActiveMembership(user(), { patientId: SOME_ID })).resolves.toBeUndefined();
    await expect(s.getActiveMembership(user(), { patientId: SOME_ID, at: NOW })).resolves.toBeUndefined();
  });
  it("getHomeAddress → common.not_found", async () => {
    await expectLims(() => stub("EngagementPort").then((s) => s.getHomeAddress(sys(), { homeAddressId: SOME_ID, purpose: "home_visit" })), "common.not_found");
  });
});

describe("stubs never open a transaction or call another port", () => {
  it.each(STUB_PORTS)("%s: ctx.tx/ctx.ports are untouched", async (port) => {
    const s = await stub(port);
    const touched: string[] = [];
    const ctx = ctxFor(T_A);
    ctx.tx = new Proxy({}, { get: (_t, k) => { touched.push(`tx.${String(k)}`); return undefined; } });
    ctx.ports = new Proxy({}, { get: (_t, k) => { touched.push(`ports.${String(k)}`); return undefined; } });
    for (const m of portMethods(port)) { try { await s[m](ctx, {}); } catch { /* feature-off errors expected */ } }
    expect(touched).toEqual([]);
  });
});
