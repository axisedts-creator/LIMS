# C0 — Foundation & Contracts — 02 TRD

Status: DRAFT for build, 2026-11-05. Abbreviations as in `01-PRD.md` (CM, CV, IC, DoD, 04 X#).
C0 runs as **four parallel workstreams** (CM §8 risk 1). Every section below says which workstream owns what. A workstream agent edits only its sub-paths in §1. Cross-workstream needs go through the C0-internal interfaces listed in §1.3. They do not edit each other's files.

---

## 1. Owned paths

### 1.1 Paths per workstream (all are C0 paths per CM §3, split here so four agents never collide)

| Workstream | Owned sub-paths (exact) | Notes |
|---|---|---|
| **0A** repo, tooling, CI, shared libs | `/.github/**` · `/package.json` · `/pnpm-workspace.yaml` · `/pnpm-lock.yaml` · `/tsconfig.base.json` · `/turbo.json` · `/.eslintrc.cjs` (or flat `eslint.config.js`) · `/.prettierrc` · `/.nvmrc` · `/.gitignore` · `/.gitleaks.toml` · `/pubspec.yaml` (Dart workspace root) · `/analysis_options.yaml` · `/packages/shared-ts/**` · `/packages/shared-dart/**` · `/packages/test-fixtures/**` · `/tools/devstack/**` (CR-C0-001) · `/tools/lint/**` (CR-C0-001) | owns CODEOWNERS and every CI workflow, including jobs that run other workstreams' checks |
| **0B** database | `/db/**` (`bootstrap/`, `migrations/`, `policies/`, `seeds/`, `tests/`, `meta/` incl. `meta/index-exceptions.yaml` (08 §4.7), `tools/`) | the only writer of SQL DDL |
| **0C** contracts, codegen, mocks, fakes | `/contracts/**` (incl. `/contracts/render/**` RenderPort data schemas — 08 R12c) · `/tools/codegen/**` · `/packages/api-client-ts/**` · `/packages/api-client-dart/**` · `/packages/fakes/**` | the only writer of specs, schemas, port types and generated clients |
| **0D** runtime cores, UI kit, Flutter base | `/services/api/src/core/**` · `/services/api/src/main.ts` · `/services/api/{package.json,tsconfig.json,Dockerfile}` · `/services/worker/src/core/**` · `/services/worker/src/main.ts` · `/services/worker/{package.json,tsconfig.json,Dockerfile}` · `/apps/web/src/core/**` · `/apps/web/src/middleware.ts` · `/apps/web/src/app/layout.tsx` · `/apps/web/src/app/(staff)/layout.tsx` · `/apps/web/{package.json,tsconfig.json,next.config.*,Dockerfile}` · `/packages/ui/**` · `/packages/ui-flutter/**` · `/services/api/src/core/ports/phase-stubs.ts` (08 R9) | app/service package roots are needed by every module in that package; CR-C0-001 records them in CM §3. **Not C0:** `/apps/web/src/app/(auth)/**` and `/apps/web/src/app/(platform)/**` (incl. their `layout.tsx`) are **C2**; `/apps/web/src/app/(display)/**` is **C16** (08 R14). `middleware.ts` excludes `(auth)` and `(display)` from the staff-session requirement |

Feature chunks add npm dependencies to `services/api`, `services/worker` or `apps/web` through a CR to C0-0D (shared-lib type). These packages are shared by many modules, so no chunk has "its own package.json" there (CR-C0-002 clarifies CM §4).

### 1.2 Paths C0 must never edit

`services/api/src/modules/**`, `services/worker/src/jobs/**`, `apps/web/src/app/(staff)/<m>/**`, `apps/web/src/app/(auth)/**`, `apps/web/src/app/(platform)/**`, `apps/web/src/app/(display)/**`, `apps/web/src/features/**`, `services/renderer/**`, `apps/portal/**`, `apps/partner/**`, `apps/patient_app/**`, `apps/phlebo_app/**`, `apps/bridge-agent/**`, `infra/**`, `tools/migration/**`, `docs/**`.

### 1.3 C0-internal interfaces between workstreams

| Producer → consumer | Artifact | Rule |
|---|---|---|
| 0A → all | `@lims/shared-ts`, `lims_shared`, `@lims/test-fixtures` | published as workspace packages; semver in `package.json` `version` bumped on any export change |
| 0B → 0C, 0D | `db/meta/tables.yaml` (table registry), migrated schema | 0C's probe generator and 0D's core repository read the registry; they never read migration files |
| 0C → 0D | `contracts/**`, `@lims/contracts` (port types, generated error/permission/route/event types), `@lims/fakes` | 0D imports types only from `@lims/contracts` |
| 0D → 0C | `ModuleManifest`/`WorkerManifest` types in `services/*/src/core/module.ts` | 0C's CI check (manifest `produces` vs IC §3.25) imports these types |
| 0A → 0B/0C/0D | dev stack (`pnpm dev:up`), CI jobs | 0B/0C/0D request CI job changes from 0A by PR review, never by editing `.github/` |

---

## 2. Stack and pinned libraries

### 2.1 Pinned by 04 / CV (do not change)

| Item | Version | Source |
|---|---|---|
| Node.js | 26.x "Lithium" LTS, exact patch pinned in `.nvmrc`, `engines.node`, and base image by digest | CV §1.1 |
| PostgreSQL image | `supabase/postgres:17.6.1.136` (PG 17, no native `uuidv7()`) | 04 D9 |
| PgBouncer | ≥1.21, transaction mode, via official `docker-compose.pgbouncer.yml` override, Supavisor disabled | 04 S8 |
| Graphile Worker | 0.18.0 | 04 S10, T7 |
| fastify-openapi-glue | 4.12.0 | 04 T7 |
| openapi-typescript / openapi-fetch | 7.13.0 / 0.17.0 | 04 T7 |
| openapi-generator `dart-dio` | v7.27.0 (OAS 3.1 completeness UNVERIFIED, so specs stay 3.0.3) | 04 T8 |
| Prism / MSW | 5.16.0 (3.1 UNVERIFIED) / 3.0.3 | 04 T7 |
| oasdiff | stable 1.35.x line (not v2.2.0-openapi31 beta) | 04 T7 |
| B.S. TS | `@remotemerge/nepali-date-converter` 1.2.7, wrapped in `packages/shared-ts/src/bsdate` only | 04 D13 |
| B.S. Dart | `nepali_utils` 3.0.8 (via `nepali_date_picker` 8.0.0), wrapped in `packages/shared-dart/lib/src/bsdate` only | 04 D13 |
| drift | 2.35.3 (exposed to C17 through `lims_shared` docs only; C0 does not use it) | 04 A15 |

### 2.2 C0 pins (no version in 04; exact version recorded in lockfile and in the §2.3 table at T0-03)

| Item | Choice | Why this choice (DECISION) |
|---|---|---|
| pnpm | `packageManager` field | CM §3 |
| TypeScript | C0 pins | CV §1.1 |
| Fastify | C0 pins (must be a major supported by fastify-openapi-glue 4.12.0 — verified in SP-8) | CV §1.1 |
| Next.js (App Router) | C0 pins | CV §1.1; 04 S4 |
| React | the version Next.js pins | — |
| Postgres driver | `pg` (node-postgres), C0 pins | mature; unnamed statements by default work with PgBouncer transaction mode (research 03 §2.4) |
| JWT library | `jose`, C0 pins | supports pinned-algorithm verification and JWKS from a local file (no network fetch) |
| JSON Schema validation | `ajv` (draft 2020-12 build for event schemas; the draft used by fastify-openapi-glue for OAS 3.0) | CV §4.7 |
| Logger backend | `pino` (Fastify's logger), wrapped by `@lims/shared-ts/logger` | CV §9.1 |
| Metrics | `prom-client`, C0 pins | CV §9.4 Prometheus naming |
| Redis client (rate-limit cache only) | `ioredis`, C0 pins; optional, with UNLOGGED-table fallback | 04 S11 |
| Monorepo task runner | Turborepo (`turbo.json` listed in CM §3) | CM §3 |
| TS test runner | Vitest, C0 pins | CV §11.1 |
| Browser automation (E2E, a11y) | Playwright (same family C6 uses for rendering), C0 pins | CV §11.1 |
| Accessibility rules engine | axe-core, C0 pins | AC-0D-8.6 |
| UI primitives | `react-aria-components` (Apache-2.0, licence re-checked at pin time) | accessible keyboard behaviour out of the box; no styling opinions |
| Table engine | `@tanstack/react-table` (MIT) | headless; virtualisation-friendly |
| Form state | `react-hook-form` (MIT) with ajv resolvers built from generated request schemas | CV §2.4 "form schemas mirrored from generated API types" |
| Icons | Lucide icon set (ISC), SVGs bundled into `@lims/ui` | no CDN (04 §11) |
| Fonts | Noto Sans, Noto Sans Devanagari, Noto Sans Mono (OFL-1.1), woff2 bundled | CV §13; 04 S14 |
| JSON Schema → TS | `json-schema-to-typescript`, C0 pins | event payload types |
| Flutter / Dart SDK | C0 pins (`packages/ui-flutter/pubspec.yaml` `environment:` + CI image) | CV §1.1 |
| Flutter state management | Riverpod (`flutter_riverpod`), C0 pins; binding for C16/C17 | CV §2.5 requires one choice |
| Flutter camera barcode scanning | candidate `mobile_scanner`; licence and maintenance checked at pin time, else CR | needed by `LimsBarcodeScanner` (C17) |
| Migration runner | Atlas (community build) **or** sqitch, decided by spike SP-5 | 04 S12 |
| pgTAP | in-image extension if SP-3 confirms; else plain-SQL assertions | CV §5.12 |
| Secret scan / deps / image scan | gitleaks, osv-scanner (+ `pnpm audit`), trivy | CV §12 gates 11, 12, 14 |
| Local mail sink | Mailpit (MIT) | 04 S20 relay is never called from dev |
| HTML sanitiser + server DOM, SMTP client (worker; CR-C6-019) | C0 pins exact versions after the licence check and a no-runtime-egress check (08 A21.3); added to `services/worker` by 0D for C6 | requested by C6 (narrative sanitising, e-mail delivery); one repo pin |
| Excel read/write (worker) | `write-excel-file` 4.1.1, `read-excel-file` 9.3.14, exact versions, added to `services/worker` by 0D (repo-wide pin; CR-C8-014, CR-C0-002; 08 R12e) | C3's choice is the repo pin; C3, C4, C8 use the same writer |

### 2.3 Dependencies table (filled at T0-03; CV §15.1 columns)

| Name | Exact version | Licence | Purpose | Last release (evidence) | Alternatives considered |
|---|---|---|---|---|---|
| *(one row per §2.2 item; the agent fills this table when pinning, in the same PR)* | | | | | |

Banned (CI gate 13, CV §15.3): `pdf-lib` upstream, `sqlcipher_flutter_libs`, `bikram-sambat` outside tests, `bullmq`/Redis queues, `@supabase/supabase-js`/`@supabase/ssr` in browser bundles, Mirth 4.6+, PowerSync/ElectricSQL, foreign SaaS SDKs, Postgres `ENUM`.

---

## 3. Workstream 0A — shared libraries and tooling

### 3.1 `@lims/shared-ts` (path `packages/shared-ts/src/`)

| Subpath export | File(s) | Public API (exact) |
|---|---|---|
| `@lims/shared-ts/uuidv7` | `uuidv7/index.ts` | `export function uuidv7(): Uuidv7;` · `export function createSeededUuidv7(opts: { seed: number; startMs: number; stepMs?: number }): () => Uuidv7;` · `export function uuidv7Timestamp(id: Uuidv7): number;` · `export function isUuidv7(s: string): s is Uuidv7;` |
| `@lims/shared-ts/bsdate` | `bsdate/index.ts` | see §3.2 |
| `@lims/shared-ts/money` | `money/index.ts` | see §3.3 |
| `@lims/shared-ts/errors` | `errors/index.ts` | re-exports `LimsError`, `FieldError`, `ErrorCode` from `@lims/contracts`; `export function toProblem(err: unknown, instance: string, requestId: Uuidv7): Problem;` · `export function isLimsError(e: unknown, code?: ErrorCode): e is LimsError;` · `export const ERROR_HTTP: Readonly<Record<ErrorCode, number>>` (generated) |
| `@lims/shared-ts/validation` | `validation/index.ts` | `export function compileSchema<T>(schema: object): (v: unknown) => v is T;` (ajv, strict, `removeAdditional: false`) · `export function assertValid<T>(schema, v, path?): T` (throws `LimsError('common.validation_failed', …, fieldErrors)`) |
| `@lims/shared-ts/logger` | `logger/index.ts` | `export interface LogContext { request_id?; trace_id?; span_id?; tenant_id?; actor_id?; actor_type?; module?; operation_id?; task?; route?; status?; duration_ms?; error_code? }` · `export function createLogger(opts: { service: ServiceName; env: string; version: string; level?: LogLevel }): Logger;` · `Logger.child(ctx: LogContext): Logger` · `.info/.warn/.error/.debug(msg: string, fields?: Record<string, unknown>)` |
| `@lims/shared-ts/crypto` | `crypto/index.ts` | `randomToken(bytes: 16 | 32): string` (base64url, CSPRNG; 16 bytes = 128-bit for links/QR/reset per 04 A10–A12, 32 bytes = 256-bit for device tokens per 04 A13) · `sha256Hex(input: string | Uint8Array): string` · `sha256Bytes(input: string | Uint8Array): Uint8Array` (32 bytes; for `<name>_sha256 bytea` columns — 08 R24) · `hmacSha256Hex(key: Uint8Array, input: string): string` · `timingSafeEqualStr(a, b): boolean` · `randomDigits(n: number): string` (≥6 for OTP per 04 A9) |
| `@lims/shared-ts/routes` | `routes/index.ts` (generated from `contracts/routes.yaml` by 0C codegen into `routes/generated.ts`) | `buildRoute<R extends RouteId>(id: R, params: RouteParams<R>): string` — throws if a param is not a UUID/opaque token (IC §7) |
| `@lims/shared-ts/clock` | `clock/index.ts` | `export interface Clock { now(): IsoUtc }` · `systemClock` · `fixedClock(iso)` · `toIsoUtc(d: Date): IsoUtc` |
| `@lims/shared-ts/types` | `types.ts` | re-export of the branded types from `@lims/contracts/ports/common` (`Uuid`, `Uuidv7`, `IsoUtc`, `IsoDate`, `DecimalString`, `Code`, `Money`) |
| `@lims/shared-ts/decimal` | `decimal/index.ts` | exact decimal arithmetic, ≥ 28 significant digits, half-up rounding; implementation library pinned by 0A within the licence allowlist (08 R12a) |
| `@lims/shared-ts/formula` | `formula/index.ts` | `parseFormula`, `formulaRefs`, `evaluateFormula` — exact signatures in `program/08-CR-REGISTER.md` §4.13; grammar text owned by C3 (C3 02-TRD §7.1 + `log10`); `+ − × ÷` and comparisons exact decimal, `sqrt`/`ln`/`log10`/`exp`/non-integer `pow` in IEEE-754 double rounded to 15 significant digits with `inexact: true`; missing input → `{ok:false, reason:'missing_input:<CODE>'}`; golden vectors `packages/fakes/contract-tests/formula.vectors.json` (08 R12a; CR-C3-002, CR-C5-002 merged) |
| `@lims/shared-ts/spreadsheet` | `spreadsheet/index.ts` | `export function neutraliseFormula(cell: string): string;   // prefixes "'" when cell starts with = + - @ \t \r or "'"` · `export function restoreNeutralised(cell: string): string;  // strips exactly one leading "'"; restoreNeutralised(neutraliseFormula(s)) === s for all s` (08 A13 P-9; 03-IC §13.6). Rule: every XLSX/CSV text cell written by product code passes `neutraliseFormula`; importers apply `restoreNeutralised` before validation; writer `write-excel-file` 4.1.1; module-local copies are banned (C3, C4, C8). Golden test `packages/test-fixtures/spreadsheet/golden.json` [CONV path]: round trip for every leading character of the rule plus plain text |

UUIDv7 algorithm (both TS and Dart, RFC 9562 §5.7 layout): 48-bit big-endian Unix ms; 4-bit version `0111`; 12-bit `rand_a` used as a monotonic counter within the same millisecond, seeded randomly at each new millisecond, incremented by 1 per id, and on overflow the timestamp is advanced by 1 ms; 2-bit variant `10`; 62-bit `rand_b` from the CSPRNG (`node:crypto.getRandomValues` / `Random.secure()`). The seeded variant replaces the CSPRNG with a seeded PRNG (xoshiro128** [CONV]) and the clock with `startMs + i * stepMs` (default `stepMs = 1`). Output: lowercase canonical text.

Logger rules (CV §9.2): key denylist (case-insensitive substring): `name` (when the key is not exactly `service`/`module`/`event_type`/`task`), `phone`, `mobile`, `email`, `address`, `dob`, `birth`, `barcode`, `registration_no`, `patient_code`, `lab_no`, `accession`, `token`, `otp`, `password`, `secret`, `authorization`, `cookie`, `jwt`, `signature`, `result`, `value`, `comment`, `diagnosis`, `url` (except key `route`). Value scrubbers: Nepali mobile shape `(\+?977[- ]?)?9[678]\d{8}` → `[PHONE]`; JWT shape `eyJ[\w-]+\.[\w-]+\.[\w-]+` → `[JWT]`; email shape → `[EMAIL]`; any 32+ char base64url run → `[TOKEN]`. Allowed: UUIDs, `invoice_no`, `credit_note_no`, error codes, counts, durations (CV §9.2).

### 3.2 B.S. wrapper (`@lims/shared-ts/bsdate`, mirrored in `lims_shared`)

```ts
export interface BsDate { readonly year: number; readonly month: number; readonly day: number } // month 1 = Baisakh … 4 = Shrawan … 12 = Chaitra
export const BS_SUPPORTED = { minYear: 1975, maxYear: 2099 } as const;              // 04 D13 common range
export function adToBs(date: IsoDate): BsDate;                                     // throws LimsError('common.date_out_of_range')
export function bsToAd(bs: BsDate): IsoDate;                                       // same
export function instantToBs(instant: IsoUtc, timezone?: string): BsDate;           // default 'Asia/Kathmandu' (CV §4.8)
export function daysInBsMonth(year: number, month: number): number;
export function fiscalYearBs(date: IsoDate): { short: string; long: string; startsOn: IsoDate; endsOn: IsoDate }; // e.g. { short: '082/83', long: '2082/83' } — FY starts Shrawan 1 (04 L16)
export function formatBs(bs: BsDate, style?: 'iso' | 'display'): string;          // 'iso' = 'YYYY-MM-DD'; 'display' = 'YYYY-MM-DD B.S.' (CV §13)
export function formatAd(date: IsoDate | IsoUtc, timezone?: string): string;      // 'DD/MM/YYYY' or 'DD/MM/YYYY hh:mm A' (CV §13; 00 §4)
export function parseBs(text: string): BsDate;                                     // accepts 'YYYY-MM-DD' and 'YYYY/MM/DD'
```

- Only `bsdate/impl.ts` imports `@remotemerge/nepali-date-converter`. A lint rule (`tools/lint/no-raw-bs-lib`) enforces this, and the Dart equivalent (`lims_shared` `analysis_options` custom check in CI: grep for `package:nepali_utils` outside `lib/src/bsdate/`).
- `fiscalYearBs` field `short` matches the `{fy}` numbering token and `long` matches `{fyl}` (IC §9.3).
- **Golden table** `packages/test-fixtures/bsdate/golden-2000-2099.json` [CONV path]. One row per B.S. month 2000-01 … 2099-12: `{ "bs_year", "bs_month", "days", "ad_first_day" }`, plus 200 random-day probes `{ "ad", "bs" }`. Generation and review procedure (T0A-06):
  1. Generate candidate rows from `@remotemerge/nepali-date-converter` 1.2.7.
  2. Compare against `nepali_utils` 3.0.8 (all years) and, as test oracles only, `bikram-sambat` 1.8.1 (≤ 2090 B.S.) and `@sbmdkl/nepali-date-converter` 2.0.5 (A.D. ≤ 2040) (04 D13).
  3. Every disagreement is written to `packages/test-fixtures/bsdate/review.json` with all library values. A human (founder or delegate) resolves each before the table is committed. No row is committed while any library disagreement is unresolved.
  4. Rows for years later than the current year + 5 carry `"projection": true` (04 D13: far-future month lengths are projections). CI prints a yearly reminder when `today` passes 1 Baisakh (re-check yearly).

### 3.3 Money (`@lims/shared-ts/money`, mirrored in `lims_shared`)

```ts
export type Paisa = number & { readonly __brand: 'Paisa' };             // safe integer (CV §4.9)
export function paisa(n: number): Paisa;                                 // throws unless Number.isSafeInteger(n)
export function money(amountPaisa: number): Money;                       // { amountPaisa, currency: 'NPR' }
export function add(...m: Money[]): Money; export function sub(a: Money, b: Money): Money;
export function mulQty(m: Money, qty: number): Money;                    // qty integer ≥ 0
export function percentOf(m: Money, basisPoints: number): Money;         // half-up to the paisa; 1300 bp = 13% VAT (04 L14)
export function allocate(total: Money, weights: readonly number[]): Money[]; // largest-remainder; sum(result) === total
export function compare(a: Money, b: Money): -1 | 0 | 1; export function isZero(m: Money): boolean;
export function format(m: Money, opts?: { grouping?: 'lakh' | 'international'; symbol?: 'Rs.' | 'NPR' }): string;
```
- Half-up rule: for non-negative x, `round(x) = floor(x + 0.5)` computed with integer arithmetic (`(a * bp + 5_000) / 10_000` floor) — no floats.
- Default display grouping `lakh` [CONV] (South Asian grouping, e.g. `Rs. 12,34,567.89`); `international` available. Display only. Wire format stays integer paisa.
- Golden file `packages/test-fixtures/money/golden.json`: ≥ 200 cases, shared by TS and Dart. Tax treatment (exempt/taxable/other tax) is C4 logic. The library only provides arithmetic (B7 BLOCKED).

### 3.4 `lims_shared` (Dart, `packages/shared-dart/lib/`)

`uuidv7.dart` (same algorithm), `bsdate.dart` (same API in Dart naming: `adToBs`, `bsToAd`, `fiscalYearBs`, `formatBs`; throws `LimsException(ErrorCode.commonDateOutOfRange)`), `money.dart` (`int` paisa), `errors.dart` (`LimsException`, `ErrorCode` generated by 0C codegen), `analysis_options.yaml` (strict-casts, strict-inference, strict-raw-types per CV §1.3), `test/golden_test.dart` reading `../test-fixtures/bsdate/golden-2000-2099.json` and `../test-fixtures/money/golden.json`.

### 3.5 `@lims/test-fixtures` (path `packages/test-fixtures/`)

| Export | Content |
|---|---|
| `tenants` | Fixed ids and names of the two permanent synthetic tenants (CV §11.2): `tenant_a` "Synthetic Lab Alpha" `01a1a98a-ac40-7000-8000-00000000a001`, `tenant_b` "Synthetic Lab Beta" `01a1a98a-ac40-7000-8000-00000000b001` (IC §1 id family); each with 2 branches and 3 centres (one `home_collection` pseudo-centre, 00 §4 pattern) |
| `actors` | One staff actor per default role per tenant (the default roles of `contracts/permissions.yaml`, currently 10 incl. `radiologist` — 03-IC §11; × 2 tenants), plus per tenant one centre-scoped `centre_staff` limited to centre 1, one locked user, one aal1-only `finance` user (for `auth.mfa_required` tests), one `partner_member` and one `partner_admin` partner actor, one `patient` (with membership), one portal-link actor, one `bridge_agent` device and one `queue_display` device (for the P-16 and A19.1 probes, §4.5 step 9, §5.3), and system actors |
| `generators/*` | Seeded generators producing synthetic patients ("Test Patient 0042"), orders, specimens, results, invoices at **1× lab volume** (500 patients/day, 04 §14) and **10×** (DoD §3.5). Each feature chunk's domain generator is added by C0 in the contract wave from that chunk's `05-SCHEMA.md` |
| `catalog/` | `starter_catalog_master.xlsx`, `starter_price_list.xlsx` (08 A13 D-17, CR-C3-007): generated by a script in `packages/test-fixtures/catalog/` from C3 TRD §8.2 (columns) and C3 05-SCHEMA §8 (content); every value labelled SYNTHETIC; regenerated, never hand-edited |
| `bsdate/`, `money/`, `spreadsheet/` | golden tables (§3.1–§3.3) |
| `gotrue/` | `seedAuthUsers(env)` — creates GoTrue users for the seed actors; dev/CI/staging only; refuses when `LIMS_CORE_ENV=production`; mechanism decided by SP-1 (GoTrue admin API with the stack's service key, or SQL on `auth.users` in dev only). This file is on the service-key allowlist (`07-SECURITY.md` §7) |

Phone and email values must never be deliverable. Nepali-looking mobile numbers are **not** generated because they could be real. Generators emit emails only under the reserved `.invalid` TLD (e.g. `test.patient.0042@example.invalid`). They emit phone numbers only under one fixed non-Nepali prefix, which T0A-05 verifies is unassigned in the ITU E.164 list before it is committed (candidate `+999`; UNVERIFIED until checked). Non-prod environments also hold no real provider credentials (REQ-SEC-136), so no message can reach a real person.

### 3.6 Local dev stack (`tools/devstack/`, CR-C0-001)

| File | Content |
|---|---|
| `compose.yaml` | Services from the official Supabase self-hosting docker stack (images pinned **by digest** to one stable snapshot, never mixed tags — research 03 §2.1, REQ-ARCH-012). The digests are read from C1's `infra/compose/supabase/upstream/UPSTREAM.lock`, the single source (08 A25 D-208; C0 reads that C1 file, ownership unchanged); CI job `supabase-pin` fails when `compose.yaml` and `UPSTREAM.lock` differ (§15.1): `db` = `supabase/postgres:17.6.1.136`, `auth` (GoTrue), `storage`, `rest` (PostgREST, `db-schemas=api`, `db-max-rows` set — 04 S3), the default API gateway (Envoy), `realtime` (profile `flutter` only — 04 S5), `studio`/`meta` (profile `studio`, bound to 127.0.0.1 only); `pgbouncer` via the official `docker-compose.pgbouncer.yml` override with Supavisor **disabled** (04 S8); `mailpit` (SMTP sink for GoTrue, web UI on 127.0.0.1); `redis` (profile `ratelimit`, `--save '' --appendonly no`, 04 S11); `prism-<domain>` (profile `mocks`, one container per spec, Prism 5.16.0) |
| `ports.md`-equivalent table in `compose.yaml` comments | every published port is `127.0.0.1:<port>:<port>` (04 S6) |
| `init-secrets.ts` | generates `.env.devstack` (gitignored) with fresh random secrets for every Supabase secret listed in REQ-SEC-037, and the `lims_api`/`lims_worker`/`lims_migrator` passwords; aborts if any value equals the published `.env.example` value |
| `up.ts` (`pnpm dev:up`) | `init-secrets` (if absent) → `docker compose up -d --wait` → `db/bootstrap` (as the image superuser, dev only) → migrations (as `lims_migrator`) → `db/seeds` → `seedAuthUsers` → task-registry sync → prints URLs |
| `down.ts`, `reset.ts` | stop; drop volumes and re-run `up` |
| `env/` | per-service env templates with **no secret values** |

The GoTrue custom access-token hook is not used (08 R10); the dev stack leaves `GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_*` unset. SMTP → `mailpit:1025`.

---

## 4. Workstream 0B — database

Full table/column/policy specification is in `05-SCHEMA.md`. This section covers the mechanics.

### 4.1 Layout of `db/`

```
db/
├── bootstrap/                 # run ONCE per cluster by the provisioning superuser (dev: image superuser; prod: C1 runbook)
│   ├── 00_roles.sql           # CREATE ROLE lims_owner/lims_migrator/lims_app/lims_api/lims_worker/lims_queue/lims_reporting_lookup/lims_analytics/lims_monitor/lims_replicator/lims_audit_ship
│   └── 01_database.sql        # GRANT CREATE ON DATABASE to lims_owner; REVOKE CREATE ON SCHEMA public FROM PUBLIC; extensions needing superuser
├── migrations/                # forward-only SQL, runner per SP-5
├── policies/<schema>.sql      # canonical current policy set (CV §5.12), diffed vs pg_policies in CI
├── seeds/                     # synthetic only; idempotent upserts; ordered NNN_<schema>__<what>.sql
├── meta/
│   ├── tables.yaml            # registry: every table → class, centre_scoped, mutable columns, audited, retention, phi_class, rls_exempt reason,
│   │                          #   shared_with: [partner|portal|patient] (08 A17 P-16, A23.3), mandatory_column_exceptions (P-18(b))
│   ├── dag.yaml               # schema DAG for FK direction (CM §5 R3)
│   ├── definer-inventory.yaml # every SECURITY DEFINER function, owner, justification, reviewer (04 D7; REQ-SEC-020)
│   ├── system-actors.yaml     # module → fixed UUIDv7 system actor id
│   ├── index-exceptions.yaml  # listed exceptions to the tenant-leading index rule, with justification (08 §4.7; CR-C2-017; CR-C2-018 identity.sessions(previous_token_sha256) partial, 08 A3.1)
│   └── decisions/             # spike decision records (SP-1…SP-6)
├── tests/
│   ├── rls_exempt.txt         # tables without RLS + reason (CV §5.8)
│   ├── isolation/             # generated per-table probes (§4.5)
│   ├── roles/                 # BYPASSRLS/owner/grant assertions
│   ├── immutability/          # enforce_mutable_columns per C/B table
│   ├── policies/              # per-policy negative tests (REQ-SEC-042)
│   └── harness/               # runner: pgTAP if SP-3 passes, else SQL assertion harness
└── tools/
    ├── check-migrations.ts    # gate-9 scripted checks (§4.3)
    ├── check-fk-dag.ts        # R3 + "no FK into billing"
    ├── check-registry.ts      # tables.yaml ⇔ catalog (class grants, RLS, triggers, indexes lead with tenant_id, mandatory columns
    │                          #   unless listed); fails any __tenant/__tenant_centre policy whose qual or with_check lacks
    │                          #   app.is_staff_or_system() unless the table is shared_with and has the matching __partner/__portal/
    │                          #   __patient policy (08 A17 P-16); fails a policy with the uncast centre predicate (08 A16.1)
    ├── export-tenant-billing.ts  # per-tenant export/restore test (04 D16)
    └── policy-dump.ts         # regenerates db/policies/*.sql from a migrated DB for review
```

### 4.2 Migration runner and ordering rules

- **Runner:** decided in spike SP-5 with these criteria. (a) Applies plain forward-only `.sql` files in lexical order. (b) Supports a per-file non-transactional mode for `CREATE INDEX CONCURRENTLY` (CV §5.12). (c) Lets each file start with the owner role switch. (d) Keeps its revision table outside module schemas (schema `migrations_meta`, owned by `lims_migrator`, no grants to `lims_app`). (e) Has an integrity/checksum mode. (f) Makes no network call to a foreign service at run time (04 §11; telemetry must be disabled or absent). (g) Licence is allowed by CV §15.2. Atlas community is evaluated first (research 03 §3.5 preference), then sqitch. Not supabase CLI (04 S12).
- **File name** (CV §5.12): `<YYYYMMDDHHMMSS>_<schema>__<verb>_<object>.sql`, UTC. One logical change per file. RLS policies, grants, triggers and probe registration for a new table ship in the same file as the table.
- **First statement of every file:** transactional files `SET LOCAL ROLE lims_owner;`. Non-transactional files (index builds only) `SET ROLE lims_owner;` followed by exactly one `CREATE INDEX CONCURRENTLY …;`. The `SET` ban in CV §1.3 applies to application code, not to migrations, which run on a direct connection as `lims_migrator` (04 S8). `check-migrations.ts` enforces this.
- **Session settings set by the runner:** `lock_timeout = '5s'`, `statement_timeout = '15min'` [CONV] (CV §5.12 requires `lock_timeout` from the runner).
- **Ordering = schema DAG.** C0 writes all DDL, so timestamps follow the DAG (stage list: `05-SCHEMA.md` §4.5, 08 A30.1). Bootstrap → `app` helpers (incl. the module policy helpers of `05-SCHEMA.md` §4.5: `app.current_partner_id()`, `app.engagement_*` policy helpers) → `core` → `audit` → `identity` → `catalog` → `frontdesk` → `billing` → `lab` → `instruments` → `reporting` → `analytics` → Wave 2 (`quality`, `micro`, `anatomic`, `inventory`, `partners`, `smartreport`, `payments`) → Wave 3 (`engagement`, `homecollection`) → `migration_staging`. Within a contract wave, a later migration may reference only objects from earlier files. CI proves it by applying from empty (AC-0B-6.1).
- **Fresh + upgrade apply:** every PR applies (1) from empty and (2) on top of a DB holding the previous release tag's migrations and seeds (DoD §1.7).
- **Zero-downtime rules** (CV §5.12; REQ-ARCH-027): additive first, `CONCURRENTLY` alone in its own file, never rename/drop a column in the release that stops using it, no `ACCESS EXCLUSIVE` on hot tables except in documented maintenance windows (C1 schedules).
- **Forbidden in migrations** (scripted check): `CREATE TYPE … AS ENUM`; `USING (true)` / `WITH CHECK (true)` (single allowlisted exception: `identity.platform_staff__select__owner_only … TO lims_owner USING (true)`, 08 A10.5; `05-SCHEMA.md` §4.2); `TO public|anon|authenticated` on module tables; `SECURITY DEFINER` without `SET search_path = ''`; `DEFAULT` on a column named `id` or `tenant_id`; tables without `tenant_id` that are not listed as class G or in `rls_exempt.txt`; `GRANT … DELETE` to `lims_app` on class C/B/A tables; `ALTER TABLE … DISABLE ROW LEVEL SECURITY`; the uncast centre predicate `centre_id = ANY ((SELECT app.current_centre_ids()))` — every policy uses `= ANY ((SELECT app.current_centre_ids())::uuid[])` (08 A16.1; on PostgreSQL 16 the uncast form fails with `operator does not exist: uuid = uuid[]`, `05-SCHEMA.md` §10 schema test 26); `DROP` of anything except in a CR-approved file carrying the label `cr-approved-breaking`. A chunk 05-SCHEMA that carries the uncast form is not translated: CR back to the chunk, the cast form is built (`05-SCHEMA.md` §9 rule 2).

### 4.3 Gate-9 migration checklist (manual review while B10 is open; scripted parts marked ⚙)

1. ⚙ File name format; ⚙ first statement is the owner role switch.
2. ⚙ No forbidden construct (§4.2).
3. ⚙ Every new table is in `db/meta/tables.yaml` with class, `centre_scoped`, `phi_class` per column, retention, and `audited`.
4. ⚙ Every new tenant table: `tenant_id uuid NOT NULL` without default, `UNIQUE (tenant_id, id)`, ENABLE + FORCE RLS, one policy per allowed command to `lims_app`, `tenant_id` leading every index and unique constraint.
5. ⚙ Composite FKs only; direction allowed by `dag.yaml`; nothing references `billing`.
6. ⚙ Grants match the table class (CV §5.2); no DELETE on C/B/A.
7. ⚙ Class C/B tables have `app.enforce_mutable_columns` with the column list from the owner's `05-SCHEMA.md`.
8. ⚙ Audited tables have `audit.tg_row_audit`.
9. ⚙ `db/policies/<schema>.sql` regenerated and committed.
10. ⚙ Probe and policy negative tests present for every new table/policy (REQ-SEC-042).
11. Manual: locks acceptable at peak; backfill plan for new NOT NULL columns; `CONCURRENTLY` for indexes on tables expected above 1 M rows.
12. Manual: the owner chunk's `05-SCHEMA.md` matches the DDL (any deviation → CR to that chunk's docs).

### 4.4 Grants model (summary; DDL in `05-SCHEMA.md` §5)

| Object | `lims_app` (via `lims_api`, `lims_worker`) | Others |
|---|---|---|
| Module schemas | `USAGE` | `lims_analytics`: `USAGE` (for `v_pub_*` only) |
| Class M tables | `SELECT, INSERT, UPDATE` | — |
| Class C tables | `SELECT, INSERT, UPDATE` (updates constrained by trigger) | — |
| Class B tables | `SELECT, INSERT, UPDATE` (lifecycle columns only, trigger) | — |
| Class A tables | `SELECT, INSERT` (except `audit.audit_log`: `SELECT` only; inserts by DEFINER trigger) | — |
| Class E tables | `SELECT, INSERT, UPDATE, DELETE` constrained by policy | — |
| Class G tables | `SELECT` | writes only by `lims_owner` in migrations/seeds |
| `v_pub_*` views | `SELECT` | `lims_analytics`: `SELECT` |
| `app` schema | `USAGE`; `EXECUTE` on the helpers listed in `05-SCHEMA.md` §4 | nothing to `supabase_auth_admin` (no GoTrue hook — 08 R10) |
| `graphile_worker` schema | none (only through `app.enqueue_job`) | `lims_queue` owns; `lims_worker` is a member of `lims_queue` |
| `api` schema | none in v1 (reserved for PostgREST curated views — 04 S3) | — |
| `PUBLIC` | `REVOKE ALL` on every schema; default privileges revoke `EXECUTE` on functions from `PUBLIC` | `anon`, `authenticated`: nothing on module schemas (IC X9) |

### 4.5 Isolation probe suite (`db/tests/isolation/`)

Generated by `db/tools/gen-isolation-probes.ts` from `db/meta/tables.yaml` plus the live catalog, so a table cannot dodge it (AC-0B-3.6). Per tenant table T, the generated test:
1. Seeds ≥ 1 row in tenant A and tenant B (from `db/seeds` or a per-table fixture factory declared in `tables.yaml` `probe_fixture:`). Every centre-scoped table gets rows in centres A1 and A2.
2. As `lims_api` with claims of tenant A (all-centres actor): `SELECT count(*) FROM T WHERE tenant_id = B` → 0.
3. `INSERT` a row with `tenant_id = B` → SQLSTATE `42501`.
4. `UPDATE T SET updated_at = updated_at WHERE tenant_id = B` → 0 rows; `DELETE` (where granted) → 0 rows.
5. Centre-scoped T: claims of a centre-A1 membership → no rows with `centre_id = A2`; insert with `centre_id = A2` → `42501`.
6. Child FK probe for every composite FK of T: insert in A referencing B's parent → error `23503` or `42501`.
7. Without claims: `SELECT count(*) FROM T` → 0 (AC-0B-3.7).
8. Same probes as `lims_worker` with system claims of tenant A.
9. Claims of actor type `partner`, `portal` and `patient` of tenant A (the fixture actors of §3.5): `SELECT count(*) FROM T` → 0 on every table not marked `shared_with`; on a `shared_with` table only the rows its actor policy admits (08 A17 P-16; for C0's `core.event_log` and `audit.access_log`: 0, `core.idempotency_keys`: own rows only).

Additional fixed suites: roles (AC-0B-1.x), grants per class (AC-0B-4.2/4.3), policy shape (AC-0B-2.2), immutability per C/B table (AC-0B-4.1), DEFINER inventory equals `pg_proc WHERE prosecdef` (REQ-SEC-020), every DEFINER has `search_path=''` in `proconfig` (REQ-SEC-019), every view in module schemas has `security_invoker=true` (REQ-SEC-031).

**DEFINER owner-policy suite (08 A10.5; `db/tests/definers/`; AC-0B-2.4).** Every function in `db/meta/definer-inventory.yaml` that touches a FORCE-RLS table runs its contract test with FORCE RLS on: the test first asserts `relforcerowsecurity = true` for each touched table from `pg_class`, then asserts non-empty results where the fixture expects rows (e.g. `app.is_platform_actor()` = true for an active staff row; each purge deletes its seeded expired rows). Each inventory entry lists the tables and commands it touches and the `<table>__<cmd>__owner_only` policy that admits them (`05-SCHEMA.md` §4.3 owner-policy rule); `check-registry.ts` fails when a listed policy is missing from `pg_policies`. GUC-bound DEFINERs (`app.pre_*` pre-tenant lookups, `app.maintenance` cross-tenant functions — every purge and expiry function that touches a FORCE-RLS table, 08 A15.3; `05-SCHEMA.md` §4.3 GUC rule, 08 A12) also prove that a `lims_app` session setting the same GUC directly sees nothing and that the GUC is `''` after the function returns (08 A12.7). A static check fails CI on `DISABLE ROW LEVEL SECURITY` / `NO FORCE ROW LEVEL SECURITY` anywhere under `db/tests/**`, or on a stand-in table created without ENABLE + FORCE RLS. Stand-ins never disable RLS.

### 4.6 Seeds (`db/seeds/`)

| File | Content |
|---|---|
| `001_core__g_permissions.sql` | every permission from `contracts/permissions.yaml` (generated by 0C codegen into this file; 0B commits) |
| `002_core__g_system_actors.sql` | from `db/meta/system-actors.yaml` |
| `003_audit__g_cs_access_actions.sql` | access-log action coded set, **generated** by `gen-access-actions` from the 03-IC §13.1 block + the C0 base list (`05-SCHEMA.md` §3.7; equality-tested, 08 A13 P-3) |
| `010_core__synthetic_tenants.sql` | `tenant_a`, `tenant_b`, branches, centres, default roles + role permissions (copied from `permissions.yaml` defaults), memberships for every fixture actor |
| `1xx_<schema>__synthetic_*.sql` | per-module synthetic seeds added in contract waves from each chunk's `05-SCHEMA.md` |

Seeds are idempotent (`INSERT … ON CONFLICT DO NOTHING`), run as `lims_migrator` → `SET LOCAL ROLE lims_owner`, with claims set per tenant via `set_config('request.jwt.claims', …, true)` so RLS `WITH CHECK` applies even to seeds. Production runs only `001`–`003`. Membership seed rows set `status` (default `'active'`) and never list `is_active`, which is generated on `core.memberships` (05-SCHEMA §3, 08 A3.4).

---

## 5. Workstream 0C — contracts, codegen, mocks, fakes

### 5.1 `contracts/` content (IC is the source; transcription is verbatim)

| File | Source | Check |
|---|---|---|
| `events/_defs.v1.schema.json`, `_envelope.v1.schema.json` | IC §2.1, §2.2 | IC examples validate |
| `events/<event_type>.schema.json` × 25 | IC §3.1–§3.24 and §3.26 (`instruments.calibration.received.v1`, 08 §4.10) framed by the IC §2.2 template | each IC example validates; schema count = 25 (IC §3.25 matrix) |
| `ports/common.ts` + 13 ports | IC §4.1–§4.11, §4.15 `BillingCommandPort`, §4.16 `RenderPort`, §4.17 `EngagementPort` (08 §4.14), incl. the additive methods `CatalogPort.getPriceListStatus` (08 A24.1; consumer C16), `IdentityPort.readSignatureImage` (08 A21.2; consumer C6), `IdentityPort.updatePartnerMembership` with `expectedVersion?: number` (08 A19 D-100) | `tsc --noEmit`; exported version constants (all `*_PORT_VERSION = 1`) |
| `render/<templateKey>.schema.json` | RenderPort data schemas for `billing.invoice`, `billing.credit_note`, `billing.register`, `analytics.report` (08 R12c; `analytics.report.schema.json` from C8 TRD §10.2 step 6a) | ajv compile; owner chunk (C4/C8) review |
| `ports/generated/error-codes.ts` | codegen from `errors.yaml` | — |
| `errors.yaml`, `routes.yaml`, `permissions.yaml` | IC §8, §7, §11 | equality test against IC's fenced YAML blocks (AC-0C-1.3) |
| `openapi/_common.yaml` | CV §4.2–§4.12 | components below |
| `openapi/core.yaml` | §8 of this TRD | lint |
| `openapi/<m>.yaml` per module | each owner chunk's `02-TRD.md` endpoint table (incl. C8 operation #30 `getCollectionsFilterOptions` in `analytics.yaml`, 08 A17 D-46; C14 `getSmartLibraryCodedSet` in `smartreport.yaml`, 08 A19 P-43) | lint + owner review |

`_common.yaml` components (exact names, used by every spec through `$ref`):
- `schemas`: `Problem` (`type`, `title`, `status`, `code`, `detail`, `instance`, `request_id`, `errors[]` of `FieldError {path, code, message}`; `additionalProperties: false`), `Uuid`, `Uuidv7`, `IsoUtc`, `IsoDate`, `DecimalString`, `Code`, `Money {amount_paisa, currency: enum [NPR]}`, `PageInfo {next_cursor, limit}`, `Version` (integer ≥ 1).
- `parameters`: `IdempotencyKey` (header, `^[A-Za-z0-9_-]{1,64}$`), `IfMatch` (header), `Limit` (1–200, default 50), `Cursor` (maxLength 512), `RequestId` (header `X-Request-Id`, Uuidv7), `Traceparent`.
- `responses`: `BadRequest`, `Unauthorized`, `Forbidden`, `NotFound`, `Conflict`, `PreconditionRequired`, `PayloadTooLarge`, `UnsupportedMediaType`, `Unprocessable`, `TooManyRequests` (with `Retry-After` header), `Internal`, `ServiceUnavailable` — all `application/problem+json` → `Problem`.
- `headers`: `RetryAfter`, `IdempotentReplayed`, `Deprecation`, `Sunset`.
- `securitySchemes`: `bffSession` (cookie **plus** `X-Lims-Bff-Key`), `bearerJwt`, `deviceToken`, `queueDisplayToken`, `portalSession`, `patientPreAuth`, `paymentCallbackToken` (CV §4.12; one resolver module per scheme — 08 R10 table).

### 5.2 Spec lint rules (`tools/codegen/lint-openapi.ts`, CI gate 7)

1. Parses YAML. Validates against the OAS 3.0 JSON Schema (from the OpenAPI Initiative schema set, vendored at a pinned commit in `tools/codegen/vendor/`). `openapi` field must equal `3.0.3`.
2. Rejects: `nullable`, `type` arrays, `const`, `exclusiveMinimum`/`exclusiveMaximum`, `example` (singular) inside schemas, `$ref` with siblings, `not`, `if`/`then`/`else`, `prefixItems`, `$defs`, `contentMediaType`, `contentEncoding`, top-level `webhooks` (CV §4.12).
3. Every object schema: `additionalProperties: false`. Every string: `maxLength`. Every array: `maxItems`. Every integer: `minimum` and `maximum`.
4. Every operation: `operationId` (lowerCamel, unique across all specs), `tags: [<m>]`, `summary`, `security`, exactly one of `x-permission` (∈ `permissions.yaml`) or `x-public` (non-empty justification string), `x-idempotency ∈ {required, optional, none}` (`required` on every POST that creates state or moves money per CV §4.5; reviewer check); a POST with `x-idempotency: none` must carry `x-idempotency-justification` whose value starts with `E1 ` (secret shown once) or `E2 ` (portal/patient pre-auth OTP POST) (08 A13 P-8; review C0 m#35), `x-rate-limit-tier ∈ {login, otp_request, otp_verify, qr_verify, report_download, ingest, general}`, `x-error-codes` (each ∈ `errors.yaml`, and `owner` ∈ {that module's owner, C0, C2 for `auth.*`, or the owner of a port this module is a listed consumer of in `PORT_CONSUMERS` — a port-propagated code, 08 A17 P-23}), ≥ 1 request example (if a body exists) and ≥ 1 response example.
5. Paths start with `/v1/<m>/` where `<m>` = file name (CV §4.1). No path parameter named like a human number (`barcode`, `registration_no`, `invoice_no`, `phone`) (CV §4.1, REQ-SEC-098).
6. Coded-set fields use `x-coded-set: <name>`, not `enum` (CV §5.5). `enum` allowed for state-machine statuses and closed flags; `x-extensible: true` marks enums that may grow (CV §4.11).
7. Request bodies never declare `tenant_id`, `created_by`, `updated_by`, or `status` outside action endpoints (CV §4.7).
8. Extensions (08 §4.11): `x-context: tenant|platform` (CR-C2-004); `x-edge-exposure: public|internal`, default `internal` (CR-C1-004); `x-anonymous-tx: true` only in `reporting.yaml` with `x-public` (CR-C6-001); `x-raw-body: true` only for reporting provider callbacks (≤ 256 KB); `text/html` responses only for `payments` operations with `x-public` or `paymentCallbackToken` (CR-C15-004); `x-upload: [<mime>…]` on every upload operation, ⊆ the 02-CV §10.2 allowlist (08 R12b); `x-context: identity_auth` only in `identity.yaml`, only on the operationIds of `LIMS_CORE_IDENTITY_AUTH_OPS` (§11), and always with `x-public` + justification (08 A25 D-212). `x-rate-limit-tier` `login` on a `x-edge-exposure: internal` operation means per-account limits only; the per-IP part sits on the public route (08 R6).

### 5.3 Codegen (`tools/codegen/`, entry `pnpm codegen`)

| Generator | Input | Output (committed) |
|---|---|---|
| `gen-ts-client` | `contracts/openapi/*.yaml` | `packages/api-client-ts/src/<m>.ts` (openapi-typescript 7.13.0 types) + `client.ts` (openapi-fetch 0.17.0 factory `createApiClient({ baseUrl, fetch })`) |
| `gen-dart-client` | same | `packages/api-client-dart/` (openapi-generator 7.27.0 `dart-dio`, one library per domain) |
| `gen-handler-types` | specs | `packages/api-client-ts/src/server/operations.ts`: `Operations` map `operationId → { params, query, headers, body, responses }` used by core `Handler<'opId'>` |
| `gen-error-codes` | `errors.yaml` | `contracts/ports/generated/error-codes.ts` (`ErrorCode` union + `ERROR_META`), `packages/shared-dart/lib/src/error_codes.g.dart` |
| `gen-permissions` | `permissions.yaml` | `contracts/ports/generated/permissions.ts` (`PermissionCode` union, `PRIVILEGED` set, default role grants, `FIXED_ACTOR_PERMISSIONS` from `fixed_actor_permissions`), `db/seeds/001_core__g_permissions.sql` (handed to 0B by PR). Fails (CI, 08 §4.1 rules; review C0 m#39): a code with `roles: []` granted to a tenant role; a partner-only or patient-only code granted to a tenant role; a staff code in a partner or patient fixed set |
| `gen-access-actions` | 03-IC §13.1 YAML block + C0 base list (`05-SCHEMA.md` §3.7) | `db/seeds/003_audit__g_cs_access_actions.sql` and `contracts/ports/generated/access-actions.ts` (`AccessAction` union); equality-tested (08 A13 P-3) |
| `gen-port-consumers` | 03-IC §4.x headings (consumer lists) | `contracts/ports/generated/port-consumers.ts` (`PORT_CONSUMERS: Record<PortName, readonly ModuleName[]>`) used by the registry (§6.3) and the `contracts` CI check (08 A19 P-46) |
| `gen-routes` | `routes.yaml` | `packages/shared-ts/src/routes/generated.ts` (handed to 0A by PR), Dart `routes.g.dart` |
| `gen-event-types` | `events/*.schema.json` | `contracts/ports/generated/events.ts`: `EventType` union, `EventPayload<E>` types (json-schema-to-typescript), `EVENT_PRODUCERS`, `EVENT_CONSUMERS` (from IC §3.25) |
| `gen-tokens` | `packages/ui/tokens/tokens.json` | owned by 0D (`packages/ui/scripts/build-tokens.ts`) — not in 0C |
| `gen-probe-manifest` | specs | `tools/codegen/out/probe-manifest.json` (gitignored): every operationId with path params, body id fields, bulk-id arrays. CI gate 10 compares it with probe tests tagged `// @probe <operationId>` in owner `__tests__/probes/` and fails on any uncovered operation. Operations listed in the owner's `__tests__/probes/pending.json` (stubs answering `503 common.service_unavailable`) are skipped; the list must be empty at M6 (CR-C3-008). **Device boundary probe (08 A19.1):** for every operation whose path does not start with `/v1/instruments/agent/`, a generated probe calls it with `deviceToken` (bridge_agent) and `staff_mobile` session credentials and expects `401`/`403`; operations secured by `queueDisplayToken` (`getQueueBoard`, C16) are exempt from the `deviceToken` part (C16 hand-off) |
| `gen-msw` | specs | `packages/fakes/src/msw/handlers.generated.ts` |

Codegen is deterministic (sorted keys, no timestamps). CI gate 8 reruns it and fails on any diff.

### 5.4 Fakes (`packages/fakes/`)

```
packages/fakes/
├── src/
│   ├── <PortName>.fake.ts        # 13 files: CatalogPort, FrontdeskPort, BillingPort, LabPort, ReportingPort, IdentityPort,
│   │                              #           NotificationPort, PaymentProviderPort, SmartReportPort, QualityPort,
│   │                              #           BillingCommandPort, RenderPort, EngagementPort (08 §4.14)
│   ├── stubs/<Port>.stub.ts      # phase stubs (§9; 08 R9): QualityPort, SmartReportPort, PaymentProviderPort, EngagementPort
│   ├── base.ts                   # FakeBase: seed, tenant keying, failNext, latency, calls
│   ├── fixtures/                 # synthetic per-port fixtures built from @lims/test-fixtures
│   ├── event-spy.ts              # in-memory events.publish spy used by contract tests (IC §4 cases with "event spy")
│   └── msw/                      # handlers.generated.ts + server.ts (MSW 3.0.3)
└── contract-tests/
    └── <PortName>.contract.ts    # export function run<PortName>Contract(makeImpl: () => Promise<{ impl; seed(fixtures): Promise<void>; ctxFor(actorKey): RequestContext; events: EventSpy }>): void
```

```ts
// packages/fakes/src/base.ts
export interface FakeControls<M extends string> {
  failNext(method: M, code: ErrorCode, safeDetail?: string): void;
  latency(ms: number): void;
  calls(method: M): readonly { ctx: { tenantId: Uuidv7; actorId: Uuid }; input: unknown }[];
  reset(): void;
}
export function createFakeCatalogPort(opts: { seed: number; fixtures?: Partial<CatalogFixtures> }): CatalogPort & FakeControls<keyof CatalogPort>;
// … one factory per port, same shape
```

Fakes and suites follow the review hand-offs (08 A25 §(c)(ii)): the CatalogPort fake and suite add `getPriceListStatus` (A24.1); the IdentityPort fake and suite add `readSignatureImage` (A21.2) and accept `updatePartnerMembership` without `expectedVersion` (D-100); the SmartReportPort fake and suite: `buildSummary` never throws `smartreport.summary_not_ready` (D-111); the FrontdeskPort fake and suite add C14 and C15 as callers (D-110, CR-C14-009, CR-C15-014). Port `idempotencyKey` inputs in fakes are checked against `^[A-Za-z0-9_.:-]{1,200}$` (08 A19 P-40, A22.0). Every fake implements the "Fake must support" row of its IC §4 section. Every contract file implements the numbered case list of its IC §4 section exactly (owners may add cases, never remove — CV §8.4). The fakes for `QualityPort` and `SmartReportPort` default to the Phase-1 behaviour in IC §4.11 / §4.10 (`deny`/`feature_disabled`, `no_qc_data`; feature-disabled tenant).

### 5.5 Mocks

- `pnpm mock:<m>` → Prism 5.16.0 `mock contracts/openapi/<m>.yaml --host 127.0.0.1 --port <4100 + index of m in CM §3 module table>` [CONV port mapping, printed by `pnpm mock:list`]. Responses come from the spec examples, so the examples must be realistic synthetic data.
- `@lims/fakes/msw` → `setupServer(...handlers)` for Vitest; `setupWorker` is **not** shipped for the staff web (the browser never calls the API directly — 04 S4); web component tests mock the BFF server functions instead.

---

## 6. Workstream 0D — API core (`services/api/src/core/`)

### 6.1 File skeleton

```
services/api/src/
├── main.ts                      # loads config, calls bootstrap(), listens
└── core/
    ├── bootstrap.ts             # build Fastify instance, register plugins in the order of §6.2
    ├── config.ts                # typed LIMS_CORE_* config (§11), fails fast on missing/invalid values
    ├── module.ts                # ModuleManifest, Handler, HandlerContext types; autoloader
    ├── openapi.ts               # mounts specs through fastify-openapi-glue; securityHandlers; response validation toggle
    ├── auth/
    │   ├── jwt.ts               # verifyAccessToken(): pinned alg, iss, aud, exp (no grace), nbf
    │   ├── claims.ts            # buildDbClaims(): normalised claims object for request.jwt.claims (from claimsResolver / AuthResolver output only)
    │   ├── claims-resolver.ts   # calls the identity module's claimsResolver for every GoTrue JWT (mandatory; 08 R10)
    │   ├── bff-key.ts           # verifies X-Lims-Bff-Key on bffSession operations (staff_web, partner, portal keys from the secret store;
    │   │                        #   old + new key accepted during the rotation overlap; 08 R10, A13 D-32, A19 P-45)
    │   ├── client-ip.ts         # ctx.clientIp / app.client_ip per 08 A25 P-61 (§6.4)
    │   └── resolvers.ts         # AuthResolver registry: deviceToken (instruments), queueDisplayToken + patientPreAuth (engagement),
    │                            #   portalSession (reporting), paymentCallbackToken (payments) — one module per scheme, CI-checked
    ├── db/
    │   ├── pool.ts              # pg Pool (PgBouncer URL for API); never exported to modules
    │   ├── tx.ts                # requestTx(), savepoint tx(), retry policy, context set_config
    │   └── sqlstate.ts          # SQLSTATE → ErrorCode mapping
    ├── errors.ts                # Fastify error handler → problem+json
    ├── idempotency.ts           # Idempotency-Key hook (§6.6)
    ├── ratelimit/
    │   ├── index.ts             # tier hook + ctx.rateLimit.consume()
    │   ├── redis.ts             # sliding-window counters (ioredis)
    │   └── pg.ts                # fallback via app.ratelimit_hit()
    ├── ports/
    │   ├── registry.ts          # real vs fake resolution, LIMS_CORE_FAKE_PORTS, production guard
    │   ├── phase-stubs.ts       # committed allowlist of ports that may resolve to a phase stub in staging/production (§9; 08 R9)
    │   └── authz-guard.ts       # wraps IdentityPort.assertRole to record "asserted" per request
    ├── uploads/                 # ctx.uploads.accept(): multipart parser, per-route cap, magic bytes + extension, image re-encode, scan (08 §4.13)
    ├── storage/                 # ctx.storage.*: server-side Storage adapter; the only reader of the Storage service credential (08 R12b),
    │   │                        #   read from LIMS_CORE_STORAGE_KEY_FILE [CONV] only; delete counts lims_core_storage_deletes_total (P-12)
    │   └── download.ts          # ctx.download.stream(): the core streaming download helper (08 A13 P-2, §6.3)
    ├── events/
    │   └── publish.ts           # events.publish(): validate → event_log insert → app.enqueue_job('core.event_fanout')
    ├── audit/
    │   └── access.ts            # ctx.audit.access(): insert audit.access_log
    ├── core-repo/
    │   └── index.ts             # ctx.core.*: read-only queries on core tables (§6.8)
    ├── system-actors.ts         # registry of module system actors + systemPermissions (from manifests)
    ├── observability/
    │   ├── logging.ts           # request logger binding (route template, no raw URL)
    │   ├── metrics.ts           # prom-client registry + required metrics (CV §9.4)
    │   └── tracing.ts           # traceparent parse/propagate
    ├── health.ts                # getLiveness / getReadiness handlers (§8)
    └── DECISIONS.md             # spike outcomes that affect the core (SP-1, SP-8, SP-9)
```

### 6.2 Request pipeline (Fastify hook order)

| # | Stage | Behaviour |
|---|---|---|
| 1 | `onRequest` request id | `X-Request-Id` if it is a valid UUIDv7 (set by nginx/BFF), else a new `uuidv7()`; parse `traceparent` |
| 2 | `onRequest` body-size guard | limit from route (`common.payload_too_large`); default JSON body limit 1 MB [CONV]; multipart 15 MB (CV §10.2) |
| 3 | routing + spec validation | fastify-openapi-glue + ajv; unknown fields/params → `400 common.validation_failed` with `errors[]` (sub-codes `common.unknown_field`, `common.field_required`, `common.field_invalid`) |
| 4 | security handler | per `security` of the operation: `bearerJwt` → `auth/jwt.ts` then the identity `claimsResolver` (mandatory, the only claims source — 08 R10); `bffSession` → `X-Lims-Bff-Key` check (`auth/bff-key.ts`; kinds `staff_web`, `partner`, `portal`) + identity session lookup, only on `/v1/identity/auth/*`; `deviceToken`/`queueDisplayToken`/`portalSession`/`patientPreAuth`/`paymentCallbackToken` → resolver of the single owning module (08 R10 table); `x-public` → anonymous actor (no tenant) |
| 5 | rate limit | tier from `x-rate-limit-tier`; `general` and `ingest` enforced here automatically; other tiers via `ctx.rateLimit.consume()` in the handler |
| 6 | idempotency (pre) | §6.6 |
| 7 | request transaction | `requestTx()` opens the transaction and sets context (§6.4); public operations without tenant get no DB transaction unless the handler asks for `ctx.db.anonymousTx()` (reporting `x-anonymous-tx` only) or, for module `identity` operations tagged `x-context: identity_auth` and listed in `LIMS_CORE_IDENTITY_AUTH_OPS`, `ctx.db.identityAuthTx(fn)` (08 A25 D-212, §6.3) |
| 8 | handler | `handlers[operationId](req, ctx)` |
| 9 | authz guard | in dev/ci/staging: non-public operation returning < 400 without an `assertRole` call → `500 common.internal`, log `authz_not_asserted` (AC-0D-2.4). In production, log + metric `lims_core_authz_not_asserted_total` only. Operations tagged `x-context: identity_auth` are exempt (they carry `x-public`; 08 A25 D-212) |
| 10 | idempotency (post) | status < 400: store the response in the same transaction (K2). Status ≥ 400: nothing is stored; if the handler called `ctx.commitOnError()`, the core deletes the `in_progress` key row in the same transaction before commit (08 A25 D-202, §6.6) |
| 11 | commit / rollback | commit on status < 400. On ≥ 400 the transaction **rolls back** unless the handler marked `ctx.commitOnError()` (security counters, `denied` access-log rows — explicit only, 08 A19 P-42) |
| 12 | response validation | dev/ci/staging: response validated against the spec; mismatch → `500 common.internal` + log `response_contract_violation` (REQ-ARCH-071) |
| 13 | `onResponse` log + metrics | one log line (CV §9.1 fields); `lims_http_requests_total`, `lims_http_request_duration_seconds` |

### 6.3 Module contract

```ts
// services/api/src/core/module.ts
import type { PortRegistry, RequestContext, Uuidv7, Uuid } from '@lims/contracts/ports/common';
import type { Operations, OperationId } from '@lims/api-client-ts/server';
import type { EventType, PermissionCode } from '@lims/contracts';

export type ModuleName = 'core' | 'identity' | 'audit' | 'catalog' | 'frontdesk' | 'billing' | 'lab' | 'instruments'
  | 'reporting' | 'analytics' | 'quality' | 'micro' | 'anatomic' | 'inventory' | 'partners' | 'smartreport'
  | 'payments' | 'engagement' | 'homecollection';

export interface HandlerResult<Op extends OperationId> {
  readonly status: keyof Operations[Op]['responses'] & number;
  readonly body?: unknown;                         // narrowed by generated type per status in Operations
  readonly headers?: Readonly<Record<string, string>>;
}
export type Handler<Op extends OperationId> = (
  req: { params: Operations[Op]['params']; query: Operations[Op]['query']; headers: Operations[Op]['headers']; body: Operations[Op]['body'] },
  ctx: HandlerContext,
) => Promise<HandlerResult<Op>>;

export interface HandlerContext extends RequestContext {      // RequestContext from IC §4.1 (tenantId, actor, requestId, tx, now, ports)
  readonly db: { tx<T>(fn: (tx: RequestContext) => Promise<T>): Promise<T> };   // SAVEPOINT inside the request transaction
  readonly core: CoreRepository;                                                  // §6.8
  readonly audit: { access(entry: AccessLogEntry): Promise<void> };               // §6.9
  readonly events: { publish<E extends EventType>(ctx: RequestContext, type: E, e: PublishInput<E>): Promise<{ eventId: Uuidv7; duplicate: boolean }> };
  readonly rateLimit: { consume(tier: RateLimitTier, key: string): Promise<void> }; // throws LimsError('common.rate_limited') with retryAfterSeconds
  readonly uploads: { accept(file: IncomingFile, opts: UploadAcceptOptions): Promise<AcceptedUpload> };   // 08 §4.13 (R12b)
  readonly files: { scan(bytes: Uint8Array): Promise<'clean' | 'infected' | 'unavailable'> };         // ClamAV-class service (C1); mandatory in staging/prod
  readonly storage: StorageAdapter;                 // put/read/move/signedUrl/delete per 08 §4.13; first path segment = ctx.tenantId; module may write only its own <module>-* buckets (08 R26)
  readonly log: Logger;
  readonly services: unknown;                       // the module's own services object (typed by the module through createServices)
  readonly operationId: OperationId;
  readonly clientIp: string;                        // 08 A25 P-61 (§6.4); modules never parse a header
  readonly download: {                              // core streaming download helper (08 A13 P-2, D-67; core/storage/download.ts)
    stream(input: { bucket: BucketName; objectPath: string; filename: string; contentType: string;
                    scanState: 'clean' | 'pending' | 'infected' | 'unavailable'; access: AccessLogEntry;
                    inline?: { reencodedImage: true } }): Promise<HandlerResult<any>>;
    // Streams the object through the API (the BFF proxies the stream). Headers: Content-Disposition: attachment (filename RFC 6266
    // encoded), X-Content-Type-Options: nosniff, Cache-Control: no-store. scanState ≠ 'clean' → throws 422 common.upload_quarantined
    // (P-2, P-19). Writes the access-log row (input.access) in the request transaction. `inline` is allowed only for PNG/JPEG that
    // ctx.uploads.accept re-encoded (08 A13 D-67): Content-Disposition: inline, still nosniff/no-store. ctx.storage.signedUrl never
    // appears in a response, header or log.
  };
  commitOnError(): void;
  noRetry(): void;                                  // disables the 40001/40P01 whole-request retry for this request (§6.4; C15 gateway calls)
}

export interface ModuleManifest {
  readonly name: ModuleName;                        // = schema = openapi file stem
  readonly openapi: `contracts/openapi/${string}.yaml`;
  readonly handlers: { readonly [Op in OperationId]?: Handler<Op> };   // must cover exactly the operationIds of `openapi`
  readonly createServices?: (deps: CoreDeps) => unknown;
  readonly ports?: Partial<PortRegistry>;           // only ports this module owns (CM §5.1); checked against PORT_OWNERS
  readonly produces: readonly EventType[];          // must equal EVENT_PRODUCERS[name] (IC §3.25)
  readonly systemPermissions?: readonly PermissionCode[];   // permissions of this module's system actor; never platform.*
  readonly claimsResolver?: ClaimsResolver;         // accepted only from module 'identity' (CR-C2-005; 08 R10); C2 02-TRD §6.1
  readonly authResolvers?: {                         // module → allowed resolvers (CI-checked; 08 §4.11)
    readonly deviceToken?: AuthResolver;             // 'instruments'
    readonly portalSession?: AuthResolver;           // 'reporting' (may return { error: 'reporting.link_invalid' } → 404, CR-C6-001)
    readonly paymentCallback?: AuthResolver;         // 'payments'   (actor: system of payments; extraClaims { payment_intent_id })
    readonly patientPreAuth?: AuthResolver;          // 'engagement' (actor: patient; extraClaims { patient_stage, otp_token_sha256 })
    readonly queueDisplayToken?: AuthResolver;       // 'engagement' (actor: device; extraClaims { device_kind: 'queue_display' })
  };
}

export interface AuthResolver {
  /** Runs inside an anonymous transaction; must call only its inventoried DEFINER lookup function. Returns undefined when invalid. */
  resolve(credential: string, tx: DbTxAnonymous): Promise<{ tenantId: Uuidv7; actor: { type: 'device' | 'portal' | 'patient' | 'system'; id: Uuid }; centreId?: Uuidv7; extraClaims?: Readonly<Record<string, string>> } | { error: ErrorCode } | undefined>;
}
// Allowed extraClaims keys per module (core copies them into request.jwt.claims; 08 §4.11): reporting {portal_stage, portal_report_id, portal_session_id};
// instruments {credential_kind, credential_id}; payments {payment_intent_id}; engagement {patient_stage, otp_token_sha256, device_kind}.
// Further core APIs (08 §4.11): ctx.db.anonymousTx() (reporting only, x-public + x-anonymous-tx); ctx.db.withTenantScope(tx, tenantId, fn)
// (identity, platform context, operationId allowlist LIMS_CORE_WITH_TENANT_SCOPE_OPS (08 R10 item 4 as extended by 08 A25 D-214):
// provisionTenant, inviteTenantAdmin, activateTenant, suspendTenant, reactivateTenant, terminateTenant, updateTenantSettingsAsPlatform,
// setFeatureFlagAsPlatform, openSupportSession, activateSupportSession, endSupportSession, revokeSupportSession (only where C2 TRD §5.10
// runs them in platform context), getDeadLetter; every use writes a tenant access-log row — tenant.lifecycle_change, settings.change,
// support_session.open/.activate/.close/.revoke, dead_letter.view. 08 A28.2 adds the patient-context IdentityPort writes provisionPatientMembership, openPatientSession, revokePatientSessions, run by C2 inside withTenantScope(ctx.tenantId, <identity system actor>) (gated by D-218). Core-internal uses outside module identity: the worker-core cron
// fan-out (08 A23.1) and ctx.core.deadLetters.replay of a tenant row (08 A23.2), each under the owning module's system actor. No module
// code calls withTenantScope); ctx.core.systemActorPermissions(actorId) (CR-C2-013).
// ctx.db.identityAuthTx(fn) (08 A25 D-212): only for module 'identity' operations tagged x-context: identity_auth and listed in
// LIMS_CORE_IDENTITY_AUTH_OPS (loginStaff, loginPartner, openMobileSession, refreshMobileSession, logoutMobileSession, confirmEmailToken,
// requestPasswordRecovery, verifyMfaChallenge, startMfaEnrolment, completeMfaEnrolment, resolveSession, logoutSession,
// setPasswordFromSetup, resolvePatientSession, logoutPatientSession). Opens the request transaction with claims
// { sub: <identity system actor>, actor_type: 'system' } and no tenant_id (only inventoried DEFINERs and the tenant-less auth_events
// insert work then). tx.bindTenant(tenantId) may be called once, after a DEFINER (identity_login_context / identity_session_by_token /
// identity_resolve_session) chose the membership; it rewrites the transaction-local claims to { …, tenant_id } so the ordinary
// __tenant policies (staff guard admits system) apply; a second call throws common.internal. Every success path writes an access-log or
// auth event (C2).
export interface PublishInput<E extends EventType> {
  readonly aggregate: { readonly type: string; readonly id: Uuidv7; readonly seq: number };
  readonly idempotencyKey: string;                  // per IC §3.x
  readonly payload: EventPayload<E>;
  readonly causationEventId?: Uuidv7;
}
```

Autoloader (`module.ts`): `glob('src/modules/*/index.ts')` at boot. For each, import `manifest` and validate: name equals the directory; spec file exists; handler key set equals spec operationId set (boot fails otherwise — AC-0D-1.2); `ports` keys ⊆ ports owned by this module (`PORT_OWNERS` from IC §4 headings: CatalogPort→catalog, FrontdeskPort→frontdesk, BillingPort→billing, LabPort→lab, ReportingPort→reporting, NotificationPort→reporting, IdentityPort→identity, PaymentProviderPort→payments, SmartReportPort→smartreport, QualityPort→quality, BillingCommandPort→billing (consumer allowlist: frontdesk only), RenderPort→reporting, EngagementPort→engagement); `produces` equals `EVENT_PRODUCERS[name]`; `claimsResolver` only from `identity`; **port consumers (08 A19 P-46):** the registry hands `ctx.ports.<Port>` to a module only if it is listed in `PORT_CONSUMERS[<Port>]` (generated from the 03-IC §4.x headings, §5.3) — otherwise the access throws `LimsError('common.internal')` and logs `port_consumer_not_listed{module,port}` in dev/ci/staging (production: log + metric `lims_core_port_consumer_not_listed_total` [CONV]); the `contracts` CI job fails a static `ctx.ports.<Port>` use in `services/{api,worker}/src/{modules,jobs}/<m>/**` by a non-listed module; `authResolvers.deviceToken` only from `instruments`, `portalSession` only from `reporting`, `paymentCallback` only from `payments`, `patientPreAuth`/`queueDisplayToken` only from `engagement`. `contracts/openapi/core.yaml` is mounted with the core's own handlers (§8).

### 6.4 Database transactions (`core/db/tx.ts`)

```ts
export interface DbClaims {          // exactly what policies read (CV §5.8); JSON-serialised into request.jwt.claims
  sub: string; tenant_id?: string; membership_id?: string; centre_id?: string;
  actor_type: 'user' | 'system' | 'device' | 'portal' | 'patient' | 'partner';
  aal?: 'aal1' | 'aal2'; support_session_id?: string;
  lims_session_id?: string; session_state?: string;                          // identity sessions (08 R10)
  scope?: 'platform' | 'support'; platform_staff_id?: string; platform_role?: string; support_scope?: string;   // platform context (CR-C2-004)
  [extra: string]: unknown;                                                  // resolver extraClaims (allowlisted keys per module, §6.3)
}
// Claims shapes per session kind (tenant_staff, platform, partner, patient, staff_mobile): 08 R10 table; built only by the identity claimsResolver.
```

Request transaction opening (one round trip after `BEGIN`):

```sql
SELECT set_config('request.jwt.claims', $1::text, true),
       set_config('app.request_id',     $2::text, true),
       set_config('app.client_ip',      $3::text, true),
       set_config('app.user_agent',     $4::text, true),
       set_config('statement_timeout',  $5::text, true),   -- default '5000' ms [CONV]
       set_config('lock_timeout',       $6::text, true),   -- default '3000' ms [CONV]
       now() AS tx_started_at;
```

- `$1` is built by `buildDbClaims()` from the **verified** token or resolver result, never from request input (04 D2; REQ-SEC-013). `app.client_ip` (= `ctx.clientIp`, 08 A25 P-61): the core takes it from `X-Forwarded-For` (single hop; nginx overwrites it, C1 TRD §6.6) only when (a) the request carries a valid `X-Lims-Bff-Key`, or (b) the TCP peer address is in `LIMS_CORE_TRUSTED_PROXY_CIDRS` (C1 sets it to the nginx container address on `edge_net`); otherwise it uses the TCP peer address. Module code reads only `ctx.clientIp`; it never parses a header. `app.user_agent` is truncated to 512 chars.
- `tx_started_at` is kept as `tx.startedAt` and used as the event `occurred_at` (CV §7.1 "transaction time").
- `ctx.db.tx(fn)` → `SAVEPOINT s<n>` / `RELEASE` / `ROLLBACK TO`. Ports always receive the caller's `RequestContext` with the same `tx` (CV §8.1).
- Retry: SQLSTATE `40001` / `40P01` → whole request transaction retried up to `LIMS_CORE_TX_RETRY_MAX` (3) times with jitter 10–50 ms [CONV], only when no external side effect has happened (always true for handlers, by the outbox rule CV §7.3). A handler that calls `ctx.noRetry()` (C15 `PaymentProviderPort` paths, C15 TRD) is never retried: a `40001`/`40P01` then ends the request with `503 common.dependency_unavailable`, so a gateway initiate cannot repeat.
- The pool is module-private. Modules never get a raw client (CV §5.10).
- Worker transactions use the identical function with the worker's direct-connection pool (§7).

SQLSTATE mapping (`core/db/sqlstate.ts`; a module may catch and re-map to its own codes first):

| SQLSTATE / condition | Error code | HTTP |
|---|---|---|
| `P0001` with message `immutable_row` | `common.immutable_record` | 409 |
| `42501` (RLS `WITH CHECK` / privilege) | `common.not_found` (+ `lims_rls_denied_total`) | 404 |
| `23503` FK violation | `common.not_found` (no existence oracle — REQ-SEC-026) | 404 |
| `23505` unique violation not re-mapped by the module | `common.internal` + log `unmapped_unique_violation{constraint}` | 500 |
| `23514` check violation not re-mapped | `common.validation_failed` | 400 |
| `40001`, `40P01` after retries | `common.dependency_unavailable` | 503 |
| `55P03` lock timeout (module may re-map, e.g. `billing.counter_busy`) | `common.dependency_unavailable` | 503 |
| `57014` statement timeout | `common.dependency_unavailable` | 503 |
| connection errors | `common.dependency_unavailable` | 503 |

### 6.5 Authentication (`core/auth/`)

- Algorithm pinned per environment: `LIMS_CORE_JWT_ALG` ∈ {`HS256`, `ES256`, `RS256`}. Which one the pinned GoTrue issues, and that it issues `session_id` and `aal`, is confirmed in SP-1 (rescoped, 08 R10). Key material comes from a file path (`LIMS_CORE_JWT_KEY_FILE`, secret store mount — REQ-SEC-128). JWKS is read from a local file, never fetched from a URL at run time.
- Checks: signature; `alg` equals the pinned alg (reject `none`/others — REQ-SEC-066); `exp` strictly in the future with **0 s leeway** (04 A7); `nbf`/`iat` not in the future beyond 60 s clock skew [CONV]; `iss` = `LIMS_CORE_JWT_ISSUER`; `aud` = `LIMS_CORE_JWT_AUDIENCE`.
- Claims source: the identity module's `claimsResolver` (mandatory; CR-C2-005; 08 R10) maps `(session_id, sub)` to the session row; claims inside the JWT other than `sub`, `session_id`, `aal`, `exp`, `iat` are ignored. A token without `session_id` → `401 auth.token_invalid`.
- Privileged-permission re-validation, MFA level and lock state are **IdentityPort** concerns (C2). Core only forwards `aal` from the token into `ctx.actor` metadata and claims.
- `ctx.actor` = `{ type, id: sub, membershipId, supportSessionId? }` (IC §4.1).
- Session-kind binding comes from the calling BFF's `X-Lims-Bff-Key` (kinds `staff_web`, `partner`, `portal`; 08 A13 D-32, A19 P-45; old and new key accepted during the C1 rotation overlap) or from the endpoint family (`/v1/identity/auth/patient/*`, `/v1/identity/mobile/*`), never from a client header; no client-supplied origin/kind header is trusted (08 R10).

### 6.6 Idempotency (`core/idempotency.ts`)

Applies to operations with `x-idempotency: required|optional` when the header is present (`required` + absent → `400 common.idempotency_key_required`).

1. `request_sha256` = SHA-256 of canonical JSON `{ method, route_template, path_params, query, body }` (keys sorted, no whitespace).
2. **Claim** in a separate short autocommit transaction with the caller's claims:
   `INSERT INTO core.idempotency_keys (tenant_id, actor_id, key, method, route, request_sha256, state, created_at, expires_at) VALUES (…, 'in_progress', now(), now() + interval '7 days') ON CONFLICT (tenant_id, actor_id, key) DO NOTHING RETURNING key`.
3. If no row was returned, `SELECT` the existing row:
   - `request_sha256` differs → `422 common.idempotency_key_reused`;
   - `state = 'completed'` → replay `response_status` + `response_body`, header `Idempotent-Replayed: true`, handler not run;
   - `state = 'in_progress'` and `created_at > now() - 60 s` [CONV] → `409 common.idempotency_in_progress`, `Retry-After: 1`;
   - `state = 'in_progress'` and older → treated as abandoned (crashed process): take over with `UPDATE … SET created_at = now() WHERE … AND state = 'in_progress' AND created_at <= now() - interval '60 seconds' RETURNING key` (0 rows → 409 as above).
4. Handler runs in the request transaction. Before commit, in **the same transaction**: `UPDATE core.idempotency_keys SET state='completed', response_status=$s, response_body=$b WHERE (tenant_id, actor_id, key) = (…)` for status **< 400** only (08 A25 D-202).
5. Status ≥ 400 — 4xx and 5xx — store nothing (D-202): when the transaction rolls back, a separate transaction `DELETE … WHERE … AND state = 'in_progress'` releases the key (policy allows only the actor's own in-progress rows — `05-SCHEMA.md` §6); when the handler called `ctx.commitOnError()` (P-42), the core runs that DELETE inside the request transaction before commit. A retry with the same key re-runs the handler (a retried wrong password therefore counts again — intended). Tests: 4xx rollback, 4xx with `commitOnError`, 5xx (T0D-05).
6. Public operations (no tenant) never use idempotency; operations that need it must be authenticated. Platform-context operations (`provisionTenant`, `openSupportSession`, `invitePlatformStaff`) store their key with `tenant_id` NULL (08 A25 D-213; `UNIQUE NULLS NOT DISTINCT (tenant_id, actor_id, key)`, `__platform` policies). Non-staff actors (partner, portal, patient) use their own rows (`shared_with`, 08 A23.3).

### 6.7 Rate limiting (`core/ratelimit/`)

| Tier | Key (hashed with HMAC-SHA256, server key `LIMS_CORE_RATELIMIT_KEY_FILE`, so no PHI is stored) | Algorithm | Limit (04 §4) |
|---|---|---|---|
| `general` | `u:<actor_id>` and `t:<tenant_id>` | token bucket | user 10 req/s, burst 20; tenant aggregate default **100 req/s, burst 200** [CONV, see §10.1] configurable `LIMS_CORE_TENANT_RPS`/`LIMS_CORE_TENANT_BURST` |
| `ingest` | `d:<device_id>` | sliding window 60 s | 60 requests/min/device |
| `login` | caller passes `a:<account>` and, for failures only, `f:<client_ip>` (client IP as seen by the public edge, forwarded by the BFF — never the BFF's own address); the edge flood guard is nginx (C1) | sliding window | 10/hour/account; per client IP **failed attempts only**: ≥ 10 failures in 10 min → 5 attempts/min for 30 min (C2 applies it; successful logins never count); nginx 60 req/min/IP burst 20 on public login/recovery routes (08 Addendum A1) |
| `otp_request` | caller passes `p:<phone_e164>` | sliding window 1 h | 3/hour/phone |
| `otp_verify` | caller passes `o:<otp_id>` | counter for the OTP's lifetime | 5 attempts |
| `qr_verify` | `i:<client_ip>` (per-minute part is nginx) | sliding window 24 h | 100/day/IP |
| `report_download` | caller passes `l:<link_id>` | sliding window 1 h | 20/hour/link |

Backend: Redis (`LIMS_CORE_RATELIMIT_BACKEND=redis`, ephemeral, no persistence — 04 S11) or Postgres fallback `app.ratelimit_hit(key_hash, window_seconds, limit)` over the UNLOGGED table `core.rate_limit_counters` (`05-SCHEMA.md` §3.8). On exceed: `429 common.rate_limited`, `Retry-After` = seconds until a slot frees (rounded up), metric `lims_ratelimit_rejections_total{tier}`. If the backend is unavailable: fail **open** for `general` (log + alert `ratelimit_backend_down`) and fail **closed** (`503 common.dependency_unavailable`) for `login`, `otp_request`, `otp_verify`, `qr_verify`, `report_download` (brute-force surfaces, REQ-SEC-078) — DECISION.

### 6.8 Core repository (`ctx.core`, read-only)

```ts
export interface CoreRepository {
  tenant(ctx: RequestContext): Promise<{ id: Uuidv7; tenantCode: string; displayName: string; legalName: string; status: 'provisioning' | 'active' | 'suspended' | 'offboarded'; timezone: string }>;
  branches(ctx: RequestContext, input?: { activeOnly?: boolean }): Promise<readonly BranchRow[]>;
  branch(ctx: RequestContext, input: { branchId: Uuidv7 }): Promise<BranchRow>;                // common.not_found
  centres(ctx: RequestContext, input?: { branchId?: Uuidv7; activeOnly?: boolean; kinds?: readonly ('own' | 'franchise' | 'home_collection')[] }): Promise<readonly CentreRow[]>;   // `kinds` = 08 §4.11 ctx.core.centres.list (CR-C17-013)
  centre(ctx: RequestContext, input: { centreId: Uuidv7 }): Promise<CentreRow>;   // CentreRow below (incl. phoneDisplay, C4 hand-off)
  user(ctx: RequestContext, input: { userId: Uuid }): Promise<{ id: Uuid; displayName: string; isActive: boolean }>;
  membership(ctx: RequestContext, input: { membershipId: Uuidv7 }): Promise<MembershipRow>;   // MembershipRow below (08 A17 D-47)
  membershipPermissions(ctx: RequestContext, input: { membershipId: Uuidv7 }): Promise<readonly PermissionCode[]>;
  memberships: { list(tx: RequestContext, input: { centreId?: Uuidv7; roleCode?: string; permission?: PermissionCode;
      membershipIds?: readonly Uuidv7[] /* ≤ 200 */; activeOnly?: boolean /* default true */; limit?: number /* 1–500, default 200 */ }):
    Promise<readonly { membershipId: Uuidv7; displayName: string; roleCodes: readonly string[]; allCentres: boolean; isActive: boolean }[]> };   // 08 A17 D-47 (widens CR-C17-013; existing calls stay valid)
  systemActorPermissions(actorId: Uuid): readonly PermissionCode[];   // CR-C2-013, built from worker manifests
  deadLetters: {                                                     // used only by C2's platform console handlers after PlatformAuthz.assertPlatform(platform.dead_letter.manage) (08 R23)
    list(ctx: RequestContext, input: {                                // filters = C2 listDeadLetters (08 A9.2)
      state?: 'open' | 'replayed' | 'discarded';
      platformRows?: boolean;                                          // true → only rows with tenant_id IS NULL (via app.dl_list_platform)
      tenantId?: Uuidv7;
      taskIdentifier?: string;
      deadAtFrom?: IsoUtc;                                             // inclusive (02-CV §4.4)
      deadAtTo?: IsoUtc;                                               // exclusive (02-CV §4.4)
      cursor?: string;
      limit?: number;                                                  // default 50, max 200 (02-CV §4.3)
    }): Promise<Page<DeadLetterRow>>;
    get(ctx: RequestContext, input: { deadLetterId: Uuidv7 }): Promise<DeadLetterRow>;   // throws LimsError('common.not_found') (08 A9.1); platform rows via app.dl_list_platform(p_dead_letter_id)
    replay(ctx: RequestContext, input: { deadLetterId: Uuidv7; expectedVersion: number; reasonText?: string }): Promise<void>;   // re-enqueues original job; state → replayed; optional note (1–500) → resolution_note (08 A8.4, A9.3); version + 1; tenant row: enqueue inside withTenantScope(row.tenant_id, owning module's system actor), job_key per §7.4 (08 A23.2)
    discard(ctx: RequestContext, input: { deadLetterId: Uuidv7; expectedVersion: number; reasonText: string }): Promise<void>;   // reasonText (1–500) → resolution_note (08 A8.4); who/when in resolved_by/resolved_at + audit_log; version + 1
    // expectedVersion = the caller's If-Match value (08 A6.4): the UPDATE is guarded by `version = expectedVersion`;
    // a mismatch (0 rows) throws LimsError('common.version_conflict') → 409; nothing is enqueued and the row is unchanged.
  };
}

// 08 A17 D-47 — memberships.list / membership semantics:
// - tenant from ctx only; actor_type = 'user' memberships only;
// - centreId: all_centres or member of that centre;
// - permission: a role of the membership grants it (core.role_permissions);
// - membershipIds: unknown or other-tenant ids are omitted (≤ 200 per call; more → `400 common.validation_failed` [CONV, P-1]);
// - displayName comes from core.users;
// - callers must be staff or system; portal, patient and partner actors get auth.forbidden.
export interface MembershipRow { readonly membershipId: Uuidv7; readonly userId: Uuid; readonly actorType: 'user'|'system'|'device'|'portal'|'patient'|'partner';
  readonly displayName: string; readonly status: 'invited'|'active'|'deactivated'; readonly isActive: boolean; readonly lockedAt?: IsoUtc;
  readonly allCentres: boolean; readonly centreIds: readonly Uuidv7[]; readonly roleCodes: readonly string[] }
export interface BranchRow { readonly id: Uuidv7; readonly branchCode: string; readonly name: string; readonly addressText?: string;
  readonly phoneDisplay?: string; readonly isProcessingLab: boolean; readonly isActive: boolean }
export interface CentreRow { readonly id: Uuidv7; readonly branchId: Uuidv7; readonly centreCode: string; readonly name: string;
  readonly centreKind: 'own'|'franchise'|'home_collection'; readonly addressText?: string; readonly phoneDisplay?: string;   // phone_display (C4 hand-off)
  readonly isActive: boolean }   // BranchRow / CentreRow = the 05-SCHEMA §3.2 columns, camelCased [CONV: no shape was written before]

// 08 A8.5 — C0 defines the dead-letter read shape. `job_payload` is never returned (it may contain identifiers);
// replay reads it inside C0 only. C2's list/get responses carry `version` for If-Match.
// 08 A10.1 — for a platform row (tenant_id IS NULL), replay gets job_payload from app.dl_resolve(..., 'replayed', ...);
// core-repo strips it before building DeadLetterRow (see stripPayload below) and re-enqueues it (§7.4).
export interface DeadLetterRow {
  readonly id: Uuidv7;
  readonly tenantId: Uuidv7 | null;                 // NULL = platform task (IC §12)
  readonly taskIdentifier: string;
  readonly lastErrorCode: string;
  readonly lastErrorMessageRedacted: string;        // logger-scrubbed, ≤ 2,000 chars
  readonly attempts: number;
  readonly firstFailedAt: IsoUtc;
  readonly deadAt: IsoUtc;
  readonly state: 'open' | 'replayed' | 'discarded';
  readonly resolvedBy: Uuid | null;
  readonly resolvedAt: IsoUtc | null;
  readonly resolutionNote: string | null;           // discard reason / optional replay note (08 A8.4)
  readonly version: number;                         // If-Match source for replay/discard (08 A3.4, A6.4)
}

// services/api/src/core/core-repo/dead-letters.ts — internal to core, not exported to modules (08 A10.1).
// Result row of app.dl_resolve after column mapping: DeadLetterRow + job_payload ('replayed' only; NULL for 'discarded').
interface DlResolveResult extends DeadLetterRow {
  readonly jobPayload: Readonly<Record<string, unknown>> | null;
}
// Split before anything leaves the function: `row` is the only shape ever returned or logged; `payload` goes only to app.enqueue_job.
function stripPayload(r: DlResolveResult): { readonly row: DeadLetterRow; readonly payload: Readonly<Record<string, unknown>> | null } {
  const { jobPayload, ...row } = r;
  return { row, payload: jobPayload };
}
```

All queries filter `tenant_id = ctx.tenantId` explicitly in addition to RLS (REQ-SEC-024). Writes to `core.*` tables are C2's: the lint rule `tools/lint/no-foreign-schema-sql` allows SQL mentioning `core.` only in `services/api/src/core/**` and `services/api/src/modules/identity/repository/**` (CM §3: core = C0 tables / C2 logic). Dead-letter rows with `tenant_id IS NULL` are reachable only through the DEFINER functions `app.dl_list_platform` / `app.dl_resolve` (`05-SCHEMA.md` §4.3 inventory; SQL bodies in §10, 08 A9.4, A9.6); the `__platform` policies admit only rows with `tenant_id IS NOT NULL` (08 A10.4). `app.dl_resolve(..., 'replayed', ...)` also returns `job_payload`, to this core service only: `stripPayload` separates it before a `DeadLetterRow` is built, `replay` returns `void`, and the payload is passed only to the core enqueue path (§7.4). No HTTP response, error detail or log line contains it (08 A10.1; A8.5 holds at every API boundary). `ctx.core.deadLetters.list` filters (08 A9.2): `state`, `tenantId` and the `dead_at` range are served by `dead_letters__state_dead_at__idx (state, dead_at)` and `dead_letters__tenant_id_state_dead_at__idx (tenant_id, state, dead_at)`; `taskIdentifier` has no index and is filtered in-page [CONV]. `ctx.core.deadLetters.get` returns the same `DeadLetterRow` shape and throws `common.not_found` when no row with that id is visible (08 A9.1). `core.dead_letters` is not part of the `identity/repository/**` allowance: SQL naming it is allowed only in `services/api/src/core/**` (not in `services/api/src/modules/**`), and C2 writes dead letters only through `ctx.core.deadLetters` (08 A8.6).

### 6.9 Audit access API

```ts
export interface AccessLogEntry {
  readonly action: Code;              // from audit.g_cs_access_actions (05-SCHEMA §3.3), e.g. 'report.view', 'report.download', 'invoice.reprint', 'data.export'
  readonly entityType: string;        // ≤ 40 chars, e.g. 'report_version'
  readonly entityId?: Uuidv7;
  readonly centreId?: Uuidv7;
  readonly purpose?: Code;            // e.g. FrontdeskPort DemographicsPurpose
  readonly outcome: 'allowed' | 'denied';
  readonly detail?: Readonly<Record<string, string | number | boolean>>;  // ids/counts only; values validated by the logger denylist (no PHI)
}
```
Valid `action` codes: 08 §4.4 (seeded in `audit.g_cs_access_actions`, CHECK `^[a-z_]+\.[a-z_]+$`). `ctx.audit.access()` inserts into `audit.access_log` inside the current transaction (it commits with the action). For `outcome: 'denied'`, the handler calls `ctx.commitOnError()` so the entry survives the error response.

### 6.10 Events publish (`core/events/publish.ts`)

Inside the caller's transaction:
1. Build envelope: `event_id = uuidv7()`, `event_type`, `tenant_id = ctx.tenantId`, `occurred_at = tx.startedAt`, `actor = ctx.actor` (snake-cased), `idempotency_key`, `producer` (= calling module, from the manifest; must be in `EVENT_PRODUCERS`), `aggregate`, `request_id = ctx.requestId`, `causation_event_id?`, `payload`.
2. Validate the full envelope against `contracts/events/<type>.schema.json` (ajv 2020-12, compiled at boot). Failure → throw `LimsError('common.internal')` + log `event_schema_violation{event_type}` (transaction rolls back — AC-0D-5.2).
3. `INSERT INTO core.event_log (…) VALUES (…) ON CONFLICT (tenant_id, event_type, idempotency_key) DO NOTHING RETURNING event_id`. No row → return `{ duplicate: true }` with the existing `event_id`, no enqueue (AC-0D-5.3).
4. `SELECT app.enqueue_job('core.event_fanout', jsonb_build_object('event_id', $id, 'tenant_id', $t), $id::text, NULL, NULL)`.
5. Metric `lims_core_events_published_total{event_type}`.

---

## 7. Workstream 0D — worker core (`services/worker/src/core/`)

### 7.1 File skeleton

```
services/worker/src/
├── main.ts
└── core/
    ├── bootstrap.ts          # config, pools, port registry (same as API — IC X7), Graphile Worker run()
    ├── manifest.ts           # WorkerManifest type + autoloader (src/jobs/*/index.ts)
    ├── tasklist.ts           # builds Graphile taskList: plain tasks + generated evt.* consumer tasks + core tasks
    ├── fanout.ts             # task core.event_fanout
    ├── consumer.ts           # wrapper: tenant tx + inbox + handler + seq helper
    ├── deadletter.ts         # final-failure capture → core.dead_letters (copies helpers.job.key into job_key, 08 A23.2)
    ├── tenant-scope.ts       # core-internal withTenantScope for the cron fan-out (08 A23.1, D-214)
    ├── storage/              # same storage adapter as the API core (08 R12b; 03-IC §13.6 services/{api,worker}/src/core/storage)
    ├── uploads/              # ctx.files.scan for re-scan jobs (P-19); worker never accepts multipart
    ├── cron.ts               # crontab assembly (in code — REQ-ARCH-042)
    ├── retention.ts          # task core.retention_purge
    ├── registry-sync.ts      # writes core.g_task_registry at deploy (run as migrator step, not at worker runtime)
    ├── replay.ts             # CLI: pnpm worker:replay --event-type --since --module (≤ 90 days, event_log retention)
    └── DECISIONS.md          # SP-2 outcome
```

### 7.2 Worker manifest

```ts
export interface WorkerManifest {
  readonly module: ModuleName;
  readonly tasks?: Readonly<Record<`${ModuleName}.${string}`, TaskHandler>>;       // plain tasks, identifier '<m>.<snake_task>'
  readonly subscriptions?: { readonly [E in EventType]?: ConsumerHandler<E> };     // must ⊆ EVENT_CONSUMERS for this module (IC §3.25)
  readonly crontab?: readonly { identifier: string; schedule: string /* 5-field, UTC */; tenantScope: 'per_tenant' | 'platform'; maxAttempts?: number }[];
  // tenantScope (08 A13 P-6, A23.1): 'per_tenant': at each schedule tick the worker core enqueues one job per tenant with
  // core.tenants.status IN ('active','suspended') [CONV]. Payload is {tenant_id}, job_key = '<identifier>:<tenant_id>:<tick, ISO minute>'
  // [CONV]. The job runs under that tenant's claims for the module's system actor. The tenant list comes from the DEFINER
  // app.cron_tenant_ids() RETURNS SETOF uuid (owner lims_owner, EXECUTE lims_worker, SET search_path = ''), which reads core.tenants
  // through tenants__select__owner_only gated by app.maintenance = 'cron_tenant_ids'. Tick: the worker core calls app.cron_tenant_ids()
  // under core system-actor claims (no tenant), then for each id runs, in its own transaction, withTenantScope(id, <module system actor>)
  // → app.enqueue_job(identifier, {tenant_id: id}, '<identifier>:<id>:<tick ISO minute>'), so the tenant-match check of app.enqueue_job
  // holds (05-SCHEMA §10 schema test 22).
  // 'platform' is for C0 core tasks and for module tasks that only call an inventoried DEFINER without tenant claims.
  readonly maxAttempts?: Readonly<Record<string, number>>;   // overrides per task (CV §7.5 classes)
  readonly taskOptions?: Readonly<Record<string, { statementTimeoutMs?: number /* ≤ 300000 */ }>>;   // CR-C8-012
}
export type TaskHandler = (payload: { tenant_id?: string } & Record<string, unknown>, ctx: JobContext) => Promise<void>;
export type ConsumerHandler<E extends EventType> = (event: EventEnvelope<E>, ctx: JobContext) => Promise<void>;
export interface JobContext extends RequestContext {      // actor = { type: 'system', id: <module system actor> }
  readonly db: { tx<T>(fn: (tx: RequestContext) => Promise<T>): Promise<T> };
  readonly events: HandlerContext['events']; readonly core: CoreRepository; readonly log: Logger;
  readonly storage: StorageAdapter;                 // 08 R12b; P-12 deletes (owner bucket only), P-13 reads
  readonly files: HandlerContext['files'];          // re-scan jobs: ctx.files.scan(await ctx.storage.read(bucket, objectPath)) (08 A17 P-19)
  readonly audit: HandlerContext['audit'];          // worker access-log rows (e.g. C6 portal.link_reissue)
  readonly attempt: number; readonly maxAttempts: number; readonly jobId: string;
  /** Returns true if `seq` is newer than the last applied seq the caller stored; helper only — storage is the consumer's read model (CV §7.4 step 3). */
  isNewer(lastAppliedSeq: number | undefined, seq: number): boolean;
}
```

### 7.3 Event fan-out and consumption

`core.event_fanout` (payload `{event_id, tenant_id}`):
1. Open a tenant transaction with claims `{sub: <core system actor>, tenant_id, actor_type: 'system'}`.
2. `SELECT event_type, envelope FROM core.event_log WHERE tenant_id = $t AND event_id = $e`. Missing → log `fanout_event_missing` and complete (it can happen only after retention purge).
3. For each module `m` subscribed to `event_type`: `SELECT app.enqueue_job('evt.' || m || '.' || event_type, jsonb_build_object('event_id', $e, 'tenant_id', $t, 'event_type', $type), $e || ':' || m, NULL, 10)`.
4. Commit. Metric `lims_core_event_fanout_lag_seconds` = `now() - occurred_at`.

`app.enqueue_job` calls `graphile_worker.add_job(identifier, payload, queue_name => NULL, run_at, max_attempts, job_key, job_key_mode => 'unsafe_dedupe')`. Parameter names and the `job_key_mode` values (`replace` default, `preserve_run_at`, `unsafe_dedupe`) are taken from Graphile Worker's `add_job` documentation page (fetched 2026-11-05). Matching them to 0.18.0 exactly is part of SP-2. `unsafe_dedupe` is chosen so that a re-run fan-out never resets the attempt counter of a pending or permanently failed consumer job (DECISION). The durable dedupe is still the inbox (CV §7.4).

Consumer task `evt.<m>.<event_type>` (generated by `tasklist.ts`):
1. Open a tenant transaction with claims of `m`'s system actor.
2. `INSERT INTO <m>.event_inbox (tenant_id, event_id, event_type, received_at, created_by) VALUES (…, now(), <actor>) ON CONFLICT (tenant_id, event_id) DO NOTHING RETURNING event_id`. No row → commit, return (AC-0D-5.5).
3. Load the envelope from `core.event_log` (consumer modules have `SELECT` on `core.event_log` through the `__select__tenant` policy). Validate **known fields only** (CV §7.2): ajv with `removeAdditional: 'all'` on a cloned schema.
4. Call the module's `ConsumerHandler` with the envelope and `JobContext` (same transaction).
5. Commit. A throw rolls everything back, including the inbox row, and Graphile retries.

Job payloads hold ids only (`event_id`, `tenant_id`, `event_type`), so the queue tables hold no PHI (P1).

### 7.4 Dead letters

On a task's final attempt failure (detection mechanism = SP-2 outcome: Graphile Worker events API, or the wrapper comparing `helpers.job.attempts` with `max_attempts` before rethrowing), the wrapper, in its own transaction with the job's tenant claims (or platform context for `tenantScope: 'platform'`), inserts `core.dead_letters` with `job_key` (= `helpers.job.key`, NULL if the job had none; 08 A23.2), `last_error_code` (`LimsError.code` or `common.internal`), `last_error_message_redacted` (logger scrubber applied, ≤ 2,000 chars), `attempts`, `first_failed_at`, `dead_at = now()`, `state = 'open'`. Then it increments `lims_core_dead_letters_total{task}` (alert → C1). For `tenantScope: 'platform'` tasks the row has `tenant_id IS NULL` and is inserted through `app.dl_insert_platform(...)` (`05-SCHEMA.md` §4.3, §10). Replay via `ctx.core.deadLetters.replay({ deadLetterId, expectedVersion, reasonText? })` (If-Match; `409 common.version_conflict` on mismatch, 08 A6.4) re-enqueues the stored `job_payload` with `job_key = coalesce(job_key, task_identifier || ':' || id) || ':replay:' || <version after the bump>` (08 A23.2; a second replay of the same row is impossible — only `open` rows are replayed — and every replay key is distinct). **Tenant rows** (08 A23.2): `ctx.core.deadLetters.replay` runs under platform claims; it does the version-guarded state change through the `__platform` policies, then re-enqueues inside `withTenantScope(row.tenant_id, <owning module's system actor from core.g_task_registry.module>)`, so `app.enqueue_job`'s tenant-match check holds — the platform actor never enqueues a tenant job directly; the state change and the enqueue commit or roll back together (`05-SCHEMA.md` §10 schema test 23); the optional `reasonText` (1–500 chars) is stored in `resolution_note` (08 A8.4, A9.3). Discard via `ctx.core.deadLetters.discard({ deadLetterId, expectedVersion, reasonText })` stores `reasonText` (1–500 chars) in `resolution_note` (08 A8.4). Platform rows are resolved through `app.dl_resolve(...)` with the same version guard (`05-SCHEMA.md` §10, 08 A9.4). Platform-row replay (08 A10.1): in the request transaction core calls `app.dl_resolve(deadLetterId, expectedVersion, 'replayed', reasonText)`. 0 rows → `LimsError('common.version_conflict')`, nothing enqueued. Otherwise `stripPayload` (§6.8) splits off `job_payload`, and core re-enqueues it through the existing core enqueue path, `app.enqueue_job(task_identifier, job_payload, <replay job_key as above>)` (the `platform` scope skips the tenant-match check), in the same transaction; `app.dl_resolve` also returns the row's `job_key` (core-only, like `job_payload`) for the replay key. The state change and the enqueue therefore commit or roll back together, as on the tenant-row path. `ctx.core.deadLetters.list` (filters `state`, `platformRows`, `tenantId`, `taskIdentifier`, `deadAtFrom`, `deadAtTo`, `cursor`, `limit` — 08 A9.2) and `ctx.core.deadLetters.get({ deadLetterId })` (`common.not_found` — 08 A9.1) return `DeadLetterRow` (§6.8), never `job_payload` (08 A8.5).

### 7.5 Retry classes

`max_attempts` per CV §7.5: `evt.*` = 10; tasks declared by modules use their manifest value (C6 messaging 8, C6 render 5, C4 CBMS per C4 TRD). Core tasks: `core.event_fanout` = 25 [CONV: fan-out must not dead-letter on transient DB issues], `core.retention_purge` = 5. Backoff = Graphile Worker built-in (not overridden — CV §7.5). The exact built-in formula is confirmed in SP-2 and recorded.

### 7.6 Cron (core)

| Identifier | Schedule (UTC) | Scope | Action |
|---|---|---|---|
| `core.retention_purge` | `30 21 * * *` (= 03:15 Asia/Kathmandu) [CONV] | platform | declares `taskOptions: { 'core.retention_purge': { statementTimeoutMs: 300000 } }` (CR-C8-012 mechanism; 08 A25 D-200) and calls `app.purge_idempotency_keys()`, `app.purge_event_log()` (no argument; the 90-day predicate is in the function, 08 A12.4), `app.purge_event_inboxes()`, `app.purge_dead_letters()` (no argument; the 90-day predicates are in the functions, 08 A15.4), `app.purge_ratelimit_counters()`, **each in its own transaction**. Each returns `(deleted, capped)`: `deleted` is logged and exported as `lims_core_retention_purged_total{table}`; `capped = true` (the function's 4-minute loop cap was hit; the next day's run continues) increments `lims_core_retention_purge_capped_total{table}` [CONV] (C1 alerts when > 0 for 3 days in a row) |
| `core.queue_depth_probe` | `* * * * *` | platform | reads queue depth through `app.queue_depth()` (DEFINER owned by `lims_queue`; returns `(task_identifier, ready, locked, failed)` counts only, `05-SCHEMA.md` §10) → `lims_queue_depth{task}` |

Audit/access-log retention (≥ 5 years, B15) is **not** purged by C0 cron. Shipping to the separate store is C1 (04 D11).

### 7.7 Task registry

`app.enqueue_job` rejects identifiers not present in `core.g_task_registry` (IC §12). At deploy (C1 pipeline step, also `pnpm dev:up`), `registry-sync.ts` runs as `lims_migrator` → `SET LOCAL ROLE lims_owner`, computes the full identifier set (core tasks + module tasks + `evt.<m>.<event>` for every subscription), upserts it and deactivates removed identifiers (`is_active = false`, never deleted, so old queued jobs still resolve).

---

## 8. Endpoints C0 implements (`contracts/openapi/core.yaml`)

| Method | Path | operationId | Security / permission | Request | Response 200 | Errors | Idempotency | Rate-limit tier |
|---|---|---|---|---|---|---|---|---|
| GET | `/v1/core/health/live` | `getLiveness` | `x-public: "process liveness for the orchestrator; no data"` | — | `{ "status": "ok" }` | `503 common.service_unavailable` | none | general (per IP via nginx only) |
| GET | `/v1/core/health/ready` | `getReadiness` | `x-public: "readiness for the orchestrator; dependency names only, no versions or hosts"` | — | `{ "status": "ok", "checks": { "db": "ok", "ratelimit": "ok" } }` (`checks` values enum `ok`/`degraded`/`down`) | `503 common.dependency_unavailable` (same body shape with failing checks) | none | general |

- The path segment `health` is singular, which deviates from CV §3 plural-resource naming [CONV exception, recorded as CR-C0-006].
- C1's nginx exposes these two paths only on the internal interface (C1 TRD). Metrics are served on a separate internal port (`LIMS_CORE_METRICS_PORT`) and are not part of the API spec.
- The staff BFF (Next.js) has no public API surface of its own beyond C2's login routes and module server actions.

## 9. Ports and events

| Kind | C0 implements | C0 consumes |
|---|---|---|
| Ports | none (fakes only, §5.4); the **registry** (§6.3) | `IdentityPort` through the authz guard (wrapper only, it never decides) |
| Events produced | none (the core publishes on behalf of modules) | none (the core dispatches on behalf of modules) |
| Background jobs | `core.event_fanout`, `core.retention_purge`, `core.queue_depth_probe` (§7) | — |

Port registry resolution (CV §8.2): for each port name, the real implementation if its owner module is loaded **and** the name is not in `LIMS_CORE_FAKE_PORTS` (comma list); otherwise the fake from `@lims/fakes`. Production/staging boot fails if any port resolves to a fake (AC-0D-6.2), except a phase stub listed in `phase-stubs.ts` (below; 02-CV §8.2, 08 R9). The gauge `lims_core_fake_ports_active` reports how many fakes are in use.

**Phase stubs (CR-C0-010, designed as accepted).** IC §4.11 says Phase 1 runs with the *registered fake* of `QualityPort` (always `deny`/`feature_disabled`, `no_qc_data`). `SmartReportPort` (Phase 2–3), `PaymentProviderPort` (Phase 1.5–2) and `EngagementPort` (C16, Phase 2–3; consumed by C4 in Phase 1) also have no owner module in Phase 1. A literal CV §8.2 production check would therefore make Phase-1 production unbootable. Resolution: `@lims/fakes` exports a separate, minimal **phase stub** per not-yet-delivered port (`packages/fakes/src/stubs/<Port>.stub.ts`). A stub has no seeding, no failure injection, no in-memory data, and returns only the documented "feature off" outcome:
- `QualityPort`: the IC §4.11 Phase-1 behaviour.
- `SmartReportPort`: throws `smartreport.feature_disabled`.
- `PaymentProviderPort`: every method (incl. `getIntent`, `cancelIntent`) throws `payments.gateway_not_available`.
- `EngagementPort`: `getActiveMembership` → `undefined`; `getHomeAddress` → `common.not_found`.

`RenderPort`, `BillingCommandPort` and the deferred `Legacy*ImportPort`s get no stub (08 R9).

Replacing a stub (08 A17 P-20): the first PR that creates `services/api/src/modules/<owner>/` removes the port from `phase-stubs.ts` (paired C0-0D PR; AC-0D-6.3 unchanged). In the same PR the module registers its own port implementation, which returns exactly the stub results for every method not yet built and passes the `phase1Stub` contract subset; each later task replaces one method. No C0 manifest flag is added.

Stubs are allowed in staging/production only for ports listed in the committed file `services/api/src/core/ports/phase-stubs.ts` (default: QualityPort, SmartReportPort, PaymentProviderPort, EngagementPort — 08 R9). The list shrinks as owners ship, and CI fails if a listed port's owner module exists. Stubs pass the subset of the contract suite marked `phase1Stub` in each suite. The gauge `lims_core_phase_stub_ports_active` reports them separately from fakes.

---

## 10. Performance targets (derived from 04 §14; ASSUMPTION until load-tested)

### 10.1 Load arithmetic

| Quantity | Arithmetic | Result |
|---|---|---|
| API requests at N = 10 labs | 04 §14: 60–120 req/s sustained, ~500 req/s burst | design point 120 req/s sustained, 500 burst |
| Per-tenant aggregate cap | 04 §14 per lab: 6–12 req/s sustained, bursts ~50 req/s → cap at 2× the burst assumption | **100 req/s, burst 200** [CONV] (configurable) |
| Events/day/lab | order created 500 + specimen transitions ≈ 500 patients × 3 specimens × 6 transitions = 9,000 + result verified/approved ≈ 25,000 results × 2 = 50,000 (04 §14 upper bound) + others ≈ 1,000 | ≈ 60,500 → **≈ 61k/day/lab** |
| Events peak rate at N = 10 | 61k × 10 × 25% peak hour ÷ 3,600 s | **≈ 42 events/s** |
| Consumer jobs peak | 42 events/s × avg ≈ 3 consumers (IC §3.25 matrix) | **≈ 126 jobs/s** (+42 fan-out jobs/s) |
| `core.event_log` size (90 d) | 61k × 10 × 90 = 54.9 M rows × ≈ 1 KB envelope (ASSUMPTION) | **≈ 55 GB** before indexes → see risk R-4 in `06-IMPLEMENTATION-PLAN.md` |
| `event_inbox` rows (90 d, all modules) | 54.9 M × 3 ≈ 165 M rows × ≈ 100 B | ≈ 16.5 GB |
| `audit.audit_log` growth | result rows 25k/day/lab × ≈ 3 audited writes × ≈ 600 B (changed-columns-only rows, §5 of `05-SCHEMA.md`) | ≈ 45 MB/day/lab ≈ 16 GB/year/lab — above 04 §14 "DB ≈ 9 GB/year/lab" → measure (risk R-5) |

### 10.2 Targets [CONV, validated by the load test of REQ-SEC-025]

| Path | Target |
|---|---|
| API core overhead per request (JWT verify + context `set_config` + idempotency claim + log/metrics), excluding handler SQL | p95 ≤ 5 ms at 500 req/s on VM-2 (04 I1) |
| JWT verification | p95 ≤ 0.5 ms (local key, no network) |
| `events.publish` (validate + insert + enqueue) | p95 ≤ 3 ms |
| Fan-out lag (commit → consumer job start) | p95 ≤ 2 s at 168 jobs/s total |
| RLS helper cost | hot queries show `InitPlan` for `(SELECT app.current_tenant_id())` (REQ-SEC-022); per-row function calls = 0 in `EXPLAIN` |
| Web shell | first-load JS for the shell ≤ 250 KB gzip [CONV]; route change TTI ≤ 1 s on a reception PC (ASSUMPTION: 4-core, 8 GB) |
| Isolation probe suite runtime | ≤ 10 min in CI at full schema [CONV] |

---

## 11. Configuration keys (global; no per-tenant keys in C0)

| Key | Default | Notes |
|---|---|---|
| `LIMS_CORE_ENV` | — (required) | `dev` \| `ci` \| `staging` \| `production`; drives guards (fakes, authz guard, response validation) |
| `LIMS_CORE_DATABASE_URL` | — | API: PgBouncer transaction-mode URL as `lims_api` |
| `LIMS_CORE_WORKER_DATABASE_URL` | — | worker: **direct** Postgres URL as `lims_worker` (04 S8) |
| `LIMS_CORE_DB_POOL_MAX` | `20` [CONV] | per API process |
| `LIMS_CORE_STATEMENT_TIMEOUT_MS` / `LIMS_CORE_LOCK_TIMEOUT_MS` | `5000` / `3000` [CONV] | set per transaction |
| `LIMS_CORE_TX_RETRY_MAX` | `3` [CONV] | serialization/deadlock retries |
| `LIMS_CORE_JWT_ALG` / `_ISSUER` / `_AUDIENCE` / `_KEY_FILE` | — | SP-1 fixes values per env |
| `LIMS_CORE_FAKE_PORTS` | empty | comma list of port names forced to fakes (dev/ci only) |
| `LIMS_CORE_RESPONSE_VALIDATION` | `on` in dev/ci/staging, `off` in production | REQ-ARCH-071 |
| `LIMS_CORE_RATELIMIT_BACKEND` | `postgres` | `redis` \| `postgres` |
| `LIMS_CORE_REDIS_URL` | — | only if backend = redis |
| `LIMS_CORE_RATELIMIT_KEY_FILE` | — | HMAC key for rate-limit keys |
| `LIMS_CORE_TENANT_RPS` / `LIMS_CORE_TENANT_BURST` | `100` / `200` [CONV] | §10.1 |
| `LIMS_CORE_IDEMPOTENCY_TTL_DAYS` | `7` | CV §4.5 |
| `LIMS_CORE_TRUSTED_PROXY_CIDRS` | — (empty = no trusted peer) | CIDRs whose TCP peer may supply `X-Forwarded-For` (single hop, nginx overwrites it); C1 sets it to the nginx container address on `edge_net` (08 A25 P-61, §6.4). Replaces the former `LIMS_CORE_TRUSTED_PROXY_HEADER` / `_HOPS` keys |
| `LIMS_CORE_LOG_LEVEL` | `info` | |
| `LIMS_CORE_METRICS_PORT` | `9464` [CONV] | internal only |
| `LIMS_CORE_WORKER_CONCURRENCY` | `10` [CONV] | Graphile Worker concurrency per process |
| `LIMS_CORE_EGRESS_PROXY_URL` | — | outbound HTTP of every module goes through this HTTP CONNECT proxy (CR-C1-008) |
| `LIMS_CORE_SHUTDOWN_GRACE_S` | `55` | SIGTERM drain time for worker/API (CR-C1-008); `GET /health/live` is also served on `LIMS_CORE_METRICS_PORT` |
| `LIMS_CORE_BFF_KEY_FILES` | — | secret-store paths of the per-BFF keys checked on `bffSession` and for P-61: `LIMS_WEB_BFF_KEY_FILE` (kind `staff_web`), `LIMS_PARTNER_BFF_KEY_FILE` (`partner`), `LIMS_PORTAL_BFF_KEY_FILE` (`portal`) [CONV names, 08 A19 P-45]; old and new key accepted during the C1 rotation overlap (08 R10, A13 D-32) |
| `LIMS_CORE_WITH_TENANT_SCOPE_OPS` | the R10 item 4 list as extended by 08 A25 D-214 (§6.3) | operationIds allowed to call `ctx.db.withTenantScope` (identity, platform context only); the two core-internal uses (cron fan-out, tenant dead-letter replay) are not operationIds and are not configurable |
| `LIMS_CORE_IDENTITY_AUTH_OPS` [CONV name] | the 15 operationIds of 08 A25 D-212 (§6.3) | operations allowed to use `ctx.db.identityAuthTx` (module `identity`, `x-context: identity_auth`) |
| `LIMS_CORE_SCANNER_URL` / `LIMS_CORE_SCANNER_TIMEOUT_MS` | `tcp://clamd:3310` / `30000` [CONV] | `ctx.files.scan` / `ctx.uploads.accept` scanner (ClamAV INSTREAM; C1 sets them; 08 A25 D-209) |
| `LIMS_CORE_STORAGE_KEY_FILE` [CONV] | — | file path of the Storage service credential, read only by `core/storage/**` (API and worker; 08 R12b; 07-SECURITY §6, §7) |
| `LIMS_WEB_SESSION_COOKIE_NAME` | `__Host-lims_sid` | the opaque session-id cookie of C2's provider (08 R10, CR-C0-003 ACCEPTED-MODIFIED); `__Host-` prefix forces Secure, Path=/, no Domain |
| `LIMS_WEB_API_BASE_URL` | — | internal API URL used by the BFF |
| `LIMS_ORIGIN_STAFF_WEB` | — | C1 sets (IC §7); used for Origin checks |

Per-tenant values that the core needs (idle/absolute timeout) come from `IdentityPort.getTenantSettings` (C2), never from C0 config.

---

## 12. Workstream 0D — web core (`apps/web/src/core/`) and UI kit

### 12.1 Web core skeleton

```
apps/web/src/
├── middleware.ts                    # CSP nonce + security headers (complementing C1 nginx), Origin/Sec-Fetch-Site check, session presence;
│                                    #   CSP incl. img-src 'self' data: (PrintFrame branding images, 08 A18.1; 07-SECURITY REQ-SEC-089)
├── app/layout.tsx                   # <html lang="en">, fonts from @lims/ui, ToastProvider
├── app/(staff)/layout.tsx           # AppShell (requires session; renders nav from generated manifest filtered by permissions)
└── core/
    ├── shell/AppShell.tsx           # PageShell + TopBar + SideNav + HelpPanel + SessionTimeoutDialog
    ├── nav/types.ts                 # NavManifest, NavEntry (04-UI-UX §6)
    ├── nav/build-nav.ts             # build step: scans src/features/*/nav.manifest.ts → nav/generated.ts (gitignored); fails on duplicate ids/shortcuts
    ├── session/
    │   ├── cookie.ts                # opaque id, HttpOnly, Secure, SameSite=Lax, __Host- prefix
    │   ├── store.ts                 # interface BffSessionStore (CR-C0-003): dev-only in-memory provider's shape (08 R10)
    │   ├── policy.ts                # idle/absolute enforcement using tenant settings (15–30 min idle, ≤12 h absolute — 04 A8)
    │   └── provider.ts              # loads src/features/identity/session.provider.ts if present, else dev in-memory fake
    ├── api/server-fetch.ts          # "server-only"; typed openapi-fetch client; bearer from session; X-Request-Id; traceparent; problem+json → typed error
    ├── api/actions.ts               # wrapper for server actions: Origin check, Idempotency-Key generation (uuidv7) for mutating calls
    ├── sse/relay.ts                 # SSE endpoint helper for modules (polling fallback); no browser Supabase (04 S4); the @lims/ui polling/SSE
    │                                #   helpers send X-Lims-Background on background requests, the BFF maps it to resolveSession touch:false (08 A25 D-206)
    ├── help/HelpPanel.tsx           # loads src/features/<m>/help/<screenKey>.ts; required on every page (CV §14)
    ├── i18n/                        # message catalogue loader; keys '<m>.<screen>.<key>'; en only in v1 (CV §13)
    ├── permissions/                 # usePermissions(), <PermissionGate> (UI hint only; API enforces)
    ├── errors/                      # PageError, PermissionDenied, NotFound page parts for loading.tsx/error.tsx
    └── shortcuts/registry.ts        # global shortcut registry; build-time duplicate detection
```

BFF session store interface (C2 provides the production implementation — CR-C0-003):

```ts
export interface BffSession {
  readonly sessionId: string;             // opaque, 256-bit random (crypto.randomToken(32))
  readonly tenantId: Uuidv7; readonly membershipId: Uuidv7; readonly userId: Uuid;
  readonly accessToken: string; readonly accessTokenExp: IsoUtc; readonly refreshToken: string;
  readonly createdAt: IsoUtc; readonly lastSeenAt: IsoUtc;
  readonly idleTimeoutMinutes: number;    // snapshot of tenant setting at login, refreshed on token rotation
  readonly absoluteHours: number;
}
export interface BffSessionStore {
  get(sessionId: string): Promise<BffSession | undefined>;
  touch(sessionId: string, at: IsoUtc): Promise<void>;
  rotateTokens(sessionId: string, tokens: { accessToken: string; accessTokenExp: IsoUtc; refreshToken: string }): Promise<void>;
  destroy(sessionId: string): Promise<void>;
}
export interface TokenRefresher { refresh(refreshToken: string): Promise<{ accessToken: string; accessTokenExp: IsoUtc; refreshToken: string }> } // C2
```

**Superseded by CR-C2-009's shape (08 R10; CR-C0-003 ACCEPTED-MODIFIED).** The production provider is C2's: the BFF holds only the opaque `__Host-lims_sid` cookie, forwards it to `/v1/identity/auth/*` (`bffSession`) together with its own `X-Lims-Bff-Key` (the key, not a request header, binds the session kind), and receives the access JWT from `resolveSession`; GoTrue refresh tokens stay server-side in `identity.sessions` (encrypted). The interfaces above remain only as the dev in-memory provider's shape; `refreshToken` never reaches the BFF in staging/production.

Per-request flow in the BFF (staging/production, 08 R10): cookie `__Host-lims_sid` → `POST /v1/identity/auth/…` `resolveSession` with `X-Lims-Bff-Key` (`bffSession`; `touch: false` when the browser request carries `X-Lims-Background`, 08 A25 D-206) → C2 checks idle/absolute limits and refreshes server-side → access JWT → call the API with the bearer. C2's `401 auth.session_expired` is relayed unchanged and the shell shows sign-in. Tokens never leave the server (REQ-SEC-068). The dev in-memory provider (`BffSessionStore` shape above) mimics the same contract and is the only place a refresh token exists on the BFF side; it refuses to load when `LIMS_CORE_ENV` is `staging` or `production`.

### 12.2 UI kit (`packages/ui/`) and Flutter base (`packages/ui-flutter/`)

Full component and token specification in `04-UI-UX.md`. Build: `tokens/tokens.json` → `scripts/build-tokens.ts` → `dist/tokens.css` (CSS custom properties), `src/tokens.ts`, and `../ui-flutter/lib/src/tokens.g.dart`. Components in `src/components/<Name>/{<Name>.tsx, <Name>.test.tsx, <Name>.stories.tsx}`. The story set is the input for the axe scan (AC-0D-8.6) and for visual review.

---

## 13. Observability

| Signal | Name / content | Owner of alert rule |
|---|---|---|
| Logs | one JSON line per request/job with CV §9.1 fields; events: `authz_not_asserted`, `response_contract_violation`, `event_schema_violation`, `unmapped_unique_violation`, `fanout_event_missing`, `ratelimit_backend_down`, `dead_letter_created`, `fake_port_active`, `port_consumer_not_listed` | C1 ships |
| Metrics (required by CV §9.4) | `lims_http_requests_total{module,operation_id,status}`, `lims_http_request_duration_seconds{module,operation_id}`, `lims_jobs_total{task,outcome}`, `lims_job_duration_seconds{task}`, `lims_queue_depth{task}`, `lims_core_dead_letters_total{task}`, `lims_ratelimit_rejections_total{tier}`, `lims_rls_denied_total` | C1 |
| Metrics (C0 additions) | `lims_core_events_published_total{event_type}`, `lims_core_event_fanout_lag_seconds` (histogram), `lims_core_idempotency_replays_total`, `lims_core_idempotency_conflicts_total{kind}`, `lims_core_tx_retries_total{sqlstate}`, `lims_core_auth_failures_total{reason}` (reason ∈ invalid, expired, alg, aud, iss, missing_claims, missing_session_id, session_not_found), `lims_core_fake_ports_active`, `lims_core_phase_stub_ports_active` (08 R9), `lims_core_authz_not_asserted_total{operation_id}`, `lims_core_retention_purged_total{table}`, `lims_core_retention_purge_capped_total{table}` [CONV] (08 A25 D-200), `lims_core_storage_deletes_total{bucket,reason}` [CONV] (08 A13 P-12), `lims_core_port_consumer_not_listed_total{module,port}` [CONV] (08 A19 P-46) | C1 |
| Alerts proposed to C1 | dead letter created (any); `lims_core_fake_ports_active > 0` in staging/prod; fan-out lag p95 > 10 s for 5 min; `lims_rls_denied_total` rate > 5× 7-day baseline (REQ-SEC-045/133); `lims_core_auth_failures_total{reason="alg"}` > 0; rate-limit backend down; `authz_not_asserted` > 0; `lims_core_retention_purge_capped_total` > 0 on 3 consecutive days (warn, 08 A25 D-200) | C1 registers (DoD §3.7) |

`tenant_id` is a label only on `lims_core_events_published_total` and `lims_ratelimit_rejections_total` (low cardinality ≤ number of tenants, CV §9.4); never patient/order ids.

---

## 14. Test strategy

| Layer | What C0 tests | Tooling / fakes |
|---|---|---|
| Unit (0A) | uuidv7 ordering/monotonicity/seeding; bsdate golden + range errors + fiscal year; money golden + fuzz; logger redaction corpus; crypto sizes; routes builder rejects PHI params | Vitest; `flutter test` for `lims_shared` |
| DB (0B) | §4.5 isolation probes; roles; grants per class; immutability per C/B table; audit trigger content; DEFINER inventory; policy diff; FK DAG; per-tenant billing export/restore | pgTAP or SQL harness (SP-3) on the dev-stack Postgres image |
| Contract (0C) | IC examples validate; registry equality with IC; spec lint; codegen determinism; each fake passes its contract suite; MSW handler completeness | ajv, Vitest |
| Integration (0D) | full request pipeline against migrated DB + seeds: JWT matrix (AC-0D-2.1), body tenant ignored (AC-0D-2.2), PgBouncer context isolation (AC-0D-2.3), idempotency matrix (AC-0D-4.x), publish/fan-out/inbox/dead-letter (AC-0D-5.x), registry guard (AC-0D-6.x) | dev-stack compose in CI; a test module `services/api/src/core/__fixtures__/module-sample/` (core-owned, never deployed) exercising the manifest contract |
| Web/UI (0D) | component unit tests; keyboard tests; axe scan on stories; token contrast test; shell session timeout; CSRF; bundle scan for `@supabase/*` and JWT strings | Vitest + Testing Library, Playwright, axe-core |
| Probe coverage (0C + all chunks) | every operation has a probe (gate 10) | `gen-probe-manifest` |
| Load (0D) | §10.2 targets on the 1× and 10× seed | k6-class load tool [PIN-C0], staging (REQ-SEC-025) |

The core sample module (`__fixtures__/module-sample`) has its own tiny spec `services/api/src/core/__fixtures__/sample.yaml`. It is loaded only when `LIMS_CORE_ENV=ci` and flag `LIMS_CORE_LOAD_SAMPLE_MODULE=1`, and is never mounted in staging/production.

---

## 15. CI pipeline (owned by 0A; `.github/workflows/`)

### 15.1 `pr.yml` (required on every PR to `main`)

| Job | Gate (CV §12 / DoD §1) | Runs | Command(s) |
|---|---|---|---|
| `paths` | 1 | always | `tools/lint/check-paths.ts --branch $HEAD_REF` (branch prefix `c<NN>`/`c00-0<x>` → owned globs from `tools/lint/ownership.yaml`, generated from CM §3 + §1.1 of this TRD); CR-reference check for `db/**`, `contracts/**`, `packages/**`, `**/core/**` |
| `typecheck` | 2 | always | `pnpm -w turbo run typecheck` (`tsc --noEmit`), `dart analyze` on changed Dart packages, `go vet ./...` when `apps/bridge-agent/**` changed |
| `lint` | 3 | always | ESLint (incl. `tools/lint` custom rules), Prettier check, `flutter analyze`, `gofmt -l`, `staticcheck` |
| `unit` | 4 | changed packages + dependants (turbo `--filter=...[origin/main]`) | `pnpm turbo run test:unit` |
| `integration` | 4 | when `services/**`, `db/**`, `packages/**` changed | `pnpm dev:up --ci` → `pnpm turbo run test:integration` |
| `contracts` | 5, 7 | always | `pnpm --filter @lims/contracts test` (IC examples, registry equality), `tools/codegen/lint-openapi.ts`, port contract suites (fakes + any real impls present); `tools/codegen/check-access-actions.ts` — fails a string-literal `action:` in `services/**` that is not in `audit.g_cs_access_actions` (08 A13 P-3); `tools/codegen/check-port-consumers.ts` — fails a `ctx.ports.<Port>` use by a module not in `PORT_CONSUMERS` (08 A19 P-46); the three 08 §4.1 permission rules (§5.3 `gen-permissions`) |
| `oasdiff` | 6 | when `contracts/openapi/**` changed | `oasdiff breaking origin/main:<file> HEAD:<file> --fail-on ERR` per spec (1.35.x); bypass only with label `cr-approved-breaking` |
| `codegen-fresh` | 8 | always | `pnpm codegen && git diff --exit-code` |
| `migrations` | 9 | when `db/**` changed | `db/tools/check-migrations.ts`; fresh apply; upgrade apply on previous release; `check-registry`, `check-fk-dag`, policy diff; manual checklist presence in PR body (B10) |
| `isolation` | 10 | when `db/**`, `services/**`, `contracts/**` changed; nightly always | `db/tests` suites; API probe tests; probe coverage vs `probe-manifest.json`; BYPASSRLS assertion |
| `secrets` | 11 | always | `gitleaks detect --redact` |
| `deps` | 12, 13 | when lockfiles/manifests changed | `osv-scanner`, `pnpm audit --audit-level critical` triage file check, licence allowlist (CV §15.2), banned list (CV §15.3) |
| `images` | 14 | when a Dockerfile or base digest changed | `trivy image` |
| `bsdate-golden` | 15 | when `packages/shared-ts/**`, `packages/shared-dart/**`, `packages/test-fixtures/bsdate/**` changed | TS + Dart golden tests |
| `phi-log-scan` | DoD §1.8 | with `integration` | scans captured test logs for denylisted keys/patterns |
| `ui` | DoD §1.4 (UI) | when `packages/ui/**`, `apps/web/**` changed | component tests, axe scan, token contrast, bundle scan |
| `supabase-pin` | DoD §1.7 | when `tools/devstack/**` or `infra/compose/supabase/upstream/UPSTREAM.lock` changed | image digests in `tools/devstack/compose.yaml` = `UPSTREAM.lock` (08 A25 D-208) |
| *chunk-supplied jobs* | per chunk | per the chunk's trigger paths | **P-14 mechanism (08 A13 P-14, A16.2):** each chunk TRD table "CI jobs for C0-0A" (job id, trigger paths, runner OS, command) is wired into `pr.yml` by one C0-0A PR per CR; scripts stay in the chunk's paths, C0-0A owns only the workflow lines. Known so far: CR-C7-013 (C7 bridge-agent jobs incl. a **Windows runner**: build, `go vet`/`staticcheck`, tests of `apps/bridge-agent/**`), CR-C3-009 (C3 jobs), `c04-copy-scan` (C4), `c8-no-commission` (C8), `c17-no-bad-cert-callback`, `c17-db-forensics`, `c17-release-binary-scan` (C17) — job definitions as in those chunks' tables (08 A25 §(c)(ii)) |

### 15.2 `nightly.yml` (gate 16)

`pnpm dev:up --ci` → full migrations → seeds at 1× → smoke suite of every chunk (`pnpm turbo run test:smoke`) → E2E journeys that exist (DoD §5.2 list grows as chunks merge) → isolation suite in full → load smoke on 10× seed (short run, §10.2 targets reported, not gated until M4). Results are posted to the C0 channel. Failures open an issue labelled `nightly`.

### 15.3 Branch protection

Required checks: every `pr.yml` job that ran. Squash merge only. CODEOWNERS (generated from `tools/lint/ownership.yaml`) require the owner chunk reviewer, and a C0 reviewer for PRs consuming a new contract version (CV §12).

---

## 16. Error codes used by C0

Emitted by the C0 core: all `common.*` codes and `auth.unauthenticated`, `auth.token_invalid`, `auth.token_expired`, `auth.csrf_failed` (IC §8; owner C0). `auth.session_expired` is owned and emitted by C2 (`resolveSession`, 08 R10); the BFF core relays it unchanged (CR-C0-005 ACCEPTED: the BFF is an allowed emission location; with R10 it only relays). C0 never emits module codes.

---

## 17. Change requests raised

> Status per `program/08-CR-REGISTER.md` (2026-11-06). CR texts below are kept as history.

| CR | Status |
|---|---|
| CR-C0-001 | ACCEPTED-MODIFIED in 08 — Merged with CR-C2-001/C13-001/C15-007/C16-001/C4-004/C8-009 into the amended 01 §3 tree (§2 R14). `(auth)` and `(platform)` groups incl. their `layout.tsx` → C2. |
| CR-C0-002 | ACCEPTED in 08 |
| CR-C0-003 | ACCEPTED-MODIFIED in 08 — Shape of CR-C2-009 wins; BFF authenticates to identity with per-BFF key `X-Lims-Bff-Key`; session-kind binding derives from the key (R10). |
| CR-C0-004 | ACCEPTED-MODIFIED in 08 — Check is C2 `PlatformAuthz` in platform context, not `IdentityPort.assertRole` (which refuses `platform.*`, C2 TRD §7.2). DEFINERs `app.dl_list_platform`, `app.dl_resolve`, `app.platform_list_tenants` inventoried. |
| CR-C0-005 | ACCEPTED in 08 |
| CR-C0-006 | ACCEPTED in 08 |
| CR-C0-007 | ACCEPTED-MODIFIED in 08 — `lims_queue` accepted. `lims_auth_hook` + `app.custom_access_token_hook` dropped (no hook path, R10). `owner_only` policy scope accepted; `auth_hook` scope not added. |
| CR-C0-008 | ACCEPTED in 08 |
| CR-C0-009 | MERGED in 08 into CR-C2-008 — Field `branding.accentColor` in the merged branding block (§4.12). |
| CR-C0-010 | ACCEPTED-MODIFIED in 08 — Stub set = QualityPort, SmartReportPort, PaymentProviderPort (+getIntent/cancelIntent), EngagementPort (C4 calls it in Phase 1). Stubs only deny/disable (R9). |
| 08 Addendum A3 | applied 2026-11-06 — A3.1 (CR-C2-018): `identity.sessions(previous_token_sha256)` partial unique index added to the index-exception list (05-SCHEMA §3, `db/meta/index-exceptions.yaml` comment in §3 tree) and to the `app.identity_session_by_token` inventory text (05-SCHEMA §4.3). A3.3: C0 05-SCHEMA §10 is the authority C2 §3.1 mirrors; C0 DDL not changed by this pass. The OPEN column list noted at the time was closed by A3.4 (next row). |
| 08 A3.4 | applied 2026-11-06 (CR-C2-003 remainder merged) — 05-SCHEMA §3 (mandatory-column exception: `core.memberships.is_active` generated; R27 exception predicate), §3.1 (`core.tenants` `status_reason`, `activated_at`, `suspended_at`, `offboarded_at`, `billing_live_on`), §3.3 (`core.users` `email_normalized` + UNIQUE (tenant_id, email_normalized), `phone_e164`, `last_login_at`; `core.memberships` `status`, `invited_at`, `accepted_at`, `deactivated_at`, `deactivated_by`, `deactivation_reason_code`, `lock_reason_text`, `last_login_at`, `lock_reason_code` CHECK set, `is_active GENERATED ALWAYS AS (status = 'active') STORED`, no `is_locked` — locked = `locked_at IS NOT NULL`; both partial unique indexes `WHERE status IN ('invited','active')`), §3.4 (`role_permissions (tenant_id, permission_code)`, `membership_roles (tenant_id, role_id)` indexes), §3.5 + §4.4 + §10 (`core.dead_letters.version`; `app.tg_dead_letter_transition()` also lets `version` change), §7 index table, §10 DDL, §10 schema tests 1–8; this TRD §4.6 seeds note; 06 T0B-03 tests; 07 §4 checklist. |
| 08 A6 | applied 2026-11-06 — A6.1: 05-SCHEMA §3.3 `locked_at` row notes `is_locked` / `ActorProfile.isLocked` as wire names computed as `locked_at IS NOT NULL` (no column, no API rename). A6.2: DDL `users__phone_e164__ck` `^\+[1-9][0-9]{7,14}$` unchanged (source for C2 API validation). A6.3: `core.memberships.deactivation_reason_code` CHECK `memberships__deactivation_reason__ck` (same set as `lock_reason_code`) in 05-SCHEMA §3.3 + §10 DDL + §10 schema test 2; `deactivated_*` rows note clearing on reactivate; `core.tenants.status_reason` row notes it holds `suspendTenant`/`terminateTenant` `reason_text`; `users.last_login_at` internal, `memberships.last_login_at` shown. A6.4: §6.8 `ctx.core.deadLetters.replay/discard` take `expectedVersion` (If-Match; mismatch → `409 common.version_conflict`), §7.4, 03-APP-FLOW §3.2, 01-PRD AC-0D-5.7, 06 T0D-08. A6.5: confirmations, already as written (05-SCHEMA §4.4 trigger lets `version` change). A6.6: C0 holds no `app.identity_login_context` SQL (C2 05-SCHEMA §10.3); nothing to change here. |
| 08 A8 | applied 2026-11-06 — A8.1–A8.3: no C0 SQL or flow changes (the `app.identity_login_context` body and membership lifecycle writes are C2's: C2 05-SCHEMA §10.3, C2 03-APP-FLOW §2.2/§2.3); the C0 columns used (`updated_at`, `deactivated_*`) already exist; 06 T0B-06 ships C2 05-SCHEMA §11 test 20 (login membership choice) with the translated DEFINER. A8.4: `core.dead_letters.resolution_note text NULL` + `dead_letters__resolution_note__ck` `char_length(resolution_note) BETWEEN 1 AND 500` (05-SCHEMA §3.5 + §10 DDL); `app.tg_dead_letter_transition()` allowed-change list includes `resolution_note` (05-SCHEMA §4.4 + §10); `app.dl_resolve` inventory row (05-SCHEMA §4.3); §6.8 `discard({ deadLetterId, expectedVersion, reasonText })`, `replay` optional `reasonText`; §7.4; 03-APP-FLOW §3.2; 01-PRD AC-0D-5.8; 05-SCHEMA §10 schema tests 7 + 9; 06 T0B-05, T0D-08; 07-SECURITY §4 checklist. A8.5: `DeadLetterRow` defined in §6.8 (no `job_payload`); §7.4; 03-APP-FLOW §3.2; 05-SCHEMA §3.5 + §4.3 `app.dl_list_platform` note; 01-PRD AC-0D-5.9; 06 T0D-08; 07-SECURITY §5 item 4, AB-22. A8.6: §6.8 lint note (`core.dead_letters` SQL only in core; C2 only through `ctx.core.deadLetters`); 03-APP-FLOW §3.2; 05-SCHEMA §5 grant note and §6 note (the C2 `__platform` SELECT/UPDATE policies on `core.dead_letters` are written by C0 and used by `ctx.core` under platform claims); 06 T0A-03 lint fixture; 07-SECURITY AB-21 + §4 checklist. |
| 08 A9 | applied 2026-11-06 — A9.1: §6.8 `ctx.core.deadLetters.get({ deadLetterId }): Promise<DeadLetterRow>` (throws `common.not_found`) + §6.8 note; §7.4; 03-APP-FLOW §3.2; 01-PRD AC-0D-5.10; 06 T0D-08. A9.2: §6.8 `list` filters `{ state?; platformRows?; tenantId?; taskIdentifier?; deadAtFrom?; deadAtTo?; cursor?; limit? }` + index note (`(state, dead_at)`, `(tenant_id, state, dead_at)`; `taskIdentifier` in-page [CONV]); §7.4; 01-PRD AC-0D-5.11; 06 T0D-08. A9.3: §6.8 `replay({ deadLetterId, expectedVersion, reasonText? })` (1–500 → `resolution_note`); §7.4; 03-APP-FLOW §3.2; 01-PRD AC-0D-5.12. A9.4: 05-SCHEMA §4.3 inventory row (full signatures, platform-context predicate) and §10 SQL bodies of `app.dl_insert_platform`, `app.dl_list_platform` (incl. `p_dead_letter_id` for `get`), `app.dl_resolve` (version guard, `open → replayed | discarded`, `resolution_note`, no `job_payload` in output) + `dead_letters__{select,insert,update}__owner_only` policies + REVOKE/GRANT; 05-SCHEMA §10 schema tests 10–12; 06 T0B-05; 07-SECURITY §4 checklist. A9.5: no C0 change (C2 `terminateTenant` write; `core.memberships.deactivated_by` exists). A9.6: §6.8 reference `05-SCHEMA.md` §4.8 → §4.3 (inventory; bodies §10). Open: platform-row replay payload source (05-SCHEMA §10 OPEN comment) — closed by 08 A10.1 (next row). |
| 08 A10 | applied 2026-11-06 — A10.1: `app.dl_resolve` result gains `job_payload jsonb` (stored payload for `'replayed'`, NULL for `'discarded'`), core-only. The 05-SCHEMA §10 OPEN comment is removed. Changed: 05-SCHEMA §3.5 row, §4.3 inventory row, §10 header comment and `dl_resolve` body; this TRD §6.8 (`DlResolveResult`, `stripPayload`, note) and §7.4 (platform-row replay re-enqueues through `app.enqueue_job` in the same transaction); 05-SCHEMA §10 schema test 11; 01-PRD AC-0D-5.13; 03-APP-FLOW §3.2; 06 T0B-05, T0D-08; 07-SECURITY §4 checklist, §5 item 4, AB-22. A10.2: C2-only (`platform_rows` query parameter); C0 `platformRows` already in §6.8. A10.3: confirmed, no change (get via `p_dead_letter_id`; `dead_at DESC, id DESC` [CONV]; `dl_resolve_invalid_input`); confirmation comments in 05-SCHEMA §10. A10.4: `dead_letters__select__platform` / `__update__platform` written in C0 DDL with `tenant_id IS NOT NULL AND (SELECT app.is_platform_actor())` (05-SCHEMA §6 table + note, §10 DDL; schema test 14; §6.8 note). A10.5: owner-policy rule, CI rule and C0 DEFINER audit in 05-SCHEMA §4.3. Owner policies added: `event_log__select__owner_only`, `event_inbox__select__owner_only` (per §3.9 schema), `idempotency_keys__select__owner_only`; `dead_letters__select__owner_only` extended with the purge predicate; `dead_letters__delete__owner_only` and `event_log`/`event_inbox` `__delete__owner_only` DDL made explicit (they were already in §6). Also: §6 table; schema tests 13 and 15; `USING (true)` allowlist for `identity.platform_staff__select__owner_only` (§4.2 forbidden list; 05-SCHEMA §4.2; 01-PRD AC-0B-2.2); this TRD §4.5 DEFINER owner-policy suite; 01-PRD AC-0B-2.4; 06 T0B-05, T0B-06, T0B-08; 07-SECURITY §4 checklist, AB-23. The C2 DEFINERs are audited in C2 05-SCHEMA §5.4; some parameter-bound lookup predicates there are OPEN. `app.platform_list_tenants` is not audited (no SQL body exists). |
| 08 A12 | applied 2026-11-06 — A12.1: `05-SCHEMA.md` §10 `core` owner policies for the C2 pre-tenant lookups — `memberships__select__owner_only` gains the `user_id = app.pre_user_id` branch (ORed with the tenant-bound one); added `users__select__owner_only` (`id = app.pre_user_id`), `tenants__select__owner_only` (`id = app.pre_tenant_id`), `roles__select__owner_only` (`tenant_id = app.pre_tenant_id`), `membership_roles__select__owner_only` (`tenant_id = app.pre_tenant_id` and a membership of `app.pre_user_id`); 05-SCHEMA §4.1, §4.2, §4.3 inventory row + audit, §6 table. The C2 function bodies and identity-table policies are C2's (C2 05-SCHEMA §5.4, §10). A12.2: 05-SCHEMA §4.3 owner-policy rule generalised (GUC-bound owner policies: `app.pre_*` and `app.maintenance = '<function name>'`, reset to `''` before return, `TO lims_owner` only); C0 `app.purge_*` keep their static predicates (not named by A12.2). A12.3: `app.platform_list_tenants(text, text, text, timestamptz, uuid, integer)` SQL body in 05-SCHEMA §10 (platform-claims check `(SELECT app.is_platform_actor())`, `app.maintenance = 'platform_list_tenants'`, non-PHI columns [CONV], keyset `code` / `-created_at`, REVOKE/GRANT `lims_api`); `tenants__select__owner_only` maintenance branch; 05-SCHEMA §4.3 inventory row + audit row (no longer "not audited"). A12.4: §7.6 `app.purge_event_log()` called without argument. A12.5: 05-SCHEMA §4.4 + §10 — `app.tg_row_audit` uses the `core.tenants` row's own `id` in platform context (body unchanged, comment added); `audit_log__insert__owner_only` admits that platform-context `core.tenants` row; trigger not attached to `identity.platform_staff`, `identity.platform_events` or other platform-only tables. A12.6: C2-only (`app.identity_expire_invitations`). A12.7: 05-SCHEMA §10 schema tests 16–19; §4.5 DEFINER suite note; 06 T0B-03/T0B-05/T0B-06/T0B-08; 07-SECURITY §2 row, AB-23, §4 checklist. |
| 08 A15 | applied 2026-11-06 — A15.1/A15.2: C2-only (C2 05-SCHEMA §5.4, §10.1, §10.3). A15.3: every C0 purge that touches a FORCE-RLS table uses `app.maintenance = '<function name>'`: `app.purge_event_log` body sets/resets it; `app.purge_event_inboxes`, `app.purge_idempotency_keys`, `app.purge_dead_letters` comments state the same; `event_log`, `event_inbox`, `idempotency_keys__{select,delete}__owner_only` and the purge branches of `dead_letters__{select,delete}__owner_only` gated on it (05-SCHEMA §4.3 inventory row, GUC rule — the "keep their static expiry predicates" sentence is replaced — and audit table, §6 table + note, §10 DDL). `app.purge_ratelimit_counters` unchanged (RLS-exempt table, no owner policy). A15.4: §7.6 calls `app.purge_event_inboxes()` and `app.purge_dead_letters()` without arguments. A15.5: 05-SCHEMA §10 `app.tg_row_audit` uses `v_excl := coalesce(TG_ARGV::text[], '{}')` for INSERT/DELETE values and the UPDATE changed-column filter; §4.4 text. A15.6: `app.is_platform_actor()` created in the 05-SCHEMA §10 context-helpers section (before every referencing policy/function; `check_function_bodies` off for that statement because its body reads `identity.platform_staff`, created later in the DAG), REVOKE PUBLIC, GRANT `lims_app`; §4.3 inventory row + audit row. Tests: 05-SCHEMA §10 schema tests 13 and 15 extended, 20 (argument-less audit trigger) and 21 (`app.is_platform_actor()` grants and creation order) added. §4.5 suite note; 06 T0B-02, T0B-03, T0B-05, T0B-06; 07-SECURITY §2 row, AB-23, AB-24, §4 checklist. |
| 08 A1 | applied earlier — §6.7 `login` tier (per-account limits, per-IP failure-only limit, nginx flood guard) cites 08 Addendum A1; nothing further for C0 (P-60 row added 2026-11-06) |
| 08 A2 | applied 2026-11-06 (review fix pass) — A2.4: `app.engagement_redeem_link_code(bytea)` (05-SCHEMA §4.3); A2.9: C4 access codes `patient.update`, `patient.anonymise`, `credit_note.print`, `receipt.print` in the §3.7 seed list. Other A2 items name no C0 file (checked by grep for C0) |
| 08 A4 | applied 2026-11-06 — A4.8 (03-IC §13.1 as a strict YAML list) is the input of the new `gen-access-actions` generator (§5.3; 05-SCHEMA §3.7). Other A4 items: not applicable to C0 |
| 08 A5 | applied 2026-11-06 — A5.2 `partners-slips` bucket (05-SCHEMA §8, with the write-once/upsert-before-issued rule); A5.1 RenderPort consumer C13 is transcribed from 03-IC by §5.1. Other A5 items: not applicable |
| 08 A7 | not applicable (notes for 03, C3, C4, C6) |
| 08 A11 | not applicable to C0 docs (client decisions; the portal payment route and dues flow are 03-IC §7 / C6 / C15) |
| 08 A13 | applied 2026-11-06 (review fix pass) — P-2 + D-67 (`ctx.download.stream`, §6.1/§6.3; 07 §5 item 7); P-3 (`gen-access-actions`, `check-access-actions` in `contracts`, 05-SCHEMA §3.7, 06 T0B-04); P-6 (§7.2 `per_tenant` semantics + tick, 05-SCHEMA `app.cron_tenant_ids`); P-8 (lint `x-idempotency-justification`, §5.2); P-9 (§3.1 spreadsheet row, 06 T0A-12); P-12 (metric `lims_core_storage_deletes_total`, §13); P-14 (§15.1 chunk-supplied jobs, 06 T0A-13); D-11 (C5 codes in the seed); D-17 (§3.5 `catalog/` fixtures); D-27(a) (05-SCHEMA §4.4 trigger note); D-30 (05-SCHEMA §1, §4.3); D-32 (BFF key kind `portal`, §6.1/§6.5/§11); D-42 (`app.purge_instruments_archive(integer)`, 05-SCHEMA §4.3). Files: 01-PRD, 02-TRD, 03-APP-FLOW, 05-SCHEMA, 06, 07 |
| 08 A14 | applied 2026-11-06 — A14.2 (no browser signed-URL path): 07 §5 item 7 replaced; downloads only through `ctx.download.stream`. A14.1/A14.3/A14.4: not applicable to C0 |
| 08 A16 | applied 2026-11-06 — A16.1: §4.2 forbidden construct, `check-registry`, 05-SCHEMA §9 rule 2, schema test 26 (no C0 policy has a centre predicate except the cast form; scratch run: uncast form fails on PG 16); A16.2: CR-C7-013 jobs incl. Windows runner wired by the §15.1 chunk-supplied-jobs mechanism (06 T0A-13) |
| 08 A17 | applied 2026-11-06 — P-16 (guard in every `__tenant` DDL policy, `shared_with`, `check-registry` rule, probe step 9; 05-SCHEMA §4.1/§6/§10, §4.1/§4.5 here); P-17/D-47 (`MembershipRow`, widened `memberships.list`, §6.8; 06 T0D-08); P-18(b) (`mandatory_column_exceptions`, 05-SCHEMA §3); P-19 (`JobContext.files/storage`, 06 T0D-17); P-20 (§9 stub replacement); P-23 (lint rule 4); D-46 (`analytics.yaml` op #30, §5.1); D-53 (C9/C11 codes in the seed) |
| 08 A18 | applied 2026-11-06 — A18.1: CSP `img-src 'self' data:` (§12.1, 07 REQ-SEC-089 + header test). A18.2: not applicable |
| 08 A19 | applied 2026-11-06 — A19.1 (device/`staff_mobile` probe, §5.3; 07 §4; 06 T0C-09); P-40 (fake key grammar, §5.4); P-41 (05-SCHEMA §4.3 inventory rows, §9 rule 6); P-42 (§6.2 stage 11, D-202 interplay); P-45 (`LIMS_CORE_BFF_KEY_FILES`, 07 §6); P-46 (`PORT_CONSUMERS`, §5.3/§6.3/§15.1; AC-0D-6.4); D-100, D-110, D-111 (§5.4 fakes); D-121 (`app.core_resolve_tenant_code`, 05-SCHEMA §4.3/§10) |
| 08 A20 | applied 2026-11-06 — A20.1: served by the existing `tenants__select__owner_only` `app.pre_tenant_id` branch (05-SCHEMA §4.3 note; SQL is C2's); A20.2: `app.current_lims_session_id()` C0 DDL + GRANT `lims_app, lims_api, lims_worker` (05-SCHEMA §4.1/§10); A20.3: `enforce_mutable_columns` `coalesce(TG_ARGV::text[], '{}')` + schema test 25; A20.4: no change |
| 08 A21 | applied 2026-11-06 — A21.2 (`IdentityPort.readSignatureImage` in contracts/fake/suite, §5.1/§5.4; its return type per 08 A26.1 is C2's port text); A21.3 (CR-C6-019 pins, §2.2; no default `tg_row_audit` on `reporting.portal_links`, 05-SCHEMA §4.4); A21.4 (`app.pre_*` GUC names, 05-SCHEMA §4.3). A21.1, A21.5: not applicable (A21.5 withdrawn by A22.0) |
| 08 A22 | applied 2026-11-06 — A22.0 (port key grammar in fakes, §5.4). A22.1–A22.4: not applicable to C0 |
| 08 A23 | applied 2026-11-06 — A23.1 (§7.2 tick, 05-SCHEMA `app.cron_tenant_ids` + owner branch, schema test 22, 06 T0B-05/T0D-09); A23.2 (`core.dead_letters.job_key`, `p_job_key`, `dl_resolve` returns `job_key`, replay key, tenant replay inside `withTenantScope`; §7.4, 05-SCHEMA §3.5/§10, schema tests 7/12/23, AC-0D-5.14); A23.3 (`shared_with` tables and actor policies, guard on every `__tenant` incl. `core.tenants` and `audit.audit_log`; 05-SCHEMA §3.5/§3.7/§6/§10, schema test 24) |
| 08 A24 | applied 2026-11-06 — A24.1 `CatalogPort.getPriceListStatus` in `contracts/ports`, the C3 fake and the contract suite (§5.1/§5.4) |
| 08 A25 | applied 2026-11-06 — P-60 (this table); P-61 (§6.4, §11 `LIMS_CORE_TRUSTED_PROXY_CIDRS`); D-200 (§7.6, 05-SCHEMA purge bodies, schema test 31); D-201 (05-SCHEMA §1/§2/§10 grant-revoke window, schema test 30, 06 SP-2/T0B-02, 07 §6); D-202 (§6.2 stage 10, §6.6, APP-FLOW K2/K3, AC-0D-4.5); D-206 (§12.1 BFF `touch:false`); D-208 (§3.6, §15.1 `supabase-pin`); D-209 (§11 scanner keys); D-212 (§6.2/§6.3 `identityAuthTx`, §5.2 rule 8, §11); D-213 (05-SCHEMA idempotency NULL tenant, schema test 27); D-214 (§6.3, §11); D-215 (05-SCHEMA `tg_row_audit`, schema test 28); D-217 (`core.users.email_hmac`, `app.identity_tenants_for_email_hmacs`, schema test 29); review hand-offs of 08 A25 §(c)(ii). D-203–D-205, D-207, D-210, D-211, D-216, D-218–D-220: not applicable to C0 |
| 08 A26 | applied 2026-11-06 — A26.1: not C0 (C2's port type; C0 transcribes it in `contracts/ports` with T0C-02); A26.3: `BucketName` gains `partners-slips` when transcribed from 03-IC §13.6; A26.4: the C0 uncast-form grep (05-SCHEMA schema test 26) scans the spec SQL blocks only, so quoted history is not counted. A26.2: not applicable (02-CV) |
| 08 A27 | not applicable to C0 (C1 fix-pass decisions) |
| 08 A28 | applied 2026-11-06 — A28.3 `core.memberships.partner_role` + two CHECKs (05-SCHEMA §3.3/§10, schema test 33); A28.5 `app.tg_row_audit` maintenance branch, `audit.audit_log.detail` [CONV column], nullable `actor_id`/`created_by` with `audit_log__actor__ck`, owner INSERT policy branch (05-SCHEMA §3.6/§4.4/§10, schema test 32); A28.6 audit/access-log `(tenant_id, request_id)` and partial support-session indexes, CR-C2-010 centre clause (cast) on both audit SELECT policies, index exception `identity.auth_events__occurred_at__idx`, `tables.yaml` notes (`ird_annex_documents` class M; `sessions`/`mfa_factors` `shared_with: [partner]`) (05-SCHEMA §3, §6, §7, §9 rule 7, §10); A28.2 allowlist sentence (§6.3); A28.1/A28.4 inventory placeholder row pointing to C2's SQL (05-SCHEMA §4.3). |
| 08 A30 | applied 2026-11-06 (final check) — A30.1: helpers migration stage with the module policy helpers `app.current_partner_id()` (C13 body) and the four C16 §6.1 `app.engagement_*` helpers, `check_function_bodies` off, stage order recorded (05-SCHEMA §4.5, §10; 06 T0B-02); A30.2: `<m>.event_inbox` generated by C0 only (05-SCHEMA §3.9; C5, C10 and C16 inbox DDL removed); A30.3: not C0 (C4). §4.3 inventory now names the five `app.identity_platform_auth_write_*` functions and `app.identity_notify_ip_throttle_hmacs(inet, timestamptz)` (08 A28.1/A28.4) |
| 08 A31 | applied 2026-11-06 (smoke load) — A31.1: `01_database.sql` creates `btree_gin` beside `pg_trgm` in `extensions` (availability stays SP-3) and grants `USAGE ON SCHEMA extensions` to `lims_owner`, `lims_migrator`; opclasses referenced as `extensions.gin_trgm_ops` (05-SCHEMA §1, §9 rule 7; C4, C11 05-SCHEMA); A31.4: `catalog` dropped from the `event_inbox` list (05-SCHEMA §3.5 row, §3.9, `app.purge_event_inboxes` array; 16 schemas). A31.2, A31.3: not C0 (C16, C11) |
| Review fix pass 2026-11-06 — review/C0-foundation-contracts.md + 08 Addendum A25 — your COMPLETE binding work list is /home/claude/lims-docs/review/_triage-batch4.md §(c) (all P/D/addendum items incl. A13, A16, A17, A19, A20, A21, A23, A24 and every hand-off addressed to C0); also apply A20 (decided earlier) applied | Scratch PostgreSQL 16 run of the 05-SCHEMA SQL with FORCE RLS: 05-SCHEMA §10 "Scratch-cluster evidence" |

Format per `program/04-CHANGE-REQUESTS.md` §2 (abridged; full text is filed as issues at T0-01). Each is designed in these documents **as if accepted**.

**CR-C0-001 — Path ownership listing for C0 sub-paths** · To: doc owner (CM §3) · Type: shared-lib/docs · Blocking: no.
Problem: CM §3 does not list `tools/devstack/`, `tools/lint/`, the service/app package root files (`services/*/package.json`, `services/*/src/main.ts`, `Dockerfile`s, `apps/web/{package.json,next.config.*}`, `apps/web/src/middleware.ts`, `apps/web/src/app/layout.tsx`, `apps/web/src/app/(staff)/layout.tsx`), or a home for staff login routes. Proposed: add these as C0 (split per §1.1 of this TRD), and add `apps/web/src/app/(auth)/**` as C2 for login/MFA pages. Backward compatible: yes. Security impact: none.

**CR-C0-002 — Dependencies in shared packages** · To: doc owner (CM §4) · Type: docs · Blocking: no.
Problem: CM §4 lets a chunk add dependencies "to its own package's package.json", but API/worker modules and web features live inside the shared packages `services/api`, `services/worker`, `apps/web`. Proposed: dependencies for those packages are added by C0-0D on a CR (turnaround per program/04 §3.3); each chunk lists the dependency row in its own TRD. Alternatives: per-module workspace packages (rejected: version drift and Next.js transpile config churn).

**CR-C0-003 — BFF session store contract** · To: C2 · Type: api · Blocking: no (C0 ships an in-memory dev provider).
Problem: CV §6 requires a server-side BFF session lookup holding GoTrue tokens, but no interface or storage owner is defined. Proposed: C0 defines `BffSessionStore` and `TokenRefresher` (§12.1). C2 implements them in `apps/web/src/features/identity/session.provider.ts` with storage in C2's `identity` schema via C2 API endpoints authenticated by a BFF client credential (C2 TRD). Tests: AC-0D-7.2/7.3.

**CR-C0-004 — Platform-operator identity in claims** · To: C2 · Type: port/api · Blocking: no.
Problem: IC/CV define support sessions (`actor_type: 'user'`, `support_session_id`) but not how the core recognises a platform operator outside a tenant (tenant list, platform dead letters). Proposed: platform console handlers run under a support session in a tenant for tenant data. For cross-tenant platform data, they call only the inventoried DEFINER functions (`app.dl_list_platform`, `app.dl_resolve`; C2 may request `app.platform_list_tenants` by CR), after `IdentityPort.assertRole` on a `platform.*` permission. Security: REQ-SEC-063.

**CR-C0-005 — Emission of `auth.session_expired` by the BFF core** · To: doc owner (IC §8) · Type: api · Blocking: no.
Problem: IC §8 lists owner C2; the code that detects idle/absolute expiry lives in C0's web core (CM §3 "BFF session"). Proposed: keep owner C2 (policy), allow emission from `apps/web/src/core/session/policy.ts`. Update the IC §8 note "except `common.*`/`auth.*` emitted by the C0 core" to also cover this one.

**CR-C0-006 — Health endpoint naming exception** · To: doc owner (CV §3) · Type: api · Blocking: no.
Proposed: allow `/v1/core/health/{live,ready}` as a documented exception to plural-resource naming. Alternative `/v1/core/health-checks/...` rejected as unidiomatic for orchestrator probes.

**CR-C0-007 — Extra DB roles `lims_queue` and `lims_auth_hook`** · To: doc owner (CV §5.9) · Type: schema · Blocking: no.
Problem: IC §12 says `app.enqueue_job` is "owned by a role holding the Graphile Worker queue privileges", and the GoTrue hook must read memberships before any tenant context exists. CV §5.9 lists no such roles. Proposed: add `lims_queue` (NOLOGIN, NOBYPASSRLS; owns `graphile_worker` schema and the enqueue/queue-depth DEFINER functions; `lims_worker` is a member) and `lims_auth_hook` (NOLOGIN, NOBYPASSRLS; owns only `app.custom_access_token_hook`; SELECT on 4 core tables restricted by an `__auth_hook` policy). Also extend the CV §3 policy-scope list with `auth_hook` and `owner_only` usage as defined in `05-SCHEMA.md` §4. Security: both roles have no LOGIN, no BYPASSRLS; covered by AC-0B-1.1.

**CR-C0-009 — Tenant accent colour in `TenantSettings`** · To: C2 + doc owner (IC §4.6) · Type: port · Blocking: no (default accent used).
Problem: the design system must stay brand-neutral with a per-tenant accent (C0 scope), but `TenantSettings` has no branding field. Proposed (additive): `readonly branding?: { readonly accentColor?: string /* '#RRGGBB' */ }`. C2 validates the format (`identity.setting_out_of_range` on bad values), and the kit derives accessible variants (`04-UI-UX.md` §1.6). Security: none (not PHI).

**CR-C0-010 — Phase stubs for ports without a Phase-1 owner** · To: doc owner (CV §8.2, IC §4.9–§4.11) · Type: port · Blocking: **yes for the first production deploy** (not for development).
Problem: CV §8.2 fails production boot on any fake, while IC §4.11 says Phase 1 uses the registered QualityPort fake, and SmartReportPort/PaymentProviderPort have no Phase-1 owner. Proposed: the phase-stub mechanism in §9 (explicit allowlist, minimal stubs, separate metric, CI check that removes a stub once its owner exists). Alternatives: owner chunks C9/C14/C15 ship stub modules early (rejected: puts C0-style plumbing into feature chunks and creates fake schemas). Security: stubs only ever deny or disable. Tests: AC-0D-6.2 extended — production boot passes with exactly the allowlisted stubs and fails with any other fake.

**CR-C0-008 — Glossary alignment** · To: doc owner (`program/06-GLOSSARY.md`) · Type: docs · Blocking: no.
Problem: the glossary says `core` table `centres` (Collection centre row) and RLS policies `TO authenticated`. IC §9.1 says `core.collection_centres`, and IC X9 binds policies to `lims_app`. Proposed: fix the glossary to match IC. C0 builds to IC (higher precedence per `00-README.md`).
