# T0-03 impl (rev LD-13/LD-15)
- Files: db/meta/decisions/T0-03-dependencies.md (+3 rows: fastify-openapi-glue 4.12.0, @fastify/ajv-compiler 4.0.7, server-only 0.0.1; LD-13/LD-15 header), pnpm-workspace.yaml (`services/*`, `apps/*`), pnpm-lock.yaml (root `pnpm install`, +51 pkgs).
- Earlier: package.json, .nvmrc 26.13.0, pubspec.yaml (sdk 3.12.0, flutter 3.44.0), packages/shared-dart/pubspec.yaml.
- [CONV] Fonts recorded twice (family row + npm package row). k6 -> autocannon (AGPL); dompurify under Apache-2.0; server-only last release 2022 (single-release marker pkg).
- Tests: 26/27 pass (`node --test tests/monorepo/T0-03.pins.test.mjs`).
- Fail: pubspec.lock exists — `flutter pub get` needs approval (denied in agent session). HANDOFF (human): run `flutter pub get` at repo root, commit pubspec.lock.
- Open: contracts/codegen vitest pin vs 5.1.0 (C0-0C); nodemailer MIT-0; prom-client last release 2024-06-27.
