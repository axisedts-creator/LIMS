# T-EP1 dispute (writer)
Test file `services/api/src/modules/engagement/__tests__/EngagementPort.phase1stub.contract.test.ts` (T-01) is obsolete once T-EP1 lands; 5 cases fail against the real impl:
- contract (1) and (3) via the phase1Stub harness: ctx has no `tx` and no `IdentityPort` (brand-only ctx), so the real impl cannot read. Same cases pass in `EngagementPort.impl.test.ts` with the real harness (full contract, 28/28).
- "returns exactly the stub results on any input" and "is pure at T-01: ctx.tx is never used": assert the T-01 stub behaviour that 06-PLAN T-EP1 ("replaces the stub-equivalent methods", 08 A17 P-20) removes.
Kept valid: "manifest.ports owns exactly EngagementPort ... no fake controls" (passes).
Request: tester/arbiter retires the 2 stub-behaviour cases and the phase1Stub contract run (superseded by T-EP1 full contract run). Impl not changed to satisfy them: doing so would mean no actor check / no DB read, contradicting contract case (2) and US-EN-13.3 / 17.5.
