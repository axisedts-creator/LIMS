APPROVE
# ADMINPAGE-ENG-1 review round 3 (reviewer)

Checked: diff 052539369..HEAD (incl. review-fix 1b96396c1) vs C16 04-UI-UX §1.3 + W12, contracts/openapi/engagement.yaml T1/T2 (EngagementSettingsInput), routes.yaml, packages/ui TextField contract.
Round-2 item 1 FIXED: SettingsView.tsx:327-328 prefixes TextField now has `maxLength={34}` with the derivation comment (5 x "+NNNN" + 4 x ", " = 33, +1).
Still OK (unchanged since round 2): names verbatim, nav entry engagement.settings (order 90, phase 2, no chord), permission gating before API, If-Match, no `version` in body, 409/428/403/429/400/422 handling, no PHI/secrets, owned paths only, routes/permissions/openapi/rs-c4 baseline untouched, LD-255 cited, CR T0D-NAV-COMPLETE-1.1 answered in impl note. No DB/RLS in scope.
Runs (2026-11-16): adminpage-eng-1 config 3 files 81/81; nav-complete engagement + admin-pack 27/27; rs-c4 static 10/10. `pnpm exec tsc --noEmit -p apps/web`: 294 errors repo-wide (LD-256), 0 in apps/web/src/features/engagement/settings or app/(staff)/engagement/settings; the only task-file hit is adminpage-eng-1.settings.test.tsx:83 TS2353 `onUnhandledRequest`, the same msw typing pattern as the sibling engagement tests (t-n1, t-m1, t-r2), test-only, not a build blocker.

Not defects (recorded gaps): tag input / multi-select / per-section Save rendered as comma text field, checkboxes, one Save; T1 needs engagement.booking.read; centre cannot be cleared once set; clearing optional texts omits the key (server semantics not verified).
