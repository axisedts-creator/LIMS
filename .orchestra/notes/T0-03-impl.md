# T0-03 impl (rev ruling IMPLEMENTATION_WRONG / LD-15)
- Files: db/meta/decisions/T0-03-dependencies.md (pgTAP row cites LD-15, stale CR T0-03-licences wording dropped; no lru-cache row wording to fix). Earlier: pnpm-workspace.yaml, pnpm-lock.yaml, package.json, .nvmrc 26.13.0, pubspec.yaml, packages/shared-dart/pubspec.yaml.
- [CONV] Fonts recorded twice (family row + npm package row). k6 -> autocannon (AGPL); dompurify under Apache-2.0.
- Tests: 26/27 pass (`node --test tests/monorepo/T0-03.pins.test.mjs`).
- Fail: pubspec.lock exists — `flutter --version` and `flutter pub get` both need approval and were denied in this agent session. HANDOFF (human): run `flutter pub get` at repo root, commit pubspec.lock.
- Open: nodemailer row still says MIT-0 "see CR T0-03-licences" — MIT-0 not covered by LD-15 (test passes, but lead should rule). contracts/codegen vitest pin (C0-0C); prom-client last release 2024-06-27.
