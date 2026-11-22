T0D-BUILD-2 dispute (writer). Two API tests are wrong; the code is built, tsc clean, not run on PG (no Docker on this host).
1. settings/settings.test.ts `refused(o, RANGE, '*')` (mass assignment line 182, unknown field line 230): the local `refused` checks `errors[].path` CONTAINS the literal '*'.
   In the kit '*' means "any field path" (sales/helpers.ts:81). The handler answers common.validation_failed with path `/tenant_id`, `/foo` etc. (JSON pointer, as every other
   case in the same file pins). Fix: in `refused`, treat '*' as "some path starts with '/'". Writing a literal '*' path would break the JSON pointer pin.
2. boot.test.ts IMPLEMENTED (tester-owned list, line 45) lacks 'updatePartnerSettings': now a real handler, so the two "stub" tests call it with a fake ctx and get auth.forbidden
   (dev) / not common.internal (staging). Fix: add 'updatePartnerSettings' to IMPLEMENTED (getPartnerSettings is already excluded at line 117).
