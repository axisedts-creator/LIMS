APPROVE
T0A-M5-PHLEBO-2 review (diff a9215babe..HEAD, 12 files, all under apps/phlebo_app/ or own notes).
- Restyle only: payment, fail visit, handover, outbox, settings now wrap existing content in LimsCard; same keys, labels, callbacks, mutation/payment/sync code untouched. No route, API, storage, permission or security change; no DB/RLS in scope.
- Strings unchanged (no board sample content); no hex/radius/font literals in touched UI (only hits = sha256 constants, untouched). Sensitive fields keep `sensitive: true`; no new logging.
- MergeSemantics on fail-visit reasons keeps one labelled node per choice (a11y preserved).
- Gaps listed in impl note (History/Profile tabs, board-only elements); offline banner reasoning recorded as [CONV].
- Ran `flutter test __tests__`: 772 pass, 1 fail = db_ci_guards REQ-SEC-102 (core/db, not touched by this diff; pre-existing). `flutter analyze` on touched lib folders + __tests__/m5 + support: 2 issues, both in purge_fixture.dart / visit_fixture.dart (not in this diff).
- Not verified: eye check vs M5-phlebotomist.png (founder, 13-M-SERIES 6.5).
