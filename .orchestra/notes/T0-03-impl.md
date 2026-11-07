# T0-03 impl
- Files: db/meta/decisions/T0-03-dependencies.md (LD-04 table, 57 rows; +3 `@fontsource/*` package rows per LD-05 so exact-name dep test passes), package.json, pnpm-workspace.yaml, pnpm-lock.yaml, pubspec.yaml (sdk 3.12.0, flutter 3.44.0), packages/shared-dart/pubspec.yaml.
- [CONV] Fonts recorded twice: family row (REQUIRED_ROWS) + npm package row (exact-name check). Flutter 3.44.0/Dart 3.12.0 = local toolchain; k6 -> autocannon (AGPL); dompurify under Apache-2.0.
- Tests: 22/25 pass (`node --test tests/monorepo/T0-03.pins.test.mjs`).
- Fail 1+3: pgTAP = PostgreSQL License, lru-cache (via jsdom, T0D-12) = BlueOak-1.0.0; neither in CV §15.2 -> CR .orchestra/cr/T0-03-licences.md (needs founder ruling + tester ALLOWED update).
- Fail 2: pubspec.lock absent — `flutter pub get` denied permission again; run it at root and commit pubspec.lock.
- Open: contracts/codegen vitest pin vs repo 5.1.0 (C0-0C); nodemailer MIT-0; prom-client last release 2024-06-27.
