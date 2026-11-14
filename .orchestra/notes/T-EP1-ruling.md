TESTS_WRONG — the T-01 stub-behaviour assertions are time-bound to T-01 and P-20 requires T-EP1 to retire them.
Change in `services/api/src/modules/engagement/__tests__/EngagementPort.phase1stub.contract.test.ts`:
  (a) delete `it('returns exactly the stub results on any input ...')` and `it('is pure at T-01: ctx.tx is never used ...')`;
  (b) delete the `runEngagementPortContract(harness, { phase1Stub: true })` run (brand-only ctx, no tx/IdentityPort) — cases (1)/(3) are covered by the full contract run with the real harness in `EngagementPort.impl.test.ts`;
  (c) keep `it('manifest.ports owns exactly EngagementPort ...')` unchanged.
Reasons:
- spec/program/02-CONVENTIONS.md:948 and spec/program/08-CR-REGISTER.md:2370 (P-20): the module's impl "returns exactly the stub results for every method *not yet built*"; "each later task replaces one method and adds that method's full contract cases". Stub results are only required for unbuilt methods.
- spec/chunks/C16-patient-engagement/06-IMPLEMENTATION-PLAN.md:89 (T-EP1): "replaces the stub-equivalent methods registered in T-01 (P-20)"; tests = contract cases 1–3 (08 §4.14); device/patient actor → `auth.forbidden`. Both methods are built here, so "returns stub results" and "never touches ctx.tx" contradict the T-EP1 row (DB read + actor check, case 2).
- packages/fakes/contract-tests/EngagementPort.contract.ts:1-2: the phase1Stub subset exists to run "against the phase stub"; once no stub-equivalent method remains, the subset run is superseded by the full run (cases 1–3), not a separate requirement.
- Implementation must not be changed to satisfy the removed cases.
