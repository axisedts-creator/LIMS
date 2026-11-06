# 02 — Conventions (code, API, DB, events, ports, security defaults, testing, git)

Status: DECISION, 2026-11-05 (rev. 2: aligned with the lead's acceptance of 03-IC additions A1–A8 and binding resolutions X1–X12). Binding on every chunk (C0–C18).
Inputs, in precedence order: `research/00-scope-baseline.md` (00) → `research/04-consolidated-decisions.md` (04) → `program/01-CHUNK-MAP.md` (01) → `research/01|02|03-*.md` (by section / REQ ID).
Companion: `03-INTERFACE-CATALOG.md` (03-IC) holds every event schema, port signature, published view, route and error code. This file holds the *rules*; 03-IC holds the *shapes*.

## 0. How to read this file

| Marker | Meaning |
|---|---|
| **04 Xn** | Value taken from 04 row Xn. Do not change it in a chunk doc. |
| **[CONV]** | Program convention set here by the lead architect (an engineering choice with no external fact behind it). Change only through `04-CHANGE-REQUESTS.md`. |
| **[PIN-C0]** | No version is fixed in 04. C0 pins an exact version at implementation time and records it in the lockfile and in C0's `02-TRD.md`. No other chunk picks a different version. |
| **BLOCKED Bn** | Cannot be finalised; build against the stated default from 04 §13. |
| **UNVERIFIED** | Must not be presented as fact; code must not hard-depend on it (04 precedence rule 3). |
| MUST / MUST NOT / SHOULD | RFC 2119 sense. A MUST violation fails review. |

Rule zero: if a value you need is not here, not in 03-IC and not in 04, **do not invent it**. File a CR and build against the fake/default.

---

## 1. Languages, runtimes, toolchains

### 1.1 Pinned versions

| Component | Version rule | Source |
|---|---|---|
| Node.js (API, worker, web BFF, renderer, portal, partner) | **Node.js 26.x "Lithium" LTS** — the newest LTS line on nodejs.org's release table (fetched 2026-11-05; latest patch listed 26.13.0, 28 Oct 2026; other LTS lines listed: 24 "Krypton", 22 "Jod"). C0 pins the exact patch in `.nvmrc`, root `package.json` `engines.node`, and the Docker base image **by digest** (REQ-SEC-129). Odd-numbered/"Alpha" lines (27.x) are banned in production. | nodejs.org/en/about/previous-releases (opened 2026-11-05) |
| Package manager | pnpm workspaces (01 §3). Version [PIN-C0] via root `packageManager` field. | 01 §3 |
| TypeScript | [PIN-C0]. `strict: true` plus the flags in §1.2. One root `tsconfig.base.json` (C0); packages `extends` it and may only *add* stricter flags. | — |
| Next.js (staff web `apps/web`, `apps/portal`, `apps/partner`) | [PIN-C0]. App Router (01 §3 uses route-group folders `src/app/(staff)/…`). Server-only BFF pattern (04 S4). | 04 S4 |
| Fastify (API) | [PIN-C0]; HTTP routes mounted from the OpenAPI specs via `fastify-openapi-glue` **4.12.0** | 04 T7 |
| OpenAPI documents | authored as **OpenAPI 3.0.3**, restricted to constructs also valid in 3.1 (binding X10, §4.12) | 04 S19, T7, T8 |
| Graphile Worker | **0.18.0** | 04 S10, T7 |
| PostgreSQL | PostgreSQL 17 via the self-hosted Supabase image `supabase/postgres:17.6.1.136` (no native `uuidv7()`) | 04 D9 |
| PgBouncer | **≥1.21**, transaction mode, via the official `docker-compose.pgbouncer.yml` override, Supavisor disabled | 04 S8 |
| OpenAPI tooling | `openapi-typescript` **7.13.0**, `openapi-fetch` **0.17.0**, openapi-generator `dart-dio` (v**7.27.0** listed; 3.1 completeness UNVERIFIED), Prism **5.16.0** (3.1 support UNVERIFIED), MSW **3.0.3**, `oasdiff` **1.35.x** stable line (not the v2.2.0-openapi31 beta) | 04 S19, T7, T8 |
| PDF | Playwright-managed Chromium pool (Playwright version [PIN-C0]/C6); qpdf **12.4.2**; stamping via `@cantoo/pdf-lib` **2.11.1** or `@pdfme/pdf-lib` **6.2.8** (C6 picks one in its TRD; never both) | 04 S14, S15 |
| B.S. date (TS) | `@remotemerge/nepali-date-converter` **1.2.7**, wrapped in `packages/shared-ts/bsdate` only | 04 D13 |
| Flutter / Dart | [PIN-C0] for the Flutter SDK and Dart SDK (exact versions in `packages/ui-flutter/pubspec.yaml` `environment:` and CI image). Dart pub workspace (01 §3). | 01 §3 |
| B.S. date (Dart) | `nepali_utils` **3.0.8** (via `nepali_date_picker` **8.0.0**), wrapped in `packages/shared-dart/bsdate` only | 04 D13 |
| Offline store (Dart) | `drift` **2.35.3** on `package:sqlite3` ≥3.x with its SQLCipher (or SQLite3MultipleCiphers) hook option | 04 A15, T7 |
| Mobile secrets | `flutter_secure_storage` (version [PIN-C0]) | 04 A15 |
| Go (bridge agent) | **Go ≥1.26** toolchain, pinned identically in `go.mod` (`go`/`toolchain` lines) and CI; `golang.org/x/sys` **v0.49.0**, `go.bug.st/serial` **v1.8.0**; target Windows 10/11 or Server 2016+ only | 04 S16, T7 |
| Migration runner | Atlas **or** sqitch (C0 decides in its TRD; not supabase CLI) | 04 S12 |
| Migration linter | **BLOCKED B10** (Atlas Pro paid vs free linter, e.g. `squawk-cli` 2.70.0 — rule coverage UNVERIFIED). Default until answered: "no lint gate assumed free" → CI runs the manual migration checklist (§5.12) as a required review item | 04 S13, B10 |

### 1.2 TypeScript compiler settings (all TS packages)

```jsonc
// tsconfig.base.json (C0) — minimum; packages may only tighten
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "useUnknownInCatchVariables": true,
    "forceConsistentCasingInFileNames": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": false
  }
}
```

[CONV] Rules on top of the compiler:
- `any` is banned (lint error). Use `unknown` and narrow.
- No non-null assertions (`!`) outside tests.
- No default exports except where a framework requires them (Next.js `page.tsx`/`layout.tsx`).
- Every exported function in `service/` and `ports/` has an explicit return type.
- `Date` objects never cross a module boundary; timestamps cross as ISO-8601 UTC strings (`IsoUtc` branded type from `@lims/shared-ts`).

### 1.3 Lint and format

[CONV] ESLint + Prettier configs are C0-owned at the repo root. Mandatory lint rules (all error level):

| Rule | Why |
|---|---|
| no `dangerouslySetInnerHTML` with non-constant input | REQ-SEC-088 |
| no import from another module's folder (`services/api/src/modules/<other>/…`, `apps/web/src/features/<other>/…`) | 01 §4, REQ-ARCH-076 |
| no import from `@supabase/supabase-js` or `@supabase/ssr` in any file that can be bundled for the browser | 04 S4, REQ-SEC-068 |
| no string-built SQL: `sql` tagged template or `$n` placeholders only | REQ-SEC-082 |
| no bare `SET ` statement in SQL strings (only `set_config(…, true)` / `SET LOCAL`) | 04 S9, REQ-ARCH-016 |
| no `console.*` (use the shared logger) | §9 |
| no `Math.random()` for tokens/ids (use `@lims/shared-ts/crypto`) | 04 A9–A13 |
| no `new Date()` in `domain/` (inject a clock) | testability |

Dart: `flutter analyze` with C0's `analysis_options.yaml` (strict-casts, strict-inference, strict-raw-types on). Go: `go vet`, `staticcheck` [PIN-C0], `gofmt` check.

---

## 2. Repository, packages, module skeletons

### 2.1 Package naming

| Kind | Name | Path (owner per 01 §3) |
|---|---|---|
| npm workspace packages | `@lims/<name>` [CONV] | — |
| API service | `@lims/api` | `services/api` (core C0, modules per owner) |
| Worker service | `@lims/worker` | `services/worker` |
| Renderer service | `@lims/renderer` | `services/renderer` (C6; `templates/smart/` C14) |
| Staff web | `@lims/web` | `apps/web` |
| Patient portal + QR verify | `@lims/portal` | `apps/portal` (C6) |
| Partner portal | `@lims/partner` | `apps/partner` (C13) |
| Shared TS | `@lims/shared-ts`, `@lims/ui`, `@lims/fakes`, `@lims/test-fixtures`, `@lims/api-client-ts` | `packages/*` (C0) |
| Contracts (TS port types) | `@lims/contracts` (exports `contracts/ports/*.ts` and generated event types) | `contracts/` (C0) |
| Dart packages | `lims_shared` (`packages/shared-dart`), `lims_api_client` (`packages/api-client-dart`), `lims_ui` (`packages/ui-flutter`) [CONV] | C0 |
| Flutter apps | `patient_app`, `phlebo_app` | C16, C17 |
| Go module | module path set by C0 at `go mod init` (repo host path + `/apps/bridge-agent`) | C7 |

**Paths (binding, 03-IC §5.2 X1):** repo-root `db/` and `contracts/` per 01 §3 — not `packages/db` / `packages/contract` as worded in 04 S12 and research 03 §8 (the lead is aligning that wording). Semantics are identical: one C0-owned home for forward-only SQL and one for contracts.

### 2.2 API module skeleton (`services/api/src/modules/<m>/`)

`<m>` = module name = Postgres schema name = OpenAPI domain file name (01 §3 module table). Exact layout [CONV]:

```
services/api/src/modules/<m>/
├── index.ts                    # ModuleManifest (the ONLY file the core autoloader reads)
├── permissions.ts              # permission codes this module checks (must exist in contracts/permissions.yaml, see §10.1)
├── config.ts                   # typed config keys this module reads (env names prefixed LIMS_<M>_)
├── handlers/
│   ├── index.ts                # export const handlers = { [operationId]: handlerFn }  (keys = OpenAPI operationIds)
│   └── <operationId>.ts        # ONE file per operationId; thin: authz → service → mapper
├── service/
│   └── <aggregate>.service.ts  # use-cases; owns transaction boundaries; publishes events
├── domain/
│   ├── <aggregate>.ts          # pure types + invariants, no IO
│   └── <aggregate>.state.ts    # state machine table (states, transitions, guards) — pure
├── repository/
│   └── <aggregate>.repo.ts     # SQL for THIS schema only; parameterised; tenant filter explicit (REQ-SEC-024)
├── events/
│   └── publish.ts              # typed publishers for events this module PRODUCES (wraps core publish)
├── ports/
│   └── <PortName>.impl.ts      # implementation(s) of port(s) this module OWNS (01 §5.1)
├── mappers/
│   └── <aggregate>.dto.ts      # row → response DTO with explicit field allowlist per role (REQ-SEC-081)
└── __tests__/
    ├── unit/                   # domain + state machine + mappers
    ├── integration/            # service+repo against a real migrated DB (testcontainers or compose)
    ├── contract/               # runs packages/fakes/contract-tests/<Port> against the REAL impl
    └── probes/                 # cross-tenant + cross-centre probes for every owned endpoint/table (§11.3)
```

There is **no hand-written routes file**: routes, methods, path params and request/response JSON Schemas come from `contracts/openapi/<m>.yaml`, mounted by the core through `fastify-openapi-glue` (04 T7; REQ-ARCH-071). The module supplies only the `operationId → handler` map.

```ts
// services/api/src/modules/lab/index.ts
import type { ModuleManifest } from '../../core/module';
import { handlers } from './handlers';
import { labPortImpl } from './ports/LabPort.impl';

export const manifest: ModuleManifest = {
  name: 'lab',                       // = schema = openapi domain
  openapi: 'contracts/openapi/lab.yaml',
  handlers,                          // every operationId in lab.yaml MUST have a handler (core fails boot otherwise)
  ports: { LabPort: labPortImpl },   // only ports this module owns per 01 §5.1
  produces: [                        // must equal 01 §5.1 producer list (CI checks)
    'lab.specimen.status_changed.v1', 'lab.specimen.rejected.v1',
    'lab.result.verified.v1', 'lab.result.approved.v1', 'lab.result.amended.v1',
    'lab.order.ready_for_report.v1', 'lab.critical_value.detected.v1',
  ],
};
```

Handler shape (every handler):

```ts
// handlers/rejectSpecimen.ts
import type { Handler } from '../../../core/http';
export const rejectSpecimen: Handler<'rejectSpecimen'> = async (req, ctx) => {
  const specimen = await ctx.services.lab.specimens.getForAuthz(ctx, req.params.specimen_id); // 404 if not visible
  await ctx.ports.IdentityPort.assertRole(ctx, { permission: 'lab.specimen.reject', centreId: specimen.centreId });
  const out = await ctx.services.lab.specimens.reject(ctx, req.params.specimen_id, req.body);
  return { status: 200, body: toSpecimenDto(out, ctx.actor) };
};
```

Layer rules [CONV]:
- `handlers/` MUST NOT contain SQL or business rules. `domain/` MUST NOT import IO. `repository/` MUST NOT call ports or publish events.
- Transactions are opened in `service/` via `ctx.db.tx(async (tx) => …)`; the core sets tenant context inside every transaction (§6). Ports and repositories receive the caller's `tx`.
- A module reads foreign data only via (a) a port, (b) `core` repository functions supplied by C0 (`ctx.core.*`: tenants, branches, centres, users, memberships), or (c) a `v_pub_*` view (01 §5 R1).

### 2.3 Worker module skeleton (`services/worker/src/jobs/<m>/`)

```
services/worker/src/jobs/<m>/
├── index.ts                     # WorkerManifest: tasks, subscriptions, crontab
├── tasks/<task_name>.ts         # one Graphile Worker task per file
├── consumers/<event_type>.ts    # one consumer per subscribed event (file name = full event name, dots kept)
├── cron.ts                      # crontab entries (in code, never hand-configured — REQ-ARCH-042)
└── __tests__/{unit,integration}/
```

```ts
// services/worker/src/jobs/lab/index.ts
export const manifest: WorkerManifest = {
  module: 'lab',
  tasks: { 'lab.recompute_tat_rollup': recomputeTatRollup },
  subscriptions: {
    'frontdesk.order.created.v1': onOrderCreated,      // must be in 01 §5.1 consumer list for C5
    'instruments.result.received.v1': onInstrumentResult,
  },
  crontab: [],
};
```

Task identifier format [CONV]: `<m>.<snake_task>` for plain tasks; `evt.<consumer_module>.<event_type>` for consumer tasks (generated by the core dispatcher, §7.4). Business logic shared between an API handler and a job lives in the module's `services/api/src/modules/<m>/service/`; the worker imports it through the module's manifest (same owner, same chunk). The worker core builds the same port registry as the API (§8.2).

### 2.4 Web feature skeleton (staff web `apps/web`)

```
apps/web/src/app/(staff)/<m>/            # Next.js App Router route segment (owner chunk)
│   ├── layout.tsx                       # optional; uses core shell only
│   ├── page.tsx                         # server component; data via BFF server functions
│   ├── loading.tsx / error.tsx          # mandatory for every page (App Flow empty/loading/error states)
│   └── <sub-route>/…
apps/web/src/features/<m>/
├── nav.manifest.ts                      # nav entries + required permission (build-time collected; 01 §3)
├── server/                              # BFF server-only code: calls API through core proxy with the session's token
│   └── <operationId>.server.ts          # "server-only" import guard at top
├── components/                          # composed ONLY from @lims/ui primitives (§14)
├── hooks/
├── forms/                               # form schemas mirrored from generated API types (no hand-typed DTOs)
├── help/                                # in-app help content per screen (IRD cl.6(ढ) for billing — 04 L26)
└── __tests__/
```

- Browser code MUST NOT hold any JWT, Supabase client, or API base URL with credentials (04 S4; REQ-SEC-068). The browser talks only to the BFF origin; the BFF talks to the API.
- Live updates in staff web = SSE or polling through the BFF (04 S4). No Supabase Realtime in the browser.
- `apps/portal` and `apps/partner` follow the same `app/` + `features/` split inside their own app root (C6, C13 own the whole app).

### 2.5 Flutter app skeleton (`apps/patient_app`, `apps/phlebo_app`)

```
apps/<app>/
├── pubspec.yaml                 # depends on lims_shared, lims_api_client, lims_ui (workspace)
├── analysis_options.yaml        # includes C0's package:lims_shared/analysis_options.yaml
├── lib/
│   ├── main.dart                # flavour entry (dev/staging/prod); no secrets (REQ-SEC-107)
│   ├── app/                     # router (deep links from contracts/routes.yaml), theme from lims_ui
│   ├── core/                    # app-local: session (flutter_secure_storage), api client factory, connectivity
│   └── features/<feature>/
│       ├── data/                # repositories over lims_api_client (+ drift DAOs for phlebo offline)
│       ├── domain/              # pure models, state machines
│       └── presentation/        # widgets from lims_ui only, screens, controllers
├── test/                        # unit + widget
└── integration_test/            # device/emulator flows against Prism mock or staging
```

State-management library: [PIN-C0] — C0 picks one for both apps in `packages/ui-flutter` docs; C16/C17 do not choose differently.

### 2.6 Go bridge agent skeleton (`apps/bridge-agent`, C7)

```
apps/bridge-agent/
├── go.mod                       # go 1.26.x + toolchain line (04 S16)
├── cmd/agent/main.go            # Windows service entry (x/sys/windows/svc)
├── internal/
│   ├── transport/{serial,tcp}/  # go.bug.st/serial; TCP client/server per instrument config
│   ├── astm/                    # E1381 framing (in-house, 04 N13) + E1394 records (04 N4/N5)
│   ├── hl7/ , mllp/             # HL7 v2 parse/ACK; MLLP 0x0B…0x1C 0x0D (04 N9)
│   ├── drivers/<vendor>_<model>/# one driver per model, only after the official manual is in hand (04 B2)
│   ├── queue/                   # encrypted local SQLite WAL queue (04 N11, REQ-SEC-117)
│   ├── uploader/                # batched ≤100 messages/request, backoff (04 §4)
│   ├── config/ , update/        # signed config + signed self-update (04 N11)
│   └── heartbeat/               # every 60 s (04 N11)
└── testdata/sessions/           # SYNTHETIC captured sessions for the replay harness (REQ-ARCH-064)
```

### 2.7 Contracts folder (C0 only)

```
contracts/
├── openapi/<m>.yaml                         # one per API module (01 §3)
├── openapi/_common.yaml                     # shared components: Problem, Money, PageInfo, Id, IsoUtc, headers
├── events/_envelope.v1.schema.json          # envelope (03-IC §2)
├── events/_defs.v1.schema.json              # shared $defs (Uuid, IsoUtc, Actor, Money, …)
├── events/<event-name>.schema.json          # e.g. frontdesk.order.created.v1.schema.json (name incl. .v1)
├── ports/<PortName>.ts                      # e.g. LabPort.ts; plus ports/common.ts
├── errors.yaml                              # global error-code registry (03-IC §8)
├── routes.yaml                              # cross-app deep-link routes (03-IC §7)
└── permissions.yaml                         # permission codes + default role grants (§10.1) — content in 03-IC §11 (accepted addition A6)
```

---

## 3. Naming conventions (one table)

| Thing | Convention [CONV] | Example |
|---|---|---|
| Postgres schema | module name, lower snake | `frontdesk`, `billing`, `lab` |
| Table | plural lower snake | `order_items`, `specimens`, `ledger_entries` |
| Global (non-tenant) reference table | prefix `g_` | `catalog.g_units`, `micro.g_cs_ast_interpretations` |
| Coded-set table | prefix `cs_` | `lab.cs_rejection_reasons` |
| Column | singular lower snake; FK = `<entity>_id`; booleans `is_`/`has_`; timestamps `_at` (timestamptz); dates `_on` (date) | `centre_id`, `is_active`, `collected_at`, `birth_on` |
| Money column | `<name>_paisa bigint` | `total_paisa` |
| Published view | `<schema>.v_pub_<name>` | `billing.v_pub_invoice_daily` |
| Storage bucket | `<owner-module>-<purpose>` (exception: `reports`, 04 D15) | `frontdesk-trf`, `micro-imports` |
| Access-log action code | `<entity>.<verb>` (exactly two segments; seeded in `audit.g_cs_access_actions`) | `report.download`, `app_link.redeem` |
| Token hash column | `<name>_sha256 bytea`, 32 bytes, `CHECK (octet_length(...) = 32)` | `token_sha256` |
| Phone number (E.164) | `phone_e164` columns and `phoneE164`/`phone_e164` fields: `^\+[1-9][0-9]{7,14}$` everywhere (08 A6.2 made program-wide; 08 A13 P-11) | `phone_e164` |
| Internal view | `<schema>.v_<name>` | `lab.v_worklist` |
| Index | `<table>__<cols>__idx` / unique `__uq` / partial adds `__p` | `specimens__tenant_id_status__p_idx` |
| Constraint | `<table>__<purpose>__ck` / FK `__fk` | `invoices__total_nonneg__ck` |
| RLS policy | `<table>__<command>__<scope>` | `orders__select__tenant_centre` |
| Function (SQL) | `<schema>.<verb>_<object>`; helpers in `app` schema | `app.current_tenant_id()` |
| OpenAPI path | `/v1/<m>/<plural-resource>[/{id}[/<sub-resource or action>]]`. Documented exception: `/v1/core/health/{live,ready}` (CR-C0-006). | `/v1/lab/specimens/{specimen_id}/reject` |
| operationId | lowerCamel verb+noun, unique across ALL specs | `rejectSpecimen`, `listWorklistItems` |
| JSON field (HTTP, events) | lower snake_case | `registration_no` |
| TS identifiers | camelCase values, PascalCase types | `getOrderSummary`, `OrderSummary` |
| Event name | `<producer_module>.<aggregate>.<past_tense_verb>.v<N>` (01 §5 R4) | `lab.result.approved.v1` |
| Error code | `<owner_module>.<snake_reason>`; common = `common.*`, auth = `auth.*` | `billing.invoice_immutable` |
| Permission code | `<m>.<resource>.<action>` | `billing.invoice.cancel` |
| Env var | `LIMS_<MODULE>_<KEY>`; core `LIMS_CORE_<KEY>` | `LIMS_REPORTING_LINK_TTL_DAYS` |
| Metric | `lims_<m>_<name>_<unit>` (Prometheus style) | `lims_lab_results_ingested_total` |
| Branch | `c<NN>/<kebab-topic>` | `c05/specimen-reject` |

Wire vs code casing [CONV]: HTTP JSON, event payloads, DB columns and `routes.yaml` params use **snake_case**. TypeScript port interfaces use **camelCase** member names (in-process only). Mappers convert at the HTTP boundary; event payload types generated from JSON Schema keep snake_case.

---

## 4. API conventions (HTTP / OpenAPI)

### 4.1 URL and resource style

- Base: `/v1/<m>/…` where `<m>` is the owning module (01 §5 example `POST /v1/frontdesk/registrations`). One module = one spec file = one URL prefix. A module MUST NOT define paths outside its prefix.
- Resources: plural nouns. IDs in paths are UUIDv7 (04 D9). Human numbers (registration no, barcode, invoice no) are **never** path identifiers; look them up with a body, never a URL (`POST /v1/lab/specimens/lookup` with `{ "barcode": "E1100001677" }` — REQ-SEC-098, CR-C5-008).
- State transitions are **action sub-resources** with `POST`, never `PATCH status`:
  `POST /v1/lab/specimens/{specimen_id}/receive`, `/reject`, `POST /v1/lab/results/{result_id}/verify`, `/approve`, `/amend`, `POST /v1/billing/invoices/{invoice_id}/cancel`, `/reprint`.
- Methods: `GET` (safe, no body), `POST` (create or action), `PUT` (full replace of the mutable subset of a master-data record), `PATCH` (partial update of master data only; never for clinical/billing records), `DELETE` (only for drafts and master-data associations that are not clinical/billing records — see §5.6).
- Bulk actions: `POST /v1/<m>/<resources>/bulk-<action>` with body `{ "ids": [...] }` or, where each row needs optimistic concurrency, `{ "items": [ { "id": …, "version": … } ] }` (08 A17.3, CR-C5-011), max 200 ids/items [CONV], response lists per-id outcome; any id outside the caller's tenant/centre yields a per-id `common.not_found` (never reveals existence — REQ-SEC-044).
- No PHI in URLs or query strings (REQ-SEC-098): search by name/phone uses `POST /v1/frontdesk/patients/search` with a body, not `GET ?name=`.

### 4.2 Request/response envelope

```json
// collection response
{ "data": [ { "id": "01933b6e-8f1a-7c3d-9a40-2f5e6b7c8d90", "status": "received" } ],
  "page": { "next_cursor": "eyJrIjoiMjAyNi0xMS0wNVQwNDoxNTowMC4wMDBaIiwiaSI6IjAxOTMzYjZlLi4uIn0", "limit": 50 } }

// single resource response: the object itself (no wrapper)
{ "id": "01933b6e-8f1a-7c3d-9a40-2f5e6b7c8d90", "status": "received", "version": 3 }
```

- **No `null` on the wire** [CONV]. Absent optional field = omitted. (This is also what keeps specs inside the OpenAPI 3.0/3.1 intersection, §4.12.) Clearing an optional master-data field uses `PATCH` with `"unset": ["field_name"]`.
- Every mutable resource returns `version` (integer, optimistic concurrency). Updates and actions send `If-Match: "<version>"`; mismatch → `409 common.version_conflict`.

### 4.3 Pagination (cursor)

| Param | Rule |
|---|---|
| `limit` | default 50, max 200 [CONV]; >200 → `400 common.validation_failed` |
| `cursor` | opaque base64url string from `page.next_cursor`; encodes the last row's sort key + `id`. It is not signed because it carries no authority: the server re-applies tenant/centre filters and the caller's permission on every page, and a malformed cursor → `400 common.invalid_cursor` |
| end of data | `page.next_cursor` omitted |
| totals | not returned by default; endpoints that need a count expose `include_total=true` with a documented cost bound |

Offset pagination is banned (unstable under concurrent inserts and expensive on large tables).

### 4.4 Filtering and sorting

- Filters are plain query params named after the field: `status=received,in_process` (comma = OR within field), different params AND together.
- Ranges: `<field>_from` / `<field>_to` (inclusive from, exclusive to), ISO-8601 UTC: `received_at_from=2026-11-05T00:00:00.000Z`.
- Sorting: `sort=-received_at,id` (leading `-` = descending). Each list endpoint enumerates its allowed sort keys in the spec (`enum`); `id` is always appended as tie-breaker.
- Unknown query params → `400 common.validation_failed` (strict, REQ-SEC-080).

### 4.5 Idempotency (`Idempotency-Key`)

**Required** on every `POST` that creates state or moves money [CONV, implementing 04 P6 / REQ-SEC-050/051]: registrations, orders, invoices, credit notes, ledger entries, payment intents, refunds, report releases, deliveries, bulk actions, device ingest batches, offline mutation uploads, bookings. Optional (accepted) on other POSTs. The spec marks it with `$ref: '_common.yaml#/components/parameters/IdempotencyKey'` and `required: true`.

'Creates state' includes master-data creates (catalog rows, rules, templates, contacts). There are two exceptions, each with `x-idempotency: none` and a justification string (08 A13 P-8):
- **(E1) secret shown once.** The 2xx body contains a secret, so storing it for replay would persist the secret. Double submit is guarded by `If-Match` on the parent row's `version`. Existing user: C7 E14; C6 C3 `rotateChannelCallbackToken`.
- **(E2) portal / patient pre-auth OTP POSTs.** Rows are superseded and bounded by the `otp_request`/`otp_verify` tiers. Covers C6 P1, P2, P5 and the C16 OTP challenge POSTs.

The portal dues-payment request POST (08 A11.1, C6 spec) is **not** an exception: `x-idempotency: required`.

| Aspect | Rule |
|---|---|
| Format | 1–64 chars `[A-Za-z0-9_-]`; clients SHOULD send a UUIDv7 |
| Scope | unique per `(tenant_id, actor_id, key)` |
| Storage | `core.idempotency_keys(tenant_id, actor_id, key, method, route, request_sha256, state, response_status, response_body, created_at, expires_at)` (C0 DDL) — stored in the Nepal DB like any other PHI-bearing row |
| Same key, same request hash, completed | replay the stored status + body; header `Idempotent-Replayed: true` |
| Same key, different request hash | `422 common.idempotency_key_reused` |
| Same key, first request still running | `409 common.idempotency_in_progress` with `Retry-After: 1` |
| Retention | 7 days [CONV] (covers offline phlebotomy sync windows) — then key may be reused |
| Missing when required | `400 common.idempotency_key_required` |
| Domain uniqueness still applies | the header is a client-retry guard; money paths ALSO keep their DB unique constraints (04 P6: unique `(gateway, gateway_txn_id)`, one open intent per order) |

**Port idempotency keys (08 A19 P-40; A22.0).** The `Idempotency-Key` **HTTP header** keeps the format above (1–64 `[A-Za-z0-9_-]`). An `idempotencyKey` **input of a port** (any `contracts/ports/*`) matches `^[A-Za-z0-9_.:-]{1,200}$` [CONV]. Callers build it as `<prefix>:<id>[:<suffix>]`. A port owner that stores the key uses exactly this CHECK.

**4xx responses are not stored (08 A25 D-202).** Status < 400: the response is stored and replayed. Status ≥ 400: the response is not stored; the `in_progress` row goes with the rollback. When the handler called `ctx.commitOnError()` (§4.7, P-42), the core deletes the key row in the same transaction before commit. A retry with the same key re-runs the handler. Platform-context operations (`provisionTenant`, `openSupportSession`, `invitePlatformStaff`) store keys with `tenant_id` NULL (08 A25 D-213; 03-IC §12).

The core implements this as a Fastify hook + transaction (C0); modules never hand-roll it.

### 4.6 Errors — RFC 9457 `application/problem+json`

Every non-2xx response body:

```json
{
  "type": "urn:lims:error:lab.specimen_invalid_transition",
  "title": "Specimen cannot move to the requested state",
  "status": 409,
  "code": "lab.specimen_invalid_transition",
  "detail": "Transition received -> collected is not allowed.",
  "instance": "/v1/lab/specimens/01933b6e-8f1a-7c3d-9a40-2f5e6b7c8d90/collect",
  "request_id": "01933b6f-0a11-7e2b-8c55-1d2e3f405162",
  "errors": [ { "path": "/reason_code", "code": "common.field_required", "message": "reason_code is required" } ]
}
```

- `code` MUST exist in `contracts/errors.yaml` (03-IC §8). `type` = `urn:lims:error:` + code [CONV] (a URN, so no domain name is invented). `title` is the registry title; `detail` is human text with **no PHI, no SQL, no stack, no file paths** (REQ-SEC-095).
- `errors[]` only for validation (`common.validation_failed`), JSON-Pointer paths.
- Unknown internal failures → `500 common.internal` with `request_id` only.
- Existence hiding: an object in another tenant (or outside the caller's centre scope) returns `404 common.not_found`, identical to a truly missing id (REQ-SEC-044, REQ-SEC-093 pattern).
- Rate limits → `429 common.rate_limited` + `Retry-After` seconds.

### 4.7 Validation

- Every request body/param/query is validated against the spec JSON Schema at the edge of the API (ajv through fastify-openapi-glue) **before** the handler runs (REQ-SEC-080).
- Every object schema in every spec has `additionalProperties: false` (unknown fields rejected — REQ-SEC-080, mass-assignment API3). CI lint fails a spec object without it.
- Strings have `maxLength`; arrays `maxItems`; integers `minimum`/`maximum`; enumerations are `enum` lists.
- Never accept `tenant_id`, `created_by`, `price`, `amount_paisa` where the server can compute the amount (prices, dues, gateway amounts, discounts after approval), `status` (outside action endpoints), or role/permission fields from a client body where the server is the authority (REQ-SEC-046, REQ-SEC-013/067). Specs simply do not declare them as request properties. Amounts that are facts entered by a person — cash/card received at the desk (04 P1), a finance-entered refund amount, a bank-statement total on a reconciliation worksheet — are allowed only when the operation names them explicitly (`amount_received_paisa`, `refund_amount_paisa`, `statement_total_paisa`), the server bounds them (≤ due, ≤ refundable) and, for refunds, the operation is privileged and approved by a second person (08 R15; CR-C4-012, CR-C15-012).
- Responses are validated against the spec in dev/CI/staging (REQ-ARCH-071; 03 §8.3 "runtime response-validation in staging").
- `common.validation_failed` is always `400` (03-IC §8). A business rule with no registered code of its own is reported as `400 common.validation_failed` with a JSON-pointer path in `errors[]`. No document writes '422 common.validation_failed'; 422 is used only by codes registered with `http: 422`. (08 A13 P-1)
- **Security counters on a failing request (08 A19 P-42).** A handler that records an attempt, a failure counter or a `denied` access-log row and then returns ≥ 400 calls `ctx.commitOnError()` (C0 TRD §5 step 11) right after those writes and makes no other write in that transaction. Each such path has an integration test that asserts the write survives the 4xx. A path whose other writes must roll back (for example a redemption that hits a limit) does not call it.

### 4.8 Date and time

| Kind | Wire format | Example |
|---|---|---|
| Instant | RFC 3339 / ISO-8601 **UTC**, `Z` suffix, millisecond precision | `2026-11-05T04:15:00.000Z` |
| Calendar date (A.D.) | `YYYY-MM-DD` | `1983-04-12` |
| B.S. date | **never in the API, events or DB** as an authority (04 D12) — computed at display time by `bsdate` modules. Exception: derived, labelled fields where a legal document requires the B.S. value as printed (e.g. `fiscal_year_bs: "2082/83"` on an invoice, `invoice_date_bs: "2082-07-19"` as a display snapshot) |
| Duration | integer seconds with unit in the field name | `tat_seconds` |
| Time zone for display | `Asia/Kathmandu` (UTC+05:45) unless a tenant setting says otherwise [CONV]; in v1 `TenantSettings.timezone` accepts only `Asia/Kathmandu` (08 A13 P-15, 03-IC §6) |

Instrument timestamps are stored as received plus server `received_at` (04 N12).

### 4.9 Money

- Integer **paisa** (1 NPR = 100 paisa) in `int64`/`bigint`; JSON field suffix `_paisa`; currency field `currency: "NPR"` (only allowed value in v1).
- Shared schema: `Money = { amount_paisa: integer (≥ −9007199254740991, ≤ 9007199254740991), currency: "NPR" }`.
- No floats anywhere in money paths (TS `number` is allowed only because values stay within safe-integer range; `@lims/shared-ts/money` asserts `Number.isSafeInteger`). Dart uses `int`.
- Rounding: line-level, half-up to the paisa [CONV]; every tax/discount computation is in `@lims/shared-ts/money` with golden tests; the rounding rule is reviewed by the client's auditor with the invoice format (BLOCKED B7 for tax treatment).
- Taxes: an invoice line carries `vat_paisa` and a separate `other_tax_paisa` + `other_tax_code` slot (04 L25 Health Service Tax possibility, BLOCKED B7); exempt vs taxable flags per line (04 L15).

### 4.10 Identifiers

- Internal IDs: UUIDv7 (RFC 9562 layout), **generated in application code** via `@lims/shared-ts/uuidv7` or `lims_shared/uuidv7.dart` — the only allowed generators (04 D9). Columns `uuid`, no DB default.
- Never sequential integers in URLs, QR codes or tokens (04 D9; REQ-SEC-028).
- Human-readable numbers (registration no, lab/barcode no, invoice no, credit-note no, histo accession no) are **separate columns** with per-tenant formats and counters (03-IC §9.3). Invoice numbers are gapless per (tenant, B.S. fiscal year) (04 L7; series granularity BLOCKED B6/L8, default per (tenant, FY)).
- Tokens (QR verify, report link, OTP, reset, device): CSPRNG only, sizes per 04 A9–A13; stored hashed where 04 says so (device token SHA-256, 04 A13).

### 4.11 Versioning and deprecation

- URL major version `/v1/`. Within v1, only **additive** changes: new optional request fields, new response fields, new endpoints, new enum values **only where the spec marks the enum `x-extensible: true`** [CONV] (clients must tolerate unknown values there).
- Breaking change = new path version (`/v2/…`) after v1 freeze, via CR (REQ-ARCH-077). `oasdiff` 1.35.x breaking check fails CI without a `cr-approved-breaking` label (04 S19, T7; REQ-ARCH-078).
- Deprecation: mark `deprecated: true` in the spec + response header `Deprecation: true` and `Sunset: <HTTP-date>`; minimum sunset window 90 days [CONV]; removal really removes the route (REQ-SEC-099).
- Event versions follow the same rule (§7.2).

### 4.12 OpenAPI authoring rules

The documents are hand-written and **authored as valid OpenAPI 3.0.3 using only constructs that are also valid OpenAPI 3.1** — binding resolution X10 (03-IC §5.2) of 04 S19 ("3.1 kept 3.0-compatible"), because `oasdiff` stable supports 3.1 only in a beta line (04 T7), dart-dio 3.1 completeness is UNVERIFIED (04 T8) and Prism 3.1 support is UNVERIFIED (04 T7).

**Binding (X10):** every spec file starts with `openapi: 3.0.3`. CI validates each file as OpenAPI 3.0.3 and additionally rejects the 3.0-only/3.1-only constructs in the table below, so a later switch of the header to `3.1.0` (by CR, once oasdiff/dart-dio/Prism support is verified) needs no content changes.

Allowed-construct rules (the 3.0 ∩ 3.1 subset):

| Do | Don't |
|---|---|
| Omit optional fields instead of null | `nullable: true` (3.0-only) or `type: [x, "null"]` (3.1-only) |
| Single-value `enum: [NPR]` | `const` |
| `minimum`/`maximum` | `exclusiveMinimum`/`exclusiveMaximum` (boolean in 3.0, number in 3.1) |
| `examples` at media-type level | `example` inside schemas mixed with `examples` |
| `$ref` alone (wrap in `allOf` if you need siblings) | `$ref` with sibling keywords |
| `oneOf` + `discriminator.propertyName` with explicit `mapping` | `not` (unsupported by dart-dio per 03 §8.1), `if/then/else`, `prefixItems`, `$defs` inside paths |
| `multipart/form-data` with `type: string, format: binary` for uploads | `contentMediaType`/`contentEncoding` |
| `components.securitySchemes`: `bffSession` (cookie, staff web origin only), `bearerJwt` (API), `deviceToken` (ingest), `portalSession` | `webhooks` top-level object |

Every operation MUST have: `operationId`, `tags: [<m>]`, `summary`, `security`, `x-permission: <permission code>` (or `x-public: true` with a justification string — REQ-SEC-099 inventory), `x-idempotency: required|optional|none`, `x-rate-limit-tier` (§10.3), all response codes it can return each with `$ref` to a Problem response listing the possible `code` values in `x-error-codes`, and at least one request and one response example built from synthetic data.

- Extensions: `x-context: tenant|platform` (CR-C2-004); `x-edge-exposure: public|internal`, default internal, spec-lint enforced (CR-C1-004); `x-anonymous-tx: true` (module reporting, with `x-public`, CR-C6-001); `x-raw-body: true` (reporting provider callbacks only, ≤ 256 KB); `text/html` responses only for payments operations with `x-public` or `paymentCallbackToken` (CR-C15-004); `x-upload: [<mime>…]` per upload operation (08 R12b).
- Conditional permissions (08 A13 P-10): `x-permission` names the permission required on every call (the floor). Permissions that depend on a request value or on resource state are checked in the handler with `IdentityPort.assertRole` immediately after loading the target. They are written in the TRD row as `+ <code> when <condition>`, each branch has a hand-written permission test, and `auth.forbidden` / `auth.mfa_required` are in `x-error-codes`. `x-permission-by-param` / `x-permission-by-kind` do not exist.
- **One permission floor per operation (08 A19 P-43).** `x-permission` is one code that every caller holds. An operation never accepts 'A **or** B'. Where two audiences need the same data, there are two operationIds, each with its own floor (for example a staff path and a `/me/…` patient path, or one coded-set operation per audience). The extra conditions of P-10 still apply inside each handler.

---
## 5. Database conventions

### 5.1 Model

- Single PostgreSQL 17 database, shared schema, **one Postgres schema per module** (01 §3 module table), `tenant_id uuid NOT NULL` on every tenant table, no default (04 D1; REQ-SEC-027).
- C0 writes all DDL (01 §0). Chunk `05-SCHEMA.md` files are the specification C0 implements.
- **Data ownership of instrument code maps (binding X4):** instrument analyte-code ↔ catalog analyte mappings (incl. unit conversion and flag maps) are **catalog data** in `catalog.instrument_code_maps`, owned by C3 and exposed through `CatalogPort.mapInstrumentCode`; C7's mapping screens write them via C3's HTTP API (`/v1/catalog/instrument-code-maps`, permission `catalog.instrument_code_map.manage`). The `instruments` schema holds only driver/channel configuration (ports, delimiters, protocol options, agent bindings).
- Platform tables behind the channels (`core.event_log`, `<m>.event_inbox`, `core.dead_letters`, `core.idempotency_keys`, `app.enqueue_job`) are specified in 03-IC §12 (accepted addition A7).
- Extra non-module schemas (C0-owned): `app` (helper functions, SECURITY DEFINER inventory — never exposed), `api` (curated PostgREST views/RPC, only if PostgREST is used at all — 04 S3), `graphile_worker` (queue, pre-installed — 04 D6 UNVERIFIED), Supabase's own (`auth`, `storage`, `realtime`) which app code never queries directly except Storage/Realtime policies written by C0.

### 5.2 Table classes and mutability

| Class | Examples | UPDATE | DELETE | Mandatory columns |
|---|---|---|---|---|
| **M — master data** | catalog tests/panels, price lists, doctors, centres, templates | allowed; clinically meaningful attributes are **versioned rows**, not updated in place (reference ranges, units — 04 D14) | **never hard-deleted**; deactivate with `is_active = false` | id, tenant_id, created_at, created_by, updated_at, updated_by, version, is_active |
| **C — clinical record** | specimens, results, result_versions, verifications, approvals, critical_value_log, reports, report_versions | state transitions only, through the module's state machine; content columns frozen after approval by trigger (§5.7) | **never** (no DELETE grant, no DELETE policy) | id, tenant_id, created_at, created_by, updated_at, updated_by, version |
| **B — billing record** | invoices, invoice_lines, credit_notes, ledger_entries, fiscal counters, print log | only whitelisted lifecycle columns (status, print_count, CBMS sync state, cancellation fields) via trigger (§5.7); content immutable (04 L5, L26 ख/ट) | **never** (VAT Act s.29(1)(g2) exposure — 04 L5) | id, tenant_id, created_at, created_by, is_active (04 L26 घ), plus updated_* where lifecycle columns exist |
| **A — append-only log** | `audit.audit_log`, `audit.access_log`, `core.event_log`, `<m>.event_inbox`, delivery attempts, `instruments` raw messages, ledger (also B) | **never** | only by retention purge functions run under the owner role (§5.11) | id, tenant_id, created_at, created_by |
| **E — ephemeral** | idempotency keys, OTP challenges, drafts, BFF session records | allowed | allowed (retention job) | id, tenant_id, created_at, expires_at |
| **R — derived rollup** | `analytics.daily_*`, `analytics.tat_facts` | **never** (delete + insert by refresh) | by the owning module's system actor only | tenant_id, refresh_run_id, refreshed_at; natural composite PK with tenant_id leading; no audit trigger |
| **G — global reference** (no tenant data) | `catalog.g_units`, `micro.g_cs_ast_interpretations` | owner role only (migrations/seeds) | owner role only | id, created_at, is_active; **no tenant_id** |

"Correction" of a C or B row always means: end the old record's validity and create a new one (04 L5/L26 ख/ट): a new `result_versions` row, a new `report_versions` row, a credit note or a reversing ledger entry — never an in-place edit.

**The table class follows the write path, and the purge path follows the class (08 A17 P-18).**
- (a) Class C, B and A rows are never deleted by `lims_app`, and class A rows are never updated. A table whose rows `lims_app` updates (run state) or deletes on expiry is class E. A row removed from an M or C parent is deactivated (`is_active = false` for M, `removed_at`/`removed_by` for C draft lines), never deleted. Documented exception: C15 `reconciliation_runs` / `reconciliation_findings` stay class C (5-year financial evidence, REQ-SEC-054) although `lims_app` updates run state/resolution (08 A22.3).
- (b) Mandatory-column exceptions (C5 05-SCHEMA §1 precedent): a one-row-per-key table (settings, counter, sync or refresh state, per-export file) whose natural key is its PK may omit `id`. It may also omit `version`/`is_active` when users never edit it, and `expires_at` when it never expires or is deleted when processed. Each exception is listed in the chunk's 05-SCHEMA §1 paragraph 'Mandatory-column exceptions' with its reason and copied to `db/meta/tables.yaml`.
- (c) Purge path: see §5.11.

**Per-tenant singleton rows are created lazily (08 A17 P-22).** Module settings, sync cursors, counters and refresh-state rows are created by the owning module on first use in any path (API, consumer, cron) with `INSERT … ON CONFLICT (<natural key>) DO NOTHING` and the TRD defaults. A read that finds no row uses the defaults. There is no tenant-provisioning event or hook. A user-path INSERT policy on such a table is allowed only for the row kind that a user writes first, restricted to that kind.

### 5.3 Mandatory columns (DDL template)

```sql
CREATE TABLE lab.specimens (
  id              uuid        NOT NULL,                 -- UUIDv7 from app code (04 D9); no DEFAULT
  tenant_id       uuid        NOT NULL,                 -- no DEFAULT (REQ-SEC-027)
  centre_id       uuid        NOT NULL,                 -- present on every centre-scoped table (§5.8)
  -- domain columns …
  status          text        NOT NULL,
  version         integer     NOT NULL DEFAULT 1,       -- optimistic concurrency (If-Match)
  is_active       boolean     NOT NULL DEFAULT true,    -- IRD cl.6(घ)-style active flag where applicable (04 L26)
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid        NOT NULL,                 -- actor id (user / system / device); no FK (actors span types)
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid        NOT NULL,
  CONSTRAINT specimens__pk PRIMARY KEY (id),
  CONSTRAINT specimens__tenant_id_id__uq UNIQUE (tenant_id, id),           -- parent side of composite FKs (04 D8)
  CONSTRAINT specimens__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT specimens__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT specimens__order__fk  FOREIGN KEY (tenant_id, order_id)  REFERENCES frontdesk.orders (tenant_id, id),
  CONSTRAINT specimens__status__ck CHECK (status IN ('ordered','collected','in_transit','received','aliquoted',
             'in_process','resulted','verified','approved','reported','rejected','recollection_ordered','stored','discarded'))
);
CREATE INDEX specimens__tenant_id_status__p_idx ON lab.specimens (tenant_id, status, created_at)
  WHERE status IN ('received','in_process');                                -- REQ-ARCH-023 hot-set partial index
```

Rules:
- `tenant_id` is the leading column of every index and unique constraint on tenant tables **except the single-column `PRIMARY KEY (id)`** (UUIDv7, globally unique, 04 D9). Every tenant table also has `UNIQUE (tenant_id, id)` (§5.4). Other exceptions are listed in `db/meta/index-exceptions.yaml`. (08 A13 P-7, replacing the earlier rule text; REQ-SEC-023; 04 D16 isolatability. The listed exceptions are global uniques on a token hash or a one-tenant invariant, used only by inventoried DEFINER functions; 08 §4.7.)
- `updated_at`/`updated_by`/`version` are set by the repository on every UPDATE (the audit trigger records old/new — 04 D11). `version = version + 1` in the same statement; the `WHERE version = $expected` clause implements `If-Match`.
- `created_at` uses DB `now()` (transaction time, UTC storage). Business event times (collected_at, received_at, approved_at) are explicit columns set from the server clock (instrument time stored separately — 04 N12).
- Time-range partition readiness: results and audit tables carry their time column in every unique key that a future partition would need (04 D10; REQ-ARCH-022). No partitioning in v1.

### 5.4 Composite foreign keys

- Every FK between tenant tables is `(tenant_id, <x>_id) → parent (tenant_id, id)`; parent has `UNIQUE (tenant_id, id)` (04 D8; REQ-SEC-026).
- Cross-schema FKs only "downstream → upstream" along `core → catalog → frontdesk/billing → lab → instruments → reporting → analytics`; Wave-2/3 schemas may reference these, never the reverse (01 §5 R3).
- [CONV] **No schema may hold an FK into `billing`** (keeps billing relocatable to its own schema/DB if IRD requires — 04 D16, BLOCKED B17). Billing's own FKs outward (to `core`, `catalog`, `frontdesk`) are allowed and are rewritten by C0 if B17 forces a separate database.
- Global (G) tables are referenced by plain `code`/`id` FK without tenant_id.

### 5.5 Status values and coded sets (no Postgres ENUM types)

[CONV] `CREATE TYPE … AS ENUM` is banned (values cannot be removed; adding requires `ALTER TYPE`).

| Value kind | Representation | Examples |
|---|---|---|
| State-machine status owned by code | `text` + `CHECK (status IN (…))`; the list equals the state table in 03-IC §10 | `specimens.status`, `results.status`, `invoices.status` |
| Small closed technical flags | `text` + `CHECK` | `priority IN ('routine','urgent')`, `visit_type IN ('opd','ipd')` |
| Clinical / external vocabularies, tenant-configurable lists | **coded-set table** `cs_<name>` (tenant-extensible) or `g_cs_<name>` (global), columns `(code text, display text, system text, system_version text, sort_order int, is_active bool)`; tenant rows shadow global rows by code | rejection reasons (seed: haemolysed, clotted, QNS, mislabel/unlabeled, wrong container, delayed transport — 01 §2.1), comment short codes, units, specimen types, payment methods |
| AST interpretation | **global extensible coded set**, never a 3-value enum: CLSI `S, SDD, I, I^, R, NS` (colistin/polymyxin B: I/R only), EUCAST `S, I` ("susceptible, increased exposure"), `R`, ECOFF `WT, NWT`; every stored interpretation carries `(category_code, standard ∈ {CLSI, EUCAST, ECOFF}, standard_version)` plus raw value (zone mm / MIC) as received. Owner: C10 (`micro.g_cs_ast_interpretations`), not C3 (CR-C10-009). | 04 D14; CLSI M100 Ed36 current (04 L24) |
| Ordinal / semi-quantitative results | coded-set per test (`1+`, `2+`, …) referenced by the result row | 04 D14 |

Wire representation: status and coded values travel as their `code` string. Specs mark coded-set-backed fields as `type: string` with `x-coded-set: <name>` (not an `enum`), so additions are non-breaking.

### 5.6 Delete rules (summary)

- Clinical (C) and billing (B) records: **never hard-deleted**; no DELETE grant to `lims_app`; no DELETE policy. CI test asserts `has_table_privilege('lims_app', '<table>', 'DELETE') = false` for every C/B/A table.
- Master data (M): deactivate only. A master row referenced by any clinical/billing row MUST stay readable forever (reports must re-render — REQ-ARCH-036).
- Patient deletion/anonymisation requests: workflow per REQ-SEC-139 (retention floor UNVERIFIED — BLOCKED B15, default 5 years, per-tenant config). Implemented by C4 as a privileged, audited anonymisation, not DELETE.
- Ephemeral (E): DELETE by retention job only.
- C, B and A rows are never deleted by `lims_app`; a row removed from an M or C parent is deactivated, never deleted (08 A17 P-18(a), §5.2).

### 5.7 Immutability triggers

C0 ships one generic trigger function; tables of class C/B attach it with the list of columns that MAY change.

```sql
CREATE FUNCTION app.enforce_mutable_columns() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  -- TG_ARGV = names of columns allowed to change; everything else must be identical
  IF (to_jsonb(OLD) - TG_ARGV::text[]) IS DISTINCT FROM (to_jsonb(NEW) - TG_ARGV::text[]) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row',
      DETAIL = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER invoices__mutable_columns BEFORE UPDATE ON billing.invoices
  FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns(
    'status','cancelled_at','cancelled_by','cancel_reason_code','cancel_reason_text','credit_note_id',
    'print_count','last_printed_at','cbms_state','cbms_last_attempt_at','cbms_synced_at',
    'updated_at','updated_by','version');
```

`app.tg_row_audit()` takes an optional excluded-column list as trigger argument; columns listed are never copied into `audit_log` (e.g. `payments.merchant_accounts.secret_ciphertext/secret_nonce/secret_auth_tag`, CR-C15-013).

- The API maps SQLSTATE `P0001` + message `immutable_row` to `409 common.immutable_record` (billing: `billing.invoice_immutable`).
- Allowed state transitions on those lifecycle columns are additionally checked by a per-table `CHECK`/trigger written from the state table in 03-IC §10 (e.g. `cancelled → issued` impossible).
- Results: after `status = 'approved'`, the `results` row's value columns are frozen; amendments write `result_versions` (03-IC §10.2).

### 5.8 RLS — helpers, naming, template

Helpers (C0, schema `app`, not exposed; DEFINER only where listed, with `SET search_path = ''` and schema-qualified references — 04 D7; REQ-SEC-019/020/021):

```sql
CREATE FUNCTION app.current_claims() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
CREATE FUNCTION app.current_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(app.current_claims() ->> 'tenant_id', '')::uuid          -- NULL → every policy evaluates false
$$;
CREATE FUNCTION app.current_actor_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(app.current_claims() ->> 'sub', '')::uuid
$$;
CREATE FUNCTION app.current_actor_type() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT app.current_claims() ->> 'actor_type'                            -- user | system | device | portal | patient | partner
$$;
-- Centre scope: second predicate via membership table (04 D2; REQ-SEC-017).
-- Fail-closed: no active membership → has_all_centres() = false and current_centre_ids() = '{}'.
CREATE FUNCTION app.has_all_centres() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE app.current_actor_type()
    WHEN 'system' THEN app.current_tenant_id() IS NOT NULL
    WHEN 'user'   THEN coalesce((SELECT m.all_centres FROM core.memberships m
                                 WHERE m.tenant_id = app.current_tenant_id()
                                   AND m.id = nullif(app.current_claims() ->> 'membership_id', '')::uuid
                                   AND m.is_active), false)
    ELSE false                                                  -- device, portal, patient, partner (08 R3)
  END
$$;
CREATE FUNCTION app.current_centre_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE app.current_actor_type()
    WHEN 'device' THEN coalesce(ARRAY[nullif(app.current_claims() ->> 'centre_id', '')::uuid], '{}')
    ELSE coalesce((SELECT array_agg(mc.centre_id)
                   FROM core.memberships m
                   JOIN core.membership_centres mc ON mc.tenant_id = m.tenant_id AND mc.membership_id = m.id
                   WHERE m.tenant_id = app.current_tenant_id()
                     AND m.id = nullif(app.current_claims() ->> 'membership_id', '')::uuid
                     AND m.is_active), '{}')
  END
$$;
```

```sql
CREATE FUNCTION app.is_staff_or_system() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(app.current_actor_type() IN ('user','system','device'), false)
$$;   -- CR-C13-011: added to every __tenant policy of tables not meant for partner/portal/patient actors
```

Policy naming: `<table>__<command>__<scope>`, scope ∈ `tenant`, `tenant_centre`, `owner_only` (owner-role functions bound to a transaction-local GUC), `lookup` (pre-tenant lookup role bound to the presented token hash), `platform` (`app.is_platform_actor()`; post-login platform writes use `USING/WITH CHECK (tenant_id IS NULL AND (SELECT app.is_platform_actor()))` — 08 A28.1), `partner`, `portal`, `patient` (actor-specific reads; each actor policy binds `actor_type = <type>` — 08 A29.2; `portal` scope accepted from C0 by 08 A29.2). Chunk-qualified scope names (for example C16 `__patient_*`, `__preauth_*`, `__system`) are permitted when a table needs several policies of the same actor and command; each such name is documented in the chunk's 05-SCHEMA (lead note on the C16 hand-off, final sweep 2026-11-06).

Policy template for a centre-scoped tenant table:

```sql
ALTER TABLE lab.specimens ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab.specimens FORCE ROW LEVEL SECURITY;          -- 04 D4; FORCE is not sufficient alone (04 D5)

CREATE POLICY specimens__select__tenant_centre ON lab.specimens
  FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id())
         AND (SELECT app.is_staff_or_system())                -- P-16 staff-actor guard (08 A17, A26.2)
         AND ((SELECT app.has_all_centres())
              OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));

CREATE POLICY specimens__insert__tenant_centre ON lab.specimens
  FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id())
              AND (SELECT app.is_staff_or_system())
              AND ((SELECT app.has_all_centres())
                   OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));

CREATE POLICY specimens__update__tenant_centre ON lab.specimens
  FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
              AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
              AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
-- no DELETE policy (class C) → default deny (REQ-SEC-016)

-- __tenant variant (tenant-only table, no centre_id), e.g.:
CREATE POLICY patients__select__tenant ON frontdesk.patients
  FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));   -- P-16 (08 A26.2)
```

Tenant-only tables (no `centre_id`) use the `__tenant` variant (drop the centre clause, keep the `(SELECT app.is_staff_or_system())` guard — 08 A17 P-16, A26.2). Rules:
- Every policy is per command (REQ-SEC-014), names a role (REQ-SEC-015), never `USING (true)` (04 D4; REQ-SEC-016), wraps helpers in `(SELECT …)` for per-statement caching (REQ-SEC-022).
- **Array-returning helpers are cast (08 A16.1).** On PostgreSQL 16, `centre_id = ANY ((SELECT …))` over `app.current_centre_ids()` without a cast is parsed as a subquery comparison and fails with `operator does not exist: uuid = uuid[]`. Every policy uses **`centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])`** (the `(SELECT …)` wrapper keeps the per-statement initplan; the cast makes it an array). The same form applies to every other `uuid[]` helper, e.g. `patient_id = ANY ((SELECT app.engagement_patient_ids())::uuid[])` (CR-C16-008). The final sweep greps for the uncast form and fails on any hit.
- **Binding (03-IC §5.2 X9):** module-table policies target the group role `lims_app` (members `lims_api`, `lims_worker`, §5.9). This is "`TO authenticated` or narrower" as REQ-SEC-015 allows, applied to 04 D4. `authenticated` is used only on objects Supabase services read with end-user JWTs (`storage.objects`, `realtime.messages`, `api.*` views); no module table has a policy `TO authenticated`, `anon` or `public`.
- Which tables are centre-scoped is declared per table in the owner's `05-SCHEMA.md` (column `centre_id NOT NULL` + `__tenant_centre` policies). Default for patient-bearing tables at registration/collection: centre-scoped; lab-processing tables at hub labs: chunk decides with C2's membership model (hub staff get `all_centres`).
- Application queries ALSO filter `tenant_id = $tenant` explicitly (REQ-SEC-024).
- **The staff-actor guard is in the DDL, not only in prose (08 A17 P-16; replaces the CR-C13-011 bullet).** Every `__tenant` policy's USING and WITH CHECK contain `(SELECT app.is_staff_or_system())`. The only exception is a table marked `shared_with: [partner|portal|patient]` in `db/meta/tables.yaml`, which also has the matching actor-specific policy. A chunk's 05-SCHEMA puts the guard in the predicate it actually transcribes (the `pred_t` variable or the policy SQL template), not only in prose. C0-0B `check-registry` fails any `__tenant` policy without it. The generated probe adds a test that partner, portal and patient claims of the same tenant read 0 rows.
- Branch scope is application-level only (IdentityPort `branchIds`); no policy uses branches; P2/P3 data is never protected by branch scope alone (08 R3).
- Storage: private bucket `reports`, path `{tenant_id}/{yyyy}/{mm}/{report_id}-v{n}.pdf`, `storage.objects` policies on the first path segment (04 D15; REQ-SEC-034). Other buckets follow `{tenant_id}/…` as the first segment and are named `<owner-module>-<purpose>` (08 R26); exception: platform-level IRD documents in `identity-assets` under `platform/…`, readable only in platform context.
- Realtime (Flutter only): private channels, topic prefix `tenant:{tenant_id}:…`, `realtime.messages` policies per tenant (04 S5; REQ-SEC-036). D3: whether self-hosted Storage/Realtime populate `request.jwt.claims` identically is **UNVERIFIED** — the cross-tenant probe suite must prove it before either is used for PHI.
- **DEFINERs under FORCE RLS (08 A10.5).** FORCE RLS applies to `lims_owner`, so any SECURITY DEFINER that reads, updates or deletes a FORCE-RLS table has a matching `__<cmd>__owner_only` policy `TO` the function owner with the narrowest USING clause the function needs. CI (C0-0B): for each function in `db/meta/definer-inventory.yaml`, its contract test runs with FORCE RLS on and asserts non-empty results where expected; schema tests never disable RLS on stand-in tables.
- **Pre-tenant and maintenance GUCs (08 A12.1, A12.2; A13 D-30).** A pre-tenant DEFINER sets transaction-local GUCs **inside the function body** with `set_config(name, value, true)` before each read; its owner policies match on them. Names are `app.pre_*` (text values): `app.pre_session_token_sha256` (hex of the presented 32-byte hash), `app.pre_gotrue_session_id`, `app.pre_user_id` (GoTrue `sub`), `app.pre_tenant_id` (set only after the function has chosen the membership, A8.1), `app.pre_portal_token_sha256` (policies `TO lims_reporting_lookup`). Cross-tenant maintenance DEFINERs set `set_config('app.maintenance', '<function name>', true)`; their owner policies are `USING (current_setting('app.maintenance', true) = '<function name>' AND <narrow predicate>)` (no ad-hoc GUC names). Each function resets its GUCs to `''` before returning. Callers (`lims_app`) cannot benefit from setting these GUCs because the policies are `TO` the owner role only. Tests (A12.7): for every such function a FORCE-RLS contract test proves (a) it returns the expected row, (b) a `lims_app` session that sets the same GUC directly sees nothing, (c) GUCs are empty after return. Inventory: 03-IC §13.3.
- Global (G) tables: no tenant data → no RLS policies; SELECT granted to `lims_app`; no write grants; listed in `db/tests/rls_exempt.txt` with a reason per table; CI fails on any unlisted table without RLS (REQ-SEC-011).

### 5.9 Database roles (04 D5; REQ-SEC-012/029/030/039/131)

| Role | LOGIN | BYPASSRLS | Owns tables | Purpose |
|---|---|---|---|---|
| `lims_owner` | NO | NO | **all** tenant tables, views, `app` functions | object owner; FORCE RLS applies to it |
| `lims_migrator` | YES | NO | — | runs migrations; `SET ROLE lims_owner` first statement of every migration session |
| `lims_app` | NO | NO | — | group role holding DML grants + policies' `TO` target |
| `lims_api` | YES | NO | — | API pool login (through PgBouncer); member of `lims_app` |
| `lims_worker` | YES | NO | — | Graphile Worker login (direct connection — 04 S8); member of `lims_app`; queue privileges per 04 D6 (UNVERIFIED — C0 tests a pre-installed schema without DDL rights first) |
| `lims_analytics` | NO (reserved) | NO | — | future BI read path: SELECT on `v_pub_*` only (REQ-SEC-131; 01 §1.6 KEEP-LATER) |
| `lims_queue` | NO | NO | `graphile_worker` schema, `app.enqueue_job`, `app.queue_depth` | queue owner; member: `lims_worker` (CR-C0-007) |
| `lims_monitor` | YES | NO | — | metrics exporter; `pg_monitor` (CR-C1-002) |
| `lims_replicator` | YES | NO | — | standby streaming; REPLICATION (CR-C1-002) |
| `lims_audit_ship` | YES | NO | — | REPLICATION; logical decoding of publication `lims_audit_ship`, insert-only on `audit.audit_log`, `audit.access_log`, `billing.activity_log` (CR-C1-002) |
| `lims_reporting_lookup` | NO | NO | C6 lookup DEFINER functions | owns C6 pre-tenant token lookup DEFINERs (CR-C6-002) |
| `postgres`, `supabase_admin`, `service_role`, `supabase_etl_admin`, `supabase_read_only_user` | — | YES (per 04 D5) | — | **never used by any request path or job**; CI asserts no app code/config references them |

CI assertion (C0 `db/tests`): no `lims_%` role has `rolsuper` or `rolbypassrls`; `rolreplication` only for `lims_replicator` and `lims_audit_ship`; every tenant table's owner is `lims_owner`. (CR-C1-002, CR-C0-007)

Grants: `lims_app` gets per-table `SELECT/INSERT/UPDATE` as the table class allows (§5.2), `SELECT` on `v_pub_*`, `EXECUTE` on `app.*` helpers it needs. Nothing is granted to `anon`.

**The chunk that requests a SECURITY DEFINER writes its owner policies (08 A19 P-41).** Every DEFINER requested by a chunk is specified in that chunk's 05-SCHEMA with: (a) the full SQL body; (b) every `__<cmd>__owner_only` policy `TO <function owner>` that it needs, with the narrowest USING (08 A10.5); (c) how the policies are gated: tenant-claim functions on `app.current_tenant_id()` plus the claim columns they need; pre-tenant functions on an `app.pre_*` GUC set inside the body (08 A12.1); maintenance functions on `app.maintenance = '<function name>'` (08 A12.2); (d) its 08 §4.7 / 03-IC §13.3 inventory row; (e) the A12.7 FORCE-RLS tests. Wording such as 'C0 assigns the mechanism' or 'C0 decides' is not allowed. Module-specific GUC names (`partners.redaction`, `app.payments_lookup_token`, `app.purge_tenant`, `app.retention_purge`) are replaced by the A12 names (and all pre-auth/lookup DEFINERs, incl. C6 `app.lookup_*`, use `app.pre_*` names and reset before return — 08 A21.4). A per-tenant class-E retention delete is **not** a DEFINER: it follows P-18(c) (§5.11), with a system-actor `__delete__tenant` policy in a `per_tenant` task. C0-0B transcribes the SQL.

### 5.10 Transaction-local request context (04 S9; REQ-ARCH-016)

Every DB transaction opened by API or worker code starts with exactly this (implemented once in `services/api/src/core/db` and `services/worker/src/core/db`):

```sql
BEGIN;
SELECT set_config('request.jwt.claims', $1::text, true);   -- verified claims JSON (§6), transaction-local
SELECT set_config('app.request_id',     $2::text, true);   -- UUIDv7 request/job id
SELECT set_config('app.client_ip',      $3::text, true);   -- for audit_log (04 D11); '' for jobs
SELECT set_config('app.user_agent',     $4::text, true);
-- … domain statements …
COMMIT;
```

- Bare `SET`/`SET SESSION` is banned (lint + code review) because PgBouncer transaction pooling would leak it to the next client (04 S8/S9).
- A query run outside `ctx.db.tx()` is impossible through the core DB API (the pool is not exported to modules).
- Audit triggers read `app.request_id`, `app.client_ip`, `app.user_agent` and the claims for actor/centre (04 D11; REQ-ARCH-025).

### 5.11 Retention and purge

- Defaults (04 I8): reports 5 years online then archive; audit ≥5 years; raw analyser archive ≥1 year server-side; legal periods UNVERIFIED (BLOCKED B15) → per-tenant config with these floors.
- [CONV] Platform plumbing: `core.event_log` 90 days; `<m>.event_inbox` 90 days; `core.idempotency_keys` 7 days; OTP challenges deleted at expiry + 24 h; `core.dead_letters` until resolved + 90 days.
- Purge functions are `lims_owner`-owned, reviewed SQL functions invoked by a cron task (REQ-ARCH-042); append-only grants to `lims_app` never include DELETE.
- **Purge path by class (08 A17 P-18(c)).** A class E retention delete runs in the owning module's `per_tenant` task (P-6) as its system actor, under `<t>__delete__tenant` (or `__tenant_centre`) `FOR DELETE TO lims_app USING (<tenant predicate> AND (SELECT app.current_actor_type()) = 'system' AND expires_at < now())`. DELETE is granted to `lims_app` on E tables only. A class A purge, or any cross-tenant purge, is a `lims_owner` DEFINER with `__select__owner_only`/`__delete__owner_only` policies bound to `app.maintenance = '<function>'` (08 A10.5, A12.2) and an 08 §4.7 inventory row.

### 5.12 Migrations

- Location `db/migrations/` (01 §3; see §2.1 path note re 04 S12). Forward-only plain SQL (04 S12). Runner Atlas or sqitch [C0 decides].
- File name [CONV]: `<YYYYMMDDHHMMSS>_<schema>__<verb>_<object>.sql` (UTC timestamp), e.g. `20261105041500_lab__create_specimens.sql`. One logical change per file; RLS policies for a new table ship **in the same migration** as the table.
- `db/policies/<schema>.sql` holds the canonical current policy set for review; CI diffs `pg_policies` of a freshly migrated DB against it.
- Zero-downtime rules (REQ-ARCH-027): additive first (add nullable → backfill → constrain), `CREATE INDEX CONCURRENTLY` (in its own non-transactional migration), `lock_timeout` set by the runner, no long `ACCESS EXCLUSIVE` locks in peak hours, never rename/drop a column in the same release that stops using it.
- Lint gate: **BLOCKED B10** (04 S13). Until decided, every migration PR carries the checklist above ticked by the C0 reviewer; when B10 is decided the chosen linter becomes a required CI job.
- Every new policy has a negative test in `db/tests/` written in the same PR (REQ-SEC-042) — pgTAP if present in the pinned image (presence UNVERIFIED; C0 checks), else plain SQL assertions run by the test harness.

### 5.13 Published views (`v_pub_*`)

```sql
CREATE VIEW billing.v_pub_invoice_daily WITH (security_invoker = true) AS   -- REQ-SEC-031: invoker views only
SELECT i.tenant_id, i.branch_id, i.centre_id,
       (i.issued_at AT TIME ZONE 'Asia/Kathmandu')::date AS business_date,
       count(*) FILTER (WHERE i.status = 'issued')  AS invoices_issued,
       sum(i.total_paisa) FILTER (WHERE i.status = 'issued') AS gross_paisa
FROM billing.invoices i
GROUP BY 1,2,3,4;
GRANT SELECT ON billing.v_pub_invoice_daily TO lims_app;
```

- Name `<owner_schema>.v_pub_<name>`; owner module specifies it in `05-SCHEMA.md`; C0 writes the DDL; column list is a contract (03-IC §6) — removing/renaming a column is breaking (CR).
- `security_invoker = true` so the underlying table RLS (tenant + centre) applies to the reader.
- No PHI beyond what the consumer's purpose needs; prefer ids and aggregates (REQ-SEC-081).
- Cross-module SQL from module code may reference only `v_pub_*` of other schemas (CI grep check on `repository/` folders: any `<other_schema>.` reference not matching `v_pub_` fails, except `core.*` reads through `ctx.core`).

---

## 6. Tenant context — end to end

Tenant identity **always** comes from a credential the server verified. It **never** comes from a body field, header, query param or path segment (04 D2; REQ-SEC-013/067).

```
STAFF WEB
Browser ──cookie (HttpOnly,Secure,SameSite=Lax; opaque session id)──▶ Next.js BFF (apps/web, server-only)
  BFF: look up server-side session → holds GoTrue access JWT (≤1 h, 04 A5) + refresh token (rotation, 04 A6)
       enforce idle 15–30 min / absolute ≤12 h (04 A8) → refresh if needed
  BFF ──Authorization: Bearer <access JWT>, X-Request-Id, traceparent──▶ Fastify API

API (services/api/src/core/auth)
  1. Verify JWT signature with the pinned algorithm; reject `none`/substitution; check exp/aud/iss; no expiry grace (04 A7; REQ-SEC-066)
  2. Resolve claims through the identity `claimsResolver` (session row → tenant, membership, actor_type, state; REQ-SEC-067)
  3. For privileged permissions (§10.1 `privileged: true`) re-validate membership + role against core.memberships (REQ-SEC-067) and MFA level (04 A4)
  4. Build RequestContext { tenantId, actor, requestId, claimsJson } — immutable for the request
  5. Every ctx.db.tx(): set_config('request.jwt.claims', claimsJson, true) … (§5.10) → RLS predicates (§5.8)

WORKER (services/worker/src/core)
  Job payload carries tenant_id (+ event envelope) written by an API transaction that itself ran under RLS.
  Worker builds claims { sub: <system actor id of the module>, tenant_id: payload.tenant_id, actor_type: 'system' }
  and runs every job transaction through the same set_config path. A job without tenant_id is rejected
  (except cron tasks marked `tenantScope: 'platform'`: C0 core tasks and module tasks that only call an inventoried DEFINER
  without tenant claims — 08 A13 P-6).
  Module cron tasks use `tenantScope: 'per_tenant'` (08 A13 P-6): at each schedule tick the worker core enqueues one job per tenant
  with core.tenants.status IN ('active','suspended') [CONV], payload {tenant_id},
  job_key = '<identifier>:<tenant_id>:<tick, ISO minute>' [CONV]; the job runs under that tenant's claims for the module's
  system actor. Tenant list: DEFINER app.cron_tenant_ids() RETURNS SETOF uuid (owner lims_owner, EXECUTE lims_worker,
  SET search_path = ''; core.tenants__select__owner_only per 08 A10.5, app.maintenance per A12.2; 03-IC §13.3).

DEVICE (bridge agent → ingest)
  Device token (≥256-bit, SHA-256 stored — 04 A13) → API resolves device → { tenant_id, centre_id, device_id }
  → claims { sub: device_id, tenant_id, centre_id, actor_type: 'device' } → ingest-only permissions (REQ-SEC-072)

PORTAL (patient web, C6) / PATIENT APP (C16) / PARTNER (C13)
  Portal: report-link token + OTP (04 A9/A10) → server-issued portal session bound to the link's tenant/report
          → claims { sub: link_id, tenant_id, actor_type: 'portal' } and only portal permissions
  Patient app / partner users / phlebotomy app: GoTrue users with sessions of kind `patient` / `partner` / `staff_mobile`; the app or partner BFF holds an opaque LIMS session token, never a GoTrue refresh token (08 R10).
```

**Claims resolution (binding, 08 R10).** For every GoTrue access JWT the API core verifies the token (step 1) and then calls the identity module's `claimsResolver`, the only source of claims: it maps the JWT's `session_id` + `sub` to the `identity.sessions` row (`app.identity_resolve_session`) and builds the claims JSON. Claims inside the JWT other than `sub`, `session_id`, `aal`, `exp`, `iat` are ignored. The GoTrue custom access-token hook is not used. Session kinds: `tenant_staff`, `platform`, `partner`, `patient`, `staff_mobile` (lifetimes and claim shapes: 08 R10 table). Kind binding comes from the calling BFF's key (`X-Lims-Bff-Key`: staff_web, partner) or from the endpoint family (`/v1/identity/auth/patient/*`, `/v1/identity/mobile/*`), never from a client header. Non-GoTrue credentials (device, queue display, portal, patient pre-auth, payment callback) are resolved by the single module allowed per scheme (08 R10 table). SP-1 proves only that the pinned GoTrue issues `session_id`/`aal` and which `alg`; a missing `session_id` is a blocker for C2, not a reason to fall back to unbound claims.

**BFF key secrets are named and listed (08 A19 P-45).** Each BFF holds its own `X-Lims-Bff-Key` as a file-mounted secret from the C1 secret store: `LIMS_WEB_BFF_KEY_FILE` (kind `staff_web`), `LIMS_PARTNER_BFF_KEY_FILE` (`partner`), `LIMS_PORTAL_BFF_KEY_FILE` (`portal`) [CONV]. The key lives in server memory only and is never logged or sent to a browser. Rotation follows the C1 runbook, with the core accepting old and new keys for one overlap window. C0 `LIMS_CORE_BFF_KEY_FILES` lists all three kinds.

**Pre-auth and session operations (08 A25 D-212).** Module `identity` operations tagged `x-context: identity_auth` and listed in core config (`loginStaff`, `loginPartner`, `openMobileSession`, `refreshMobileSession`, `logoutMobileSession`, `confirmEmailToken`, `requestPasswordRecovery`, `verifyMfaChallenge`, `startMfaEnrolment`, `completeMfaEnrolment`, `resolveSession`, `logoutSession`, `setPasswordFromSetup`, `resolvePatientSession`, `logoutPatientSession`) run in `ctx.db.identityAuthTx(fn)`: claims `{sub: <identity system actor>, actor_type: 'system'}` with **no** `tenant_id`, so only the inventoried DEFINERs and the tenant-less `auth_events` insert work. `tx.bindTenant(tenantId)` may be called **once**, after a DEFINER (`identity_login_context` / `identity_session_by_token` / `identity_resolve_session`) has chosen the membership; it rewrites the transaction-local claims to `{…, tenant_id}`. The C0 authz guard (stage 9) exempts `x-context: identity_auth`; every listed operation carries `x-public` with a justification. Bound: only the listed operationIds, only the identity system actor, at most one tenant per transaction, and an access-log or auth event on every success path (03-IC §13.5).

Multi-tenant staff accounts: [CONV] one staff user = memberships in exactly one tenant. The LIMS provider platform staff use a separate identity (REQ-SEC-063) and act inside a tenant only through an audited "support session" issued by C2's platform console (claims carry `actor_type: 'user'`, `support_session_id`).

---

## 7. Events

### 7.1 Envelope and naming

- Name: `<producer_module>.<aggregate>.<past_tense_verb>.v<N>`; facts, past tense (01 §5 R4). The full versioned name is the event type and the schema file stem: `contracts/events/lab.result.approved.v1.schema.json`.
- Envelope fields (01 §5 R4 requires the first five; the rest are [CONV] and defined in 03-IC §2):

| Field | Type | Rule |
|---|---|---|
| `event_id` | UUIDv7 | unique; consumers dedupe on it (01 R4) |
| `tenant_id` | UUID | from the producing transaction's context; never from client input |
| `occurred_at` | ISO-8601 UTC | time of the domain change (transaction time) |
| `actor` | object `{type, id, membership_id?}` | who caused it; `type ∈ user|system|device|portal|patient|partner` |
| `idempotency_key` | string | producer-defined natural key per event type (03-IC lists each) so a retried producer transaction cannot publish two logically identical facts |
| `event_type` | string | e.g. `lab.result.approved.v1` |
| `producer` | string | module name |
| `aggregate` | `{type, id, seq}` | `seq` = the aggregate row's `version` after the change; for staleness checks |
| `request_id` | UUIDv7 | correlation with logs |
| `causation_event_id` | UUIDv7 | present when emitted by a consumer reacting to another event |
| `payload` | object | per-event schema; `additionalProperties: false` |

- Payloads carry **ids, codes and states — not names, phones or result values** unless a consumer cannot work without them (03-IC states the PHI class per event). Consumers fetch details through ports.

### 7.2 Versioning

- Additive payload changes (new optional field) keep `.v1`; consumers MUST ignore unknown fields (envelope `additionalProperties` is false, payload schemas are validated strictly by the **producer** and leniently by **consumers**: consumers validate known fields only).
- Breaking change (remove/rename/retype a field, change trigger semantics) → new `.v2` schema; producer emits **both** `.v1` and `.v2` until every consumer listed in 01 §5.1 has moved (tracked in the CR); then `.v1` is retired by CR.
- An event enum may gain values in `.v1` only when its schema marks it `x-extensible: true`; consumers handle unknown values as documented for that event (today: `catalog.changed.v1.entity_type` → invalidate all; `reporting.report.released.v1.report_kind` → treat as `amended` for display) (08 R13). Since 08 A13 also: `reporting.delivery.status_changed.v1.recipient_kind` → C8 counts as `other` (D-3); `catalog.changed.v1.entity_type` gains `catalog_import` (D-21).
- A consumer that stores a field marked `x-extensible: true` must not constrain it with a closed `CHECK … IN (…)`. Use `CHECK (char_length(<col>) BETWEEN 1 AND 32)`, and state in the consumer TRD how an unknown value is treated. (08 A13 P-4)
- A payload field that is legitimately absent in some cases is not listed in top-level `required`. The condition is expressed with JSON Schema 2020-12 `if`/`then`/`else`, or, when no payload field can express it, stated in the event's Notes. Consumers must tolerate the absence. This counts as an additive `.v1` change only if every listed consumer confirms it tolerates the absence; the apply phase records that confirmation. (08 A13 P-5; applied: 03-IC §3.4 D-1, §3.9 D-2)

### 7.3 Publishing = transactional outbox (Graphile Worker)

```ts
// inside a service, within ctx.db.tx(async (tx) => { ... })
await repo.markApproved(tx, result);                         // domain write
await events.publish(tx, 'lab.result.approved.v1', {         // same transaction (04 S10; REQ-ARCH-038)
  aggregate: { type: 'result', id: result.id, seq: result.version },
  idempotencyKey: `${result.id}:approved:${result.currentVersionNo}`,   // per 03-IC §3.10
  payload: { result_id, result_version_no, order_id, order_item_id, test_id, analyte_id,
             department_id, approved_at, approved_by_membership_id },
});
```

What `events.publish` (C0 core) does, in the caller's transaction:
1. Validates the payload against `contracts/events/<type>.schema.json` (ajv; fail = throw, transaction rolls back).
2. `INSERT INTO core.event_log (tenant_id, event_id, event_type, idempotency_key, envelope) … ON CONFLICT (tenant_id, event_type, idempotency_key) DO NOTHING` — a duplicate logical fact is silently not re-published.
3. Enqueues one fan-out job via the inventoried DEFINER wrapper `app.enqueue_job(identifier => 'core.event_fanout', payload => {event_id, tenant_id}, job_key => event_id)` which calls `graphile_worker.add_job` (04 D7, S10). The exact `add_job` parameter names are taken from Graphile Worker 0.18.0 docs by C0 (verify in C0's first task).

Rule: **no external side-effect (SMS/WhatsApp/email/CBMS/gateway/webhook) inside a request handler** — the handler commits the domain change and enqueues; a worker task performs the side effect with retries and an idempotency key (REQ-ARCH-038/039; 03 §4.2).

### 7.4 Fan-out and consumption

- `core.event_fanout` (worker core) reads the event, looks up subscriptions collected from every `services/worker/src/jobs/*/index.ts` manifest, and enqueues one task per subscriber: identifier `evt.<consumer_module>.<event_type>`, `job_key = <event_id>:<consumer_module>`.
- CI check: every subscription in a worker manifest matches a consumer listed for that event in 03-IC §3 (= 01 §5.1 plus the accepted additions A2–A5, A8 logged in 03-IC §5.1, or a later approved CR); every listed consumer has a subscription once its chunk merges.
- **Delivery guarantee: at-least-once, unordered.** Consumers MUST:
  1. Open a transaction with the event's tenant context (§6 worker path).
  2. `INSERT INTO <consumer_schema>.event_inbox (tenant_id, event_id, event_type, received_at) VALUES (…) ON CONFLICT (tenant_id, event_id) DO NOTHING RETURNING event_id` — no row returned → already processed → commit and return success.
  3. For state-carrying events (`*.status_changed.*`), compare `aggregate.seq` with the last seq applied for that aggregate (stored in the consumer's read model); ignore stale.
  4. Do the work in the same transaction; enqueue follow-up tasks for any external side effect.
  5. Commit. A thrown error rolls back the inbox insert too, so the retry re-processes.
- `job_key` prevents duplicate *queued* jobs only; durable dedupe is the inbox table (completed Graphile Worker jobs are removed from the queue — C0 confirms this behaviour for 0.18.0).

### 7.5 Retry, backoff, dead letters

| Task class | `max_attempts` [CONV] | Backoff |
|---|---|---|
| Event consumers (`evt.*`) | 10 | Graphile Worker's built-in exponential backoff (not overridden) |
| Outbound messaging (SMS/WhatsApp/email via NotificationPort) | 8 | built-in; plus provider-specific rules in C6 TRD; SMS fallback rule per REQ-ARCH-085 |
| Outbound webhooks (C13, later) | per schedule 1 m → 5 m → 30 m → 2 h → 6 h, dead-letter after ~24 h, per-endpoint circuit breaker (REQ-ARCH-041; 03 §4.2) | explicit `run_at` rescheduling |
| CBMS sync (C4) | until success; failures beyond 10 attempts raise an alert but the invoice stays in the sync queue (offline tolerance — 01 §4.1) | built-in, capped by C4 TRD |
| PDF render (C6) | 5 | built-in |

Dead letters: when a task fails its final attempt, the worker core writes `core.dead_letters (tenant_id, task_identifier, job_payload, last_error_code, last_error_message_redacted, attempts, first_failed_at, dead_at, state ∈ open|replayed|discarded, resolved_by, resolved_at)`, increments `lims_core_dead_letters_total{task}` and alerts (REQ-ARCH-039). Replay/discard is a platform-admin action in C2's console (audited). Error messages are redacted of PHI before storage (§9.3).

---

## 8. Ports

### 8.1 Declaring a port (C0)

```ts
// contracts/ports/LabPort.ts
import type { RequestContext, Uuid, IsoUtc } from './common';
export const LAB_PORT_VERSION = 1 as const;
/** Owner: C5 (lab). Consumers: C6, C7, C9, C10, C11, C14 (01 §5.1). */
export interface LabPortV1 {
  /** … semantics, invariants, errors (codes from contracts/errors.yaml) … */
  getOrderResults(ctx: RequestContext, input: GetOrderResultsInput): Promise<OrderResults>;
  // …
}
export type LabPort = LabPortV1;
```

Rules:
- First parameter is always `ctx: RequestContext` (tenant, actor, request id, **the caller's transaction** `ctx.tx`). Port implementations MUST run inside the caller's transaction and MUST NOT open their own (so a cross-module write is atomic with the caller's write) [CONV].
- Inputs are single objects (named fields), outputs are plain serialisable objects (no class instances, no `Date`). **No exceptions** — `SmartReportPort.buildSummary` and `QualityPort.qcStatusFor` also take one input object (binding X11; names unchanged).
- Errors: implementations throw `LimsError` from `@lims/shared-ts/errors` whose `code` is listed in the method's JSDoc `@throws` and exists in `errors.yaml`. No other exception may escape (unexpected → `common.internal`).
- Ports never take a `tenantId` argument — tenant is `ctx.tenantId` only (REQ-SEC-020 analogue).
- A breaking change creates `LabPortV2` alongside V1; owner implements both until consumers move (01 §5 R5).
- **A worker job that catches a port business error and commits uses a savepoint (08 A19 P-44).** If a job or handler catches a `LimsError` from a port and then commits, the port call runs inside `ctx.db.tx(…)` (C0 `SAVEPOINT`/`ROLLBACK TO`, C0 TRD §6). The catch block runs after the rollback to the savepoint, so nothing the port wrote before the error is committed. Each such path has a test: the fake writes a marker row, then fails (`failNext`), and the marker is absent after commit.
- **Staff names and staff pickers come from `ctx.core` (08 A17 P-17).** A response field that shows another staff member's name (`*_display`, `*_display_name`), and any staff picker, uses `ctx.core.memberships.list` (batched by `membershipIds`, or filtered by centre, role or permission; signature in 08 A17 D-47 / 03-IC §13.5) and `ctx.core.user` for user ids such as `created_by`. Results are memoised per request. `IdentityPort.getActor` returns only the caller. `IdentityPort.getSignatories` is reserved for report signatures (system actor holding `identity.signatory.read`). Modules never read `core.memberships` directly.

### 8.2 Registering

- Owner module exports `ports: { LabPort: impl }` from its manifest (§2.2). The core port registry (`services/api/src/core/ports`) resolves `ctx.ports.<Name>`:
  - real implementation if the owning module is present and not listed in `LIMS_CORE_FAKE_PORTS`;
  - otherwise the fake from `@lims/fakes` (01 §5 R5).
- `NODE_ENV=production` (and staging) boot **fails** if any port resolves to a fake. The only exception is a **phase stub** for a port listed in `services/api/src/core/ports/phase-stubs.ts` (08 R9: QualityPort, SmartReportPort, PaymentProviderPort, EngagementPort); stubs only deny or disable, are counted by `lims_core_phase_stub_ports_active`, and CI fails when a listed port's owner module exists.
- **Replacing a phase stub (08 A17 P-20).** The first PR that creates `services/api/src/modules/<owner>/` removes the port from `phase-stubs.ts` (paired C0-0D PR; AC-0D-6.3 unchanged). In the same PR the module registers its own port implementation, which returns exactly the stub results for every method not yet built and passes the `phase1Stub` contract subset. Each later task replaces one method and adds that method's full contract cases. No C0 manifest flag is added.
- **Binding (03-IC §5.2 X7):** the worker core (`services/worker/src/core/ports`) builds the **same** registry from the same module manifests, so worker jobs and event consumers use `ctx.ports` exactly as API handlers do. Port implementations exist once, in `services/api/src/modules/<m>/ports/`; the worker imports them through the owning module's manifest (same chunk), never by copying code. Both runtimes apply the fake/real resolution and the production "no fakes" boot check below.

### 8.3 Fakes (C0, `packages/fakes/<PortName>.fake.ts`)

Every fake MUST support:
- **Deterministic seeding**: `createFake<Port>({ seed, fixtures })` — same seed ⇒ same ids and data (ids from a seeded UUIDv7 generator).
- **Tenant isolation**: the fake keys every record by `ctx.tenantId` and returns `common.not_found` across tenants.
- **Programmable failure**: `fake.failNext(method, code)` to make the next call throw a given `errors.yaml` code; `fake.latency(ms)`.
- **Call recording**: `fake.calls(method)` for assertions.
- The behaviours listed per port in 03-IC §4.

### 8.4 Contract tests (`packages/fakes/contract-tests/<PortName>.contract.ts`)

- Exported as `run<PortName>Contract(makeImpl: () => Promise<{ impl, seed(fixtures) }>)`.
- Run in CI against the fake (C0) and against the real implementation (owner chunk's `__tests__/contract/`). Both must pass (01 §8 risk 3).
- Case lists per port are fixed in 03-IC §4; owners may add cases, never remove them.

### 8.5 Non-staff actors (patient, portal, partner)

1. Request handlers for `patient`, `portal` and `partner` actors read and write only their own module's tables, plus exactly these owner-supported reads: `IdentityPort.getActor` / `assertRole`; `IdentityPort.getTenantSettings` with `keys` ⊆ {`timezone`, `calendarDisplay`} (C2 refuses other keys for these actors with `auth.forbidden`); `ReportingPort.getReleasedReports` / `openReleasedReportFile` / `redeemPortalLinkForApp` (partner, patient — CR-C13-005, C16-008). `SmartReportPort` is not callable by them (08 A2.3). Partner-admin port writes are also allowed: `IdentityPort.provisionPartnerMembership` / `updatePartnerMembership` (partner, CR-C13-003). (08 A19 D-119, A22.2; replaces the earlier item 1.) Centre data for patients comes from C16's own projection `engagement.booking_centres`, written only by the system actor; `ctx.core` is not called in patient context.
2. Any other cross-module call on their behalf runs in the module's worker as its **system actor**, after the module has checked the actor's ownership in its own tables.
3. `PaymentProviderPort` (all methods) and `BillingPort` (all methods) are callable only by staff (`user`) or `system` actors. 03-IC §4.4 "or under the patient/portal request context" is deleted.

---

## 9. Logging, metrics, tracing

### 9.1 Structured logs

- One JSON object per line via `@lims/shared-ts/logger` (C0; Fastify's logger is configured to use it). `console.*` banned.
- Mandatory fields:

| Field | Example |
|---|---|
| `ts` | `2026-11-05T04:15:00.123Z` |
| `level` | `info` |
| `service` | `api` / `worker` / `web-bff` / `renderer` / `portal` / `partner` / `bridge-agent` |
| `env`, `version` | `staging`, git sha |
| `request_id` | UUIDv7 (from `X-Request-Id`; generated at nginx or BFF if absent) |
| `trace_id`, `span_id` | from W3C `traceparent` |
| `tenant_id`, `actor_id`, `actor_type` | UUIDs only |
| `module`, `operation_id` / `task` | `lab`, `rejectSpecimen` |
| `route` | route **template** (`/v1/lab/specimens/{specimen_id}/reject`), never the raw URL |
| `status`, `duration_ms` | `200`, `37` |
| `error_code` | errors.yaml code on failures |

### 9.2 PHI and secrets — never in logs, metrics, traces, URLs or error messages (REQ-SEC-098, REQ-SEC-095)

| Category | Fields (non-exhaustive; logger denylist keys are case-insensitive substrings) |
|---|---|
| Direct identifiers | patient name (any language), phone, email, address, date of birth, exact age with sex, national ID / citizenship no, photo, signature image |
| Lab-linked identifiers | registration no, barcode / sample no, lab no, histo accession no, report link URL, QR token |
| Health data | test or panel names linked to a person/order, result values, flags, comments, interpretations, diagnoses, clinical history, TRF content, report content, smart-report text, critical-value details |
| Credentials | passwords, OTPs, JWTs, refresh tokens, cookies, device tokens, signed URLs (04 A14), gateway secrets, webhook signatures, API keys |
| Financial (restricted) | card/wallet identifiers (REQ-SEC-056); invoice amounts are allowed only in billing audit trails, not general logs |

Allowed in logs: internal UUIDs (patient_id, order_id, specimen_id…), tenant/centre ids, invoice_no / credit_note_no (fiscal, non-health), error codes, counts, durations.

The shared logger enforces a key denylist + value scrubbers (phone-number and token patterns) and is unit-tested with planted PHI. Raw HL7/ASTM messages are stored in the access-controlled archive (04 I8; REQ-ARCH-062), never logged.

### 9.3 Error capture
Stack traces go to logs only (never responses — REQ-SEC-095) after scrubbing. No foreign error-tracking SaaS (04 §11 lists no such touchpoint; would need founder approval, B11).

### 9.4 Metrics and tracing
- Prometheus-style names `lims_<module>_<name>_<unit>`; counters end in `_total`; durations `_seconds` histograms. Labels: `tenant_id` only on low-cardinality business metrics (≤ number of tenants), never ids of patients/orders.
- Required per service: `lims_http_requests_total{module,operation_id,status}`, `lims_http_request_duration_seconds{module,operation_id}`, `lims_jobs_total{task,outcome}`, `lims_job_duration_seconds{task}`, `lims_queue_depth{task}`, `lims_core_dead_letters_total{task}`, `lims_ratelimit_rejections_total{tier}`, `lims_rls_denied_total` (REQ-SEC-045/133).
- Trace context: W3C `traceparent` propagated BFF → API → worker (stored in job payload) → renderer. Collector/backend choice is C1's and MUST be Nepal-hosted (04 S1, §11).
- Capacity dashboard items per REQ-ARCH-009; alerting rules per REQ-SEC-133 (C1).

---

## 10. Security defaults every chunk inherits

Applicability by phase follows 04 §12 rule (REQ-SEC §1, §3, §4, §6, §7 and REQ-SEC-057 from Phase 1; §2 gateway reqs from Phase 1.5–2; §5 mobile when apps ship). Each chunk's `07-SECURITY.md` cites the IDs; it does not copy them.

### 10.1 Authorization (REQ-SEC-002, 013, 067; ASVS 5.0 L2 target REQ-SEC-001)

- Every handler calls `IdentityPort.assertRole(ctx, { permission, centreId? })` **before** any state read beyond the authz lookup (03-IC §4.6). Missing permission → `403 auth.forbidden`; missing MFA for privileged permission → `403 auth.mfa_required` (04 A4).
- **Object-level (BOLA):** load the target object through the module repository (RLS-scoped) first; not found/other tenant/other centre → `404 common.not_found`; then check permission with that object's `centre_id`. IDs in body vs path must match or `400 common.id_mismatch` (REQ-SEC-044).
- Permission codes `<m>.<resource>.<action>` are declared in `contracts/permissions.yaml` (C0; content in 03-IC §11, accepted addition A6) with `privileged: true|false` and default role grants; roles are configured per tenant by C2. Spec operations carry `x-permission`.
- Field-level: response mappers return explicit per-role field lists (REQ-SEC-081). Never serialise a DB row directly.
- Refunds, discount approval above threshold, invoice cancel, data export of personal (P1–P3) or financial data, bulk report download, role changes are privileged (REQ-SEC-055, 062, 100). Exports holding only P0 master data (C3 `catalog_master`) are not privileged (08 A13 D-22).

### 10.2 Inputs, outputs, files

| Topic | Rule | Ref |
|---|---|---|
| Validation | spec-driven, strict, unknown fields rejected | REQ-SEC-080 |
| SQL | parameterised only; LIKE/ILIKE escaping; `format()` with `%I/%L` in PL/pgSQL | REQ-SEC-082 |
| Output encoding (web) | React text nodes only; no `dangerouslySetInnerHTML` with user data; rich text sanitised server-side (DOMPurify) | REQ-SEC-088 |
| CSP | nonce `script-src`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`, `form-action 'self'`; report-only first | REQ-SEC-089 |
| Headers | per REQ-SEC-090; HSTS `max-age=63072000; includeSubDomains`, `preload` only after every subdomain is HTTPS-only | 04 I6 |
| CSRF / CORS | state-changing = POST/PUT/PATCH/DELETE only; Origin/Sec-Fetch-Site checked in BFF; exact-origin CORS allowlist | REQ-SEC-091/092 |
| Uploads (TRF, outsourced PDFs, attachments) | per-operation allowlist ⊆ `application/pdf`, `image/jpeg`, `image/png`, `text/csv` (UTF-8, no NUL, never rendered, no scan), `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (ZIP magic + `.xlsx`, scanned); extension + magic-byte check; ≤ 15 MB; object under `{tenant_id}/…` in the module's own bucket; ClamAV-class scan **mandatory in staging/production** (scan unavailable ⇒ quarantine); image re-encode strips metadata; all through `ctx.uploads`/`ctx.storage` (08 §4.13). Exception: C3 catalog import/export files in `catalog.files` (03-IC §13.4); scan via `ctx.files.scan`. **Scan outcome without a status API (08 A17 P-19):** `ctx.uploads.accept` returns `scanState`. `clean`: the object is usable. `infected`: the module marks its row `quarantined` (terminal). `pending`/`unavailable`: the module stores `scan_state` on its own row and enqueues its own job. That job re-scans with `ctx.files.scan(await ctx.storage.read(bucket, objectPath))` (08 §4.13; ≤ 5 attempts with backoff [CONV]) and updates the row. Until the row is `clean`, a download returns `422 common.upload_quarantined` (P-2). There is no `ctx.uploads.status` method, and none is added. | REQ-SEC-083/084/087; 04 R7 |
| Serving uploads | Through an API `GET …/content` (or `…/file`) operation using the core streaming download helper (`Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`; BFF proxies the stream). The object must be `clean`, otherwise `422 common.upload_quarantined`. Every call writes an `access_log` row. `ctx.storage.signedUrl` is internal to `services/{api,worker}` and never appears in a response, header or log (03-IC §13.6). Never inline on an app origin, with one exception: **(I1)** an object accepted with `images.reencode: true` whose stored mime is `image/png` or `image/jpeg` may be streamed by its owner's `GET …/content` with `Content-Disposition: inline`, for `<img>` display through the BFF. Headers: `Content-Type` = the stored mime (never client-supplied), `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: no-store`. Every call is access-logged. All other files stay attachment-only. (08 A13 P-2, replaces the row; I1 = 08 A17 D-67, an accepted risk narrowing REQ-SEC-085) | REQ-SEC-085, 035; 04 A14 |
| Cross-module file reads | A module may `ctx.storage.read` another module's bucket only for a `(bucket, objectPath)` pair received in the same flow from the owner's port output, event payload or published view (for example `InstrumentResultInput.attachment`, `anatomic.v_pub_report_content`). Paths are never constructed. Writes stay owner-only (R26). Untrusted PDFs (instrument and outsourced) pass the renderer's `/internal/sanitize` before assembly, and `sanitized_sha256` is recorded. (08 A13 P-13) | 08 R26 |
| Spreadsheets | Every XLSX/CSV text cell written by product code passes `neutraliseFormula`; importers apply `restoreNeutralised` before validation. Writer: `write-excel-file` 4.1.1. Module-local copies are banned (C3, C4, C8). C0-0A adds the function and golden tests (`@lims/shared-ts/spreadsheet`, 03-IC §13.6). (08 A13 P-9) | 08 R12e |
| Renderer | allowlisted bundled assets only, egress-restricted, no user-controlled URLs | REQ-SEC-086; 04 S14 |
| Errors | generic bodies, `request_id`, no internals | REQ-SEC-095 |
| Secrets | secret store, never in repo/app binaries; gitleaks in CI | REQ-SEC-128, 107 |
| Supabase keys | `service_role`/secret key server-side only, confined to a C0-audited list of modules (REQ-SEC-029/030); default for all chunks: **not used**. Audited users: `services/api/src/modules/identity/gotrue/gateway.http.ts` (GoTrue service key, CR-C2-014) and `services/{api,worker}/src/core/storage/` (Storage credential, 08 R12b). | 04 D5 |
| Foreign services | only those in 04 §11 with their rules; anything else needs founder approval (B11) | 04 §11 |
| Consent | registration captures consent (collection, processing, channel, referrer sharing) with text version; NotificationPort refuses a channel without consent | REQ-SEC-005/006 |
| Audit | data changes → trigger `audit_log`; view/print/download/export/consent/role events → `access_log` via `ctx.audit.access(...)` (C0 API). Each chunk TRD lists every `ctx.audit.access` call as operation → `action` → `entityType`. Every `action` must exist in 03-IC §13.1 / the C0 seed. CI (C0-0C) fails a string-literal `action:` in `services/**` that is not in `audit.g_cs_access_actions`. (08 A13 P-3) | 04 D11; REQ-SEC-096/097 |

### 10.3 Rate-limit tiers (values from 04 §4 only)

| Tier (`x-rate-limit-tier`) | Limit | Enforced at |
|---|---|---|
| `login` | Per account: 10/hour; ≥5 failures → exponential backoff + step-up. Per client IP (as seen by the public edge, never the BFF): failed attempts only — ≥10 failures in 10 min → that IP limited to 5 attempts/min for 30 min + security alert; successful logins never count. Edge flood guard: 60 req/min/IP (burst 20) on public login/recovery routes. No static-IP or IP-registration dependency (founder decision 2026-11-06). | nginx on the public login/recovery routes (flood guard, client IP) + identity module (per-account and per-IP failure counters) |
| `otp_request` | 3/hour/phone | app/Redis |
| `otp_verify` | 5 attempts per issued OTP | app |
| `qr_verify` | 10/min/IP and 100/day/IP | nginx (min) + app/Redis (day) |
| `report_download` | 20/hour/patient-link | app/Redis |
| `ingest` | 60 requests/min/device; ≤100 messages/request | nginx/app |
| `general` (default for every other operation) | 10 req/s/user, burst 20; per-tenant aggregate caps (value not fixed in 04 → C0 sets a configurable default and records it in its TRD). Documented variant (08 A19 D-116): unauthenticated callback/launch routes: per-IP at nginx 10 r/s burst 20 (CR-C15-008) + app key per intent (`payments:cb:<intent_id>`) | app |

Algorithm: nginx `limit_req` for per-IP r/s or r/m; sliding-window or token-bucket in Redis/app for hourly/daily and per-identity (04 §4; REQ-SEC-079). Redis is ephemeral rate-limit cache only, no PHI, persistence off; fallback UNLOGGED Postgres table (04 S11). Response `429 common.rate_limited` + `Retry-After`.

The `login` tier applies to staff web, partner and staff-mobile login (patient OTP keeps its own tiers). The nginx flood guard runs on the public BFF/app login and recovery routes, keyed by the client IP — never on BFF-only internal API routes; the per-IP failure counter is kept by the identity module, keyed by the client IP the BFF forwards (header set by nginx, trusted only from nginx), never the BFF's own address. Thresholds are [CONV] tunables in tenant-independent config (08 Addendum A1, supersedes R6).

**Client IP from the trusted edge only (08 A25 P-61).** The core sets `app.client_ip` from `X-Forwarded-For` (single hop; nginx overwrites it, C1 TRD §6.6) only when (a) the request carries a valid `X-Lims-Bff-Key`, or (b) the TCP peer address is in `LIMS_CORE_TRUSTED_PROXY_CIDRS` [CONV; C1 sets it to the nginx container address on `edge_net`]. Otherwise the core uses the peer address. Module code reads only `ctx.clientIp`; it never parses a header.

---

## 11. Testing

### 11.1 Layers

| Layer | Scope | Tooling | Where |
|---|---|---|---|
| Unit | `domain/`, state machines, mappers, money/date libs | TS test runner [PIN-C0]; `flutter test`; `go test` | `__tests__/unit` |
| Integration | service + repository + RLS on a freshly migrated Postgres 17 with seed tenants | compose stack (C0) | `__tests__/integration` |
| DB | every RLS policy (positive + negative), role checks, immutability triggers, grants | pgTAP if in image, else SQL (§5.12) | `db/tests` (C0) |
| Contract — HTTP | handlers vs spec (request + response validation on), Prism/MSW mocks for UI chunks | fastify-openapi-glue runtime validation; Prism 5.16.0; MSW 3.0.3 | owner `__tests__/contract` |
| Contract — ports | shared suites (§8.4) on fake and real | `packages/fakes/contract-tests` | owner + C0 |
| Contract — events | producer: every published payload validates; consumer: handles every example in 03-IC + unknown extra fields + duplicate delivery + stale seq | ajv | owner |
| Probes | cross-tenant + cross-centre (§11.3) | generated from specs + hand-written | owner `__tests__/probes`, C0 generator |
| E2E | critical journeys on the full compose stack, nightly (REQ-ARCH-081) | browser automation [PIN-C0] | `tests/e2e` under each app root |
| Simulator | ASTM/HL7 session replay against bridge + ingest (REQ-ARCH-064) | Go harness | C7 |

### 11.2 Fixtures and data (00 §7.5; REQ-SEC-041, 136)

- **Synthetic data only.** Real patient PDFs or records from the client are never committed, never pasted into AI tools, never loaded into dev/staging (00 §7.5; REQ-SEC-136).
- Two permanent synthetic tenants in every non-prod environment: `tenant_a` "Synthetic Lab Alpha" and `tenant_b` "Synthetic Lab Beta", each with ≥2 centres and staff in every role (REQ-SEC-041). Seeds generated by `packages/test-fixtures` with fixed seeds.
- Synthetic names are visibly fake (e.g. "Test Patient 0042"); phone/email fields use generator output; non-prod environments hold **no real provider credentials**, so no message can reach a real person (REQ-SEC-136).
- Report-format examples may mimic the *layout* facts in 00 §4 (field names, column order) but never real names, NMC numbers, or values from the sample PDF.
- Catalog seeds are synthetic until the client's test list arrives (BLOCKED B3).

### 11.3 Mandatory cross-tenant / cross-centre probes (REQ-SEC-040, 044; REQ-ARCH-079)

For **every operation in every spec** (generator walks `contracts/openapi/*.yaml`; an operation without probe coverage fails CI):
1. Authenticate as tenant A user; call with tenant B's known object ids (path, body, query, batch arrays mixing A and B ids) → expect `404 common.not_found` (or per-item not_found in bulk), no B data in body, no side effect in B (verified by DB check as owner in test harness).
2. Same with a tenant-A user scoped to centre A1 against centre A2 objects (where the table is centre-scoped).
3. Write/FK probes: create a child in A referencing B's parent id → rejected (composite FK / RLS).
4. List endpoints: with B data present, A's response contains zero B rows.
For **every tenant table**: SQL probe with claims of tenant A → `SELECT` sees zero B rows; `INSERT` with `tenant_id = B` fails; `UPDATE`/`DELETE` of B rows affect zero rows.
For Storage/Realtime before PHI use: same probes (04 D3 UNVERIFIED).

### 11.4 Gates (not vanity numbers)

Line coverage is reported, **not** gated. A PR is blocked unless:
- every operationId it adds/changes has a contract test, a probe, and a test per declared `x-error-codes` entry;
- every state-machine transition (allowed and a representative forbidden one) has a unit test;
- every event it produces has a payload-validation test; every consumer it adds has duplicate-delivery and stale-seq tests;
- every money computation path has golden tests (`@lims/shared-ts/money` cases) and every B.S. conversion uses the shared golden table (2000–2099 B.S., TS ↔ Dart — 04 D13);
- every RLS policy it requests (via C0) has a negative test;
- the port contract suites for ports it implements pass.
Full DoD lives in `05-DEFINITION-OF-DONE.md`.

---

## 12. Git and PR rules

| Item | Rule [CONV] |
|---|---|
| Branch | `c<NN>/<kebab-topic>` (e.g. `c04/invoice-cancel`); C0 workstreams `c00-0b/<topic>` |
| Commit | Conventional Commits: `<type>(c<NN>/<module>): <imperative subject ≤72 chars>`; types `feat, fix, refactor, test, docs, chore, perf, build, ci`; body explains why; reference CR ids (`Refs: CR-0123`) |
| PR scope | touches **only** paths owned by the chunk (01 §3); CODEOWNERS + path-check job fails otherwise (REQ-ARCH-075) |
| PR size | one task from the chunk's `06-IMPLEMENTATION-PLAN.md` per PR where possible |
| PR template | task id, owned paths touched, CRs relied on, fakes vs real ports used, new deps (+ licence + TRD note), screenshots for UI, security checklist (07-SECURITY items touched) |
| Merge | squash; green CI required; owner-chunk reviewer + C0 reviewer for any PR that consumes a new contract version |
| Contract PRs | only C0 opens PRs touching `db/`, `contracts/`, `packages/*`, `*/core/`; each contract PR regenerates clients in the same PR (REQ-ARCH-073/077) |

CI gates (all required):

| # | Gate | Notes |
|---|---|---|
| 1 | Path ownership check | 01 §3; CODEOWNERS |
| 2 | Typecheck | `tsc --noEmit` (all TS), `dart analyze`, `go vet` |
| 3 | Lint + format | §1.3 rules |
| 4 | Unit + integration tests | per changed package + dependants |
| 5 | Contract tests | HTTP (spec validation), ports (shared suites), events (schemas) |
| 6 | OpenAPI diff | `oasdiff` 1.35.x breaking check; breaking without `cr-approved-breaking` label fails (04 S19/T7) |
| 7 | Spec lint | `additionalProperties: false`, required `x-*` extensions, 3.0∩3.1 construct rules (§4.12), operationId uniqueness |
| 8 | Generated clients up to date | regenerate and diff `packages/api-client-*` |
| 9 | Migration checks | B10 BLOCKED: checklist review until linter decided; policy diff vs `db/policies`; immutability/grant assertions |
| 10 | RLS + cross-tenant probes | §11.3; role BYPASSRLS assertion (04 D5) |
| 11 | Secret scan | gitleaks (REQ-SEC-128) |
| 12 | Dependency scan + licence check | `osv-scanner`/`npm audit` triage SLA critical 72 h (REQ-SEC-129; 04 I9); licence allowlist §15 |
| 13 | Banned-dependency check | §15.3 |
| 14 | Container image scan | trivy (REQ-SEC-130) for changed images |
| 15 | B.S. golden table | TS and Dart both pass shared fixtures (04 D13) |
| 16 | Nightly | full-stack compose up + migrate + seed + smoke every chunk (REQ-ARCH-081) |

---

## 13. i18n, calendars, fonts

- UI language v1: **English** [CONV; 00 does not ask for Nepali UI]. All user-visible strings go through a message catalog keyed `<m>.<screen>.<key>` (`@lims/ui` i18n helper / Flutter `intl` ARB files) so Nepali can be added without code changes; no string concatenation for sentences.
- User data in Devanagari (patient names, addresses, narrative text) is stored as entered, Unicode NFC-normalised [CONV]; search is Unicode-aware (pg_trgm on name — REQ-ARCH-023).
- Reports/PDF: Noto Sans Devanagari bundled in the renderer and UI kit (04 S14; REQ-ARCH-044). SMS bodies support Unicode (04 R6).
- Calendar display: tenant setting `calendar_display ∈ {AD, BS, AD_BS, BS_AD}` (primary first) [CONV values; the setting itself is 04 D12]. Default `AD` (Metro Labs reports show A.D. — 00 §4; 04 D12). Applies to UI and reports.
- Billing documents and statutory registers always show **both** B.S. and A.D. regardless of the setting (04 L11 — vendor source, not IRD text) and the fiscal year in B.S. (04 L16, Shrawan 1).
- All conversions through `packages/shared-ts/bsdate` (wrapping `@remotemerge/nepali-date-converter` 1.2.7) and `packages/shared-dart/bsdate` (wrapping `nepali_utils` 3.0.8); supported common range 1975–2099 B.S.; one shared golden table 2000–2099 B.S. enforced on both sides; far-future month lengths are projections, re-checked yearly (04 D13). Out-of-range input → `common.date_out_of_range`.
- Display formats [CONV]: A.D. `DD/MM/YYYY hh:mm A` (matches 00 §4 observed report format); B.S. `YYYY-MM-DD` with "B.S." suffix; time zone `Asia/Kathmandu`.

## 14. Accessibility and UI-kit-only rule (web + Flutter)

- Staff web, portal and partner UIs are composed **only** from `@lims/ui` (C0) primitives and tokens; Flutter apps only from `lims_ui`. A component missing from the kit → CR to C0, not a local look-alike [CONV].
- Target WCAG 2.2 level AA [CONV] for portal, partner and staff web: semantic HTML, label for every input, visible focus, contrast from tokens, no colour-only status (flags show text "High"/"Low" — matches 00 §4), error text tied to fields (`aria-describedby`).
- Keyboard-first for front desk and result entry (01 §1.1 single-page registration): every action reachable without mouse; documented shortcuts in the chunk's `04-UI-UX.md`; tab order follows visual order.
- Every page has empty / loading / error / success states (01 §7 App Flow).
- In-app help component from the web shell on every screen (04 L26 ढ for billing; 01 §2 training note).

## 15. Dependency policy

### 15.1 Adding a dependency
- Allowed only in a package the chunk owns entirely; for `services/api`, `services/worker`, `apps/web` the dependency is added by C0-0D on a CR (01 §4, CR-C0-002). The PR must add a row to the chunk's `02-TRD.md` "Dependencies" table: name, exact version, licence, purpose, maintenance evidence (last release date), alternatives considered.
- Exact versions only (no `^`/`~` ranges in app packages) [CONV]; lockfiles committed (`pnpm-lock.yaml`, `pubspec.lock`, `go.sum`) (REQ-SEC-129). Docker base images pinned by digest, never `latest` (REQ-SEC-129).
- No dependency that phones home to a foreign service at runtime (telemetry, CDN-loaded assets, licence servers) — 04 §11, S1.
- Repo-wide pins recorded by C0: `write-excel-file` 4.1.1, `read-excel-file` 9.3.14 (C3 02-TRD §2.2; CR-C8-014).

### 15.2 Licences
| Status | Licences |
|---|---|
| Allowed | MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, Zlib, Unicode-DFS / Unicode-3.0 (fonts/data), OFL-1.1 (fonts, e.g. Noto) |
| Review required (C0 + founder) | MPL-2.0, EPL-2.0, LGPL (dynamic linking only), CC-BY (data) |
| Operations tools (outside "shipped code") | Operations tools run unmodified as separate processes on the LIMS provider servers, never linked into, vendored into or distributed with product code, are outside 'shipped code' (e.g. Ansible, fail2ban, ClamAV, Grafana, testssl.sh, Squid, SOPS, rsync). Conditions: listed in `infra/THIRD-PARTY-OPS.md` with licence; AGPL tools are reachable only from the ops network, never by tenant users; any modification or redistribution needs C0 + founder review. SSPL/BUSL/RSAL stay banned everywhere. (CR-C1-007) |
| Banned in shipped code | GPL, AGPL, SSPL, BUSL, FSL, Commons Clause, "source-available"/non-commercial licences; unlicensed packages. (SENAITE GPL v2.0 and Mirth 4.5.2 = design reference only — 01 §1.2, 04 T6) |

### 15.3 Banned dependencies (CI-enforced)
| Dependency | Reason | Use instead |
|---|---|---|
| `pdf-lib` (upstream, last release 1.17.1, Nov 2021) | unmaintained | `@cantoo/pdf-lib` 2.11.1 or `@pdfme/pdf-lib` 6.2.8 (04 S15) |
| `sqlcipher_flutter_libs` | EOL (0.7.0+eol) | `package:sqlite3` ≥3.x SQLCipher/SQLite3MultipleCiphers hook (04 A15) |
| `bikram-sambat` as primary B.S. library | table ends 2090 B.S. | `@remotemerge/nepali-date-converter` 1.2.7 (04 D13) — may appear only as a test oracle, never imported by app code |
| `bullmq` / any Redis-backed queue | rejected (04 S10, S11) | Graphile Worker |
| `@supabase/supabase-js`, `@supabase/ssr` in browser bundles of staff web | 04 S4; REQ-SEC-068 | BFF |
| Mirth/NextGen Connect 4.6+ | commercial only (04 T6) | in-house bridge |
| PowerSync / ElectricSQL (v1) | not in v1 scope (04 S17) | custom drift sync |
| Foreign SaaS SDKs (analytics, crash reporting, CDN fonts) | 04 §11 | self-hosted / bundled |
| Postgres `ENUM` types (not a package, same gate) | §5.5 | text + CHECK / coded sets |

---

## 16. Quick reference — where each 04 row is applied in this file

| 04 row | Section |
|---|---|
| S2, S3, S4, S5 | §2.4, §5.1, §5.8, §6 |
| S8, S9 | §1.1, §5.10 |
| S10, S11 | §7, §10.3 |
| S12, S13 (B10) | §5.12 |
| S14, S15 | §1.1, §10.2, §15.3 |
| S16 | §1.1, §2.6 |
| S19, T7, T8 | §1.1, §4.11, §4.12, §12 |
| D1–D16 | §5, §6 |
| A1–A16 | §6, §10 |
| §4 rate limits | §10.3 |
| I6, I8 | §5.11, §10.2 |
| L5, L6, L7, L8, L11, L15, L16, L25, L26 | §4.9, §4.10, §5.2, §5.7, §13 |
| §11 touchpoints | §9.3, §10.2, §15.1 |
| §12 phasing | §10 |
