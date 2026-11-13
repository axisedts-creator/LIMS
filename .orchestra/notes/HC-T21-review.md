APPROVE

Scope: `git diff f7929d1f..HEAD` = root pubspec.yaml +1 line, impl note, CR file renamed to resolved.
- pubspec.yaml: exactly `  - apps/phlebo_app` under `workspace:` after `  - packages/ui-flutter`; nothing else touched. Matches LD-128 (CR-C17-015 approved).
- No new package/version: apps/phlebo_app pins sentry_flutter 10.3.0, go_router 18.1.3 (already in packages/ui-flutter). 
- Reviewer re-ran `flutter pub get` at repo root: "Got dependencies!", git status clean, so pubspec.lock unchanged (writer claim confirmed).
- Reviewer re-ran `flutter test __tests__` in apps/phlebo_app: 50/50 pass (incl. pinned_http MITM-refused test, ci_guards).
- grep `badCertificateCallback` in apps/phlebo_app/lib: none.
- No PHI, no secrets, no RLS/DB surface in this diff.
Not verified: real `flutter build apk` for dev/staging (no Android SDK here). That is left to CI, as the impl note says.
