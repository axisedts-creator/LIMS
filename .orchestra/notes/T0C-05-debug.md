## T0C-05 debug (2026-11-07)
Cause: checkPermissionRules R3 flagged `engagement.booking.cancel` in fixed_actor_permissions.patient (staff code, roles:[front_desk]); LD-01 requires it as a patient exception.
Fix: tools/codegen/gen-permissions.ts — added PATIENT_EXCEPTION = "engagement.booking.cancel" and exempted it for actor "patient" in R3. permissions.yaml and tests untouched.
Result: `vitest run __tests__/codegen.test.ts` 22/22 pass (incl. CLI --check, real-yaml no violations).
