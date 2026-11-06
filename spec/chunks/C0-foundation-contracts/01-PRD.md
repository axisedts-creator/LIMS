# C0 — Foundation & Contracts — 01 PRD

Status: DRAFT for build, 2026-11-05. Phase 0 / Wave 0 (01-CHUNK-MAP §1).
Precedence: `research/00` > `research/04` > `program/03` > `program/01`/`02` > this file. Where this file needs something those documents do not define, it is labelled **DECISION** or **[CONV]** with a reason, or raised as a CR in `02-TRD.md` §17.

Abbreviations used across the seven C0 documents: **CM** = `program/01-CHUNK-MAP.md`, **CV** = `program/02-CONVENTIONS.md`, **IC** = `program/03-INTERFACE-CATALOG.md`, **DoD** = `program/05-DEFINITION-OF-DONE.md`, **04 X#** = row X# of `research/04-consolidated-decisions.md`, **00 X#** = item of `research/00-scope-baseline.md`.

---

## 1. Purpose

C0 builds the things every other chunk shares, and builds them first, so eighteen chunks can be built in parallel without colliding (CM §0). It removes all three collision types:

| Collision (CM §0) | What C0 delivers to remove it |
|---|---|
| Same file edited twice | Monorepo layout, CODEOWNERS, path-ownership CI gate, autoload (no central registry file) |
| Same shape invented twice | All DDL + RLS for all chunks, OpenAPI per domain, event JSON Schemas, port interfaces, error/permission/route registries, design tokens and UI kit |
| Hidden behaviour dependency | A fake for every port, a shared contract-test suite for every port, Prism/MSW mocks for every API, synthetic seed data, a local dev stack |

C0 contains **no business logic**. It never decides how a specimen is rejected or an invoice is numbered. It turns the chunks' `05-SCHEMA.md` and `02-TRD.md` specifications into executable contracts, and it provides the runtime cores that make those contracts hard to violate: auth, tenant context, transactions, idempotency, rate-limit hooks, the outbox, the event dispatcher, audit, the web shell and the design system.

## 2. Users and roles

C0's users are mostly builders and operators, not lab staff. Lab-staff permission codes (IC §11) appear only where C0 code enforces or seeds them.

| User | Who | What they do with C0 output | Permission codes involved (IC §11) |
|---|---|---|---|
| Chunk agent / developer (C1–C18) | AI coding agents and the LIMS provider developers | Scaffold a module, code against ports and fakes, run the dev stack, file CRs, pass CI gates | none at runtime; in tests they use seeded actors holding every default role |
| C0 workstream agents (0A, 0B, 0C, 0D) | Four parallel agents (CM §8 risk 1) | Build and maintain the shared assets; triage CRs | — |
| Platform operator (the LIMS provider staff) | Founder / ops | Run migrations, inspect dead letters (through C2's console), read core metrics | `platform.dead_letter.manage`, `platform.tenant.manage` (enforced by C2's handlers through C0 core repository functions) |
| Tenant staff (indirect) | Every staff role in IC §11 `roles:` | Never see C0 directly; they see the web shell (navigation, session timeout, help panel), the design-system components, and the effects of RLS | All codes are seeded into `core.g_permissions` and the default roles of `contracts/permissions.yaml` (currently 10: `tenant_admin`, `front_desk`, `finance`, `lab_technologist`, `pathologist`, `radiologist`, `lab_manager`, `centre_staff`, `phlebotomist`, `owner_viewer` — 03-IC §11) |
| Auditor / IRD reviewer (indirect) | External | Relies on immutability triggers, append-only audit tables and per-tenant isolatable billing tables that C0 implements | — |
| System actors | Worker jobs per module | Run with `actor_type: 'system'` claims built by the worker core (CV §6) | Per-module `systemPermissions` in the module manifest, never `platform.*` (IC §11) |

## 3. Problems this chunk solves

1. **P-1 Schema drift between parallel agents** is the most expensive collision (CM §8 risk 2). One owner writes all DDL.
2. **P-2 Cross-tenant leakage** is the top-ranked failure mode for this product (research 02 §8 item 1; REQ-SEC-002). C0 makes isolation structural: roles without BYPASSRLS (04 D5), FORCE RLS (04 D4), composite FKs (04 D8), transaction-local claims (04 S9), and a probe suite that fails CI.
3. **P-3 Fakes drift from real behaviour** (CM §8 risk 3). One contract suite per port must pass against both the fake and the real implementation.
4. **P-4 IRD exposure**: VAT Act s.29(1)(g2) fines the lab NPR 500,000 for software that can delete or correct data (04 L5). C0 supplies the immutability trigger, the no-DELETE grant model and the per-tenant isolatable `billing` schema (04 D16, B17).
5. **P-5 Unverified platform behaviour** (04 D3, D6; CV §6 GoTrue claims — `session_id`/`aal`, 08 R10; CV §5.12 pgTAP). C0 runs spikes first and publishes decisions before chunks depend on them.
6. **P-6 Inconsistent UI** across 10+ UI chunks. One design system, one web shell, one Flutter theme.
7. **P-7 Calendar errors**: B.S. ↔ A.D. conversion done differently in TS and Dart. One wrapper per codebase with one shared golden table (04 D13).

## 4. Scope

### 4.1 In scope (mapped to the client baseline)

| # | In-scope item | Workstream | Client baseline / constraint it serves |
|---|---|---|---|
| I-1 | Monorepo, pnpm workspaces, Dart pub workspace, Go module stub; root configs; CODEOWNERS; path-ownership gate | 0A | 00 §7.2 (parallel agents without collisions) |
| I-2 | CI pipeline with every gate in DoD §1 and CV §12 | 0A | 00 §7.2, §7.4 (no shortcuts) |
| I-3 | `@lims/shared-ts`: uuidv7, bsdate (04 D13), money, errors, validation, logger, crypto, routes, clock | 0A | 00 G5 (IRD dual-calendar billing via C4), 00 §4 (A.D. dates on reports) |
| I-4 | `lims_shared` (Dart): uuidv7, bsdate, money, errors; shared B.S. golden table 2000–2099 B.S. | 0A | 00 §1 handwritten note (Patient APP, Phlebotomy APP) |
| I-5 | `@lims/test-fixtures`: synthetic generators, two permanent synthetic tenants, 1× and 10× lab volume | 0A | 00 §7.5 (synthetic data only); 00 G2/G3 (500 patients/day, 20 centres) |
| I-6 | Local dev stack (`tools/devstack/`, CR-C0-001): self-hosted Supabase services, PgBouncer override, local mail sink, Prism mocks | 0A | 00 §7.1 (Nepal-only data; nothing foreign in dev either) |
| I-7 | All DDL: roles, schemas for every module (CM §3), C0-owned tables (core, audit, platform), helpers, triggers, grants; and the translation of every other chunk's `05-SCHEMA.md` | 0B | 00 G1 (sell to multiple labs = multi-tenant), G3 (centre scoping), G5 (IRD immutability) |
| I-8 | Migration runner and ordering rules; isolation probe suite; role/grant/RLS assertions; seeds | 0B | 00 G1; 00 §7.5 |
| I-9 | Contracts: OpenAPI per domain (3.0.3 ∩ 3.1), `_common.yaml`, 25 event schemas, 13 port interfaces + `common.ts` (08 §4.14), `render/*.schema.json`, `errors.yaml`, `routes.yaml`, `permissions.yaml` | 0C | 00 §7.2, §7.3 |
| I-10 | Codegen: TS client, Dart client, error-code/permission/route constants, event payload types; Prism + MSW mocks; probe-coverage generator | 0C | 00 §1 (apps consume the same API) |
| I-11 | `@lims/fakes`: one fake per port + `contract-tests/` suite per port (case lists from IC §4) | 0C | CM §8 risk 3 |
| I-12 | API core: bootstrap, JWT verification, tenant context, DB transactions, errors, idempotency, rate-limit hooks, module autoload, port registry, outbox publish, audit API, `ctx.core` repository | 0D | 00 wishlist item 1 ("unlimited users; unlimited collection centres") — no hard-coded limits in core |
| I-13 | Worker core: Graphile Worker bootstrap, task/subscription/cron autoload, event fan-out, consumer inbox wrapper, dead letters, retention purge | 0D | 00 A11, D2–D4 (SMS/WhatsApp/email go through the outbox, built by C6) |
| I-14 | Web core: staff shell, BFF session mechanics, API proxy, nav registry, help component, CSP/CSRF middleware | 0D | 00 A1 (one-page registration needs a keyboard-first shell), 00 E1 (roles, lock: shell hides what the role cannot do) |
| I-15 | `@lims/ui` design system (tokens incl. status colours, Noto Sans Devanagari, components incl. DataTable, form fields, BarcodeInput, DatePicker B.S./A.D., StatusChip, Dialog, Toast, PageShell, charts) | 0D | 00 B1 (barcode stickers/scans), B3 (status of every patient), C7 (results as graph), F1 (dashboard tiles), §4 (High/Low flags shown as text) |
| I-16 | `lims_ui` Flutter base theme + base widgets | 0D | 00 §1 (apps) |
| I-17 | Spikes for UNVERIFIED platform items (GoTrue `session_id`/`aal`/`alg` claims — SP-1 rescoped by 08 R10, Graphile Worker least privilege and `add_job`, pgTAP in image, Storage/Realtime claims, migration runner) | all | 00 §7.4 (no false claims) |

### 4.2 Out of scope (explicit)

| Out of scope | Owner instead |
|---|---|
| Business logic of any module, including the admin logic behind `core` tables (user/role/centre management, tenant provisioning UI, settings) | C2 (CM §3 module table: `core` = C0 tables / C2 logic) |
| Login, MFA, password policy, session listing/revocation UI, the BFF login pages | C2. C0 provides only the BFF session mechanism and the `IdentityPort` contract + fake |
| Tenant settings storage and the `IdentityPort` implementation | C2 (`identity` schema per C2's `05-SCHEMA.md`). C0 stores only `core.tenants.timezone` (§9 of `05-SCHEMA.md`) |
| Production infrastructure: VMs, nginx edge, TLS, production compose hardening, backups, monitoring stack, secrets store, deploy pipelines | C1. C0's dev stack is for local/CI use only and is not a production template |
| Any module's tables beyond C0's own | Their owner chunk's `05-SCHEMA.md` is the spec. C0 translates it into migrations and never redefines it |
| Endpoints of other modules | Their owner chunk's `02-TRD.md`. C0 transcribes them into `contracts/openapi/<m>.yaml` |
| Real port implementations | The owner chunk (CM §5.1). C0 ships fakes only |
| Screens of feature modules | Owner chunks. C0 ships only the shell, components and tokens |
| Migration of legacy eLabs data | C18 (blocked B4) |
| Everything on the CM §2 "explicitly out of scope" list (04 §12 DROP) | — |

## 5. User stories and acceptance criteria

Each criterion is numbered `AC-<story>.<n>` and maps to tests in `06-IMPLEMENTATION-PLAN.md`. "Agent" = any chunk coding agent.

### Workstream 0A — repo, tooling, CI, shared libs

**US-0A-1 Repository layout and path ownership.** As an agent, I want every path to have one owner and CI to reject PRs that touch other chunks' paths, so that parallel work never collides.
- AC-0A-1.1 Given a PR branch `c05/x` that modifies `services/api/src/modules/billing/index.ts`, When CI runs, Then gate 1 (path ownership) fails, and the message names the owning chunk (C4) and the offending path.
- AC-0A-1.2 Given a PR from `c05/x` that modifies only `services/api/src/modules/lab/**`, When CI runs, Then gate 1 passes.
- AC-0A-1.3 Given a PR that touches `db/` or `contracts/` without a `Refs: CR-…` line in the PR body, When CI runs, Then gate 1 fails with "contract change without CR reference" (program/04 §3 rule 5).
- AC-0A-1.4 Given a fresh clone, When `pnpm install && pnpm -w build` runs with no network access to anything except the package registry, Then the build succeeds and no generated file differs from the committed one.

**US-0A-2 UUIDv7.** As an agent, I want one UUIDv7 generator per codebase, so that ids are RFC 9562-shaped and time-ordered (04 D9).
- AC-0A-2.1 Given 10,000 ids generated in one process within one millisecond, When sorted as strings, Then the sort order equals generation order, and every id matches IC §2.1 `Uuidv7`.
- AC-0A-2.2 Given `createSeededUuidv7({ seed: 42, startMs })` called twice, When 100 ids are drawn from each, Then both sequences are identical (CV §8.3 deterministic fakes).
- AC-0A-2.3 Given the TS and Dart generators, When each produces an id for a fixed timestamp and fixed random bytes (shared fixture), Then both produce the same string.

**US-0A-3 B.S. dates.** As an agent, I want B.S. conversion through one wrapper with golden tests on both sides, so that invoices and reports show the same B.S. date everywhere (04 D12, D13).
- AC-0A-3.1 Given every row of `packages/test-fixtures/bsdate/golden-2000-2099.json`, When `bsToAd` and `adToBs` run in TS and in Dart, Then every result equals the fixture (CV §12 gate 15).
- AC-0A-3.2 Given an A.D. date whose B.S. year is outside 1975–2099, When `adToBs` is called, Then it throws `LimsError('common.date_out_of_range')`.
- AC-0A-3.3 Given the A.D. date that is Shrawan 1 of a B.S. year Y, When `fiscalYearBs` is called, Then it returns `"Y/(Y+1 mod 100, 2 digits)"` (e.g. `2082/83`), and for the previous day it returns `"(Y-1)/(Y mod 100)"` (04 L16).
- AC-0A-3.4 Given app code (outside `packages/shared-ts/src/bsdate` and `packages/shared-dart/lib/src/bsdate`) that imports `@remotemerge/nepali-date-converter`, `nepali_utils` or `bikram-sambat`, When lint runs, Then it fails (CV §15.3).

**US-0A-4 Money.** As an agent, I want integer-paisa money helpers with golden tests (CV §4.9).
- AC-0A-4.1 Given `money.fromPaisa(1.5)`, Then it throws (non-integer); given a value above `Number.MAX_SAFE_INTEGER`, Then it throws.
- AC-0A-4.2 Given each case in `packages/test-fixtures/money/golden.json` (line discount in basis points, VAT 13% = 1,300 bp per 04 L14, invoice-level discount allocation), When computed in TS and Dart, Then results equal the fixture (half-up to the paisa per CV §4.9).
- AC-0A-4.3 Given a money computation using a `number` with a fractional part anywhere in `packages/shared-ts/src/money`, When unit tests run with the fuzz case set, Then no intermediate value is non-integer.

**US-0A-5 Logger with PHI scrubbing.** As an agent, I want a logger that cannot emit PHI, so that DoD §1.8 passes by construction.
- AC-0A-5.1 Given a log call whose context includes the keys `patient_name`, `phone`, `barcode`, `otp`, `authorization` (any case), When it is written, Then those values are replaced by `"[REDACTED]"`.
- AC-0A-5.2 Given a free-text message containing a Nepali mobile-number-shaped string or a JWT-shaped string, When written, Then the scrubber masks it.
- AC-0A-5.3 Given any line written, Then it is one JSON object containing every mandatory field of CV §9.1 that the context provides.

**US-0A-6 Dev stack.** As an agent, I want `pnpm dev:up` to start everything I need locally, so that I can build against real Postgres, GoTrue and mocks.
- AC-0A-6.1 Given a machine with Docker, When `pnpm dev:up` runs, Then Postgres (`supabase/postgres:17.6.1.136`), GoTrue, Storage, PgBouncer, the mail sink and Prism mocks are healthy, migrations are applied and synthetic seeds are loaded.
- AC-0A-6.2 Given the dev stack is up, When an external interface address is port-scanned, Then no port answers (all bound to `127.0.0.1`, 04 S6).
- AC-0A-6.3 Given a fresh checkout, When `pnpm dev:up` runs, Then no secret equals a value from Supabase's `.env.example` (REQ-SEC-037), because `tools/devstack/init-secrets` generated them.

### Workstream 0B — database

**US-0B-1 Roles without RLS bypass.** As the platform, I want tenant tables owned by a NOLOGIN, non-BYPASSRLS role, and the app to connect as dedicated non-BYPASSRLS roles (04 D5).
- AC-0B-1.1 Given a migrated database, When `SELECT rolname FROM pg_roles WHERE rolname LIKE 'lims\_%' AND (rolbypassrls OR rolsuper)` runs, Then it returns zero rows.
- AC-0B-1.2 Given every table in every module schema, When its owner is checked, Then it is `lims_owner`; and `lims_owner` has `rolcanlogin = false`.
- AC-0B-1.3 Given the repository and config files, When CI greps for connection strings or role names `postgres`, `supabase_admin`, `service_role`, `supabase_etl_admin`, `supabase_read_only_user` outside the allowlist in `07-SECURITY.md` §7, Then there are no matches.

**US-0B-2 RLS on every tenant table.** As the platform, I want every tenant table to have ENABLE + FORCE RLS and per-command policies to `lims_app` (04 D4; IC X9).
- AC-0B-2.1 Given a migrated database, When CI lists tables in module schemas lacking `relrowsecurity` or `relforcerowsecurity`, Then the list equals `db/tests/rls_exempt.txt` exactly (CV §5.8), and each entry in that file has a reason.
- AC-0B-2.2 Given `pg_policies`, When CI inspects every policy, Then none has `roles` containing `public`, `anon` or `authenticated` on a module table, none has a `qual` or `with_check` equal to `true` (single allowlisted exception: `identity.platform_staff__select__owner_only`, `TO lims_owner USING (true)`, 08 A10.5), and every policy name matches `<table>__<command>__<scope>`.
- AC-0B-2.3 Given `db/policies/<schema>.sql`, When CI diffs it against `pg_policies` of a freshly migrated DB, Then there is no difference.
- AC-0B-2.4 Given every function in `db/meta/definer-inventory.yaml` that touches a FORCE-RLS table, When its contract test runs, Then each touched table has `relforcerowsecurity = true` during the test, the `<table>__<cmd>__owner_only` policy the inventory names exists in `pg_policies`, and the function returns or changes the rows the fixture expects (e.g. `app.is_platform_actor()` = true for an active platform staff row; each purge deletes its seeded expired rows); and no file under `db/tests/**` disables RLS or creates a stand-in table without ENABLE + FORCE RLS (08 A10.5; `05-SCHEMA.md` §4.3, §10 schema test 13).

**US-0B-3 Isolation probes for every table.** As the platform, I want an automated probe for every tenant table (CV §11.3; REQ-SEC-040).
- AC-0B-3.1 Given seeded tenants A and B and claims of tenant A, When the probe runs `SELECT` on any tenant table, Then zero rows with `tenant_id = B` are returned.
- AC-0B-3.2 Given claims of tenant A, When the probe inserts a row with `tenant_id = B`, Then the insert fails with SQLSTATE `42501`.
- AC-0B-3.3 Given claims of tenant A, When the probe updates or deletes rows of tenant B, Then zero rows are affected.
- AC-0B-3.4 Given claims of tenant A and a centre-scoped membership on centre A1, When the probe selects a centre-scoped table, Then no row with `centre_id = A2` is returned.
- AC-0B-3.5 Given claims of tenant A, When a child row is inserted referencing tenant B's parent id, Then it fails (composite FK or RLS) and the API maps it to `404 common.not_found`.
- AC-0B-3.6 Given a new table added in a migration without a probe entry, When CI runs, Then gate 10 fails, naming the table.
- AC-0B-3.6a Given claims of actor type `partner`, `portal`, `patient` or `device` in tenant A, When `app.has_all_centres()` is evaluated or a `__tenant`-only table is selected, Then the helper returns false and zero rows are returned (08 R3, R10 item 5); a `membership_centres`/`membership_branches` row for a non-`user` membership is refused.
- AC-0B-3.6b Given claims of actor type `partner`, `portal` or `patient` in tenant A, When the generated probe selects any table not marked `shared_with` in `db/meta/tables.yaml`, Then zero rows are returned; on `core.event_log` and `audit.access_log` the actor may INSERT only rows with its own actor id and reads zero rows, and on `core.idempotency_keys` it sees only its own rows (08 A17 P-16, A23.3; `05-SCHEMA.md` §10 schema test 24).
- AC-0B-3.7 Given no claims at all (`request.jwt.claims` unset), When `lims_api` selects any tenant table, Then zero rows are returned (fail-closed, CV §5.8).

**US-0B-4 Immutability.** As an auditor, I want class C/B rows to be impossible to edit except whitelisted lifecycle columns, and impossible to delete (CV §5.2, §5.7; 04 L5).
- AC-0B-4.1 Given a table with `app.enforce_mutable_columns(...)` attached, When an UPDATE changes a column not in the trigger arguments, Then it fails with SQLSTATE `P0001`, message `immutable_row`.
- AC-0B-4.2 Given every table registered as class C, B or A in `db/meta/tables.yaml`, When CI checks `has_table_privilege('lims_app', <t>, 'DELETE')`, Then it is false.
- AC-0B-4.3 Given class A tables (`audit.audit_log`, `audit.access_log`, `core.event_log`, every `<m>.event_inbox`), When CI checks UPDATE privilege for `lims_app`, Then it is false.

**US-0B-5 Audit trail.** As a tenant admin (via C2's viewer), I want every change to audited tables recorded with actor, tenant, centre, IP, user agent and request id (04 D11; REQ-ARCH-025).
- AC-0B-5.1 Given an audited table and a transaction opened by the API core with claims and request context, When a row is inserted, updated or deleted, Then exactly one `audit.audit_log` row is written in the same transaction with `actor_id`, `membership_id`, `tenant_id`, `centre_id` (when the row has one), `request_id`, `client_ip`, `user_agent`.
- AC-0B-5.2 Given an UPDATE, Then `old_values` and `new_values` contain only the changed columns and `changed_columns` lists them.
- AC-0B-5.3 Given `lims_app`, When it tries `INSERT INTO audit.audit_log` directly, Then it fails (no INSERT grant).

**US-0B-6 Migrations.** As C0, I want forward-only migrations that apply cleanly in DAG order (CV §5.12; CM §5 R3).
- AC-0B-6.1 Given an empty database bootstrapped with `db/bootstrap/`, When the runner applies all migrations, Then it succeeds; and when applied to a database holding the previous release's seed, Then it also succeeds (DoD §1.7).
- AC-0B-6.2 Given a migrated DB, When `db/tools/check-fk-dag` runs, Then every cross-schema FK points downstream → upstream along CM §5 R3, and no FK points into `billing` (CV §5.4).
- AC-0B-6.3 Given a migration file whose first statement is not the owner role switch, When CI runs, Then gate 9 fails.
- AC-0B-6.4 Given `billing` data of tenant A and B, When `db/tools/export-tenant-billing --tenant A` runs and the output is restored into an empty `billing` schema, Then row counts and checksums for A match and no B row exists (04 D16 design rule).

### Workstream 0C — contracts, codegen, mocks, fakes

**US-0C-1 Contracts are complete and valid.** As an agent, I want every interface in IC to exist as a machine-checked file.
- AC-0C-1.1 Given `contracts/events/`, Then it holds exactly the 25 event schemas of IC §3.25 (incl. §3.26) plus `_envelope.v1` and `_defs.v1`, and each IC example validates against its schema.
- AC-0C-1.2 Given `contracts/ports/`, Then it holds `common.ts` and the 13 ports of IC §4 (§4.2–§4.11, §4.15–§4.17) with the exact signatures, and `tsc --noEmit` passes.
- AC-0C-1.3 Given `contracts/errors.yaml`, `routes.yaml`, `permissions.yaml`, Then their content equals IC §8, §7, §11 entry for entry (a test parses IC's YAML blocks and compares).
- AC-0C-1.4 Given every `contracts/openapi/*.yaml`, When spec lint runs, Then each starts with `openapi: 3.0.3`, uses only constructs allowed by CV §4.12, every object schema has `additionalProperties: false`, every operation has `operationId`, `tags`, `security`, `x-permission` or `x-public`, `x-idempotency`, `x-rate-limit-tier`, `x-error-codes` and one request + one response example.
- AC-0C-1.5 Given an operation whose `x-permission` is not in `permissions.yaml`, or whose `x-error-codes` contains a code not in `errors.yaml`, When lint runs, Then it fails.

**US-0C-2 Generated clients.** As a UI or app agent, I want typed clients that are always current (REQ-ARCH-072/073).
- AC-0C-2.1 Given a spec change, When `pnpm codegen` runs, Then `packages/api-client-ts` and `packages/api-client-dart` regenerate, and CI gate 8 fails if the committed output differs.
- AC-0C-2.2 Given a breaking spec change without the `cr-approved-breaking` label, When gate 6 runs `oasdiff` 1.35.x, Then CI fails.

**US-0C-3 Fakes and contract suites.** As an agent, I want a fake for every port that passes the same suite the real implementation must pass (CV §8.3, §8.4).
- AC-0C-3.1 Given each of the 13 ports, When `pnpm --filter @lims/fakes test` runs, Then `run<Port>Contract` passes against the fake with every case listed in IC §4 for that port.
- AC-0C-3.2 Given a fake created twice with the same seed, Then both return identical data and ids.
- AC-0C-3.3 Given `fake.failNext('getTest', 'catalog.test_inactive')`, When `getTest` is called, Then it throws `LimsError` with that code once, and the next call succeeds.
- AC-0C-3.4 Given a fake seeded for tenants A and B, When called with A's context for B's id, Then it throws `common.not_found`.

**US-0C-4 HTTP mocks.** As a UI agent, I want Prism and MSW mocks from the spec examples (REQ-ARCH-074).
- AC-0C-4.1 Given `pnpm mock:<domain>`, Then Prism 5.16.0 serves that domain's spec on a fixed local port and returns the spec example for each operation.
- AC-0C-4.2 Given `@lims/fakes/msw`, Then a handler exists for every operationId and returns the spec example.

### Workstream 0D — runtime cores, UI kit, Flutter base

**US-0D-1 Module autoload.** As an agent, I want my module to be picked up by the API without editing a central list (CM §3 autoload rule).
- AC-0D-1.1 Given a new directory `services/api/src/modules/<m>/index.ts` exporting a valid `manifest`, When the API boots, Then its operations from `contracts/openapi/<m>.yaml` are mounted.
- AC-0D-1.2 Given a manifest missing a handler for an operationId in its spec, When the API boots, Then boot fails naming the operationId.
- AC-0D-1.3 Given a manifest whose `produces` list differs from the producer list in IC §3.25 for that module, When CI runs, Then it fails.

**US-0D-2 Authentication and tenant context.** As the platform, I want every request's tenant to come only from a verified JWT (04 D2, A7; REQ-SEC-013/066).
- AC-0D-2.1 Given a JWT with `alg: none`, a JWT signed with a different algorithm than pinned, an expired JWT (even by 1 s), a wrong `aud` or `iss`, When any non-public operation is called, Then the response is `401` with `auth.token_invalid` or `auth.token_expired`.
- AC-0D-2.2 Given a valid JWT for tenant A and a request body or header containing `tenant_id: B`, When the request runs, Then the database sees `app.current_tenant_id() = A` (the body field is rejected by spec validation as an unknown field).
- AC-0D-2.2a Given a valid GoTrue JWT that carries `tenant_id`/`membership_id`/`actor_type` claims of its own, or no `session_id`, When it is used, Then the extra claims are ignored and only the identity `claimsResolver` result reaches `request.jwt.claims`; without `session_id` the response is `401 auth.token_invalid` (08 R10).
- AC-0D-2.3 Given two concurrent requests from tenants A and B over the same PgBouncer server connection, When each reads `app.current_tenant_id()` inside its transaction, Then each sees its own tenant, and a statement outside a transaction sees NULL.
- AC-0D-2.4 Given a handler that returns 2xx for a non-public operation without having called `IdentityPort.assertRole`, When it runs under `LIMS_CORE_ENV` ∈ {dev, ci, staging}, Then the core turns the response into `500 common.internal` and logs `authz_not_asserted` with the operationId.
- AC-0D-2.5 Given a request with `X-Forwarded-For`, Then `ctx.clientIp` / `app.client_ip` equals that header only when the request carries a valid `X-Lims-Bff-Key` (kinds `staff_web`, `partner`, `portal`) or the TCP peer is in `LIMS_CORE_TRUSTED_PROXY_CIDRS`; otherwise it is the TCP peer address (08 A25 P-61; A13 D-32).
- AC-0D-2.6 Given an `identity` operation tagged `x-context: identity_auth` and listed in `LIMS_CORE_IDENTITY_AUTH_OPS`, Then `ctx.db.identityAuthTx` opens the transaction with identity system-actor claims and no tenant, `tx.bindTenant` succeeds once and a second call throws, and the authz guard does not fire; the same call from any other operation or module throws (08 A25 D-212).
- AC-0D-2.7 Given a handler that called `ctx.noRetry()`, When its transaction fails with `40001`/`40P01`, Then the request is not retried and ends with `503 common.dependency_unavailable`.

**US-0D-3 Errors.** As a client developer, I want every error as RFC 9457 problem+json with a registered code (CV §4.6).
- AC-0D-3.1 Given any non-2xx response, Then the body validates against `_common.yaml#/components/schemas/Problem`, `code` exists in `errors.yaml`, and the body contains no stack trace, SQL or file path.
- AC-0D-3.2 Given a database error SQLSTATE `P0001`/`immutable_row`, Then the response is `409 common.immutable_record`; given `42501` from an RLS check, Then `404 common.not_found`; given `23503` FK violation, Then `404 common.not_found`.
- AC-0D-3.3 Given `ctx.download.stream` for an object whose `scanState` is not `clean`, Then the response is `422 common.upload_quarantined`; for a `clean` object the response streams with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, an access-log row is written, and no signed URL appears in the response, its headers or the logs (08 A13 P-2).

**US-0D-4 Idempotency.** As a client on a flaky network, I want retried POSTs to be safe (CV §4.5).
- AC-0D-4.1 Given an operation with `x-idempotency: required` and no `Idempotency-Key`, Then `400 common.idempotency_key_required`.
- AC-0D-4.2 Given the same key and identical body sent twice after the first completed, Then the second response replays the stored status and body with header `Idempotent-Replayed: true`, and the handler runs once.
- AC-0D-4.3 Given the same key with a different body, Then `422 common.idempotency_key_reused`.
- AC-0D-4.4 Given the same key while the first request is still running, Then `409 common.idempotency_in_progress` with `Retry-After: 1`.
- AC-0D-4.5 Given the handler returns any status ≥ 400 (4xx or 5xx), Then no response is stored and the key is released — after the rollback, or inside the request transaction when the handler called `ctx.commitOnError()` (whose other writes survive) — and a retry with the same key runs the handler again (08 A25 D-202). A status < 400 response is stored and replayed (AC-0D-4.2).
- AC-0D-4.6 Given a platform-context operation (`provisionTenant`, `openSupportSession`, `invitePlatformStaff`) with an `Idempotency-Key`, Then the key is stored with `tenant_id` NULL; the same platform actor and key replays, and a second platform actor with the same key gets its own row (08 A25 D-213).

**US-0D-5 Outbox and event delivery.** As a producing module, I want `events.publish` to be atomic with my write, and consumers to receive each event at least once and process it once (CV §7).
- AC-0D-5.1 Given `events.publish` inside a transaction that then rolls back, Then no `core.event_log` row and no job exist.
- AC-0D-5.2 Given a payload that violates its schema, Then `publish` throws and the transaction rolls back.
- AC-0D-5.3 Given two publishes with the same `(tenant_id, event_type, idempotency_key)`, Then one `core.event_log` row exists and one fan-out happens; the same `(event_type, idempotency_key)` in another tenant creates a second row (review C0 m#41).
- AC-0D-5.4 Given an event with two subscribed modules, When the fan-out runs, Then exactly one job per subscriber is enqueued with identifier `evt.<module>.<event_type>` and `job_key = <event_id>:<module>`.
- AC-0D-5.5 Given the same event delivered twice to a consumer, Then the consumer handler body runs once (inbox), and the second delivery completes successfully.
- AC-0D-5.6 Given a consumer that throws on every attempt, When it reaches `max_attempts` (10 for `evt.*`, CV §7.5), Then one `core.dead_letters` row is written with a redacted message, and `lims_core_dead_letters_total{task}` increments.
- AC-0D-5.7 Given an `open` dead letter with `version = n`, When `ctx.core.deadLetters.replay` or `discard` is called with `expectedVersion ≠ n`, Then it throws `common.version_conflict` (409), the row keeps `state = 'open'` and `version = n`, and no job is enqueued; When called with `expectedVersion = n`, Then the state changes and `version = n + 1` (08 A6.4).
- AC-0D-5.8 Given an `open` dead letter with `version = n`, When `ctx.core.deadLetters.discard({ deadLetterId, expectedVersion: n, reasonText })` is called with a 1–500-char `reasonText`, Then `state = 'discarded'`, `resolution_note = reasonText`, `resolved_by`/`resolved_at` are set and `version = n + 1`; a `resolution_note` of 0 or 501 chars is rejected by `dead_letters__resolution_note__ck`; `replay` with an optional `reasonText` stores it the same way (08 A8.4).
- AC-0D-5.9 Given dead letters whose `job_payload` is non-empty, When `ctx.core.deadLetters.list` is called, Then every item is a `DeadLetterRow` (02-TRD §6.8) that includes `version` and `resolutionNote` and has no `job_payload` field (08 A8.5).
- AC-0D-5.10 Given a dead letter (tenant row, and a platform row with `tenant_id IS NULL`), When `ctx.core.deadLetters.get({ deadLetterId })` is called in platform context, Then it returns that `DeadLetterRow` with `version` and `resolutionNote` and no `job_payload`; When the id does not exist, Then it throws `common.not_found` (08 A9.1).
- AC-0D-5.11 Given dead letters in two tenants and platform rows with different states, task identifiers and `dead_at` values, When `ctx.core.deadLetters.list` is called with each of `state`, `platformRows: true`, `tenantId`, `taskIdentifier`, `deadAtFrom` (inclusive) and `deadAtTo` (exclusive), alone and combined, Then exactly the matching rows are returned, and paging with `cursor`/`limit` returns every matching row once (08 A9.2).
- AC-0D-5.12 Given an `open` dead letter with `version = n`, When `ctx.core.deadLetters.replay({ deadLetterId, expectedVersion: n, reasonText })` is called with a 1–500-char `reasonText`, Then `state = 'replayed'` and `resolution_note = reasonText`; When it is called without `reasonText`, Then `resolution_note` stays NULL; both for a tenant row and for a platform row (`app.dl_resolve`) (08 A9.3, A9.4).
- AC-0D-5.13 Given an `open` platform dead letter (`tenant_id IS NULL`) with a non-empty `job_payload` and `version = n`, When `ctx.core.deadLetters.replay({ deadLetterId, expectedVersion: n })` is called in platform context, Then `app.dl_resolve` returns the stored `job_payload` to core, core enqueues one job with the row's `task_identifier`, that payload and the replay job key of 02-TRD §7.4 in the same transaction, and `state = 'replayed'`; the value returned by `replay`, every `DeadLetterRow` and every captured log line contain no `job_payload` (08 A10.1, A8.5). With `expectedVersion ≠ n`, nothing is enqueued (AC-0D-5.7).
- AC-0D-5.14 Given an `open` **tenant** dead letter of a `per_tenant` task with `version = n`, When `ctx.core.deadLetters.replay` is called in platform context, Then exactly one job is enqueued, with `job_key = coalesce(job_key, task_identifier || ':' || id) || ':replay:' || (n + 1)`, inside `withTenantScope(row.tenant_id, <owning module's system actor>)`, and the state change and enqueue commit together; the same enqueue with platform claims only raises `job_tenant_mismatch` (08 A23.2).
- AC-0D-5.15 Given a `per_tenant` crontab entry and tenants in every status, When its schedule ticks, Then exactly one job per `active` or `suspended` tenant is enqueued with payload `{tenant_id}` and `job_key = '<identifier>:<tenant_id>:<tick ISO minute>'`, none for `provisioning`/`offboarded`, and a repeated tick for the same minute enqueues nothing new (08 A13 P-6, A23.1).
- AC-0D-5.16 Given `core.retention_purge`, When it runs, Then each purge function runs in its own transaction with `statement_timeout = 300000`, a 10,000+ row expired seed per table is fully deleted, and a function that reaches its 4-minute cap returns `capped = true` and increments `lims_core_retention_purge_capped_total{table}` (08 A25 D-200).

**US-0D-6 Port registry.** As an agent, I want fakes until the owner ships, and never fakes in production (CV §8.2).
- AC-0D-6.1 Given no module provides `CatalogPort`, When the API boots in dev, Then `ctx.ports.CatalogPort` is the fake, and `lims_core_fake_ports_active` = 1.
- AC-0D-6.2 Given `LIMS_CORE_ENV=production` or `staging` and any port resolving to a fake, Then boot fails for both API and worker. The one exception is a port listed in `services/api/src/core/ports/phase-stubs.ts` that resolves to its minimal phase stub (CR-C0-010).
- AC-0D-6.3 Given a port listed in `phase-stubs.ts` whose owner module now exists in `services/api/src/modules/`, When CI runs, Then it fails and asks for the port to be removed from the list.
- AC-0D-6.4 Given a module not listed in `PORT_CONSUMERS[<Port>]` (03-IC §4.x heading), When its code reads `ctx.ports.<Port>`, Then dev/ci/staging throw `common.internal` with log `port_consumer_not_listed`, and the `contracts` CI job fails on the static use (08 A19 P-46).
- AC-0D-6.5 Given `ctx.core.memberships.list` with each of `centreId`, `roleCode`, `permission`, `membershipIds` (≤ 200; unknown or other-tenant ids omitted), `activeOnly: false` and `limit`, Then only `actor_type = 'user'` memberships of the caller's tenant matching every given filter are returned with `isActive`; a partner, portal or patient caller gets `auth.forbidden` (08 A17 D-47).

**US-0D-7 Web shell.** As tenant staff, I want one consistent shell with navigation limited to what my role allows, session timeouts, and help on every screen.
- AC-0D-7.1 Given a user whose permissions exclude `billing.invoice.read`, When the shell renders, Then no navigation entry requiring it is shown, and a direct visit to that route renders the permission-denied state (the API still enforces; the shell only hides).
- AC-0D-7.2 Given a session idle for the tenant's `idleTimeoutMinutes` (15–30, 04 A8), When the next request arrives, Then the BFF relays C2's `401 auth.session_expired` from `resolveSession` (08 R10; the BFF does not decide expiry itself in staging/production) and the shell shows the sign-in prompt; 2 minutes before expiry a warning dialog offers "Stay signed in".
- AC-0D-7.3 Given any page, Then the browser receives no JWT, refresh token or Supabase client (bundle scan finds no `@supabase/*` import; cookies are HttpOnly, Secure, SameSite=Lax) (REQ-SEC-068).
- AC-0D-7.4 Given a cross-origin POST to the BFF, Then it is rejected with `403 auth.csrf_failed` (REQ-SEC-091).
- AC-0D-7.5 Given two modules declaring the same keyboard shortcut, When the web build runs, Then it fails naming both modules.
- AC-0D-7.6 Given any staff-web page, Then the response CSP contains a per-request script nonce and `img-src 'self' data:` and no remote image origin (08 A18.1; header test).

**US-0D-8 Design system.** As a UI agent, I want accessible components and tokens so that I never build look-alikes (CV §14).
- AC-0D-8.1 Given every foreground/background token pair declared in `packages/ui/tokens/contrast-pairs.json`, When the token test runs, Then every pair meets WCAG 2.2 AA contrast (4.5:1 text, 3:1 large text and UI parts).
- AC-0D-8.2 Given a tenant accent colour that fails 4.5:1 against white, When the shell applies it, Then the derived `--lims-accent-fg` is darkened until it passes, or the default accent is used.
- AC-0D-8.3 Given `<StatusChip>` or `<FlagBadge>`, Then status is conveyed by text as well as colour ("High"/"Low" per 00 §4; CV §14).
- AC-0D-8.4 Given `<BarcodeInput>` and a keyboard-wedge scan (characters ≤ 30 ms apart ending in Enter), Then `onScan(value, { source: 'scanner' })` fires once with the uppercased value; a value outside `[A-Z0-9]{1,20}` shows the inline error and does not fire `onScan`.
- AC-0D-8.5 Given `<DatePicker calendar="BS">`, When a user picks a B.S. date, Then `onChange` receives the A.D. `IsoDate`, and the field displays the B.S. date with the "B.S." suffix plus the A.D. hint.
- AC-0D-8.6 Given an automated accessibility scan (axe-class rules) over the component story set, Then no critical or serious violation remains.
- AC-0D-8.7 Given Devanagari text in any component, Then it renders with the bundled Noto Sans Devanagari, and no font request leaves the origin.

**US-0D-9 Flutter base.** As an app agent, I want a theme and base widgets from the same tokens.
- AC-0D-9.1 Given `tokens.json`, When codegen runs, Then `packages/ui-flutter/lib/src/tokens.g.dart` is regenerated and equals the committed file.
- AC-0D-9.2 Given `LimsStatusChip` and `StatusChip` for the same status, Then both use the same colour token and label key.

### Spikes (cross-workstream)

**US-SP-1 Unverified platform facts become decisions.** As every agent, I want C0 to prove or replace each UNVERIFIED platform assumption before I depend on it.
- AC-SP-1.1 Given each spike SP-1…SP-6 in `06-IMPLEMENTATION-PLAN.md` §1, Then a decision record exists in `db/meta/decisions/` or `services/*/src/core/DECISIONS.md` [CONV path] stating outcome, evidence (commands run and outputs, pinned versions) and which fallback (if any) was selected, before any Wave-1 chunk starts work that depends on it.

## 6. Success metrics

| Metric | Target | How measured |
|---|---|---|
| Wave-1 start readiness | Every Wave-1 chunk's DDL, OpenAPI, events, ports, fakes and contract suites merged before that chunk's first implementation task | C0 milestone M3 checklist (`06-IMPLEMENTATION-PLAN.md` §3) |
| Collisions | 0 merged PRs touching foreign paths | gate 1 history |
| Isolation | 100% of tenant tables and 100% of operations covered by probes; 0 probe failures on `main` | gate 10 coverage report |
| Fake fidelity | Every real port implementation passes the same suite as its fake at its owner's chunk gate (DoD §3.2) | CI |
| CR turnaround | Blocking CR triaged within 1 working day; non-blocking batched daily (program/04 §3.3) | CR log timestamps |
| Core overhead | API core overhead p95 ≤ 5 ms per request excluding handler work (`02-TRD.md` §10) | load test |
| Event latency | Commit → consumer start p95 ≤ 2 s at the 10-lab peak (`02-TRD.md` §10) | `lims_core_event_fanout_lag_seconds` |
| B.S. parity | 100% of golden rows pass in TS and Dart | gate 15 |

## 7. Phase

Phase 0 / Wave 0. C0 then stays active for the whole programme:
- a **contract wave** for Wave 2 and another for Wave 3 (CM §1);
- continuous CR handling (program/04).

C0's own tables and cores have no phase gating. Phase-2/3 permission codes are seeded with their `phase` attribute (IC §11) and are inert until their module exists.

## 8. Dependencies (contracts only)

C0 depends on no other chunk's code. It depends on these documents and decisions:

| Needs | From | Used for |
|---|---|---|
| Each chunk's `05-SCHEMA.md` | C1–C18 | DDL translation (0B) |
| Each chunk's `02-TRD.md` endpoint tables | C1–C18 | OpenAPI transcription (0C) |
| `IdentityPort` semantics, the BFF session-store contract, platform-identity claims | C2 | Web core session mechanics, system-actor permissions (CR-C0-003, CR-C0-004) |
| Infra conventions for staging/prod images and secrets | C1 | Dockerfiles in service roots must accept C1's runtime config; dev stack is independent |
| Founder decision B10 (migration linter) | founder | gate 9 |

## 9. Blocked items and the default built meanwhile

| B# | Effect on C0 | Default C0 builds (program/07) |
|---|---|---|
| B6 | Invoice series granularity unknown | `billing` DDL keeps a configurable series key; counter per (tenant, series, B.S. FY) as specified by C4 |
| B10 | No migration linter | CI gate 9 = manual migration checklist (CV §5.12) as a required review item, plus C0's own scripted checks (owner switch, no `ENUM`, RLS-in-same-file, `CONCURRENTLY` alone in a non-transactional file) |
| B11 | No foreign touchpoints | Dev stack and UI kit contain no foreign CDN, fonts or telemetry; local mail sink only |
| B15 | Legal retention periods | Retention values are data in `db/meta/tables.yaml` and tenant config; defaults from 04 I8 and CV §5.11 |
| B17 | IRD "stored separately" | Shared schema + RLS; `billing` schema isolatable per tenant with a tested per-tenant export/restore (AC-0B-6.4) |
