# LIMS architecture plan — corrected

Status: PROPOSAL, not approved. Replaces the draft "04-FINAL-MICROSERVICES-IMPLEMENTATION-PLAN.md" (external, Antigravity).
Date: 2026-11-25. Checked against the repo on branch `ui/redesign` and `spec/research/04-consolidated-decisions.md`.

## 1. Decision

Keep the modular monolith. Do not split into 11 services and 11 databases.

Reasons:

- The spec locks it: one Fastify API is the only write path (04 S2); "a chunk is not a microservice" (06-GLOSSARY).
- The goals the draft lists (independent scaling, rolling deploys, edge survival) are already met or reachable without a split (section 3).
- The split would create the distributed-invoice problem the draft then spends a section solving.
- About 450 of the 547 cross-schema foreign keys point at `core` (tenants, branches, memberships). Tenancy and FORCE RLS (04 D4/D5) depend on them.

Any step below that changes a spec decision needs a change request first (`spec/program/04-CHANGE-REQUESTS.md`).

## 2. Corrections to the draft

| Draft says | Repo / spec says |
|---|---|
| 20 schemas, 17 modules | 27 schemas, 17 modules (`services/api/src/modules`) |
| 421 cross-schema foreign keys | 547 `REFERENCES` cross schema in `db/migrations`; about 450 into `core` |
| PostgreSQL 16, database per service | PostgreSQL 17 (`supabase/postgres:17.6.1.136`), one database, schema per module, FORCE RLS |
| Own IAM service and database | GoTrue (Supabase Auth) plus `identity` module (04 S2) |
| MinIO | Supabase Storage |
| Kong / Envoy public gateway cluster | nginx is the single public edge; Envoy only inside the Supabase stack (04 S6) |
| NATS JetStream + Debezium outbox | Transactional outbox already exists: `core.event_log`, `<module>.event_inbox`, Graphile Worker fan-out (04 S10, 02-CONVENTIONS §7.3) |
| Redis for sessions and catalog cache | Redis (valkey) allowed only for rate-limit counters (04 S11) |
| New `lims-edge-service.exe` | `apps/bridge-agent` already exists: Go, ASTM, HL7, MLLP, serial, SQLite queue, uploader with backoff, host query, heartbeat, Windows service |
| NATS leaf node / mTLS tunnel from edge | Agent is outbound-only HTTPS (04 N11) |
| Extract reporting + Chromium cluster (Wave A) | Already separate containers: `services/renderer` (Playwright pool), `pdf-sandbox`, `services/worker` |
| Events `lab.order.approved`, `instruments.result.ingested`, `billing.payment.settled` | Real names in `contracts/events`: `lab.result.approved.v1`, `instruments.result.received.v1`, `payments.intent.settled.v1`, `billing.balance.changed.v1` |
| Invoice number via `pg_advisory_xact_lock`, FY `2082.2083`, `METRO-82/83-0004521` | `billing.fiscal_counters`, key `(tenant_id, series, fiscal_year_bs)`, series `INV`/`CN`/`RC`, FY format `2082/83`, scope tenant or branch |
| CBMS JSON payload | Invented. CBMS API spec is unverified (04 L13). Real-time CBMS applies only to designated taxpayers (04 L6) |
| HIB insurance adapter | Not in spec or code. New scope |
| 27.1 GB on a 32 GB app VM | Draft rows sum to 33.75 GB with stated replicas (25.5 GB without). Omits Supabase stack, clamd, web, portal, partner, squid, PgBouncer. 04 I1: app VM is 16 GB, the 32 GB VM is data |
| `patient_snapshot_age_years INT` | Wrong for neonatal and paediatric ranges. Existing pattern is `sex_snapshot`, `display_name_snapshot`; add DOB and age in days if needed |
| Shadow traffic duplicating live requests | Unsafe for writes: a duplicated order issues a second fiscal invoice number |

Not supported by any measurement: `<45 MB` agent RAM, sub-5 ms ACK, 72-hour buffer, 50 ms failover, the SLA column.

## 3. What already delivers the draft's goals

- Independent scaling and rolling deploys: `infra/compose/lims/compose.app.yml` runs `api-a/b`, `worker-a/b`, `web-a/b`.
- Heavy PDF load isolated from the API: renderer and sandbox containers with their own memory limits.
- Module contracts: 13 ports in `contracts/ports`, 28 event schemas in `contracts/events`.
- Edge survival: bridge-agent persists frames to local SQLite before ACK and uploads at-least-once.

## 4. Work plan

Each step is small, reversible and has a check.

1. **Enforce module boundaries.**
   Remove direct cross-module imports under `services/api/src/modules` (grep finds 36, some may be type-only). Add a lint rule so a module imports another only through `contracts/ports`.
   Check: lint fails on a deliberate violation; full test suite green.

2. **Per-module database roles.**
   One login-less role per module, granted only its own schema plus the `core` reads it needs. No schema or FK changes.
   Check: `db/tests` test that module A's role cannot write module B's tables.
   Needs CR if it changes 04 D5.

3. **Measure before scaling.**
   Record API latency, worker queue depth and renderer memory during 07:00–11:00 intake. Split worker queues (render, delivery, fan-out) only if one starves another.
   Check: numbers written down before and after.

4. **Edge: harden `apps/bridge-agent`, do not rewrite.**
   On real analysers measure ACK time, queue size per day and recovery after a simulated WAN cut. Set the retention figure from the measurement.
   Check: agent crash and offline tests in `apps/bridge-agent/internal/queue` extended with the measured volumes.

5. **Extract a service only on evidence.**
   Trigger: a module needs a different release cadence, runtime or scaling profile that replicas cannot give. First candidate is instrument ingest, behind its existing port. Fiscal billing and front desk stay together so registration and invoice stay in one database.
   Needs CR against 04 S2.

6. **New scope by change request.**
   - HIB insurance: obtain the HIB API specification, then build as a module with worker-side calls.
   - CBMS: obtain the IRD checklist and API specification (blocker B6), then implement the sync task in the worker (no external call inside a request handler, 02-CONVENTIONS §7.3).

## 5. Not verified

- Whether registration plus invoice issue run in one database transaction (confirmed only that frontdesk calls billing in-process through `BillingCommandPort`).
- F-09 wording in `spec/chunks/C1-infrastructure-ops` (compared against 04 I1 only).
- The draft's legal claim about credit notes under Procedure 2074.
- The draft's two source audits (not read).
- Foreign key count is a text count of `REFERENCES` clauses in migrations, not a query on a live catalog.

## 6. Status (2026-11-25)

Step 1, module boundaries — partly done, uncommitted:
- `tools/lint/tests/tree-cross-module.test.mjs` runs `no-cross-module-import` and `no-foreign-schema-sql` on the real tree; existing violations frozen in `tree-cross-module.baseline.json` (new ones fail, list only shrinks).
- Catalog uses `core/validation/*`; partners posts the penalty entry through `BillingPort.recordAccountEntry`.
- Cross-module imports in source: now 0. Reporting gets the lab result reader injected at the composition root `core/sync/index.ts`.
- Still open: reporting queries `lab.results` directly; a `LabPort` method is blocked because sync adapters run as module `core`, not a listed consumer. See `.orchestra/cr/MODBOUNDARY-REPORTING-LAB.nonblocking.md`.
- Foreign-schema SQL in source: 61 baselined entries (26 in identity, 8 in billing); some are rule false positives (web `nav.manifest.ts` strings). Not triaged.
- Registration and invoice atomicity: stated by convention (02-CONVENTIONS, port rule: implementations run in the caller's transaction).

Step 2, per-module database roles — dropped as written:
- Every table grant goes to one group role `lims_app` (about 350 grants) and one request transaction spans modules through ports.
- Per-module roles would need a role switch inside every port call and a change to 04 D5. The same boundary is enforced statically by `no-foreign-schema-sql`, now run on the tree (step 1).

Steps 3, 4, 6 — not started; need things outside the repo: peak-hour production metrics, physical analysers, HIB and IRD CBMS API documents.
Step 5 — not started by design (extract only on evidence).
