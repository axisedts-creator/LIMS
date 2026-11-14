// T0C-07 / AC-0C-3.1 — executes run<Port>Contract (the IC §4 case lists) against each of the 13 fakes, and the
// `phase1Stub` subset against the 4 phase stubs (TRD §9). A missing module fails only its own port.
import { describe, expect, it } from "vitest";
import { PORTS, STUB_PORTS } from "./helpers";

const suites = import.meta.glob("../contract-tests/*.contract.ts") as Record<string, () => Promise<any>>;
const harnessLoad = import.meta.glob("../src/harness.ts") as Record<string, () => Promise<any>>;

const harness: any = await (harnessLoad["../src/harness.ts"]?.() ?? Promise.reject(new Error("src/harness.ts missing"))).catch((e: unknown) => ({ __error: e }));
const suite = async (p: string) => {
  const load = suites[`../contract-tests/${p}.contract.ts`];
  if (!load) throw new Error(`contract-tests/${p}.contract.ts missing`);
  const mod = await load();
  const run = mod[`run${p}Contract`];
  if (typeof run !== "function") throw new Error(`run${p}Contract not exported`);
  return run as (make: () => Promise<unknown>, opts?: { phase1Stub?: boolean }) => void;
};
const loaded = new Map<string, { run?: (make: () => Promise<unknown>, opts?: { phase1Stub?: boolean }) => void; error?: unknown }>();
for (const p of PORTS) loaded.set(p, await suite(p).then((run) => ({ run }), (error) => ({ error })));

for (const p of PORTS) {
  describe(`AC-0C-3.1 ${p}: fake passes the full IC §4 suite`, () => {
    const { run, error } = loaded.get(p)!;
    if (!run || harness.__error) {
      it("suite + harness load", () => { throw error ?? harness.__error; });
      return;
    }
    run(harness.fakeHarness(p));
  });
}

for (const p of STUB_PORTS) {
  describe(`${p}: stub passes the phase1Stub subset`, () => {
    const { run, error } = loaded.get(p)!;
    if (!run || harness.__error) {
      it("suite + harness load", () => { throw error ?? harness.__error; });
      return;
    }
    run(harness.stubHarness(p), { phase1Stub: true });
  });
}

describe("the fake harness gives every case a fresh, isolated impl", () => {
  it("two makeImpl() calls do not share state (calls log, failNext)", async () => {
    expect(harness.__error, String(harness.__error)).toBeUndefined();
    const make = harness.fakeHarness("CatalogPort");
    const a: any = await make(), b: any = await make();
    expect(a.impl).not.toBe(b.impl);
    a.impl.failNext("getTest", "catalog.test_inactive");
    const e: any = await b.impl.getTest(b.ctxFor("A"), { testId: "01900000-0000-7000-8000-0000000000f1" }).catch((x: any) => x);
    expect(e?.code).not.toBe("catalog.test_inactive");
  });
});
