# T0-03 — C0 dependencies table (CV §15.1 columns)

LD-04 (2026-11-07) T0-03 option B: this file holds the 02-TRD §2.3 table (spec/ is read-only). LD-05 (2026-11-07): T0D-12 pins (CR-C0-0D-001) are recorded here too. LD-13 (2026-11-07): T0D-01 (CR-C0-0D-002, services/api) and T0D-14 (CR-C0-0D-003, apps/web) pins are recorded here; `services/*` and `apps/*` added to pnpm-workspace.yaml. LD-15 (2026-11-07): licence allow-list adds `PostgreSQL` (pgTAP, test-only) and `BlueOak-1.0.0` (lru-cache, dev-only via jsdom).
Evidence fetched 2026-11-07 from the npm registry (`time[<version>]`, `license` of that version), pub.dev API (`latest.published`, licence tag), GitHub releases API (`published_at`, repo licence), Docker Hub tag API, nodejs.org `dist/index.json`, dart-archive `VERSION`, flutter_infra `releases_windows.json`.
Versions that 04/CV or a spike fixed are copied, not re-chosen: fastify (SP-8), pg (SP-9), Atlas (SP-5), pgTAP (SP-3), write/read-excel-file (CV §15.1), T0D-12 pins (LD-05).

| Name | Exact version | Licence | Purpose | Last release (evidence) | Alternatives considered |
|---|---|---|---|---|---|
| pnpm | 12.18.0 | MIT | package manager; root `packageManager` (CM §3) | 2026-11-05 (npm time[12.18.0]) | npm workspaces, yarn berry |
| typescript | 7.0.2 | Apache-2.0 | TS compiler, root + packages (CV §1.1) | 2026-07-08 (npm time[7.0.2]) | typescript 5.9.x line (JS-based compiler) |
| fastify | 5.12.8 | MIT | API HTTP server; major 5 verified with fastify-openapi-glue 4.12.0 (SP-8) | 2026-11-02 (npm time[5.12.8]) | express, hono |
| fastify-openapi-glue | 4.12.0 | MIT | OpenAPI routes for `@lims/api`, verified with fastify 5.12.8 (SP-8); LD-13 pin (CR-C0-0D-002) | 2026-10-18 (npm time[4.12.0]) | @fastify/swagger + hand routes |
| @fastify/ajv-compiler | 4.0.7 | MIT | per-part ajv options in `@lims/api` (SP-8 tree); LD-13 pin (CR-C0-0D-002) | 2026-10-10 (npm time[4.0.7]) | fastify default compiler only |
| server-only | 0.0.1 | MIT | build-time guard keeping server modules out of client bundles in `@lims/web`; LD-13 pin (CR-C0-0D-003) | 2022-09-03 (npm time[0.0.1]; only release, stable marker package) | none (Next.js convention) |
| next | 16.4.5 | MIT | staff web / portal / partner, App Router (CV §1.1; 04 S4); peer react ^19.0.0 | 2026-11-03 (npm time[16.4.5]) | remix, vite + react-router |
| react | 19.3.1 | MIT | UI runtime; the version Next.js accepts (peer ^19.0.0); T0D-12 pin | 2026-10-14 (npm time[19.3.1]) | none (bound to Next.js) |
| react-dom | 19.3.1 | MIT | React DOM renderer; T0D-12 pin | 2026-10-14 (npm time[19.3.1]) | none (bound to react) |
| pg | 8.23.1 | MIT | Postgres driver, unnamed statements via PgBouncer transaction mode (SP-9) | 2026-09-30 (npm time[8.23.1]) | postgres (porsager), pg-promise |
| jose | 6.2.15 | MIT | JWT verify with pinned algorithm + local JWKS file | 2026-11-01 (npm time[6.2.15]) | jsonwebtoken, fast-jwt |
| ajv | 8.17.1 | MIT | JSON Schema validation (2020-12 events; OAS 3.0 draft) — version already used by shared-ts, contracts, codegen | 2024-07-12 (npm time[8.17.1]); package latest 8.20.0 on 2026-04-24 | @cfworker/json-schema, zod |
| ajv-draft-04 | 1.0.0 | MIT | ajv draft-04 dialect for OAS 3.0 schemas (tools/codegen, C0-0C) | 2021-05-23 (npm time[1.0.0]) | ajv built-in draft-07 (not draft-04 exact) |
| yaml | 2.8.1 | ISC | YAML parser for contracts and codegen (C0-0C) | 2025-08-05 (npm time[2.8.1]); package latest 2.9.1 on 2026-09-11 | js-yaml |
| pino | 10.4.0 | MIT | logger backend behind `@lims/shared-ts/logger` (CV §9.1) | 2026-10-02 (npm time[10.4.0]) | winston, bunyan |
| prom-client | 15.1.3 | Apache-2.0 | Prometheus metrics (CV §9.4) | 2024-06-27 (npm time[15.1.3]; still latest — low release cadence) | @opentelemetry/sdk-metrics + Prometheus exporter |
| ioredis | 6.0.0 | MIT | optional rate-limit cache client, UNLOGGED-table fallback (04 S11) | 2026-07-31 (npm time[6.0.0]) | redis (node-redis) |
| graphile-worker | 0.18.0 | MIT | queue schema install (`--schema-only`, SP-2 step b) in db/tests/run-suites.sh and the runner; root devDependency; LD-31 (CR T0B-05) | 2026-09-08 (npm time[0.18.0]) | pg-boss (no D-201 role split per SP-2) |
| turbo | 2.11.10 | MIT | Turborepo task runner (`turbo.json`, CM §3) | 2026-10-20 (npm time[2.11.10]) | nx, plain pnpm -r |
| vitest | 5.1.0 | MIT | TS test runner (CV §11.1); T0D-12 pin; root devDependency | 2026-11-02 (npm time[5.1.0]) | jest, node:test |
| @playwright/test | 1.65.0 | Apache-2.0 | E2E + a11y browser automation; same family as C6 renderer | 2026-11-05 (npm time[1.65.0]) | cypress, webdriverio |
| axe-core | 4.14.0 | MPL-2.0 — review required (C0 + founder): used unmodified in tests only, never bundled into shipped code | accessibility rules engine (AC-0D-8.6); T0D-12 pin | 2026-10-05 (npm time[4.14.0]) | pa11y (wraps axe/htmlcs), Lighthouse a11y audits |
| react-aria-components | 1.22.1 | Apache-2.0 | UI primitives for `@lims/ui`; T0D-12 pin; licence re-checked at pin time | 2026-10-09 (npm time[1.22.1]) | radix-ui, headlessui |
| @tanstack/react-table | 9.3.1 | MIT | headless table engine | 2026-10-12 (npm time[9.3.1]) | ag-grid community, react-data-grid |
| react-hook-form | 7.91.0 | MIT | form state with ajv resolvers (CV §2.4) | 2026-10-23 (npm time[7.91.0]) | formik, @tanstack/react-form |
| lucide-static | 1.70.0 | ISC | Lucide SVG icons bundled into `@lims/ui` (no CDN) | 2026-11-06 (npm time[1.70.0]) | lucide-react, heroicons |
| Noto Sans | 5.3.0 | OFL-1.1 | UI font, woff2 bundled via `@fontsource/noto-sans`; T0D-12 pin | 2026-07-19 (npm time[5.3.0] of @fontsource/noto-sans) | Google Fonts CDN (banned, 04 §11), self-built woff2 |
| Noto Sans Devanagari | 5.3.0 | OFL-1.1 | Devanagari font via `@fontsource/noto-sans-devanagari`; T0D-12 pin | 2026-07-19 (npm time[5.3.0] of @fontsource/noto-sans-devanagari) | Mukta, self-built woff2 |
| Noto Sans Mono | 5.3.0 | OFL-1.1 | monospace font via `@fontsource/noto-sans-mono`; T0D-12 pin | 2026-07-19 (npm time[5.3.0] of @fontsource/noto-sans-mono) | JetBrains Mono, self-built woff2 |
| @fontsource/noto-sans | 5.3.0 | OFL-1.1 | npm package delivering the Noto Sans row's woff2 (`@lims/ui` devDependency); T0D-12 pin | 2026-07-19 (npm time[5.3.0]) | Google Fonts CDN (banned, 04 §11), self-built woff2 |
| @fontsource/noto-sans-devanagari | 5.3.0 | OFL-1.1 | npm package delivering the Noto Sans Devanagari row's woff2; T0D-12 pin | 2026-07-19 (npm time[5.3.0]) | self-built woff2 |
| @fontsource/noto-sans-mono | 5.3.0 | OFL-1.1 | npm package delivering the Noto Sans Mono row's woff2; T0D-12 pin | 2026-07-19 (npm time[5.3.0]) | self-built woff2 |
| @testing-library/react | 16.3.3 | MIT | component tests for `@lims/ui`; T0D-12 pin | 2026-08-27 (npm time[16.3.3]) | enzyme (unmaintained) |
| @testing-library/user-event | 14.6.8 | MIT | user interaction simulation in tests; T0D-12 pin | 2026-10-13 (npm time[14.6.8]) | fireEvent only |
| @types/react | 19.3.0 | MIT | React type definitions; T0D-12 pin | 2026-09-09 (npm time[19.3.0]) | none |
| @types/react-dom | 19.3.0 | MIT | React DOM type definitions; T0D-12 pin | 2026-09-09 (npm time[19.3.0]) | none |
| jsdom | 31.0.0 | MIT | DOM for unit tests (T0D-12 pin) and server DOM for the worker HTML sanitiser (CR-C6-019) | 2026-11-05 (npm time[31.0.0]) | happy-dom, linkedom |
| @types/node | 26.6.6 | MIT | Node 26 type definitions (shared-ts) | 2026-10-28 (npm time[26.6.6]) | none |
| json-schema-to-typescript | 16.0.0 | MIT | event payload types from JSON Schema | 2026-08-28 (npm time[16.0.0]) | quicktype |
| @remotemerge/nepali-date-converter | 1.2.7 | MIT | B.S. conversion in `packages/shared-ts/src/bsdate` (04 D13) | 2026-10-31 (npm time[1.2.7]) | bikram-sambat (banned as primary, CV §15.3) |
| @sbmdkl/nepali-date-converter | 2.0.5 | MIT | test oracle for the B.S. golden table (packages/test-fixtures devDependency, T0A-06) | 2026-05-02 (npm time[2.0.5]) | nepali-date-converter (unscoped) |
| bikram-sambat | 1.8.1 | Apache-2.0 | test oracle only (packages/test-fixtures devDependency; CV §15.3 line 1195), never app code | 2026-06-09 (npm time[1.8.1]) | none (oracle use only) |
| write-excel-file | 4.1.1 | MIT | Excel writer, worker (repo-wide pin CV §15.1; CR-C8-014) | 2026-06-08 (npm time[4.1.1]) | exceljs, sheetjs |
| read-excel-file | 9.3.14 | MIT | Excel reader, worker (repo-wide pin CV §15.1; CR-C8-014) | 2026-10-29 (npm time[9.3.14]) | exceljs, sheetjs |
| dompurify | 3.4.17 | (MPL-2.0 OR Apache-2.0) — used under Apache-2.0 | HTML sanitiser for worker narratives (CR-C6-019), with jsdom as server DOM | 2026-10-12 (npm time[3.4.17]) | sanitize-html, isomorphic-dompurify |
| nodemailer | 10.3.1 | MIT-0 (MIT without the attribution clause; permissive SPDX id; allow-list per LD-15) | SMTP client for worker e-mail delivery (CR-C6-019) | 2026-10-29 (npm time[10.3.1]) | emailjs, smtp-client |
| decimal library: none — bigint in `@lims/shared-ts/decimal` (T0A-12) | 26.13.0 | MIT | exact decimal math uses ECMAScript BigInt from the pinned Node.js runtime (version = .nvmrc); no third-party library | 2026-10-28 (nodejs.org dist/index.json v26.13.0, LTS Lithium) | decimal.js, big.js, bignumber.js |
| autocannon (k6-class load tool) | 9.0.0 | MIT | HTTP load tests against compose stack at 1x / 10x seed | 2026-11-06 (npm time[9.0.0]) | k6 (AGPL-3.0, banned for repo tooling under CV §15.2), artillery (MPL-2.0) |
| Flutter SDK | 3.47.9 | BSD-3-Clause | Flutter apps (C16/C17), `packages/ui-flutter`; LD-46 bump (newest 3.47.x stable, needed by nepali_date_picker 8.0.0); matches local toolchain | 2026-10-29 (flutter_infra releases_windows.json `storage.googleapis.com/flutter_infra_release/releases/releases_windows.json`, fetched 2026-11-07, manifest sha256 c368e6304a53487f328680f1ed2e51a806646921b36472b4012a53d8f11817c4; stable 3.47.9, dart_sdk_version 3.13.7) | 3.44.0 (fails nepali_date_picker 8.0.0, CR-C0-0D-005) |
| Dart SDK | 3.13.7 | BSD-3-Clause | Dart workspace (`pubspec.yaml`), bundled with Flutter 3.47.9 (LD-46) | 2026-10-29 (releases_windows.json entry for Flutter 3.47.9: dart_sdk_version 3.13.7, fetched 2026-11-07) | none (bound to Flutter SDK) |
| nepali_utils | 3.0.8 | MIT | B.S. Dart in `packages/shared-dart/lib/src/bsdate` (04 D13) | 2025-04-07 (pub.dev latest.published 3.0.8) | none (04 pins) |
| test | 1.31.1 | BSD-3-Clause | Dart unit test runner (packages/shared-dart dev); newest release compatible with flutter_test 3.47.9 (SDK pins test_api 0.7.12; one workspace resolution) | 2026-04-27 (pub.dev versions[1.31.1].published; latest 1.33.0 needs test_api 0.7.15) | flutter_test (Flutter packages only) |
| flutter_riverpod | 3.5.0 | MIT | Flutter state management, binding for C16/C17 (CV §2.5) | 2026-11-06 (pub.dev latest.published 3.5.0; sdk ^3.12.0) | bloc, provider |
| mobile_scanner | 7.5.0 | BSD-3-Clause | camera barcode scanning for `LimsBarcodeScanner` (C17) | 2026-11-01 (pub.dev latest.published 7.5.0) | no runtime egress from lims_ui code (decoding on device; source grep of the unpacked pub archive (lib/, android/, ios/) found no HTTP client). OPEN for C17 release review: Android uses bundled ML Kit (`com.google.mlkit:barcode-scanning:17.3.0`), whose terms allow usage metrics to Google (UNVERIFIED); web target loads ZXing from a CDN unless `setBarcodeLibraryScriptUrl` points at a self-hosted copy. Alternatives: google_mlkit_barcode_scanning, qr_code_scanner (unmaintained) |
| sentry_flutter | 10.3.0 | MIT | error tracking SDK for self-hosted GlitchTip (LD-24): `LimsErrorTracking.configure`, `limsBeforeSend` PHI scrubber | 2026-11-02 (pub.dev versions[10.3.0].published; latest) | no runtime egress except the LD-24 GlitchTip DSN from runtime config (SDK off when DSN unset; never Sentry SaaS). Alternatives: none (LD-24 names the Sentry protocol) |
| nepali_date_picker | 8.0.0 | BSD-3-Clause | B.S. calendar grid inside `LimsDatePicker` only (04 D13); values through lims_shared/bsdate | 2026-09-07 (pub.dev versions[8.0.0].published; latest; needs Flutter >=3.47.0) | no runtime egress (source grep of the unpacked pub archive (lib/, android/, ios/) found no HTTP client). Alternatives: own B.S. grid |
| go_router | 18.1.3 | BSD-3-Clause | router with deep links / Android App Links / iOS universal links (CR-C16-017) for C16/C17 apps | 2026-11-04 (pub.dev versions[18.1.3].published; latest) | no runtime egress (pure Dart routing; source grep of the unpacked pub archive (lib/, android/, ios/) found no HTTP client). Alternatives: auto_route, Navigator 2.0 by hand |
| url_launcher | 6.3.3 | BSD-3-Clause | open URL in the external browser / custom tab (C15 payment page, CR-C16-017) and OS hand-off for tel: / maps (CR-C17-010) | 2026-10-02 (pub.dev versions[6.3.3].published; latest) | no runtime egress by itself (hands the URL to the OS; the browser/maps app makes any request). Alternatives: android_intent_plus + own iOS channel |
| local_auth | 3.0.2 | BSD-3-Clause | OS biometric / device-credential prompt (local auth) for app lock, REQ-SEC-110 (CR-C17-010, CR-C16-017); called by apps around `LimsAppLockGate` | 2026-07-09 (pub.dev versions[3.0.2].published; latest) | no runtime egress (device-local BiometricPrompt / LocalAuthentication). Alternatives: biometric_storage |
| flutter_pdfview | 1.4.5 | MIT | PDF render from a local file in `LimsPdfViewer` (CR-C16-017), offline | 2026-08-03 (pub.dev versions[1.4.5].published; latest) | no runtime egress (Android AndroidPdfViewer 3.2.8 / pdfium, iOS PDFKit; local files only). Alternatives: pdfrx (web build fetches pdfium wasm from a CDN), syncfusion_flutter_pdfviewer (commercial licence) |
| qr | 4.0.1 | BSD-3-Clause | QR render: pure-Dart QR encoder painted by `LimsQrCode` (CR-C16-017), offline | 2026-10-29 (pub.dev versions[4.0.1].published; latest) | no runtime egress (pure Dart, no I/O). Alternatives: qr_flutter 4.1.0 (last release 2023-05-14, pins qr 3.x) |
| geolocator | 14.1.2 | MIT | on-device location capture / GPS point (CR-C17-010, C17 `capture_gps`) | 2026-10-19 (pub.dev versions[14.1.2].published; latest) | no runtime egress from lims_ui; callers must pass `AndroidSettings(forceLocationManager: true)` for platform GPS only, since the default Android fused provider is Google Play Services (`play-services-location:21.2.0`, may use network location). Alternatives: location |
| flutter_secure_storage | 11.2.0 | BSD-3-Clause | mobile secret storage (04 A15; REQ-SEC-102) | 2026-09-16 (pub.dev latest.published 11.2.0) | biometric_storage |
| Atlas (community build) | 1.3.1 | Apache-2.0 | migration runner, image `arigaio/atlas:1.3.1-community@sha256:76cc66fb31f99d5d316676b8a9866ef4b6d6bf5aacc0639485d04848670839e4` (SP-5) | 2026-08-13 (Docker Hub tag 1.3.1-community last_pushed, same digest as SP-5) | sqitch 1.6.1 (fails owner role switch, SP-5) |
| pgTAP | 1.3.3 | PostgreSQL License (OSI permissive; allowed by LD-15 2026-11-07); test/CI databases only, in-image | SQL unit tests in `db/tests` (SP-3) | 2024-04-08 (GitHub theory/pgtap release v1.3.3; v1.3.4 on 2025-10-04) | plain-SQL assertions |
| gitleaks | 8.30.1 | MIT | secret scan, CI gate 11 | 2026-03-21 (GitHub release v8.30.1) | trufflehog (AGPL-3.0) |
| osv-scanner | 2.7.0 | Apache-2.0 | dependency vulnerability scan + `pnpm audit`, CI gate 12 | 2026-10-12 (GitHub release v2.7.0) | npm audit only, grype |
| trivy | 0.76.2 | Apache-2.0 | container image scan, CI gate 14 | 2026-11-05 (GitHub release v0.76.2) | grype |
| Mailpit | 1.33.0 | MIT | local mail sink; dev never calls the 04 S20 relay | 2026-10-31 (GitHub release v1.33.0) | MailHog (unmaintained) |
| staticcheck | 2026.2.2 | MIT | Go lint (CV §1.3), dominikh/go-tools | 2026-10-12 (GitHub release 2026.2.2) | golangci-lint |

sqlite3 3.8.0 (HC-T22, LD-129): hook source: sqlcipher (SQLCipher build hook, not SQLite3MultipleCiphers; no sqlcipher_flutter_libs).
