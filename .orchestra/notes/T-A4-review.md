APPROVE
# T-A4 review round 2 (reviewer) — diff ca539593..HEAD (07368952)

Round-1 items, all resolved:
1. A4 back on kit `LimsAppLockGate` ('Try again'; kit makes the first prompt per lock). Lock-out copy uses kit `LimsEmptyState` over an offstage gate. Gap filed as CR .orchestra/cr/T-A4.md (a). OK.
2. integration_test/sign_in_prism_test.dart committed; `integration_test` dev_dep added; `flutter analyze` clean for it. Not run (needs emulator + Prism).
3. `_masked()` = prefix + `•••••` + last 2 (07-SECURITY:179, 02-TRD:407); a3 test asserts it with a regex.
4. main_prod.dart: PRIVACY_URL/TERMS_URL have no default; StateError at start if empty (LD-28). design_rules_test guards this.
5. Retry-After not reachable from T-A4 paths: filed as CR T-A4 (b). Fallback copy noted as open in T-A4-impl.md.

Ran: `flutter test` 144/144 pass (test/features/auth 75/75). `flutter analyze`: 2 infos only (unneeded imports in a3_otp_entry_test.dart). No errors or warnings.
Open (not blocking): CR T-A4 (a)+(b); Prism test not executed; A0 tenant logo asset.
