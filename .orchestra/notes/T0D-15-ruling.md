TESTS_WRONG — the test asserts something the spec does not require
All 3 are harness defects; the spec intent each test encodes stays unchanged. Tester must change ONLY:
1. test/widgets_cr16_test.dart:18 and :46 — group names hold an unescaped `$` before `,` (compile error, whole file fails to load). Escape as `\$` (or use raw strings). Regexes ^[0-9]{6}$ / E.164 asserted inside the tests are untouched.
2. test/error_tracking_test.dart:38-42 — `'breadcrumbs': {'values': [...]}` → `'breadcrumbs': [ {...same crumb...} ]` (sentry 10.3.0 `SentryEvent.fromJson` takes a List). Keep every PHI field in the synthetic event; LD-24 (inbox, binding) only requires "scrubber applied to a synthetic event with PHI", which still holds.
3. test/dependency_pins_test.dart:125 — normalise line endings: `readAsStringSync().replaceAll('\r\n', '\n')` before the line-127 regex. REQ-SEC-129 (spec/chunks/C0-foundation-contracts/07-SECURITY.md:81) requires committed lockfile + exact versions, not a byte-level LF checkout.
No AC is weakened: AC-0D-9.1/9.2 (01-PRD.md:258-259) and plan row T0D-15 (06-IMPLEMENTATION-PLAN.md:114) set no requirement on these harness details.
Implementation: no change required by this ruling.
