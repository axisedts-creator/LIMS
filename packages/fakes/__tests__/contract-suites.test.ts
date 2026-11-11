// T0C-07 / AC-0C-3.1 — static checks of the 13 contract suites + formula vectors against IC §4 (source of truth).
// Every numbered case of a port's "Contract tests" row must exist as a literal `it('(N) …')` title (CV §8.4: owners may
// add cases, never remove). Also pins the review-fix hand-offs A24.1, A21.2, D-100, D-111, D-110, P-40.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PORTS, STUB_PORTS, SUITES_DIR, fakeFile, icCaseNumbers, portMethods, readSrc, stubFile, suiteFile,
} from "./helpers";

describe("IC §4 parser sanity (guards the tests themselves)", () => {
  it("finds a case list for each of the 13 ports; Catalog has 31", () => {
    for (const p of PORTS) expect(icCaseNumbers(p).length, p).toBeGreaterThan(0);
    expect(icCaseNumbers("CatalogPort").at(-1)).toBe(31);
    expect(icCaseNumbers("RenderPort")).toEqual([1, 2, 3, 4, 5]);
    expect(icCaseNumbers("EngagementPort")).toEqual([1, 2, 3]);
  });
});

describe.each(PORTS)("%s contract suite file", (port) => {
  const src = readSrc(suiteFile(port));

  it(`contract-tests/${port}.contract.ts exports run${port}Contract(makeImpl, opts?)`, () => {
    expect(existsSync(suiteFile(port)), "suite file missing").toBe(true);
    expect(src).toMatch(new RegExp(`export\\s+(?:async\\s+)?function\\s+run${port}Contract\\s*\\(`));
  });

  it("has a literal it('(N) …') title for every numbered IC §4 case", () => {
    const missing = icCaseNumbers(port).filter(
      (n) => !new RegExp(`\\b(?:it|test)(?:\\.\\w+)?\\(\\s*(['"\`])\\(${n}\\)`).test(src),
    );
    expect(missing, `IC §4 cases without an it('(N) …') title`).toEqual([]);
  });

  it("is implementation-agnostic: no import of a *.fake module (real impls must run the same suite)", () => {
    expect(existsSync(suiteFile(port))).toBe(true);
    expect(src).not.toMatch(/from\s+['"][^'"]*\.fake(\.ts|\.js)?['"]/);
    expect(src).not.toMatch(/createFake\w+Port/);
  });

  it("is a fake source file + a port file for every method (no method left unimplemented)", () => {
    expect(existsSync(fakeFile(port)), "src/<Port>.fake.ts missing").toBe(true);
    expect(readSrc(fakeFile(port))).toMatch(new RegExp(`export\\s+function\\s+createFake${port}\\s*\\(`));
    const fake = readSrc(fakeFile(port));
    for (const m of portMethods(port)) expect(fake, `fake lacks method ${m}`).toMatch(new RegExp(`\\b${m}\\b`));
  });
});

describe.each(STUB_PORTS)("%s phase stub (08 R9; TRD §9)", (port) => {
  it("stubs/<Port>.stub.ts exports create<Port>Stub and the suite marks a phase1Stub subset", () => {
    expect(existsSync(stubFile(port)), "stub file missing").toBe(true);
    expect(readSrc(stubFile(port))).toMatch(new RegExp(`export\\s+function\\s+create${port}Stub\\s*\\(`));
    expect(readSrc(suiteFile(port))).toContain("phase1Stub");
  });
});

describe("no stub for RenderPort / BillingCommandPort or the other 9 ports (08 R9)", () => {
  it("only the four phase-1 stub files exist", () => {
    for (const p of PORTS) {
      if ((STUB_PORTS as readonly string[]).includes(p)) continue;
      expect(existsSync(stubFile(p)), `${p} must not have a stub`).toBe(false);
    }
  });
});

describe("review-fix hand-offs are covered in fakes AND suites", () => {
  it("A24.1 CatalogPort.getPriceListStatus", () => {
    expect(readSrc(fakeFile("CatalogPort"))).toContain("getPriceListStatus");
    expect(readSrc(suiteFile("CatalogPort"))).toContain("getPriceListStatus");
  });
  it("A21.2 IdentityPort.readSignatureImage", () => {
    expect(readSrc(fakeFile("IdentityPort"))).toContain("readSignatureImage");
    expect(readSrc(suiteFile("IdentityPort"))).toContain("readSignatureImage");
  });
  it("D-100 updatePartnerMembership called without expectedVersion", () => {
    expect(readSrc(fakeFile("IdentityPort"))).toContain("updatePartnerMembership");
    const s = readSrc(suiteFile("IdentityPort"));
    expect(s).toContain("updatePartnerMembership");
    expect(s).toContain("expectedVersion");
  });
  it("D-111 SmartReportPort never throws smartreport.summary_not_ready; draft summary is returned", () => {
    expect(readSrc(fakeFile("SmartReportPort"))).not.toContain("summary_not_ready");
    expect(readSrc(stubFile("SmartReportPort"))).not.toContain("summary_not_ready");
    const s = readSrc(suiteFile("SmartReportPort"));
    expect(s).toContain("summary_not_ready");   // the suite asserts it is never thrown
    expect(s).toContain("draft");
  });
  it("D-110 FrontdeskPort callers C14 (lab_display) and C15 (getOrderSummary) are exercised", () => {
    const s = readSrc(suiteFile("FrontdeskPort"));
    expect(s).toContain("lab_display");
    expect(s).toMatch(/C14/);
    expect(s).toMatch(/C15/);
  });
});

describe("formula.vectors.json (08 R12a; C3 TRD §7.1 G1–G10)", () => {
  const path = join(SUITES_DIR, "formula.vectors.json");
  const load = () => JSON.parse(readFileSync(path, "utf8")) as { vectors: any[] };

  it("exists, is valid JSON with a `vectors` array of ≥ 10 unique ids", () => {
    expect(existsSync(path), "formula.vectors.json missing").toBe(true);
    const { vectors } = load();
    expect(Array.isArray(vectors)).toBe(true);
    expect(vectors.length).toBeGreaterThanOrEqual(10);
    expect(new Set(vectors.map((v) => v.id)).size).toBe(vectors.length);
    for (const v of vectors) {
      expect(typeof v.id).toBe("string");
      expect(typeof v.expression).toBe("string");
      expect(typeof v.inputs).toBe("object");
      expect(v.expected && typeof v.expected.ok === "boolean", `${v.id}: expected.ok`).toBe(true);
      if (v.expected.ok) expect(typeof v.expected.value).toBe("string");
      else expect(typeof v.expected.reason).toBe("string");
      // main's shared shape (formula.test.mjs): null = missing input
      for (const x of Object.values(v.inputs)) expect(x === null || typeof x === "string", `${v.id}: inputs are DecimalString | null`).toBe(true);
    }
  });

  it("G1–G10 carry the spec expressions/inputs/expected values", () => {
    const by = new Map(load().vectors.map((v) => [v.id, v]));
    const num = (id: string) => Number(by.get(id)!.expected.value);
    for (let i = 1; i <= 10; i++) expect(by.has(`G${i}`), `G${i}`).toBe(true);
    expect(by.get("G1")!.expression).toBe("MCV / RBC");
    expect(by.get("G1")!.inputs).toMatchObject({ MCV: "70.0", RBC: "5.60" });
    expect(num("G1")).toBe(12.5);
    expect(num("G2")).toBe(2);
    expect(num("G3")).toBe(125);
    expect(num("G4")).toBe(5.1);
    expect(num("G5")).toBe(120);
    expect(by.get("G6")!.expected).toEqual({ ok: false, reason: "tg_over_400" });
    expect(by.get("G7")!.expected).toEqual({ ok: false, reason: "division_by_zero" });
    expect(by.get("G8")!.expected).toEqual({ ok: false, reason: "missing_input:ALB" });
    expect(by.get("G8")!.inputs.ALB ?? null).toBeNull();    // missing (main's shape: null)
    expect(num("G9")).toBe(1.414);
    expect(by.get("G9")!.expected.inexact).toBe(true);        // non-integer pow ⇒ IEEE-754 double ⇒ inexact
    expect(by.get("G10")!.ctx?.sex).toBe("female");
    expect(num("G10")).toBe(9);
  });

  it("includes a log10 case marked inexact (C3 TRD §14 'incl. log10 and inexact cases')", () => {
    const v = load().vectors.find((x) => /log10/.test(x.expression));
    expect(v, "no log10 vector").toBeDefined();
    expect(v!.expected.inexact).toBe(true);
  });

  it("contains no real-looking e-mail or phone data (synthetic only)", () => {
    const text = readFileSync(path, "utf8");
    expect(text).not.toMatch(/[\w.+-]+@(?!example\.|.*\.invalid)[\w-]+\.[a-z]{2,}/i);
    expect(text).not.toMatch(/\+977\s?\d{8,}/);
  });
});
