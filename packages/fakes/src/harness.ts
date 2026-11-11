// packages/fakes/src/harness.ts — makeImpl factories for the contract suites (C0 TRD §5.4; CV §8.4).
// A real-implementation harness (owner chunk `__tests__/contract/`) returns the same ContractHarness shape.
import type { RequestContext } from "@lims/contracts/ports/common";
import { FIXED_NOW, TENANTS, actorIdFor, type TenantKey } from "./base";
import { createEventSpy, type EventSpy } from "./event-spy";

export interface ContractHarness<P = any> {
  readonly impl: P;
  /** Seed-merges port fixtures (rows upserted by id); resets the impl's mutable state. */
  seed(fixtures: object): Promise<void>;
  /**
   * `actorKey` grammar [CONV]: `A` | `B` | `<A|B>:<actorType>` | `<A|B>:<actorType>:<persona>`; `A` = `A:user:default`.
   * Actor id = `actorIdFor(tenant, type, persona)`; every call returns a fresh `tx` object; `over` replaces fields (e.g. `now`).
   */
  ctxFor(actorKey: string, over?: Partial<RequestContext>): RequestContext;
  readonly events: EventSpy;
  /** The caller's transaction rolled back: drops the impl's writes and the events made inside `tx`. */
  rollback(tx: unknown): void;
}

let txSeq = 0;
export function makeCtxFor(): ContractHarness["ctxFor"] {
  return (actorKey, over) => {
    const [t = "A", type = "user", persona = "default"] = actorKey.split(":");
    if (!(t in TENANTS)) throw new Error(`unknown tenant key ${t}`);
    const tenant = t as TenantKey;
    const ctx: any = {
      tenantId: TENANTS[tenant],
      actor: { type, id: actorIdFor(tenant, type, persona) },
      requestId: "01900000-0000-7000-8000-0000000000e1",
      tx: { __brand: "DbTx", seq: ++txSeq },
      now: () => FIXED_NOW,
      ports: {},
      ...over,
    };
    return ctx as RequestContext;
  };
}

/** Fresh fake per call (no state shared between cases). */
export function fakeHarness(port: string, opts: { seed?: number } = {}): () => Promise<ContractHarness> {
  return async () => {
    const mod = await import(`./${port}.fake.ts`);
    const events = createEventSpy();
    const impl = mod[`createFake${port}`]({ seed: opts.seed ?? 1, events });
    return {
      impl,
      events,
      ctxFor: makeCtxFor(),
      async seed(fixtures) { impl.__seed(fixtures); },
      rollback(tx) { impl.__rollback(tx); events.rollback(tx); },
    };
  };
}

/** Phase stub (no data: seed is a no-op). */
export function stubHarness(port: string): () => Promise<ContractHarness> {
  return async () => {
    const mod = await import(`./stubs/${port}.stub.ts`);
    const events = createEventSpy();
    return {
      impl: mod[`create${port}Stub`](),
      events,
      ctxFor: makeCtxFor(),
      async seed() {},
      rollback(tx) { events.rollback(tx); },
    };
  };
}
