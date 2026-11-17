// T0C-07 — behaviour of the fake base (AC-0C-3.2, 3.3, 3.4), FakeControls, P-40 key grammar, A24.1/A21.2/D-100 presence,
// synthetic-data guard. The 13 IC §4 case lists run in run-contracts.test.ts.
import { describe, expect, it } from "vitest";
import { PORTS, SOME_ID, T_A, T_B, ctxFor, expectLims, limsCodeOf, portMethods } from "./helpers";

const factories = new Map<string, (opts: { seed: number }) => any>();
const loaders = import.meta.glob("../src/*.ts") as Record<string, () => Promise<any>>;
const harnessMod: any = await (loaders["../src/harness.ts"]?.() ?? Promise.reject(new Error("src/harness.ts missing"))).catch((e: unknown) => ({ __error: e }));
for (const p of PORTS) {
  const load = loaders[`../src/${p}.fake.ts`];
  const mod: any = await (load?.() ?? Promise.reject(new Error(`src/${p}.fake.ts missing`))).catch((e: unknown) => ({ __error: e }));
  factories.set(p, mod[`createFake${p}`] ?? (() => { throw mod.__error ?? new Error(`createFake${p} not exported`); }));
}
const make = (p: string, seed = 1) => factories.get(p)!({ seed });

describe.each(PORTS)("%s fake: shape + FakeControls (TRD §5.4)", (port) => {
  it("implements every port method and the 4 controls; exposes JSON `fixtures`", () => {
    const f = make(port);
    for (const m of portMethods(port)) expect(typeof f[m], `${port}.${m}`).toBe("function");
    for (const c of ["failNext", "latency", "calls", "reset"]) expect(typeof f[c], c).toBe("function");
    expect(f.fixtures).toBeTypeOf("object");
    expect(() => JSON.stringify(f.fixtures)).not.toThrow();
  });

  it("AC-0C-3.2: same seed ⇒ identical fixtures (data + ids); fixtures are plain JSON", () => {
    const a = make(port, 7), b = make(port, 7);
    expect(JSON.parse(JSON.stringify(a.fixtures))).toEqual(JSON.parse(JSON.stringify(b.fixtures)));
  });

  it("AC-0C-3.3: failNext throws the LimsError once (with safeDetail), the next call is not the injected error", async () => {
    for (const m of portMethods(port)) {
      const f = make(port);
      f.failNext(m, "common.internal", "boom-detail");
      await expectLims(() => f[m](ctxFor(T_A), {}), "common.internal", "boom-detail");
      // second call: whatever happens (resolve, or common.validation_failed/not_found for the garbage input) it is NOT the injection
      expect(await limsCodeOf(() => f[m](ctxFor(T_A), {})), `${port}.${m} failure repeated`).not.toBe("common.internal");
    }
  });

  it("failNext(m) does not affect another method; reset() clears a pending failure and the call log", async () => {
    const ms = portMethods(port);
    const f = make(port);
    f.failNext(ms[0], "common.internal");
    if (ms[1]) expect(await limsCodeOf(() => f[ms[1]!](ctxFor(T_A), {}))).not.toBe("common.internal");
    f.reset();
    expect(await limsCodeOf(() => f[ms[0]!](ctxFor(T_A), {}))).not.toBe("common.internal");
    expect(f.calls(ms[0]!)).toHaveLength(1);   // reset cleared earlier log; only the post-reset call remains
  });

  it("calls(method) records tenant, actor and input of each call; tenant only from ctx", async () => {
    const m = portMethods(port)[0]!;
    const f = make(port);
    const input = { marker: "x", tenantId: T_B };               // body tenant must be ignored (REQ-ARCH)
    await limsCodeOf(() => f[m](ctxFor(T_A), input));
    const log = f.calls(m);
    expect(log).toHaveLength(1);
    expect(log[0].ctx.tenantId).toBe(T_A);
    expect(log[0].ctx.actorId).toBe(SOME_ID);
    expect(log[0].input).toMatchObject({ marker: "x" });
  });

  it("latency(ms) delays each call by about that long", async () => {
    const m = portMethods(port)[0]!;
    const f = make(port);
    f.latency(60);
    const t0 = performance.now();
    await limsCodeOf(() => f[m](ctxFor(T_A), {}));
    expect(performance.now() - t0).toBeGreaterThanOrEqual(50);
    f.latency(0);
    const t1 = performance.now();
    await limsCodeOf(() => f[m](ctxFor(T_A), {}));
    expect(performance.now() - t1).toBeLessThan(50);
  });

  it("fixtures hold synthetic data only: e-mails on .invalid/example domains, no real-looking URLs", () => {
    const text = JSON.stringify(make(port).fixtures);
    for (const m of text.matchAll(/[\w.+-]+@([\w.-]+)/g)) expect(m[1], m[0]).toMatch(/(\.invalid|^example\.(com|org|net))$/);
    for (const m of text.matchAll(/https?:\/\/([\w.-]+)/g)) expect(m[1], m[0]).toMatch(/(\.invalid|\.test|\.example|^localhost|^127\.0\.0\.1)$/);
  });
});

describe("AC-0C-3.2: seeds", () => {
  it("different seeds give different entity ids (CatalogPort)", () => {
    const a = make("CatalogPort", 1).fixtures.tests[0].id, b = make("CatalogPort", 2).fixtures.tests[0].id;
    expect(a).not.toBe(b);
  });
  it("two instances with the same seed answer getTest identically", async () => {
    const a = make("CatalogPort", 3), b = make("CatalogPort", 3);
    const row = a.fixtures.tests.find((t: any) => t.tenantId === null);
    expect(row, "no global test row in catalog fixtures").toBeDefined();
    const ra = await a.getTest(ctxFor(T_A), { testId: row.id });
    const rb = await b.getTest(ctxFor(T_A), { testId: row.id });
    expect(ra).toEqual(rb);
    expect(ra.id).toBe(row.id);
  });
});

describe("AC-0C-3.3: failNext('getTest', 'catalog.test_inactive') (CatalogPort)", () => {
  it("throws LimsError with that code once, next call succeeds", async () => {
    const f = make("CatalogPort");
    const row = f.fixtures.tests.find((t: any) => t.tenantId === null);
    f.failNext("getTest", "catalog.test_inactive");
    await expectLims(() => f.getTest(ctxFor(T_A), { testId: row.id }), "catalog.test_inactive");
    await expect(f.getTest(ctxFor(T_A), { testId: row.id })).resolves.toMatchObject({ id: row.id });
    expect(f.calls("getTest")).toHaveLength(2);
  });
});

describe("AC-0C-3.4: cross-tenant ids are common.not_found (CatalogPort)", () => {
  it("tenant A asking for tenant B's test gets common.not_found; B and A each see their own", async () => {
    const f = make("CatalogPort");
    const bRow = f.fixtures.tests.find((t: any) => t.tenantId === T_B);
    const aRow = f.fixtures.tests.find((t: any) => t.tenantId === T_A);
    expect(bRow && aRow, "catalog fixtures need a tenant-specific test for each of tenants A and B").toBeTruthy();
    await expectLims(() => f.getTest(ctxFor(T_A), { testId: bRow.id }), "common.not_found");
    await expectLims(() => f.getTest(ctxFor(T_B), { testId: aRow.id }), "common.not_found");
    await expect(f.getTest(ctxFor(T_B), { testId: bRow.id })).resolves.toMatchObject({ id: bRow.id });
    await expect(f.getTest(ctxFor(T_A), { testId: aRow.id })).resolves.toMatchObject({ id: aRow.id });
  });
  it("the not_found error leaks nothing about the other tenant's row (safeDetail has no id/name)", async () => {
    const f = make("CatalogPort");
    const bRow = f.fixtures.tests.find((t: any) => t.tenantId === T_B);
    const e: any = await f.getTest(ctxFor(T_A), { testId: bRow.id }).catch((x: any) => x);
    expect(e.code).toBe("common.not_found");
    expect(JSON.stringify([e.message, e.safeDetail ?? ""])).not.toContain(bRow.name);
  });
});

describe("harness: ctxFor('A') / ctxFor('B') are different synthetic tenants for every fake", () => {
  it.each(PORTS)("%s", async (port) => {
    expect(harnessMod.__error, String(harnessMod.__error)).toBeUndefined();
    const h = await harnessMod.fakeHarness(port)();
    expect(h.ctxFor("A").tenantId).not.toBe(h.ctxFor("B").tenantId);
    expect(typeof h.seed).toBe("function");
    expect(typeof h.events.publish).toBe("function");
    for (const m of portMethods(port)) expect(typeof h.impl[m], m).toBe("function");
  });
});

describe("P-40 / A22.0: port idempotencyKey must match ^[A-Za-z0-9_.:-]{1,200}$", () => {
  const BAD = ["", "has space", "slash/key", "semi;colon", "ünïcode", "new\nline", "x".repeat(201), "a=b", "a,b"];
  const sys = () => ctxFor(T_A, "system");

  it.each(BAD)("RenderPort.renderPdf rejects key %j with common.validation_failed", async (key) => {
    await expectLims(() => make("RenderPort").renderPdf(sys(), { templateKey: "billing.invoice", data: {}, idempotencyKey: key }), "common.validation_failed");
  });
  it.each(BAD)("PaymentProviderPort.createIntent rejects key %j with common.validation_failed", async (key) => {
    await expectLims(() => make("PaymentProviderPort").createIntent(sys(), {
      orderId: SOME_ID, gateway: "esewa", idempotencyKey: key, returnUrl: "https://app.example.com/r", cancelUrl: "https://app.example.com/c",
    }), "common.validation_failed");
  });
  it.each(BAD)("PaymentProviderPort.refund rejects key %j with common.validation_failed", async (key) => {
    await expectLims(() => make("PaymentProviderPort").refund(sys(), {
      intentId: SOME_ID, amount: { amountPaisa: 100, currency: "NPR" }, reasonCode: "x", idempotencyKey: key, approvalId: SOME_ID,
    }), "common.validation_failed");
  });
  it.each(BAD)("NotificationPort.sendSms rejects key %j with common.validation_failed", async (key) => {
    await expectLims(() => make("NotificationPort").sendSms(sys(), {
      recipient: { kind: "patient", patientId: SOME_ID }, templateCode: "report_ready", purpose: "report_ready", params: {}, idempotencyKey: key,
    }), "common.validation_failed");
  });
  it.each(["a", "x".repeat(200), "Az09_.:-"])("PaymentProviderPort.createIntent accepts key %j (grammar ok; unknown order → common.not_found)", async (key) => {
    await expectLims(() => make("PaymentProviderPort").createIntent(sys(), {
      orderId: SOME_ID, gateway: "esewa", idempotencyKey: key, returnUrl: "https://app.example.com/r", cancelUrl: "https://app.example.com/c",
    }), "common.not_found");
  });
});

describe("review-fix hand-offs at runtime", () => {
  it("A24.1 getPriceListStatus: unknown price list → common.not_found", async () => {
    await expectLims(() => make("CatalogPort").getPriceListStatus(ctxFor(T_A), { priceListId: SOME_ID }), "common.not_found");
  });
  it("A24.1 getPriceListStatus: seeded list returns {priceListId,isActive,status∈draft|published|superseded|discarded}", async () => {
    const f = make("CatalogPort");
    const pl = f.fixtures.priceLists?.[0];
    expect(pl, "catalog fixtures need priceLists[] (two lists with precedence)").toBeDefined();
    const r = await f.getPriceListStatus(ctxFor(T_A), { priceListId: pl.id });
    expect(r.priceListId).toBe(pl.id);
    expect(typeof r.isActive).toBe("boolean");
    expect(["draft", "published", "superseded", "discarded"]).toContain(r.status);
  });
  it("A21.2 readSignatureImage: unknown membership → common.not_found (system actor)", async () => {
    await expectLims(() => make("IdentityPort").readSignatureImage(ctxFor(T_A, "system"), { membershipId: SOME_ID }), "common.not_found");
  });
  it("D-100 updatePartnerMembership accepts input without expectedVersion (unknown id → not_found, never a validation error about the version)", async () => {
    const e: any = await make("IdentityPort").updatePartnerMembership(ctxFor(T_A), { membershipId: SOME_ID, action: "deactivate" }).catch((x: any) => x);
    expect(e?.code).toBe("common.not_found");
  });
  it("D-111 SmartReportPort fake never produces smartreport.summary_not_ready", async () => {
    const f = make("SmartReportPort");
    const code = await limsCodeOf(() => f.buildSummary(ctxFor(T_A, "system"), { orderId: SOME_ID, version: 1 }));
    expect(code).not.toBe("smartreport.summary_not_ready");
  });
  it("QualityPort fake defaults to Phase-1 behaviour: deny/feature_disabled and no_qc_data", async () => {
    const f = make("QualityPort");
    const d = await f.canAutoVerify(ctxFor(T_A), {
      resultId: SOME_ID, analyteId: SOME_ID, instrumentFlags: [], deltaCheckFailed: false, isCritical: false, resultedAt: "2026-11-05T04:15:00.000Z",
    });
    expect(d.decision).toBe("deny");
    expect(d.reasons).toContain("feature_disabled");
    const q = await f.qcStatusFor(ctxFor(T_A), { instrumentId: SOME_ID, analyteId: SOME_ID, at: "2026-11-05T04:15:00.000Z" });
    expect(q.status).toBe("no_qc_data");
  });
});
