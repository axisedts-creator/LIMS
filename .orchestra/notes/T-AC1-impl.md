# T-AC1 impl (writer)
- API: `service/account.service.ts`, `repository/account.repo.ts`, `handlers/account.handlers.ts` (+ 2 lines in `handlers/index.ts`). App: `lib/features/settings/{account_api,settings_providers,settings_screen}.dart`.
- [CONV] E12 order (review item 1): payments (PAT_ACC) -> addresses (PAT_ACC_PID, needs active links) -> links -> account -> `IdentityPort.revokePatientSessions` -> access_log; a C2 failure rolls the whole deletion back.
- [CONV] Non-patient actor -> `auth.forbidden`; deleted account -> `common.not_found`; If-Match via shared `parseIfMatch` (428/400/409); body strict (exactly one key).
- [CONV] LD-28 legal links via `externalUrlOpenerProvider` + flavour URLs; LD-140 lims_ui only. Typed-DELETE dialog composed in the screen (`LimsConfirmDialog` has no text-confirm option).
- Tests: api `account.handlers.test.ts` 39 pass / 1 skip (BLOCKED by CR); app settings 43/43 (unchanged this round); tsc clean on account files.
- OPEN (review item 2): `.orchestra/cr/T-AC1.md` — suspended links cannot be revoked / their addresses deactivated by the patient actor (guard + PAT_ACC_PID); lead must pick (a) guard/RLS change or (b) system-actor write.
- OPEN: pre-existing failures outside T-AC1: enquiry N3 (system-actor RLS) and boot.test PHASE_STUBS.
