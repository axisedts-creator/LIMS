## Debugger pass (2026-11-07)
- Verify fails 3/25. No implementation defect fixable in code.
- Fail 1+3 (pgTAP PostgreSQL License, lru-cache BlueOak-1.0.0): test ALLOWED list (T0-03.pins.test.mjs:22) follows CV §15.2 (02-CONVENTIONS.md:1182), which omits both ids. Spec/test contradiction -> .orchestra/notes/T0-03-dispute.md; CR .orchestra/cr/T0-03-licences.md awaits founder ruling.
- Fail 2 (pubspec.lock absent): fix is `flutter pub get` at repo root + commit lockfile. Tool call denied (needs approval); not run. Not bypassed.

## Debugger pass 2 (2026-11-07)
- Still 3/25 fail; no code change made. Licence fails (pgTAP PostgreSQL, lru-cache BlueOak-1.0.0) = spec/test dispute, see T0-03-dispute.md + CR T0-03-licences.md (needs founder ruling).
- pubspec.lock missing: fix is `flutter pub get` at root + commit lockfile. Command needs approval and was denied again; not bypassed. Human must run it.
