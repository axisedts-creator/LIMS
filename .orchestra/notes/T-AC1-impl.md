# T-AC1 impl (writer)
- API: `service/account.service.ts`, `repository/account.repo.ts`, `handlers/account.handlers.ts` (+ 2 lines in `handlers/index.ts`). App: `lib/features/settings/{account_api,settings_providers,settings_screen}.dart`.
- [CONV] E12 order: DB writes (links, payments, addresses, account) -> `IdentityPort.revokePatientSessions` -> access_log; a C2 failure rolls the whole deletion back (never deleted-with-live-sessions).
- [CONV] Non-patient actor -> `auth.forbidden`; deleted account -> `common.not_found`; If-Match via shared `parseIfMatch` (428/400/409); body strict (exactly one key).
- [CONV] LD-28 legal links via `externalUrlOpenerProvider` + flavour URLs; LD-140 lims_ui only. Typed-DELETE dialog composed in the screen (`LimsConfirmDialog` has no text-confirm option).
- Tests: api `account.handlers.test.ts` 38/38; app `flutter test test/features/settings` 43/43; analyze clean on settings.
- OPEN: link revoke clears `suspend_reason/suspended_at` as a patient actor; real `guard_patient_link_update` (05-SCHEMA §4) forbids that -> needs guard change or system-actor write (lead ruling; see T-AC1-tests.md).
- OPEN: pre-existing failures outside T-AC1: enquiry N3 (7+ tests, system-actor RLS) and boot.test PHASE_STUBS.
