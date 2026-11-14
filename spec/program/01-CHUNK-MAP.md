# 01 — Chunk Map: how the work is split so agents never collide

Status: DECISION, 2026-11-05. Inputs: `research/00-scope-baseline.md`, `research/04-consolidated-decisions.md` (wins over everything else except 00). Where this file and 04 disagree, 04 wins and this file gets a change request.

## 0. The one idea that makes parallel work possible

Parallel agents collide in only three ways:
1. **Two agents edit the same file.**
2. **Two agents each invent the shape of the same thing.** Examples: an API response, a table, an event. Each works alone, then breaks at integration.
3. **One agent's code silently depends on another agent's unfinished behaviour.**

The rules below remove all three:

| Collision type | Rule that removes it |
|---|---|
| Same file | Every path in the repo has exactly **one owning chunk** (§3). An agent may only create or modify files under paths its chunk owns. CI rejects a PR that touches unowned paths (CODEOWNERS + path check). |
| Same shape invented twice | All **shared shapes are written once, by Chunk C0, before anyone else starts**: database DDL + RLS, OpenAPI specs, event schemas, port interfaces, design tokens, error codes. Feature chunks *consume* these. They never redefine them. |
| Hidden behaviour dependency | Chunks talk to each other only through four kinds of declared interface: HTTP endpoints, events, ports and published read views (§5). C0 also ships a **fake/mock for every interface**, so each chunk builds and tests against the fake until the real owner delivers. |

Consequence: **the database schema and API contracts are centrally owned (by C0), while business logic, screens and jobs are owned by feature chunks.**
- A feature chunk that needs a new column or endpoint files a Change Request (`program/04-CHANGE-REQUESTS.md`). It does not edit `db/` or `contracts/`.
- Every chunk's own `05-SCHEMA.md` and API sections are the *specification* C0 implements.

## 1. Execution order (waves are about dependencies, not calendar)

```
Wave 0  ── C0 Foundation & Contracts ── (4 internal parallel workstreams 0A–0D)
              │ freezes: DDL+RLS for all chunks, OpenAPI per domain, events, ports+fakes,
              │          UI kit + app shells, shared libs, seed data, CI gates
              ▼
Wave 1  ── all of these run in parallel ──────────────────────────────────────────
   C1 Infra & Ops        C2 Identity & Admin     C3 Catalog & Pricing
   C4 Front Desk & Billing   C5 Lab Workflow     C6 Reporting & Delivery
   C7 Instrument Integration  C8 Analytics & MIS
              ▼  (C0 opens a short "contract wave" for Wave-2 DDL/APIs; can overlap with Wave 1)
Wave 2  ── parallel ──────────────────────────────────────────────────────────────
   C9 Quality Engine (QC/Westgard, auto-verification, TAT alerts)
   C10 Microbiology    C11 Specialty Pathology (histo/cyto/IHC/molecular)
   C12 Inventory       C13 B2B Partner Portal      C14 Smart Report
   C15 Payment Gateways (eSewa/Khalti/Fonepay)
              ▼
Wave 3  ── parallel ──────────────────────────────────────────────────────────────
   C16 Patient Engagement (patient Flutter app, bookings, slots, queue, reminders, loyalty)
   C17 Home Collection (phlebotomy Flutter app, offline sync, routes)
Blocked ── C18 Legacy Data Migration (eLabs) — needs export format (B4)
```

- **Strict ordering:** only C0 must come first. Every other chunk depends on C0's contracts, not on each other's code. Because of the fakes, any Wave-2 or Wave-3 chunk *could* start the day its contracts are frozen.
- **Why waves still help:** grouping keeps the number of open change requests manageable. 04 §12 phasing is respected (Phase 1 = Wave 1, Phase 2 = Wave 2, Phase 3 = Wave 3).
- **Client override:** client blocker B1 (priority ranking) may move C16/C17 earlier. That is safe: the chunk only needs its contracts frozen first.

## 2. Chunk list

Columns: phase from 04 §12 · what it delivers · deployable(s) touched.

| ID | Chunk | Phase | Delivers (scope summary — full scope in that chunk's PRD) | Deployables |
|---|---|---|---|---|
| **C0** | Foundation & Contracts | 0 | Monorepo, tooling, CI gates; **all DDL + RLS + isolation tests**; OpenAPI per domain + generated TS/Dart clients + mocks; event JSON Schemas; port interfaces + fakes; API/worker/web runtime cores (auth, tenant context, errors, idempotency, rate-limit hooks, autoload); UI kit + web shell; Flutter base package; shared libs (UUIDv7, B.S. dates, money, error codes); synthetic seed generator; local dev stack (docker compose) | all (cores only) |
| **C1** | Infrastructure & Operations | 1 | Nepal VMs config (as code), self-hosted Supabase hardened (port bindings, secrets), nginx edge + TLS + `limit_req`, PgBouncer, Graphile Worker runtime, backups (WAL to 2nd site), restore drills, monitoring/alerting, log shipping, secrets management, deploy pipelines, environments (dev/staging/prod), DR runbooks | `infra/` |
| **C2** | Identity, Access & Administration | 1 | Staff login (BFF), MFA/TOTP, sessions/timeouts, password policy, user/role/membership management, branch & collection-centre management, tenant settings (letterhead, calendar display, numbering prefixes), tenant provisioning (platform admin console), audit-log & access-log viewer, user lock/unlock, IRD Annex workflow tracking for each tenant | api `identity`, web `admin`, web `platform` |
| **C3** | Catalog & Pricing | 1 | Departments, specimen types, containers, tests (analytes, units, methods, decimals, formulas, result types, workflow type), panels/packages, versioned reference ranges, critical limits, short-code comment library, doctors, affiliations/credit parties, price lists (per doctor/hospital/centre) + Excel import/export, urgent surcharge rules, TAT targets per test (data only) | api `catalog`, web `catalog` |
| **C4** | Front Desk & Billing | 1 | One-page registration (patient search/create, OPD/IPD/cash/credit, centre, referrer quick-add, test search, TRF upload, urgent flag, discounts with reason + approver), orders & order items, IRD-compliant immutable invoicing (gapless per tenant+FY, cancel/credit note, reprint "copy of original", print counts, audit trail, CBMS sync, Excel/XML/PDF exports, sales register), payment-method ledger (cash/card/QR/wallet recorded, part payments, reversals), dues, credit-party monthly billing, daily cash collection by staff/method, registration SMS trigger, receipts | api `frontdesk`, api `billing`, web `frontdesk`, web `billing` |
| **C5** | Lab Workflow | 1 | Specimen lifecycle state machine (barcode label print, collect, receive, accept/reject with reason, recollection, aliquots), worklists by department/analyser, manual result entry, formula evaluation, short-codes, previous results + trend graph, delta checks, critical-value detection + notification log, technologist verification, pathologist approval, result lock, amendments (versioned), TAT timestamps + pending list, worksheets, QC **data capture** (no rule engine), patient status board | api `lab`, web `lab` |
| **C6** | Reporting & Delivery | 1 | Report assembly (department grouping, methods, specimen lines, flags), template/letterhead system (on/off, logo, signatures, watermark), Chromium PDF renderer service, narrative report engine (radiology/USG/endoscopy/cytogenetics free-text with images), outsourced-PDF merge (sandboxed qpdf), release rules (hold-till-paid via billing port, partial/bulk release), report versioning, QR verify (public), delivery: WhatsApp link-only template, SMS, email link, print; delivery log; **patient web portal** (link + OTP, download) | api `reporting`, `services/renderer`, `apps/portal`, web `reporting` |
| **C7** | Instrument Integration | 1 | Go bridge agent (Windows service; ASTM E1381/E1394 + HL7 v2/MLLP; serial + TCP; encrypted local queue; batched upload; heartbeat; signed config/update), ingest API (device token, idempotency), message archive, parser framework + per-analyser drivers (driver per model once manual obtained), instrument registry, analyte code mapping UI, host-query/worklist download where supported, agent fleet monitoring UI | `apps/bridge-agent`, api `instruments`, web `instruments` |
| **C8** | Analytics & MIS | 1 | Owner dashboard (patients, income, tests, pending), income by department, top referrers/centres, referral-incentive report (never labelled "commission"), daily/monthly MIS, TAT reports, export to Excel/PDF, scheduled report emails (link-only); B2C dashboard (00 §3.11): booking/queue tiles from `engagement.v_pub_*` after C16 (later additive CR, 08 A19 D-123) | api `analytics`, web `analytics` |
| **C9** | Quality Engine | 2 | QC material/lot/target setup, Levey-Jennings charts, Westgard multirule engine (per-lab classic/modern, N-per-run aware), QC run acceptance/rejection, hold on patient results after failed QC, auto-verification rule engine, TAT targets + alerts/escalations | api `quality`, web `quality` |
| **C10** | Microbiology | 2 | Culture workflow (plates, incubation, reads), isolates, organism coding, AST panels, raw MIC/zone + interpretation as coded set (CLSI/EUCAST + version), preliminary/final/amended micro reports, ID/AST instrument results via C7 events | api `micro`, web `micro` |
| **C11** | Specialty Pathology | 2 | Histopathology (accession, grossing, blocks, slides, stains, IHC), cytology, molecular test narrative/structured reports, synoptic templates, images | api `anatomic`, web `anatomic` |
| **C12** | Inventory | 2 | Items, lots/expiry, stores per branch, consumption models (per test/cal/QC from LIS counts), stock movements, wastage, purchase orders, reorder alerts, analyser-wise consumption reports | api `inventory`, web `inventory` |
| **C13** | B2B Partner Portal | 2 | Partner (referring lab/hospital/clinic) accounts, partner users, sample submission/manifest, tracking status, report download, partner price list view, statements; separate web app | api `partners`, `apps/partner` |
| **C14** | Smart Report | 2–3 | Rules-based health summary (score, organ tiles, deranged-parameter summary, pathologist-approved advice templates, follow-up test suggestions), template library + approval workflow, structured output consumed by renderer/portal/app; optional self-hosted LLM fluency layer (behind flag, founder approval) | api `smartreport`, web `smartreport`, `services/renderer/templates/smart/` |
| **C15** | Payment Gateways | 1.5–2 | `PaymentProvider` implementations for eSewa ePay v2, Khalti KPG-2, Fonepay (blocked B8), payment intents, server-side verification, webhook/callback handling, idempotency, daily reconciliation, refunds workflow | api `payments`, worker `payments`, web `payments` |
| **C16** | Patient Engagement | 3 | Patient Flutter app (login by phone OTP, family members, bookings, reports, smart report view, notifications), appointment slots, queue tokens + display, reminders/follow-ups, minimal loyalty/membership | `apps/patient_app`, api `engagement`, web `engagement` |
| **C17** | Home Collection | 3 | Phlebotomy Flutter app (offline-first drift DB, assigned visits, route list, patient ID check, collection capture with barcode scan, payment capture as ledger entry, sync), dispatch/assignment web screen | `apps/phlebo_app`, api `homecollection`, web `homecollection` |
| **C18** | Legacy Data Migration | blocked (B4) | eLabs export ingestion → staging schema → mapping → validation → reconciliation report → cut-over runbook | `tools/migration` |

**Explicitly out of scope** (04 §12 DROP list; reversible by change request plus founder approval):
- dedicated cytogenetics module (use C6 narrative engine)
- real-time reagent telemetry
- supplement upsell
- kiosk
- CRM suite
- generic document vault
- HR/payroll
- marketing & sales-team management
- marketing website/CMS
- PACS/DICOM
- SaaS subscription billing of labs (manual for now)

**Wishlist item 9 (training):** this is a service, not a chunk. Each chunk ships user-manual pages and in-app help for its screens (an IRD Procedure 2074 cl.6(ढ) requirement for billing).

## 3. Repository layout and path ownership (the collision firewall)

Monorepo (04 S19). Package manager: pnpm workspaces (TS), Dart pub workspace for Flutter, Go module for the agent. Every path below has one owner. **No path is shared.**

```
lims/
├── .github/                          C0-0A (CODEOWNERS, CI workflows incl. deploy-*.yml — C1 required reviewer; PR templates)
├── package.json, pnpm-workspace.yaml, pnpm-lock.yaml, pubspec.yaml (Dart workspace), analysis_options.yaml   C0-0A
├── tsconfig.base.json, eslint config, .prettierrc, .nvmrc, turbo.json, .gitignore, .gitleaks.toml          C0-0A
├── docs/
│   ├── program/                      DOC OWNER (founder)
│   ├── chunks/Cxx-*/                 DOC OWNER
│   └── manual/<module>/              owning chunk (incl. partners → C13, payments → C15, engagement → C16, homecollection → C17)
├── infra/                            C1 (incl. edge/public-routes.yaml, edge/egress-allowlist.yaml, THIRD-PARTY-OPS.md, providers/<name>/)
├── db/                               C0-0B ONLY (migrations/, policies/, seeds/, tests/, bootstrap/, meta/{tables,definer-inventory,system-actors,index-exceptions}.yaml, tools/)
├── contracts/                        C0-0C ONLY
│   ├── openapi/<domain>.yaml, openapi/_common.yaml
│   ├── events/<event-name>.schema.json
│   ├── ports/                        (incl. BillingCommandPort.ts, RenderPort.ts, EngagementPort.ts; legacy-common.ts + Legacy*ImportPort.ts reserved — DEFER B4)
│   ├── render/<templateKey>.schema.json   (new — RenderPort data schemas)
│   ├── errors.yaml, routes.yaml, permissions.yaml
├── packages/
│   ├── shared-ts/                    C0-0A (uuidv7, bsdate, money, decimal, formula, spreadsheet, errors, validation, logger, routes, crypto)
│   ├── shared-dart/                  C0-0A
│   ├── test-fixtures/                C0-0A
│   ├── api-client-ts/, api-client-dart/, fakes/ (incl. src/stubs/, contract-tests/)   C0-0C
│   ├── ui/, ui-flutter/              C0-0D
├── services/
│   ├── api/
│   │   ├── package.json, tsconfig.json, Dockerfile, src/main.ts   C0-0D
│   │   ├── src/core/                 C0-0D (incl. core/ports/phase-stubs.ts, core/storage/, core/uploads/)
│   │   └── src/modules/<module>/     owning chunk
│   ├── worker/
│   │   ├── package.json, tsconfig.json, Dockerfile, src/main.ts   C0-0D
│   │   ├── src/core/                 C0-0D
│   │   └── src/jobs/<module>/        owning chunk
│   └── renderer/                     C6, except templates/smart/ → C14, templates/billing/ → C4, templates/analytics/ → C8
├── apps/
│   ├── web/
│   │   ├── package.json, tsconfig.json, next.config.*, Dockerfile   C0-0D
│   │   ├── src/core/                 C0-0D (shell incl. support-session banner slot, BFF session core, nav registry, API proxy, help)
│   │   ├── src/middleware.ts         C0-0D (excludes (auth) and (display) from the staff-session requirement)
│   │   ├── src/app/layout.tsx        C0-0D
│   │   ├── src/app/(staff)/layout.tsx  C0-0D
│   │   ├── src/app/(staff)/<module>/ owning chunk (incl. admin → C2, partners → C13, payments → C15, engagement → C16)
│   │   ├── src/app/(auth)/**         C2 (incl. its layout.tsx; login, MFA, recovery, session-expired pages; URLs /auth/…)
│   │   ├── src/app/(platform)/**     C2 (incl. its layout.tsx; URLs /platform/…; requires session kind platform)
│   │   ├── src/app/(display)/**      C16 (incl. its layout.tsx; /queue-display; display-token auth, no staff shell, no nav)
│   │   ├── src/features/<module>/    owning chunk (identity, admin, platform → C2; partners → C13; payments → C15; engagement → C16)
│   │   └── tests/e2e/<module>/       owning chunk of `<module>` (per the module → owner table below)
│   ├── portal/                       C6 (incl. app-link association files and app fallback pages — content inputs from C16 and C17; 08 A13 D-38)
│   ├── partner/                      C13
│   ├── patient_app/                  C16 (Flutter)
│   ├── phlebo_app/                   C17 (Flutter)
│   └── bridge-agent/                 C7 (Go)
└── tools/
    ├── codegen/                      C0-0C
    ├── devstack/, lint/              C0-0A
    └── migration/                    C18
```

**Module → owner table** (api `services/api/src/modules/<m>`, worker `services/worker/src/jobs/<m>`, web `apps/web/src/{app/(staff),features}/<m>`, DB schema `<m>`):

| Module (= Postgres schema) | Owner | Notes |
|---|---|---|
| `core` | C0 (tables) / C2 (logic) | tenants, branches, centres, users-profile, memberships, roles. C2 writes the admin logic; DDL stays with C0 |
| `identity` | C2 | sessions, MFA enrolment metadata, password-policy records (GoTrue holds credentials) |
| `audit` | C0 (tables, triggers) / C2 (viewer) | `audit_log`, `access_log` — append-only |
| `catalog` | C3 | |
| `frontdesk` | C4 | patients, orders, order_items, discounts, TRF attachments |
| `billing` | C4 | invoices, invoice_lines, credit_notes, ledger, counters — **isolatable per tenant (04 D16)** |
| `lab` | C5 | specimens, tests-in-progress, results, verifications, amendments, critical-value log, QC raw data |
| `reporting` | C6 | reports, versions, templates, deliveries, QR tokens, portal links/OTP |
| `instruments` | C7 | agents, devices, instruments, driver configuration, messages archive. **Analyte/test code maps are catalog data owned by C3** (`catalog` schema, `CatalogPort.mapInstrumentCode`); C7's mapping UI writes them through C3's HTTP API (03-INTERFACE-CATALOG resolved X4) |
| `analytics` | C8 | read-only materialised views over published views |
| `quality` | C9 | |
| `micro` | C10 | |
| `anatomic` | C11 | |
| `inventory` | C12 | |
| `partners` | C13 | |
| `smartreport` | C14 | |
| `payments` | C15 | gateway intents, callbacks, reconciliation (the ledger itself stays in `billing`) |
| `engagement` | C16 | |
| `homecollection` | C17 | |
| `migration_staging` | C18 | never exposed to API roles |

Web route groups outside `(staff)`: `apps/web/src/app/(auth)/**` and `(platform)/**` → C2 (incl. their `layout.tsx`); `(display)/**` → C16. Renderer templates: `services/renderer/templates/smart/` → C14, `templates/billing/` → C4, `templates/analytics/` → C8; the rest of `services/renderer/` → C6. CODEOWNERS also maps `docs/manual/<module>/`, `services/worker/src/jobs/<module>/` and `apps/web/tests/e2e/<module>/` per this table (CR-C13-001, CR-C16-001; e2e folder from the C9 hand-off). (08 R14)

Supabase image digests: `infra/compose/supabase/upstream/UPSTREAM.lock` (C1) is the single source. C0's dev stack (`tools/devstack/compose.yaml`) reads them from it, and a CI check (C0-0A, wired per 08 A13 P-14) fails when the digests differ. C0 reads a C1 file; ownership is unchanged. (08 A25 D-208)

**Autoload rule (prevents a shared registry file):**
- The API core discovers modules by scanning `src/modules/*/index.ts`.
- The worker discovers jobs by scanning `src/jobs/*/index.ts`.
- The web shell builds the navigation from each module's `src/features/<m>/nav.manifest.ts` at build time, into a generated, uncommitted file.
- No chunk ever edits a central list.

## 4. What each chunk's agent may and may not do

**May:**
- Create and modify files under its owned paths.
- Run the whole monorepo locally.
- Read every file.
- Write tests anywhere under its owned paths.
- Add dependencies to a package the chunk owns entirely (`apps/portal`, `apps/partner`, `apps/patient_app`, `apps/phlebo_app`, `apps/bridge-agent`, `services/renderer`, `tools/migration`). Dependencies of the shared packages `services/api`, `services/worker` and `apps/web` are added by C0-0D on a CR (shared-lib type); the requesting chunk lists the dependency row in its own `02-TRD.md`. (CR-C0-002, 08 R14)
- Keep CI gate scripts and alert rule files in its own paths and list them in its TRD tables 'CI jobs for C0-0A' (job id, trigger paths, runner OS, command) and 'Alert rules for C1' (expr, for, severity, route). C0-0A and C1 wire them through one CR per chunk. (08 A13 P-14)

**Must:**
- Specify every SECURITY DEFINER it requests in its own 05-SCHEMA with: (a) the full SQL body; (b) every `__<cmd>__owner_only` policy `TO <function owner>` that it needs, with the narrowest USING (08 A10.5); (c) how the policies are gated: tenant-claim functions on `app.current_tenant_id()` plus the claim columns they need; pre-tenant functions on an `app.pre_*` GUC set inside the body (08 A12.1); maintenance functions on `app.maintenance = '<function name>'` (08 A12.2); (d) its 08 §4.7 / 03-IC §13.3 inventory row; (e) the A12.7 FORCE-RLS tests. Wording such as 'C0 assigns the mechanism' or 'C0 decides' is not allowed. A per-tenant class-E retention delete is not a DEFINER (02-CV §5.11, P-18(c)). C0-0B transcribes the SQL. (08 A19 P-41)
- Keep one row per 08 Addendum (A1 onward) in its 02-TRD change-history table. The row is either 'applied <date> — <P-/D-/A-items that touch this chunk, with the files changed>' or 'not applicable'. A chunk whose table stops before the latest addendum is not 'done'. The final sweep checks this by script (every chunk × every addendum id). (08 A25 P-60)

**May not:**
- Edit `db/`, `contracts/`, `packages/*`, any `core/` folder, or another chunk's module.
- Define a table, endpoint, event or error code that is not in the contracts.
- Call another module's tables directly (§5 rule R1).
- Copy-paste another chunk's code.
- Use any foreign service not in 04 §11.

**When blocked:**
1. File a Change Request (template in `04-CHANGE-REQUESTS.md`).
2. Keep working against the fake.
3. Never "temporarily" patch someone else's path.

## 5. How chunks talk to each other (the only four allowed channels)

| Channel | Use for | Defined by | Example |
|---|---|---|---|
| **HTTP (OpenAPI)** | Apps/UIs → API; external systems | C0 `contracts/openapi/<domain>.yaml` | `POST /v1/frontdesk/registrations` |
| **Events** (Graphile Worker jobs, transactional outbox) | Asynchronous "something happened" across modules | C0 `contracts/events/*.schema.json` | `frontdesk.order.created` → C5 creates specimens |
| **Ports** (in-process TS interfaces inside the API) | Synchronous questions one module must answer for another *within a request* | C0 `contracts/ports/*.ts` + fakes in `packages/fakes` | Reporting asks `BillingPort.getReleaseEligibility(orderId)` before release |
| **Published read views** (`<schema>.v_pub_*`, read-only grants) | Cross-module *reporting* reads only (C8 analytics, C13/C16 read models) | C0 DDL, specified in owner's 05-SCHEMA | `billing.v_pub_invoice_daily` |

Rules:
- **R1 — No foreign tables.** A module's code reads and writes only its own schema's tables. Exceptions: the `core` tables (tenants, branches, centres, users, memberships) are readable by all modules through C0's core repository functions, and published views are readable through their grants.
- **R2 — Writes cross modules only by event or port.** Never by SQL into another schema.
- **R3 — Foreign keys across schemas only point "downstream → upstream"** along the DAG `core → catalog → frontdesk/billing → lab → instruments → reporting → analytics`. Wave-2/3 schemas may reference these but not the reverse. Composite `(tenant_id, id)` FKs per 04 D8. Because C0 writes all DDL, the migration order is C0's problem, not the chunks'.
- **R4 — Events are facts, past tense, versioned** (`.v1`), with these envelope fields: `event_id` (UUIDv7), `tenant_id`, `occurred_at`, `actor`, `idempotency_key`. Consumers must be idempotent on `event_id`.
- **R5 — Ports are versioned interfaces; the owner implements, consumers depend on the interface only.** Until the owner merges, the fake from `packages/fakes` is registered.
- **R6 — Non-staff actors.** Handlers for patient, portal and partner actors use only their own module's tables and the owner-supported actor reads listed in 02-CV §8.5; every other cross-module call on their behalf runs in the module's worker as its system actor (08 R8).

### 5.1 Interface catalog (names fixed here; payload detail in `03-INTERFACE-CATALOG.md`)

**Accepted additions and resolutions (2026-11-05).** These are binding, and `03-INTERFACE-CATALOG.md` is authoritative for their detail. The catalog labels the additions A1–A8, because P0–P3 are its PHI class labels.
- **Additions P1–P8:**
  - P1: `LabPort.submitModuleResult` (C10/C11 → C5).
  - P2: C12 consumes `lab.result.verified.v1` and `instruments.qc.received.v1`.
  - P3: C9 consumes `lab.specimen.status_changed.v1` and `reporting.report.released.v1`.
  - P4: C10/C11 consume `lab.specimen.status_changed.v1`.
  - P5: new event `engagement.booking.cancelled.v1` (C16 → C4, C17).
  - P6: `contracts/permissions.yaml` permission registry (C0).
  - P7: C0 platform tables `core.event_log`, per-module `event_inbox`, `core.dead_letters`, `core.idempotency_keys`, and the `app.enqueue_job` wrapper.
  - P8: C5 consumes `reporting.report.released.v1`.
- **Resolutions X1–X12:**
  - Normal paths: the instrument-result event is the bulk path and the port is for re-match/replay; the `BillingPort` call is the real gateway write and the event is a safety net; bookings come from C16 by event, and from C13/C17 by port.
  - C1 takes agent health as metrics, not events.
  - The worker builds the same port registry as the API.
  - RLS policies target a `lims_app` group role.
  - OpenAPI is authored 3.0.3-compatible.
  - `SmartReportPort.buildSummary` and `QualityPort.qcStatusFor` take a single input object.
  - C8 reads rejections through `lab.v_pub_rejection_daily`.

Where the tables below differ from these, these win.

**Events**

| Event | Producer | Consumers | Meaning |
|---|---|---|---|
| `frontdesk.order.created.v1` | C4 | C5, C6, C8, C17 | New order with items (test/panel ids, priority, centre, referrer) |
| `frontdesk.order.items_changed.v1` | C4 | C5, C6 | Items added/removed before processing |
| `frontdesk.order.cancelled.v1` | C4 | C5, C6, C8, C13 | Order cancelled (credit note handled in billing) |
| `billing.invoice.issued.v1` | C4 | C8 | Invoice issued (number, totals) |
| `billing.balance.changed.v1` | C4 | C6, C16 | Order balance due changed (drives hold-till-paid UI hints) |
| `billing.invoice.cancelled.v1` | C4 | C8 | Invoice cancelled with credit note |
| `lab.specimen.status_changed.v1` | C5 | C4 (`to_status = recollection_ordered` only — 08 A13 D-6), C6, C8, C9, C10, C11, C13, C16, C17 | Specimen moved state (collected/received/rejected/…) |
| `lab.specimen.rejected.v1` | C5 | C4, C16, C17 | Rejection + reason → recollection flow |
| `lab.result.verified.v1` | C5 | C9, C8, C12 | First-level verification done |
| `lab.result.approved.v1` | C5 | C6, C8, C11, C14 | Pathologist approval (result locked) |
| `lab.result.amended.v1` | C5 | C6, C8, C11, C14 | New result version after approval |
| `lab.order.ready_for_report.v1` | C5 | C6 | All (or the releasable subset of) order items approved |
| `lab.critical_value.detected.v1` | C5 | C6, C8 | Critical value needs notification |
| `instruments.result.received.v1` | C7 | C5, C9, C10, C12 | Parsed analyser result (barcode, analyte code, value, flags, instrument time) |
| `instruments.qc.received.v1` | C7 | C5 (capture), C9, C12 | Parsed QC result |
| `instruments.agent.health_changed.v1` | C7 | C1 (alerting), C8 | Agent online/offline/backlog |
| `reporting.report.released.v1` | C6 | C5, C8, C9, C13, C16 | Report version released to patient/doctor/centre |
| `reporting.delivery.status_changed.v1` | C6 | C8 | Delivery sent/failed/read |
| `catalog.changed.v1` | C3 | C4, C5, C6, C7, C13, C16 | Catalog entity changed (cache invalidation) |
| `payments.intent.settled.v1` | C15 | C4 | Gateway payment verified → billing records ledger entry |
| `quality.qc_run.rejected.v1` | C9 | C5 | QC failure → hold results since last good QC |
| `engagement.booking.confirmed.v1` | C16 | C4, C17 | Booking → pre-registration (centre_visit, C4) / home visit (home_collection, C17 creates the order — 08 R7) |
| `homecollection.collection.synced.v1` | C17 | C4, C5, C16 (08 A19 D-120) | Offline collections uploaded |
| `engagement.booking.cancelled.v1` | C16 | C4, C17 | Booking cancelled after confirmation (A5) |
| `instruments.calibration.received.v1` | C7 | C12 | Calibrator record parsed (driver-classified; B2) |

**Ports** (synchronous, in-process)

**A port call needs a declared consumer (08 A19 P-46).** Consumer lists are copied from the 03-IC §4.x headings. A chunk TRD may call a port only if its chunk appears there and in the 01-CM §6 matrix (`p`). A new caller is an additive CR to the owner (fake and contract suite updated). The C0 port-manifest check fails a call from a non-listed module.

| Port | Owner (implements) | Consumers | Methods (names; signatures in 03) |
|---|---|---|---|
| `CatalogPort` | C3 | C4, C5, C6, C7, C9, C10, C11, C12, C13, C14, C16 | `getTest`, `getPanel`, `resolveOrderables`, `priceFor`, `referenceRangeFor`, `criticalLimitsFor`, `mapInstrumentCode`, `getReferrer`, `getCreditParty`, `resolveCommentCodes`, `getTaxRate` (08 A2.2), `getPriceListStatus` (08 A24.1, consumer C16) |
| `FrontdeskPort` | C4 | C5, C6, C10, C11, C13, C14, C15, C16, C17 (08 A19 D-110) | `getOrderSummary`, `getPatientDemographics`, `createOrderFromBooking`, `getPatientDemographicsBatch`, `createSelfRegisteredPatient` |
| `BillingPort` | C4 | C6, C13, C15, C16, C17 | `getReleaseEligibility`, `recordGatewayPayment`, `getOrderBalance`, `recordGatewayRefund` — callers staff/system only (08 R8) |
| `LabPort` | C5 | C4, C6, C7, C10, C11, C14, C17 (C9 removed, 08 A26.3) | `getOrderResults`, `getPendingTestsForBarcode` (host query), `ingestInstrumentResult`, `holdResultsSince`, `submitModuleResult`, `getOrderItemProcessingState`, `listPendingForInstrument`, `lookupSpecimens`, `getAnalyteHistory` |
| `ReportingPort` | C6 | C13, C16 | `getReleasedReports`, `issuePortalLink`, `openReleasedReportFile`, `redeemPortalLinkForApp` |
| `IdentityPort` | C2 | all | `getActor`, `assertRole`, `getTenantSettings`, `getSignatories`, `readBrandingAsset`, `provisionPartnerMembership`, `updatePartnerMembership`, `provisionPatientMembership`, `openPatientSession`, `revokePatientSessions`, `getStaffNotificationContact` (08 A4.2), `readSignatureImage` (08 A21.2; returns `SignatureImageContent`, 08 A26.1) |
| `NotificationPort` | C6 | C4, C5, C8, C16, C17 | `sendSms`, `sendWhatsAppTemplate`, `sendEmailLink` (one outbound messaging gateway; nobody else talks to providers) |
| `PaymentProviderPort` | C15 | C4, C6, C16 | `createIntent`, `verify`, `refund`, `getIntent`, `cancelIntent` — C6 = portal dues-payment worker as system actor (`createIntent`/`getIntent`; 08 A11.1, CR-C15-010 ACCEPT-MODIFIED) |
| `SmartReportPort` | C14 | C6 (08 A5.7, A19 D-110) | `buildSummary(orderId, version)` |
| `QualityPort` | C9 | C5 | `canAutoVerify(resultContext)`, `qcStatusFor(instrument, analyte, time)` |
| `BillingCommandPort` | C4 (billing) | C4 (frontdesk only) | per 03-IC §4.15 |
| `RenderPort` | C6 | C4, C8, C13 (08 A5.1, A19 D-110) | `renderPdf` (worker/system only) |
| `EngagementPort` | C16 | C4, C17 | `getHomeAddress`, `getActiveMembership` |

**Ownership of the registration page (the one natural UI hot-spot):**
- The one-page registration screen belongs entirely to C4. It uses the catalog through `CatalogPort` and the HTTP catalog search endpoint. It records payments through C4's own billing module.
- C15 contributes only a `PaymentProvider` backend. The UI "Pay by QR" button lives in C4 and calls C4's endpoint, which calls `PaymentProviderPort`.
- No other chunk adds UI to that page.

## 6. Dependency matrix (who needs whose contract — not code)

```
           C0  C1  C2  C3  C4  C5  C6  C7  C8  C9  C10 C11 C12 C13 C14 C15 C16 C17
C1  infra  ●
C2  ident  ●
C3  cat    ●       p
C4  front  ●       p   p       e                                           p
C5  lab    ●       p   p   e
C6  rep    ●       p   p   p   e                                   p   p
C7  instr  ●       p   p       p
C8  anal   ●       p   v   v   v   v   v
C9  qual   ●       p   p       e,v e,v e,v
C10 micro  ●       p   p   p   p       e
C11 anat   ●       p   p   p   p,e
C12 inv    ●       p   p       e       e
C13 part   ●       p   p,v p,v e,v p
C14 smart  ●       p   p   p   e   p
C15 pay    ●   c   p       p,v
C16 engage ●       p   p   p   e   p                                   p
C17 home   ●       p   p   p   e   p                                       p,e
● = needs C0 delivered   p = uses port/HTTP contract   e = consumes events   v = reads published views   c = needs a C1 configuration CR [CONV] (C15: CR-C15-008)   combined cells, e.g. `e,v` = both
```
Realigned 2026-11-06 (final sweep): the C6 `p` under C15 (PaymentProviderPort), the C16 `p` under C15 and the C17 `e` under C16 (`engagement.booking.*`) were misaligned in the earlier fixed-width layout; the C16 `p` under C14 is dropped because SmartReportPort's only consumer is C6 (08 A5.7, A19 D-110). Added by 08 A26.3: C6 `p` under C14 (SmartReportPort), C4 `p` and C17 `p` under C16 (EngagementPort; C17 cell `p,e`).
Every column after C0 is satisfied by **C0's contracts + fakes**, so none of these is a code dependency. Integration tests replace fakes with real implementations as owners merge (`05-DEFINITION-OF-DONE.md`, integration gate).

## 7. Document set per chunk

Folder: `docs/chunks/Cxx-<slug>/`. Seven documents, the structure from the founder's source guide, plus a security doc as the 7th:

| # | File | Content (minimum) |
|---|---|---|
| 1 | `01-PRD.md` | Purpose, users/roles, problems, in-scope/out-of-scope (explicit), user stories with acceptance criteria (Given/When/Then), success metrics, phase, dependencies, blocked items |
| 2 | `02-TRD.md` | Owned paths, stack + exact pinned libraries (from 04), module internals, ports implemented/consumed (signatures), events produced/consumed, API endpoints (summary — full in OpenAPI spec doc section), jobs, configuration, performance targets, observability, error codes used, test strategy |
| 3 | `03-APP-FLOW.md` | Every screen/endpoint flow, state machines (states, transitions, guards, side effects), sequence diagrams for cross-chunk interactions, empty/loading/error/success states, permissions per action |
| 4 | `04-UI-UX.md` | For UI chunks: screen-by-screen layout, fields with validation rules, keyboard flows, components from `packages/ui` only, copy text. For non-UI chunks: API style/operator guide (agent tray app for C7, runbook UX for C1) |
| 5 | `05-SCHEMA.md` | Tables owned (columns, types, nullability, defaults, constraints, composite FKs, indexes), RLS policies (per command, per role), published views, enums/coded sets, retention, seed data needs — **this is the spec C0 implements** |
| 6 | `06-IMPLEMENTATION-PLAN.md` | Ordered task list (each task: goal, files, done-when, tests), milestones, integration points with fakes → real, CR candidates, risks |
| 7 | `07-SECURITY.md` | Applicable REQ-SEC IDs (cited, not copied), chunk-specific threats (STRIDE-style), abuse cases, required tests (incl. cross-tenant probes for every owned table/endpoint), data classification, logging/audit requirements |

Program-level documents (`docs/program/`):
- `00-README.md` — how agents use this set
- `01-CHUNK-MAP.md` — this file
- `02-CONVENTIONS.md` — code, API, DB, naming, errors, time, money, IDs, i18n, testing
- `03-INTERFACE-CATALOG.md` — full payload schemas of every event and port signature
- `04-CHANGE-REQUESTS.md` — protocol + template + log
- `05-DEFINITION-OF-DONE.md` — per-PR, per-chunk and integration gates
- `06-GLOSSARY.md` — lab and billing terms
- `07-BLOCKERS.md` — mirror of 04 §13 with owners and the defaults chunks build against

## 8. Known risks of this split (stated, not hidden)

1. **C0 is a bottleneck by design.** Mitigations:
   - it splits into four parallel workstreams (0A repo/tooling/shared libs, 0B database, 0C contracts/codegen/fakes, 0D runtime cores/UI kit/Flutter base);
   - all chunk schemas and APIs are specified now in the chunk documents, so C0's work is translation, not design;
   - C0 handles CRs with a turnaround target stated in `04-CHANGE-REQUESTS.md`.
2. **Central DDL means a feature chunk can't add a column itself.** This is intentional; schema drift between parallel agents is the most expensive collision.
3. **Fakes can drift from real behaviour.** Mitigation: every port has a shared contract test suite in `packages/fakes/contract-tests/`. Both the fake and the real implementation must pass it.
4. **C4 is large** (registration + IRD billing). It stays one chunk because the client's "one single page" requirement couples them in one screen. Inside, C4 splits into two modules (`frontdesk`, `billing`) that two agents can build in parallel. The module boundary is the `billing` schema plus a C4-internal port.
5. **IRD's "separately stored" question (04 D16/B17)** may force billing into per-tenant schemas or databases later. Because `billing` is its own schema with tenant-leading keys, that move stays inside C0 (DDL) and C4 (repository layer). No other chunk touches billing tables.
6. **Client blocker B1 can re-order waves.** That is harmless under this design: only contract freezing order matters.
