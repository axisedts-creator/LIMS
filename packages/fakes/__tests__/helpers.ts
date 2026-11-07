// T0C-07 test helpers. API the IMPLEMENTATION must provide (fixed by the tester; see .orchestra/notes/T0C-07-tests.md):
//   src/<Port>.fake.ts            export createFake<Port>(opts: { seed: number; fixtures?: object }) -> port & FakeControls
//                                  FakeControls = failNext(method, code, safeDetail?) | latency(ms) | calls(method) | reset()
//                                  plus read-only `fixtures` (JSON-serialisable seeded data). Catalog: fixtures.tests[] rows are
//                                  TestDefinition & { tenantId: Uuidv7 | null } (null = global row).
//   src/stubs/<Port>.stub.ts      export create<Port>Stub()  (QualityPort, SmartReportPort, PaymentProviderPort, EngagementPort)
//   src/event-spy.ts              export createEventSpy() -> { publish(...), ... }
//   src/harness.ts                export fakeHarness(port, opts?: { seed?: number }): () => Promise<ContractHarness>
//                                 export stubHarness(port): () => Promise<ContractHarness>
//                                 ContractHarness = { impl; seed(fixtures): Promise<void>; ctxFor(actorKey): RequestContext; events }
//                                 ctxFor('A') / ctxFor('B') MUST exist: a `user` actor of synthetic tenant A / B (different tenantId).
//   contract-tests/<Port>.contract.ts  export run<Port>Contract(makeImpl, opts?: { phase1Stub?: boolean })
//                                 each IC §4 case is a literal it('(N) …') title; only cases tagged phase1Stub run when opts.phase1Stub.
//   contract-tests/formula.vectors.json  { "vectors": [ { id, expression, inputs, ctx?, expected } ] }  (shape owned by main / formula.test.mjs)
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
export const FAKES_DIR = resolve(here, "..");
export const SRC_DIR = join(FAKES_DIR, "src");
export const SUITES_DIR = join(FAKES_DIR, "contract-tests");
export const PORTS_DIR = resolve(here, "../../../contracts/ports");
export const IC_PATH = resolve(here, "../../../spec/program/03-INTERFACE-CATALOG.md");

/** IC §4 order of the plan row. */
export const PORTS = [
  "IdentityPort", "CatalogPort", "FrontdeskPort", "BillingPort", "BillingCommandPort", "LabPort", "NotificationPort",
  "ReportingPort", "RenderPort", "EngagementPort", "QualityPort", "PaymentProviderPort", "SmartReportPort",
] as const;
export type PortName = (typeof PORTS)[number];
export const STUB_PORTS = ["QualityPort", "SmartReportPort", "PaymentProviderPort", "EngagementPort"] as const;
export type StubPortName = (typeof STUB_PORTS)[number];

export const T_A = "01900000-0000-7000-8000-00000000000a";
export const T_B = "01900000-0000-7000-8000-00000000000b";
export const SOME_ID = "01900000-0000-7000-8000-0000000000f1";

export function fakeFile(p: string): string { return join(SRC_DIR, `${p}.fake.ts`); }
export function stubFile(p: string): string { return join(SRC_DIR, "stubs", `${p}.stub.ts`); }
export function suiteFile(p: string): string { return join(SUITES_DIR, `${p}.contract.ts`); }
export function readSrc(path: string): string { return existsSync(path) ? readFileSync(path, "utf8").replace(/\r\n/g, "\n") : ""; }

/** Method names of a port, parsed from contracts/ports/<Port>.ts (`  name(ctx: RequestContext, …`). */
export function portMethods(p: string): string[] {
  const src = readFileSync(join(PORTS_DIR, `${p}.ts`), "utf8");
  return [...src.matchAll(/^ {2}(\w+)\(ctx: RequestContext/gm)].map((m) => m[1]!);
}

/** IC §4 contract case numbers of a port: the "| Contract tests |" row of its `### 4.n \`Port\`` section. */
export function icCaseNumbers(p: string): number[] {
  const md = readFileSync(IC_PATH, "utf8").replace(/\r\n/g, "\n");
  const start = md.search(new RegExp(`^### 4\\.\\d+ \`${p}\``, "m"));
  if (start < 0) throw new Error(`IC section of ${p} not found`);
  const rest = md.slice(start + 5);
  const end = rest.search(/^#{2,3} /m);
  const body = rest.slice(0, end < 0 ? undefined : end);
  const row = body.split("\n").find((l) => /^\| Contract tests \|/.test(l));
  if (!row) throw new Error(`"Contract tests" row of ${p} not found`);
  const nums = new Set<number>();
  for (const m of row.matchAll(/(?:^|[;:|]|\*\*)\s*\((\d+)\)\s/g)) nums.add(Number(m[1]));
  return [...nums].sort((a, b) => a - b);
}

export function ctxFor(tenantId: string, actorType = "user", id = SOME_ID): any {
  return {
    tenantId,
    actor: { type: actorType, id },
    requestId: "01900000-0000-7000-8000-0000000000e1",
    tx: { __brand: "DbTx" },
    now: () => "2026-11-05T04:15:00.000Z",
    ports: {},
  };
}

/** Asserts a promise rejects with a LimsError carrying `code` (duck-typed: no cross-package instanceof). */
export async function expectLims(p: Promise<unknown> | (() => Promise<unknown>), code: string, safeDetail?: string): Promise<void> {
  let err: any;
  try { await (typeof p === "function" ? p() : p); } catch (e) { err = e; }
  expect(err, `expected LimsError ${code}, call resolved`).toBeDefined();
  expect(err).toBeInstanceOf(Error);
  expect(err.constructor.name, `not a LimsError: ${String(err?.stack ?? err).split("\n")[0]}`).toBe("LimsError");
  expect(err.code).toBe(code);
  if (safeDetail !== undefined) expect(err.safeDetail).toBe(safeDetail);
}

/** Returns the LimsError code a call rejects with, undefined when it resolves; any non-LimsError rejection fails the test. */
export async function limsCodeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try { await fn(); return undefined; } catch (e: any) {
    expect(e?.constructor?.name, `non-LimsError thrown: ${String(e?.stack ?? e).split("\n")[0]}`).toBe("LimsError");
    return e.code as string;
  }
}
