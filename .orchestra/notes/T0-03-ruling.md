IMPLEMENTATION_WRONG — the test is right (as already amended under LD-15)
1. Dispute (.orchestra/notes/T0-03-dispute.md:2-5) is that CV §15.2 Allowed (spec/program/02-CONVENTIONS.md:1185) lacks `PostgreSQL` and `BlueOak-1.0.0`. True of the spec text, but LD-15 (inbox brief, binding, overrides spec for T0-03) adds both ids to the allow-list. No CR needed; founder ruling already given.
2. Tester has applied LD-15: tests/monorepo/T0-03.pins.test.mjs:23-26 ALLOWED includes both ids with LD-15 comment. Both disputed tests ("every row … allowed licence", "licence check: every installed package") now PASS (node --test run: 26/27 pass).
3. Implementation must:
   a. In db/meta/decisions/T0-03-dependencies.md:64 (pgTAP row), drop the stale "id not listed in CV §15.2 — see CR T0-03-licences" wording; cite LD-15 instead (header line 3 already records LD-15). Same for the lru-cache row if similar wording exists.
   b. The one remaining failure is `pubspec.lock exists` (test :320-323). `flutter --version` succeeds on this machine, so LD-15's skip-with-reason does not apply; per CV §15.1 / REQ-SEC-129 run `flutter pub get` at the repo root and commit `pubspec.lock`. Only if flutter is genuinely unavailable does it stay a HANDOFF note (LD-15).
4. .orchestra/cr/T0-03-licences.md is superseded by LD-15; no new CR.
