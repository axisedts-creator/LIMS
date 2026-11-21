Title: CR-C0-0P-merge: T0D-UIDASH-1 — main carried a stale draft of this task's tests; lane version kept
From chunk: C0-0P            To owner: C0-0D
Type: bug
Blocking? no
Problem (what you cannot do today, with the user story / acceptance criterion it serves):
  main (via lane/C0-0D merge) contains commit 745180854 "[tester] T0D-UIDASH-1 tests" — an early tests-only
  draft of T0D-UIDASH-1 with no impl, ruling or review. lane/C0-0P holds the full task chain
  (b0bd017ab tests, 06d4350eb tests revised per ruling, f13f47a95 impl, afc5bdd27/9bd3779a8 review fixes,
  64c03c914 reviewer). Both sides added the same files (AA/UU conflicts).
  Resolution: lane (HEAD) version kept for .orchestra/notes/T0D-UIDASH-1-tests.md, -verify.cmd,
  analytics an-t18.page.test.tsx, uidash1.dashboard/billing/lab/quality tests, and rs-c8.dashboard.test.tsx
  (main's auto-merged draft edit to rs-c8 line 162 fails against the lane impl: 1 failed / 36).
  Not a competing design decision: same task, the draft is superseded by the ruled + reviewed lane version.
  Left in place from main (unused, harmless): apps/web/src/features/analytics/__tests__/uidash1.helpers.tsx,
  apps/web/src/features/analytics/__tests__/vitest.uidash1.config.ts (lane uses apps/web/src/__tests__/ copies).
Proposed change (exact): none; optionally delete the two orphan draft files above in a later cleanup.
Backward compatible? yes
Tenant/security impact: none (test files only)
IRD/regulatory impact: none
Alternatives considered: keep main's draft — rejected, it contradicts the ruling (T0D-UIDASH-1-ruling.md) and fails against the impl.
Tests that will prove it: .orchestra/notes/T0D-UIDASH-1-verify.cmd (95/95), vitest.an-t18.config.ts (58/58), vitest.rs-c8.config.ts (36/36).
