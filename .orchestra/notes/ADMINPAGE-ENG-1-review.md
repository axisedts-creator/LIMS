CHANGES
# ADMINPAGE-ENG-1 review round 2 (reviewer)

Checked: diff 052539369..HEAD (incl. review-fix commits d27ebc809, 2ccc73040) vs C16 04-UI-UX §1.3 + W12, contracts/openapi/engagement.yaml T1/T2 (EngagementSettingsInput), routes.yaml, packages/ui TextField contract.
Round-1 items: 1 FIXED (five Cards Features / Patient app / Bookings / Reminders / Queue; Auto no-show, booking_reminder_hours_before, centre Select in Bookings; Auto follow-up + lead days in Reminders; history in Queue). 2 FIXED (test "W12 sections" pins headings order and placement, positive + negative).
Still OK: names verbatim, nav entry, permission gating before API, If-Match, no `version` in body, 409/428/403/429/400/422, no PHI/secrets, owned paths only, routes/permissions/openapi/rs-c4 baseline untouched, LD-255 cited, CR T0D-NAV-COMPLETE-1.1 answered. No DB/RLS in scope.
Runs (2026-11-16): adminpage-eng-1 config 81/81; nav-complete engagement + admin-pack 27/27; rs-c4 static 10/10. `pnpm exec tsc --noEmit -p apps/web`: one error in this task's code (below).

1. apps/web/src/features/engagement/settings/SettingsView.tsx:157 — TS2375: the `allowed_phone_prefixes` TextField has no `maxLength`, which is REQUIRED in packages/ui TextFieldProps ("mirror the spec maxLength"); this is new code from this task (impl note calls it "untouched", but the file is new in this diff), and `next build` type-checks (no ignoreBuildErrors). Fix: add `maxLength={34}` to that TextField (EngagementSettingsInput: maxItems 5, each item `^\+[1-9][0-9]{0,3}$` = max 5 chars, joined by ", " -> 5*5 + 4*2 = 33; 34 leaves one trailing space) — or any value >= 33 with a one-line comment giving that derivation. Re-run tsc and confirm no error under apps/web/src/features/engagement/settings or app/(staff)/engagement/settings.

Not defects (recorded gaps, unchanged from round 1): tag input / multi-select / per-section Save rendered as comma text field, checkboxes, one Save; T1 needs engagement.booking.read; centre cannot be cleared once set; clearing optional texts omits the key (server semantics not verified).
