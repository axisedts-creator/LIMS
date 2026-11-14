TESTS_WRONG — reporting/__tests__/implemented-ops.ts is stale: add 'getPortalDues' (C6-T43, P7) and 'createPortalPaymentRequest', 'getPortalPaymentRequest' (C6-T42, PP1/PP2) to IMPLEMENTED. Change nothing else in manifest.test.ts; all other ops must still answer 501.

Reasons:
- The spec defines these three as real operations, not stubs: spec/chunks/C6-reporting-delivery/02-TRD.md:652 (P7 getPortalDues), :653 (PP1 createPortalPaymentRequest), :654 (PP2 getPortalPaymentRequest); 03-INTERFACE-CATALOG.md:2479 and 08-CR-REGISTER.md:1092 (A21.1) record P7.
- They are implemented in handlers/portal.handlers.ts:22,36,37 (C6 lane, merged from main) and tested by portal.dues.test.ts / portal.payment.test.ts (C6-T42/T43), so a 501 expectation contradicts the spec.
- manifest.test.ts:70-71 says each task must add its ops to implemented-ops.ts; C6-T42/T43 did not. implemented-ops.ts:16 lists only P1-P6.
- WIRE-REP (LD-186) touches only index.ts ports, config.ts, renderPort.lazy.ts; the failure is not caused by it and the implementation needs no change.
- Edit is a tester edit (implemented-ops.ts:2 "lead-visible tester edit"); it is not a weakening, since the excluded count is asserted equal to IMPLEMENTED.size (manifest.test.ts:73).
