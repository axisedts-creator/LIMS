Title: CR-C0-0K-001: rs-c4 restyle guard needs a rule for already-landed feature drift (stop per-string LD310_ALLOW rounds)
From chunk: C0-foundation-contracts (lane C0-0K, task T0D-OFFLINE-3)            To owner: C0-0D (lead decision)
Type: bug
Blocking? yes — T0D-OFFLINE-3 (06-IMPLEMENTATION-PLAN row T0D-OFFLINE-3) cannot pass "existing frontdesk, billing and lab web tests" after 5 allow-list rounds (LD-391, LD-393, LD-398 + 2 arbiter rounds).
Problem (what you cannot do today, with the user story / acceptance criterion it serves):
  rs-c4.static.test.ts enforces LD-140 "restyle = behaviour unchanged" (spec/program/10-DESIGN-SYSTEM.md:132-136) by comparing the live tree with the frozen rs-c4.baseline.json (whose header says never regenerate).
  The spec defines that guard for restyle tasks only and says nothing on how the frozen baseline treats later, approved feature work merged from main.
  Every merge of main into a lane brings new drift; LD-398 (binding) forbids a 5th list patch without a pattern decision from the lead.
  Current failures (dispute 2026-11-19 01:49), all from main, none from this lane (`git diff main...HEAD -- apps/web` = 4 test files only):
   1. frontdesk_feature added permission `frontdesk.patient.read` (T0D-REGSCREEN-2, commit 35ca99fa4; RegistrationForm.tsx:259, read.server.ts:55).
   2. billing_feature added 22 route strings (accounting module T0B-ACCT-1/T0B-FINCTRL-1).
   3. rs-c4.screens "Daily cash (open shift)" snapshot still stale after the single-test -u run (T0D-UIDASH-1).
Proposed change (exact): lead picks ONE and records it as an LD:
  A (recommended) Re-pin: tester regenerates rs-c4.baseline.json once from current main (lead LD overrides the file header comment), records the main commit SHA in the file header, and deletes the feature-drift LD310_ALLOW entries added by LD-391/LD-393/LD-398 (keep logic_files 4, trf_symbol, CRUMB_ONLY credit-parties). Re-pin again only by lead LD after a feature wave lands.
  B Scope: the rs-c4 guard runs as a gate only for tasks LD-140/LD-353 classes as restyle; non-restyle tasks (like T0D-OFFLINE-3) are judged on the regular suites; guard failures caused only by main drift are not task blockers.
  For T0D-OFFLINE-3 under either option: also re-record the whole rs-c4.screens file with -u (dispute item 3), review the snap diff for only the Daily cash change.
Backward compatible? yes — test files only; no source, route, permission or API change.
Tenant/security impact: none directly. Risk of A: a restyle regression already on main would be baked into the new baseline; mitigate by a reviewer diff of old vs new baseline before commit (only additions expected, removal list must be empty except the ruled CRUMB_ONLY items).
IRD/regulatory impact (billing changes only): none (no billing code change).
Alternatives considered: (C) keep widening LD310_ALLOW per round — rejected: LD-398 forbids it and it grows unboundedly with each main merge (7 -> 152 -> 64 symbols -> 22 routes...).
Tests that will prove it: vitest.rs-c4.config.ts green on lane C0-0K with zero OFFLINE-3 source change; "allow-list guard is not vacuous" test still rejects frontdesk.order.cancel and deleteEverythingAction; a deliberate removal of a baseline route still fails.
