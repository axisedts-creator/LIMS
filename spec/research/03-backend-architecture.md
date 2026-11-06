# 03 — Backend Architecture Research: Multi-Tenant Cloud LIMS (Nepal)

Status: research report + requirements checklist. Date: 2026-11-05.
Scope: capacity, self-hosted Supabase reality, database design, async work, PDF generation, instrument interfacing, mobile/offline, contract-first parallel development, delivery integrations.
Constraint: all patient data hosted on servers physically in Nepal (data-residency). No Vercel/Cloudflare for PHI. Anchor client: ~500 patients/day, ~20 collection centres, Autobio/Mindray/Getein analysers.

Items marked **UNVERIFIED** could not be confirmed from a primary source during this research pass and must be checked before being relied on.

---

## 1. Capacity math

### 1.1 Load model (show the arithmetic)

Assumptions (anchor client, then ×N labs):

| Variable | Value | Basis |
|---|---|---|
| Patients/day/lab | 500 | client statement |
| Billable test orders per patient | 5–15, use 10 median | ASSUMPTION — typical panel mix (CBC=1 order but ~20 analytes; chemistry panels 8–14). *[Pass 1: row relabelled — the original said "Tests (analytes)" but the next row treats this figure as billable orders, not analytes.]* |
| Orders (billable tests) per day | 500 × 10 = **5,000** | — |
| Result values/day (analyte-level, CBC expands) | ~3–5× orders ≈ **15,000–25,000 rows** (≈ 30–50 analyte values per patient) | ASSUMPTION — CBC/urine panels expand to many OBX-equivalent values; the anchor lab's sample health-package report runs to 22 pages (00-scope §4), so this range is plausible, not measured |
| Analyser messages/day | 1 ORU per sample per analyser ≈ 1,500–3,000 msgs (500 patients × 3–6 tubes/instruments), each 2–10 KB | ASTM/HL7 ORU granularity. *[Pass 1 arithmetic fix: 500 × 2–4 = 1,000–2,000, not 1,500–3,000. To get 1,500–3,000 you need 3–6 messages per patient. The message count is kept; the multiplier is corrected.]* |
| Report PDFs/day | ~500–700 (one per patient visit + reprints/amendments) | — |
| Notifications/day | 500–1,500 (SMS/WhatsApp ready + payment msgs) | — |

**Peak-hour concurrency.** Nepali diagnostic labs front-load: ~60–70% of samples arrive 7:00–11:00. Peak hour ≈ 25% of daily volume:
- Registrations: 125/hour ≈ **1 every ~29 s**
- Result rows written: 25% × 20,000–25,000 ≈ 5,000–6,250/hour ≈ **1.4–1.7 rows/s**
- Analyser messages: 25% × 1,500–3,000 ≈ 375–750/hour ≈ **1 msg every ~5–10 s** (the original said ~600/hour, one every 6 s, which is the midpoint)
- *Note:* if 60–70% of samples arrive over the 4 hours from 7:00 to 11:00, the average is ~15–17.5% per hour. Using 25% for the peak hour is a deliberately conservative ASSUMPTION.
- Staff users concurrently active: 20 collection centres × 2 + central lab ~20 = **~60 concurrent staff sessions**, each maybe 1 request / 5–10 s ⇒ **~6–12 API req/s peak**, bursts to ~50 req/s with dashboards/worklists polling.

At **N = 10 labs** of this size (optimistic year-2): ~60–120 req/s sustained peak, rising to **~500 req/s** if every lab's dashboard and polling bursts (~50 req/s each) coincide. *[Pass 1: the original's "~250 writes/s worst case" cannot be derived from this load model. The derived figures for 10 labs are 14–17 result rows/s, roughly double that with audit rows (~30–35 rows/s), plus small amounts of registrations, jobs and status updates, for ≲ 50 writes/s. 250 writes/s is kept only as a **headroom target (assumption)**, about 5× the derived load.]* This is *small* by Postgres standards — a single well-configured Postgres on NVMe handles thousands of TPS; community sizing guidance (e.g. [EDB/PostgreSQL wiki tuning guidance](https://wiki.postgresql.org/wiki/Tuning_Your_PostgreSQL_Server), [PGTune](https://pgtune.leopard.in.ua/)) treats this as entry-level OLTP.

### 1.2 Storage growth

- Result rows: 25,000/day × ~200 B ≈ 5 MB/day/lab; with indexes/audit ×5 ≈ **25 MB/day/lab ≈ 9 GB/year/lab**.
- PDFs: 600/day × 150 KB ≈ 90 MB/day ≈ **33 GB/year/lab**. PDFs dominate storage → object storage with lifecycle policy matters more than DB sizing.
- Raw analyser message archive (keep for dispute/debug): 3,000 × 5 KB ≈ 15 MB/day ≈ 5.5 GB/year/lab (compresses ~10×; the compression ratio is an ASSUMPTION).
- **Totals (Pass 1 addition):** ≈ 9 + 33 + 5.5 ≈ **47.5 GB/year per lab** (about 43 GB if the raw archive is compressed). That is ≈ **475 GB/year at N = 10 labs**, of which ~330 GB/year is PDFs and ~90 GB/year is DB.
- **The 150 KB/PDF figure is an ASSUMPTION (UNVERIFIED — needs confirmation).** Measure it on rendered templates: a multi-page report with a letterhead, signature images and a QR code may be much larger, and radiology reports with images (00-scope D9) certainly will be.

### 1.3 Hardware sizing conclusion

Start (anchor client + a few more labs) on **two Nepal VMs** (e.g. local DC / Datahub / Silver Lining / WorldLink colo — procurement question, see open questions):

| VM | Spec | Runs |
|---|---|---|
| VM-1 "data" | 8 vCPU, 32 GB RAM, NVMe SSD ≥ 10k IOPS, 500 GB | Postgres (shared_buffers ~8 GB per 25%-of-RAM rule of thumb — [PostgreSQL docs](https://www.postgresql.org/docs/current/runtime-config-resource.html)), pgbouncer/Supavisor, WAL archiving |
| VM-2 "app" | 8 vCPU, 16 GB RAM, 200 GB | Fastify API, workers, Chromium PDF pool, Supabase aux services, MinIO/Storage |

Plus a third small VM or off-site Nepal location for **backups + standby replica** (streaming replication; manual or Patroni-less failover initially). Rationale: at <100 req/s and ~50 GB/year *per lab*, the bottleneck is operational maturity, not hardware. **⚠ Pass 1 sizing check:** 200 GB on VM-2 cannot hold report PDFs (Storage/MinIO) beyond the first few labs. At ~33 GB/year/lab, 3 labs fill it in about 2 years, and 10 labs (~330 GB/year) fill it in under a year. Likewise, VM-1's 500 GB holds about 5 years of DB growth at 10 labs (~90 GB/year at the ×5 index/audit factor) before WAL archive and backups are counted. Plan object storage as a separately growable volume or a dedicated storage node, and size it from measured PDF sizes. Overprovision disk IOPS (cheap insurance for checkpoint spikes + PDF bursts).

Sources: [PostgreSQL resource config docs](https://www.postgresql.org/docs/current/runtime-config-resource.html), [PostgreSQL wiki — Tuning](https://wiki.postgresql.org/wiki/Tuning_Your_PostgreSQL_Server), [PGTune](https://pgtune.leopard.in.ua/).

---

## 2. Self-hosted Supabase — reality check

### 2.1 What self-hosting actually is

The official docker-compose stack ([Supabase self-hosting docs](https://supabase.com/docs/guides/self-hosting/docker)) includes: **Postgres (supabase/postgres image), GoTrue (Auth), PostgREST, Realtime, Storage API (file backend or S3-compatible), API gateway, Studio, postgres-meta, edge-runtime (Edge Functions), imgproxy (removable), Supavisor (default pooler)**.

*[Pass 1 correction (OUTDATED), per the current self-hosting docs:]*
- **Envoy is now the default API gateway.** Kong is an optional override.
- **Logflare/analytics is not in the default config.** It is an opt-in add-on with Vector (`run.sh config add logs`).
- **PgBouncer is an optional alternative pooler** to Supavisor, and a direct-connection option also exists.
- The stack serves plain HTTP on port 8000. The docs recommend putting a reverse proxy (Caddy or Nginx) in front for HTTPS.
- *Pass 3 (supabase/supabase docker/ at HEAD):* the stock compose publishes gateway `${API_GW_HTTP_PORT:-8000}:8000` and, on Supavisor (2.9.13, the default pooler), `${POSTGRES_PORT}:5432` and `${POOLER_PROXY_PORT_TRANSACTION}:6543` on **all host interfaces (0.0.0.0)**. Override to `127.0.0.1:`/private-interface bindings + host firewall; an infra test asserts these ports are closed externally (04 S6). PgBouncer comes via the official `docker-compose.pgbouncer.yml` override; per D3 use it and disable Supavisor so only one pooler runs (04 S8). Default DB image is `supabase/postgres:17.6.1.136`.
- Stable snapshots ship roughly monthly. `update.sh` merges config. Mixing individual image tags is "not guaranteed" compatible.

It is "the product minus the platform": no managed upgrades, no point-in-time recovery UI, no branching, no automatic TLS, single-node by default. *(The no-TLS point is confirmed by the docs. PITR, branching and single-node are not contradicted by the page, but they were not explicitly confirmed this pass.)*

### 2.2 Known operational pain points (verified from docs/community)

- **Upgrades between versions are manual and risky**: the compose stack pins many service versions that must move together; Postgres major upgrades are entirely yours (pg_upgrade/dump-restore). Community write-ups of running self-hosted on a single VPS consistently report upgrade friction and missing dashboard features ([dev.to: moved from hosted to self-hosted Supabase](https://dev.to/lambopoewert/moved-from-hosted-supabase-to-self-hosted-on-a-single-vps-heres-what-i-learned-after-weeks-in-2om1), [WZ-IT: self-hosting pros/cons](https://wz-it.com/en/knowledge/supabase/self-hosting-pros-cons/)).
- **No built-in HA**: single Postgres container; replication/failover is DIY.
- **Backups**: DB via pg_dump/WAL-G is on you; **Storage objects are separate** — if using the file backend they're just files on disk; if S3 backend (MinIO), bucket replication is on you. Easy to back up the DB and forget object storage (report PDFs!).
- **Auth (GoTrue) config via env vars**, SMTP you must supply; multi-tenant email templates are limited.
- Studio on self-host lags the cloud dashboard (no log explorer parity, limited settings UI).

### 2.3 Supabase self-hosted vs plain Postgres + custom Node API

| Dimension | Self-hosted Supabase | Plain Postgres + Fastify API |
|---|---|---|
| Auth | GoTrue ready-made (JWT, OTP, phone) | roll your own or add Keycloak/Lucia — weeks of work |
| CRUD API | PostgREST free | you write every endpoint |
| Realtime | built-in (WAL-based) | LISTEN/NOTIFY + ws yourself |
| Storage | Storage API w/ RLS | MinIO + presigned URLs yourself |
| Complex workflows (billing, interfacing, state machines) | PostgREST poor fit → you add a Node service anyway | native |
| Ops burden | ~10 containers to babysit, coupled upgrades | 1 DB + 1–2 app processes |
| RLS multi-tenant | first-class (JWT claims → RLS) | same Postgres RLS, enforced via API |
| Failure blast radius | Gateway (Envoy/Kong)/Realtime/Storage each can break | smaller surface |

### 2.4 Pooling and PostgREST vs API layer

- **Transaction-mode pooling** (Supavisor/pgbouncer default for app traffic) breaks session state: `SET` (non-LOCAL), `LISTEN`, SQL-level `PREPARE`, session-level advisory locks, WITH HOLD cursors and temp tables. Protocol-level prepared statements *are* supported in PgBouncer transaction mode when `max_prepared_statements` > 0 (PgBouncer ≥ 1.21 per Supabase's docs). Supabase's shared pooler in transaction mode does not support prepared statements, so turn them off in the driver. **RLS with per-request tenant/user context must use `SET LOCAL` (or `set_config(..., true)`) inside the same transaction as the query.** That is transaction-pool-safe; plain `SET` is not. PostgreSQL documents that `SET LOCAL` lasts "only till the end of the current transaction" ([PostgreSQL SET](https://www.postgresql.org/docs/current/sql-set.html)), and Supabase's guidance is to "run them inside the transaction that needs them" ([Supabase connecting docs](https://supabase.com/docs/guides/database/connecting-to-postgres)). ([pgbouncer features docs](https://www.pgbouncer.org/features.html); community explainers: [netdata: transaction vs session pooling](https://www.netdata.cloud/guides/pgbouncer/pgbouncer-transaction-vs-session-pooling/), [dev.to pooling pitfalls](https://dev.to/merbayerp/pgbouncer-connection-pooling-modes-and-pitfalls-4f39)).
- PostgREST executes each request in one transaction and injects JWT claims as transaction-local settings, so it is pooler-safe by design ([PostgREST docs](https://postgrest.org/en/stable/); *Pass 1 CONFIRMED by the [PostgREST transactions reference](https://docs.postgrest.org/en/stable/references/transactions.html): "every request … runs inside a transaction", using "settings tied to the transaction lifetime"*).
- **PostgREST is wrong for LIMS workflows** (order lifecycle, verification rules, billing with IRD sync, interfacing ingest): these are multi-step, side-effectful, and audited. They belong in the Fastify service, in explicit transactions.

### 2.5 Recommendation

**Hybrid, Postgres-first**: run self-hosted Supabase primarily for **GoTrue (auth), Storage, and Realtime**, but treat **Postgres as the product and the Fastify API as the only write path for clinical/billing workflows**. Do not let web/mobile clients talk PostgREST directly for anything beyond low-risk reads (and even then prefer the API for contract stability — see §8). *Pass 2 (aligned with 02 REQ-SEC-068):* the staff web app is a **server-only (BFF) client** — no browser-side Supabase client holds a session; all Supabase/API calls go through Next.js server code, which sets HttpOnly cookies, because default `@supabase/ssr` cookies are not HttpOnly. Staff-web live updates use SSE/polling via the server, not browser Realtime. Supabase Realtime (private channels, 02 REQ-SEC-036) is used only by the Flutter apps. Design so Supabase aux services are *removable*: if GoTrue/Storage ops cost outweighs benefit, swap to Keycloak/MinIO without schema change. Reasons: auth + storage + realtime are the genuinely expensive things to rebuild; everything else Supabase adds is optional surface. Confidence: high.

---

## 3. Database design

### 3.1 Multi-tenant schema conventions

- Single database, shared schema, **`tenant_id uuid NOT NULL` on every tenant-owned table**; RLS policy `tenant_id = (SELECT app.current_tenant_id())`, where the helper reads the tenant claim from `request.jwt.claims`. *Pass 2 correction (consistency with 02 REQ-SEC-013/022/066):* the original `current_setting('app.tenant_id')` GUC would work only for the API path and invites setting the tenant from request input. Instead the API verifies the JWT itself, then sets `request.jwt.claims` via `set_config('request.jwt.claims', <verified claims>, true)` inside the transaction (pool-safe like `SET LOCAL`), so the same policies serve the API, PostgREST, Storage and Realtime. Collection-centre scoping (02 REQ-SEC-017) is a second predicate via the membership table.
- **DB roles (Pass 2, aligned with 02 REQ-SEC-012/029/131):** the API and workers connect as dedicated non-BYPASSRLS, non-owner login roles — never as `postgres`, `supabase_admin` or `service_role`. Tenant tables are owned by a NOLOGIN, non-BYPASSRLS owner role with `FORCE ROW LEVEL SECURITY`; FORCE alone is insufficient because Supabase's `postgres` has BYPASSRLS.
- **Composite FKs carry tenant_id**: `FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id)` — prevents cross-tenant references even if application code is wrong; requires `UNIQUE(tenant_id, id)` on parents. Cheap at this scale; adopt from day 1 (retrofitting is painful).
- IDs: UUIDv7 (time-ordered) to keep B-tree locality. *Pass 3:* the self-hosted stack's default image is `supabase/postgres:17.6.1.136` (Postgres 17), which has **no native `uuidv7()`** (added in PG 18). Generate UUIDv7 in application code (Node API and Dart offline clients, one shared helper per codebase, RFC 9562 layout); no DB default. A DB-side generator (extension or SQL function) only if a migration/trigger needs one, and only if present in the pinned image (04 D9).
- Keep reference data (test catalog master, units, LOINC-ish codes) global with per-tenant override tables.

### 3.2 Partitioning — the math says no (yet)

Biggest table = result values: 25k rows/day/lab × 10 labs × 365 ≈ **91 M rows/year**, ~200 B/row ≈ 18 GB of heap. With indexes and audit rows that is **≈ 50–90 GB/year**. *[Pass 1 consistency fix: §1.2 uses a ×5 multiplier for indexes and audit, which gives 9 GB/year/lab × 10 ≈ 90 GB/year. The original "≈ 50 GB/year" here implies a ×2.7 multiplier. Both are assumptions, so the range is shown.]* Postgres handles multi-hundred-million-row tables fine with correct indexes; declarative partitioning pays off mainly for retention-drop and when indexes stop fitting RAM. **Decision: no partitioning initially; design `collected_at`/`created_at` columns so time-range partitioning of `results` and `audit_log` can be added later** (avoid cross-table FKs *into* future-partitioned tables, or include the partition key).

### 3.3 Indexes for worklists/dashboards

- Worklist: partial index `ON orders (tenant_id, status, created_at) WHERE status IN ('pending','in_progress')` — hot set stays tiny.
- Pending-verification: `ON results (tenant_id, verified, resulted_at) WHERE verified = false`.
- Patient lookup: `ON patients (tenant_id, phone)`, trigram index (`pg_trgm`) on name for search.
- Dashboards: do counts from a small `daily_stats` rollup (refreshed by worker) rather than scanning fact tables.

### 3.4 Audit: triggers vs logical decoding

- **Trigger-based row audit** (generic JSONB old/new diff trigger, à la the well-known `audit trigger` pattern / supabase `supa_audit` extension) — synchronous, transactional, simple to query, costs ~2× write amplification on audited tables. Fine at 25 rows/s.
- Logical decoding (wal2json/pgoutput → consumer) is nicer at scale but adds an always-on consumer with its own failure modes, and replication-slot bloat if the consumer stalls — a real operational hazard on a self-managed box.
- **Decision: triggers now**, write to `audit_log (tenant_id, table, row_id, action, actor, old, new, at)`; revisit logical decoding only if write amplification shows up. *Pass 2 (aligned with 02 REQ-SEC-096/097):* add `centre_id`, `ip`, `user_agent`, `request_id` (taken from the transaction-local request context), and keep a separate app-level `access_log` for view/print/download/export events, which row triggers cannot see. Both are append-only (no UPDATE/DELETE grants), shipped to a separate store, retained ≥5 years. The trigger function, if SECURITY DEFINER, follows 02 REQ-SEC-019/020.

### 3.5 Migrations

Options: **supabase CLI migrations** (plain SQL files, `supabase db push/diff`), **sqitch** (dependency-aware, verify scripts), **Atlas** (declarative HCL/SQL, diffing, lint), **graphile-migrate** (watch-mode, idempotent current.sql). All exist. *[Pass 1 notes on maintenance:]*
- graphile-migrate's latest *stable* npm release is 1.4.1 (Dec 2022). A 2.0.0 line is in release-candidate (2.0.0-rc.6, Oct 2026).
- Sqitch's site exists, but its current release was not verified this pass.

**Decision: plain forward-only SQL migrations in one owned package, run by `atlas` or `sqitch`.** Do *not* couple migrations to the supabase CLI; that keeps the "Supabase is removable" property. Atlas preferred for its `migrate lint` (CI gate, §8).

**⚠ Pass 1 correction (OUTDATED):** per Atlas's docs, starting with v0.38 `atlas migrate lint` "is available only to Atlas Pro users" (requires `atlas login`). The concurrent-index analyzer (PG101/PG102/PG103) is also a Pro feature. The "free CI lint gate" rationale therefore needs either a paid Atlas Pro plan or an alternative linter. Squawk is one candidate (UNVERIFIED — needs confirmation of current status). See D7 ⚠ revisit. *Pass 2 (02 REQ-SEC-012/131):* whichever runner is used, it logs in as a migrator role and `SET ROLE`s to the NOLOGIN, non-BYPASSRLS table-owner role, so tables are never owned by `postgres`. *Pass 2 linter status:* `squawk-cli` exists on npm (2.70.0, 15 Oct 2026, Apache-2.0 OR MIT, per the npm registry API); its rule coverage versus Atlas's analyzers was not checked (UNVERIFIED). Zero-downtime practices: additive-first (add column nullable → backfill → constrain), `CREATE INDEX CONCURRENTLY`, no long `ACCESS EXCLUSIVE` locks in peak hours, `lock_timeout` set in migration runner.

### 3.6 Bikram Sambat (B.S.) calendar

- **Store UTC timestamps / ISO dates only.** B.S. is a display/reporting concern; fiscal-year logic (Shrawan 1) computed in app code from a conversion table.
- JS libraries (verified to exist on npm/GitHub): [`@remotemerge/nepali-date-converter`](https://www.npmjs.com/package/@remotemerge/nepali-date-converter), [`@sbmdkl/nepali-date-converter`](https://www.npmjs.com/package/@sbmdkl/nepali-date-converter), [`bikram-sambat` (medic/bikram-sambat)](https://github.com/medic/bikram-sambat) — the medic one is notable as it's maintained by Medic (CHT) for production health software in Nepal (the Medic-maintainer attribution is UNVERIFIED — GitHub was not reachable this pass). *[Pass 1, latest npm releases:]*
- `@remotemerge/nepali-date-converter` 1.2.7 (31 Oct 2026, MIT)
- `@sbmdkl/nepali-date-converter` 2.0.5 (May 2026, MIT)
- `bikram-sambat` 1.8.1 (Jun 2026, Apache-2.0) — *Pass 3: data table covers only 1970–2090 B.S.; not to be used as the primary JS lib*

All three were published within the last 6 months.
- Dart/Flutter (verified on pub.dev): [`nepali_date_picker`](https://pub.dev/packages/nepali_date_picker) (*Pass 1: latest is **8.0.0**, Sep 2026; the original's "v7.x" is OUTDATED*), [`bikram_sambat`](https://pub.dev/documentation/bikram_sambat/latest) (1.2.0, ~3 months old), [`nepali_kit`](https://pub.dev/packages/nepali_kit) (1.1.0, Oct 2026), [`nepali_date_converter_plus`](https://pub.dev/documentation/nepali_date_converter_plus/latest/) (0.0.1 — too immature; not re-checked this pass). `nepali_utils` is the companion to `nepali_date_picker`. *Pass 1 resolved the UNVERIFIED mark:* it is a declared dependency of nepali_date_picker 8.0.0 (`^3.0.8`), comes from the same verified publisher (sarbagyastha.com.np), and is not discontinued, but its latest release, 3.0.8, dates from Apr 2025 (~18 months ago).
- B.S.↔A.D. conversion is table-driven (month lengths vary per year; *Pass 2:* the "roughly 1970–2100 B.S." range is unsourced, and 01 §4.8 found no library page documenting its range — **UNVERIFIED per library**; test that the chosen library covers well past 2090 B.S. *Pass 3, ranges from source/README:* `bikram-sambat` 1970–2090 B.S. (throws after 2090 — **insufficient, not the primary JS lib**); `@remotemerge/nepali-date-converter` 1975–2099 B.S.; `@sbmdkl/nepali-date-converter` 1978–2099 B.S. but A.D. ≤2040; `nepali_utils` 1969–2100 B.S. Proposed: JS = `@remotemerge` 1.2.7, Dart = `nepali_utils` 3.0.8; shared golden fixtures cover 2000–2099 B.S.; far-future month lengths are projections, re-check yearly (04 D13)); wrap whichever library behind one internal module in each codebase, golden-tested against a shared fixture file so TS and Dart agree.

### 3.7 Invoice numbering (IRD) and gapless sequences

- Nepal IRD's **Electronic Billing Procedure / CBMS** requires approved billing software to produce sequential invoice numbers per fiscal year, prevent deletion (cancel-only, with audit), restrict post-print edits, and sync invoice data (incl. cancellations) to IRD CBMS in real time/near-real time. Software must be listed with IRD (Procedure 2074 cl.3) and each taxpayer needs its tax office's permission (cl.4); central/rented servers must meet cl.7(ख) (Nepal server, per-taxpayer data separation, IRD access, Annex 7 contract). See: [Frappe forum — compliance requirements for IRD Nepal approval](https://discuss.frappe.io/t/compliance-requirement-that-must-be-fulfilled-to-get-approval-from-tax-authority-in-nepal/34532), [ERPNext IRD e-billing approval thread](https://discuss.frappe.io/t/finally-got-approval-for-e-billing-from-ird-nepal-erpnext-v13-28-saas/93072), [Odoo CBMS e-billing module](https://apps.odoo.com/apps/modules/18.0/l10n_np_cbms_ebilling), [Nepal e-invoicing country booklet](https://www.vatupdate.com/2026/09/20/nepal-e-invoicing-e-reporting-country-booklet/). **Interpretation: yes, effectively gapless per fiscal year is the expectation** (cancelled invoices keep their number and are reported cancelled). Exact current Procedure text (Nepali) → legal review: **UNVERIFIED in detail**. *Pass 3:* the current text is the IRD **Electronic Invoice Procedure 2074** (in force 2074/09/16, 4th amendment 2076/09/09, under VAT Act s.14A; [IRD PDF](https://www.ird.gov.np/public/pdf/175356524.pdf)) — read in Pass 3; its cl.6 requirements are in 04 L26. Real-time CBMS push is mandatory only for taxpayers IRD designates; all software must be capable of it.

*[Pass 1, checked against the Frappe compliance thread (a community source, not IRD text).]* It states that:
- the database must record invoice numbers "on chronological order"
- deletion must not be possible
- cancellation must be possible, and cancelled records must be viewable and printable
- reprints must carry a visible "copy of original" mark plus a print count *(a requirement the original text omitted)*
- invoices must sync to CBMS "in real time"
- an audit trail and activity log is required for every user

The thread does **not** say "gapless" or "restrict post-print edits". Both are interpretations — **UNVERIFIED — needs confirmation** against the IRD Procedure. The vatupdate booklet could not be fetched this pass.

*Pass 2 (consistency with 01 §4.1), corrected in Pass 3:* the legal basis is VAT Act 2052 s.14A + the IRD **Electronic Invoice Procedure 2074** (in force 2074/09/16; the 2072 Procedure cited by [Pioneer Law](https://pioneerlaw.com/?p=551) is historical — express repeal UNVERIFIED). VAT Act s.29(1)(g2) fines **the taxpayer (the lab) NPR 500,000** if found using software that can delete or correct data; s.29(1)(c) sets NPR 10,000 for not issuing an invoice (NPR 1,000 per time is the buyer's fine for not taking one). The software is listed with IRD on the manufacturer's self-certification (cl.3), and each taxpayer applies to its tax office for permission (cl.4). So: **no edit and no delete** of issued invoices is VERIFIED (VAT Act + Procedure cl.6(ख)/(ट): corrections only by ending the old record's validity and creating a new one), not only "post-print". "Gapless" remains a design choice (the safe superset of serial numbering per FY, cl.6(ङ)), UNVERIFIED as a legal requirement. Multi-tenant: cl.7(ख) requires each taxpayer's data stored separately — billing/invoice tables must be isolatable per tenant until IRD clarifies (04 D16/B17).
- Gapless implementation: Postgres `SEQUENCE` is *not* gapless (rollback burns numbers). Standard pattern: counter row per (tenant_id, fiscal_year) and `UPDATE ... SET n = n + 1 RETURNING n` inside the invoice-creating transaction — serializes invoice creation per tenant/FY via row lock. Locking cost: at 500 invoices/day/tenant, the peak hour (25%) is ~125 invoices/hour ≈ **1 every ~29 s**, and contention is still negligible. *[Pass 1 arithmetic fix: the original said "~1 per 2 min peak". 500/day spread evenly over 24 h is ~1 per 2.9 min, which is not a peak figure.]* Allocate the number as late as possible in the transaction to keep the lock window short. Do **not** use gapless numbering for internal IDs — only the fiscal invoice number.

---

## 4. Async work

### 4.1 Queue choice

| Option | Store | Maturity | Throughput | Notes |
|---|---|---|---|---|
| [pg-boss](https://github.com/timgit/pg-boss) | Postgres | mature, long-lived (v12.38.0, Oct 2026) | thousands jobs/min, fine here | cron scheduling, retries, retention/deletion sweeps built in (*Pass 1: "archival" UNVERIFIED for v12 — the release notes describe retention deletion, not an archive table*) |
| [Graphile Worker](https://worker.graphile.org/) | Postgres | mature (v0.18.0, Sep 2026) | *Pass 1 (OUTDATED figure fixed):* the perf docs now claim **~183k jobs/s** with batching on a desktop i9-14900K running both the DB and the workers, and <5 ms average add→start latency ([perf docs](https://worker.graphile.org/docs/performance)). That is a vendor benchmark, not production. | lowest latency (LISTEN/NOTIFY), SQL-schedulable (`graphile_worker.add_job()` from triggers; needs owner privilege or a SECURITY DEFINER wrapper) |
| BullMQ + Redis | Redis | mature | highest | adds Redis = another stateful service to run in Nepal, breaks "one DB to back up" |

Load is ~2–5 jobs/s peak at N = 10 labs (notifications, PDFs, CBMS sync, webhooks). *[Pass 1: the anchor lab alone has ~1,500–3,000 jobs/day (notifications 500–1,500 + PDFs 500–700 + CBMS sync ~500 + misc), 25% of them in the peak hour, which is ≈ 0.1–0.2 jobs/s. Ten labs give ≈ 1–2 jobs/s, so 2–5 is a conservative upper bound.]* *Pass 2 (02 REQ-SEC-019/020/131):* workers connect as a non-BYPASSRLS role and set the tenant claim context per job (transaction-local) before touching tenant tables. Any SECURITY DEFINER wrapper around `graphile_worker.add_job` lives in an unexposed schema with `search_path = ''`. Whether Graphile Worker can run with a pre-installed schema under a role lacking DDL rights is UNVERIFIED. Rejecting Redis here is about job durability and backups; 02 REQ-SEC-078 still uses Redis as an **ephemeral rate-limit cache only** (no persistence, no PHI). **Decision: Graphile Worker.** Reasons: transactional enqueue (`add_job` inside the same transaction as the domain write — this *is* the outbox pattern), cron support built in, no Redis. pg-boss is an acceptable alternate; BullMQ rejected (extra infra, no transactional enqueue with Postgres data). Confidence: high.

### 4.2 Outbox / reliable side-effects

- Rule: **no external side-effect (SMS/WhatsApp/email/CBMS/webhook) from request handlers.** Handler commits domain change + enqueues job in the same transaction; worker performs the side-effect with retries + idempotency key; records delivery status back.
- Webhook deliveries (to B2B portal clients later): signed (HMAC-SHA256 header), at-least-once, exponential backoff with jitter (e.g. 1m→5m→30m→2h→6h, dead-letter after ~24h), per-endpoint circuit breaker, delivery log visible to tenant.

### 4.3 Scheduled jobs

Graphile Worker crontab (or pg_cron) for: daily stats rollup, backup verification ping, report-retention sweeps, CBMS reconciliation, QC reminders. Keep *all* schedules in code (migrated), not hand-configured.

---

## 5. PDF generation at volume

### 5.1 Volumes and approach

500–700 PDFs/day per lab (§1.1), up to ~1,000 with bulk reprints ⇒ peak hour (25%) ≈ 125–250/hour ≈ **2–4/min**. *[Pass 1 consistency and arithmetic fix: the original said "600–1,000 ⇒ ~2/min peak". That contradicted §1.1, and 25% × 1,000 is 4.2/min.]* Trivial volume, but Chromium is heavy per render.

- **Chromium pool (Playwright or Puppeteer)**: 1 browser process, N=2–4 pages (contexts) as a pool; recycle the browser every ~100–500 renders (memory creep); hard memory cap via container limit (~1–1.5 GB for the pool); render timeout + retry. HTML templates = same stack as web app, easy Nepali (Devanagari) font embedding — ship Noto Sans Devanagari in the container.
- Alternatives: **[Typst](https://typst.app/)** (fast native typesetting, great for fixed-layout reports, young ecosystem, templates in Typst language not HTML), **WeasyPrint** (Python HTML/CSS→PDF, slower, decent), **react-pdf / pdfmake / pdf-lib drawing** (programmatic, no HTML, fiddly layout). 
- **Decision: HTML→Chromium via Playwright** for v1 (team already lives in HTML/CSS; one template language; print CSS with headers/footers). Keep the renderer behind an internal `render(templateId, data) → pdf` interface so Typst can replace it if Chromium ops annoy. Confidence: medium-high. *Pass 2 (02 REQ-SEC-086):* the Chromium pool runs egress-restricted (no internal network, no metadata IPs), loads only allowlisted bundled assets, and never receives user-controllable URLs.

### 5.2 Merging outsourced PDFs

Outsourced test reports arrive as PDFs; merge with [`pdf-lib`](https://www.npmjs.com/package/pdf-lib) or shell out to `qpdf` (battle-tested, handles damaged files better; latest 12.4.2, Sep 2026). **⚠ Pass 1 correction (WRONG):** pdf-lib is pure JS but *not* maintained. Its last npm release is 1.17.1 (Nov 2021). Actively published MIT forks exist: `@cantoo/pdf-lib` (2.11.1, Sep 2026) and `@pdfme/pdf-lib` (6.2.8, Oct 2026). Pick a fork, or accept a frozen dependency, for stamping. **Treat inbound PDFs as untrusted**: parse/merge in a sandboxed worker process with timeouts; never render them through the Chromium pool; re-linearize via qpdf. Decision: qpdf for merge/sanitize, a maintained pdf-lib **fork** (`@cantoo/pdf-lib` 2.11.1 or `@pdfme/pdf-lib` 6.2.8, re-checked on the npm registry 2026-11-05 — *Pass 2: this decision line still named upstream pdf-lib; aligned with REQ-ARCH-046 and 02 REQ-SEC-087*) for stamping (page numbers, QR).

### 5.3 Storage layout + retention

`reports/{tenant_id}/{yyyy}/{mm}/{report_id}-v{n}.pdf` in Storage/MinIO, where `reports` is a private bucket and `tenant_id` is the first path segment that the `storage.objects` policies check (*Pass 2: = 02 REQ-SEC-034*); immutable versions (amended report = new version, old kept); DB row is source of truth with sha256 of file. Retention: Nepali lab-report retention duty is not clearly codified — **UNVERIFIED**; default to 5 years online + archive, make per-tenant configurable.

### 5.4 QR verification on reports

Options: (a) HMAC-signed token embedding report id + version + truncated MAC; (b) random 128-bit token stored server-side, QR = lookup URL. **Decision: (b) random token lookup.** Reasons: revocable (amended reports), no key-rotation problem, no crypto-in-URL foot-guns, constant-time lookup; HMAC only saves a DB read, which is worthless here. Verification page shows only lab name, patient initials/masked name, test panel name(s), report issue date/time + version, and status (valid / superseded) — no results, phone, address or DOB; revoked and never-existing tokens get an identical response (*Pass 2: field list aligned with 02 REQ-SEC-093*).

---

## 6. Instrument interfacing deep dive

### 6.1 Protocols

**ASTM E1394 / E1381 (now CLSI LIS2-A2 / LIS1-A)** — over serial or TCP. *Pass 2 correction (consistency with 01 §3.1–3.2):* "dominant on Autobio/Getein-class analysers" is UNVERIFIED — no official Autobio or Getein LIS manual was read, and the only Mindray manuals found (BC-5380, BS-120/200) are **HL7 v2.3.1 over MLLP**, not ASTM. The bridge must support **both** stacks from sprint 1, and each driver's protocol is set per model once the vendor manual arrives:
- Low-level (E1381/LIS1-A): `ENQ` (0x05) to request line → `ACK`/`NAK`; data sent in frames: `STX FN text [ETB|ETX] C1 C2 CR LF`, where FN = frame number cycling 1–7,0 and C1C2 = checksum (sum of chars from FN through ETB/ETX, mod 256, as 2 hex chars); `ETB` = intermediate frame, `ETX` = last; receiver ACK/NAKs each frame; `EOT` ends the session. Contention rule: the instrument effectively wins when both sides send ENQ: on contention the instrument waits 1 s and re-sends ENQ, while the computer goes neutral for 20 s. Max frame is 247 characters including 7 overhead characters, so records longer than 240 characters are split into ETB intermediate frames. *(Pass 1: CONFIRMED against a vendor LIS1-A implementation of the spec — Beckman Coulter host-interface manual. Frame numbers start at 1 and increment modulo 8. The checksum covers FN through ETB/ETX, mod 256, as 2 uppercase hex characters.)*
- Record level (E1394/LIS2-A2): `H` header, `P` patient, `O` order, `R` result, `C` comment, `Q` query (host query mode for worklist download), `L` terminator; pipe/caret delimiters similar to HL7.

**HL7 v2 over MLLP**: frame = `0x0B message 0x1C 0x0D`. Key messages: `ORU^R01` (results in), `ORM^O01` (legacy order) / `OML^O21` (newer laboratory order, introduced in v2.4; some national profiles still mandate ORM^O01, so support both), `QRY`/`QBP` (query) — *Pass 2, per 01 §3.1 (Scribd copies of Mindray manuals): Mindray's host query is instrument-initiated, either `ORM^O01` query → LIS replies `ORR^O02` (BC-5380) or `QRY^Q02` → LIS replies `QCK^Q02` + `DSR^Q03` (BS-120/200), so the bridge must accept these as inbound queries, not only send ORM outbound* — `ACK` with modes original vs enhanced (MSH-15/16; `AA/AE/AR`, enhanced adds `CA/CE/CR` commit-level). Always send app-level ACK; treat missing ACK as retransmit trigger.

Per-analyser reality: each vendor's "ASTM" or "HL7" deviates; the bridge needs **per-driver quirk layers** (encoding, units, flag fields, query support). Obtain each instrument's LIS interface manual (host-interface spec) from the vendor — this is the single biggest schedule risk.

### 6.2 Open-source prior art (existence verified)

- [`node-hl7-client`](https://github.com/Bugs5382/node-hl7-client) (TS, MLLP client + parser/builder; companion `node-hl7-server`) — exists, active on [npm](https://npmjs.com/package/node-hl7-client) (both 4.1.2, 29 Oct 2026, MIT).
- [`hl7-standard`](https://www.npmjs.com/package/hl7-standard) (JS HL7 v2 parse/build) — exists. *Pass 1: stale; the last release is 1.0.4 (May 2022).*
- [`python-hl7`](https://python-hl7.readthedocs.io/) — exists (parsing only, plus MLLP bits). *Pass 1 (OUTDATED): the "maintained" claim is doubtful; the last PyPI release (`hl7`) is 0.4.5 from Mar 2022.*
- **Mirth Connect (NextGen Connect)** — reference architecture for channels/transforms/queues. *Pass 1 CONFIRMED and resolved:* NextGen announced on 19 Mar 2025 a move "from a dual license (open-source and commercial) to a single commercial and proprietary Mirth Connect licensing model with Mirth Connect 4.6". **4.5.2 is the last open-source version.** Use as design reference only, not as a dependency.
- ASTM libraries: ecosystem is thin everywhere. Python has `astm` (*Pass 1 CONFIRMED unmaintained: last PyPI release 0.5.0 in 2013*). Prior art in TS: the open-source [Medplum agent](https://www.medplum.com/docs/agent/astm-channels) has ASTM E1381/E1394 byte-stream channels, but it is TCP-only, does not validate checksums and cannot send NAK, so it is not a full implementation. JS has no healthy standalone ASTM E1394 lib — **plan to write the ASTM framing layer in-house (~1–2k lines incl. tests)**; the protocol is small and fully specified. **UNVERIFIED: no maintained Go/C#/JS ASTM lib found; re-scan GitHub before writing from scratch.**

### 6.3 Bridge agent language

| | Windows service | Serial | Single-binary deploy | Team fit |
|---|---|---|---|---|
| Go | `golang.org/x/sys/windows/svc` native (x/sys v0.49.0, Oct 2026) | [`go.bug.st/serial`](https://github.com/bugst/go-serial) (maintained: v1.8.0 Jul 2026, BSD-3) or tarm/serial (stale — UNVERIFIED this pass) | one static .exe, trivial | new language for team |
| .NET 8 | first-class (`UseWindowsService`) | `System.IO.Ports` built-in, most battle-tested on Windows | self-contained publish ~70 MB | new language |
| Node | needs node-windows/NSSM wrapper | [`serialport`](https://serialport.io/) (mature, native module) | pkg/nexe awkward, native modules fragile | same language as backend |

*Pass 3 toolchain:* x/sys v0.49.0's go.mod declares `go 1.26.0` (go-serial v1.8.0 declares 1.25.0), so the agent builds with Go ≥1.26 — pin the toolchain in go.mod and CI consistently. *Pass 2 constraint:* "Go 1.21 requires at least Windows 10 or Windows Server 2016" ([Go 1.21 release notes](https://go.dev/doc/go1.21)), so "ancient" Windows 7/8 lab PCs are out of scope for the agent, which is consistent with 02 REQ-SEC-122's supported-Windows baseline. **Decision: Go.** Single static binary, tiny footprint on older (Windows 10+) lab PCs, solid serial lib, first-class Windows-service support, cross-compiles from CI. .NET is the runner-up (best serial pedigree); Node rejected for deployment fragility (native serialport module + packaging on 20 unmanaged Windows boxes). Confidence: medium — if the team strongly resists Go, .NET 8 is equally defensible.

### 6.4 Bridge agent design

- **Local SQLite WAL-mode queue**: every inbound frame persisted raw (bytes + parse result) before ACK to instrument; uploader drains queue to server over HTTPS with exponential backoff; at-least-once.
- **Server-side idempotency key**: `(instrument_id, message_control_id)` for HL7 (MSH-10); ASTM lacks a reliable message id → key = `(instrument_id, sha256(raw_message))` + sequence hints. Server upsert-ignores duplicates. *Pass 2 (consistency with 01 §3.3):* a second, result-level uniqueness key `(instrument_id, sample_barcode, analyte_code, instrument_result_time)` stops the same result arriving in two different messages (e.g. a re-sent batch) from duplicating. The uploader sends **batches** (e.g. ≤100 messages per request) so 02 REQ-SEC-078's 60 requests/min/device cap does not throttle backlog drain. The local queue is encrypted and truncated after confirmed upload (02 REQ-SEC-117).
- **Clock drift**: lab PCs drift badly. Agent stamps every message with monotonic counter + local time + server-offset (measured each upload via response Date); server stores both `instrument_time` and authoritative `received_at`; result timestamps displayed from server time, instrument time kept for audit.
- **Remote config/update for 20+ sites**: agent polls server for config (instrument list, port settings, driver versions) with signed config documents; self-update = download signed new binary, verify signature, swap on restart (or run under a tiny supervisor/NSSM that does the swap). Never require RDP to a site for routine changes.
- **Telemetry**: heartbeat every 60 s (agent version, queue depth, last message per instrument, disk free, clock offset); server dashboard with "instrument silent > X min" alerts — this is a headline operational feature for a 20-centre client, not a nice-to-have.
- Logs: local ring-buffer files + on-demand log upload command from server.

---

## 7. Mobile / offline

- **Patient app**: online-only (booking, report list/download, payments). No offline store beyond cache. Keep it thin against the OpenAPI contract.
- **Phlebotomy app**: offline-first required (home-collection routes). Options:
  - **[PowerSync](https://www.powersync.com/)**: Flutter SDK + Supabase integration is a first-class showcase ([PowerSync for Supabase+Flutter](https://www.powersync.com/blog/showcase-powersync-for-supabase-and-flutter)); architecture = local SQLite + sync service reading Postgres WAL + upload queue of client mutations applied via your backend. Self-hostable sync service, which would also need to run in Nepal. **⚠ Pass 1 correction (OUTDATED):** the original said the core was FSL source-available. PowerSync posted a licensing update dated **3 Nov 2026** saying it "changed the license for the core PowerSync Service from the Functional Source License (FSL)" to **Apache 2.0**, and the `powersync-service` repo LICENSE is now Apache 2.0. Client SDKs are Apache-2.0/MIT. PowerSync's legal overview page still describes the Open Edition as FSL (it lags the change). Re-confirm before committing, but licensing is no longer the obstacle. *Pass 2 primary-source check (2026-11-05):* the 3 Nov 2026 date comes from powersync.com itself, as a "Licensing update November 3, 2026" note on the [PowerSync blog post](https://powersync.com/blog/new-open-era-for-powersync), which was originally published 31 May 2024. The `powersync-ja/powersync-service` LICENSE on GitHub (raw file, main branch) reads "Apache License Version 2.0". Status: **VERIFIED** (powersync.com + GitHub); the legal overview page still lags.
  - **[ElectricSQL](https://electricsql.com/)**: since the 1.x rewrite it is **read-path sync only** (Postgres → client "shapes" over HTTP); writes are explicitly your own API ([Electric docs](https://electric.ax/docs), [writes guide](https://electric.ax/docs/guides/writes): "Electric does not do write-path sync", [v1.1 release](https://electric.ax/blog/2025/08/13/electricsql-v1.1-released)). Apache-2.0 (CONFIRMED). Flutter support is secondary to TS. *(Pass 1: the repo names TS, React and Elixir clients and no official Dart client.)*
  - **Custom: drift (SQLite) + pull/push sync**: [`drift`](https://pub.dev/packages/drift) is the mature Flutter SQLite ORM. Phlebotomy sync scope is small (today's route, patients, collection tasks; upload collected-sample events + barcodes + GPS).
- **Decision: custom drift + explicit sync for the phlebotomy app.** The dataset is a day's worklist (<1 MB), the mutation set is ~5 event types, and both PowerSync (infra in Nepal; *the license concern is resolved by the Nov 2026 Apache-2.0 relicense — see above*) and Electric (write path still yours anyway) add a service to operate for little gain at this scope. Conflict strategy: **server-wins + idempotent, append-only mutations** (each mutation has client-generated UUID; server applies once; conflicts near-impossible because one phlebotomist owns a task). No CRDTs. Confidence: medium-high; revisit PowerSync if offline scope grows to full LIMS-offline.

---

## 8. Contract-first parallel development (multi-AI-agent build)

This project will be built by multiple AI coding agents in parallel; the contract discipline below is the thing that makes that work.

### 8.1 Frozen contracts

- **OpenAPI 3.1 spec is the law**, hand-written (not generated from code), living in `packages/contract/`. Every chunk codes against it; server validates requests/responses against it at runtime in dev/CI (Fastify + ajv via `fastify-openapi-glue` or schema-per-route generated from the spec).
- **Codegen** (tools verified to exist and be maintained): [`openapi-typescript`](https://www.npmjs.com/package/openapi-typescript) (+ `openapi-fetch`) for TS types/clients; [`openapi-generator`](https://openapi-generator.tech/) with the `dart-dio` generator for Flutter clients (note: openapi-generator's OpenAPI 3.1 support has gaps — keep the spec 3.1-but-3.0-compatible, i.e. avoid 3.1-only constructs, or validate dart output early; **UNVERIFIED: current dart-dio 3.1 completeness**. *Pass 1: the dart-dio generator docs list features only as OAS2/OAS3, never 3.1. They show oneOf/anyOf/allOf/Union supported and `not` unsupported. This supports keeping the spec 3.0-compatible.*) *Pass 1 versions: openapi-typescript 7.13.0 and openapi-fetch 0.17.0 (both Feb 2026); fastify-openapi-glue 4.12.0 (Oct 2026).* Generated packages are committed (so agents never need to run codegen to compile) and regenerated only by the contract-owner chunk.
- **Mock servers**: [Prism](https://github.com/stoplightio/prism) serves the spec with examples for app/front-end chunks; [MSW](https://mswjs.io/) for web unit tests. Both verified active (*Pass 1: Prism v5.16.0, Jul 2026; MSW 3.0.3, Oct 2026. Prism's release page says "OpenAPI2/3" — explicit 3.1 support UNVERIFIED — needs confirmation.*)
- **Database schema single-source**: all migrations live in one owned package (`packages/db`); other chunks may read generated schema docs/types but never write migrations. Seed + RLS policies live there too.

### 8.2 Repo strategy

**Monorepo with owned directories.** Polyrepo multiplies contract-sync failure modes; AI agents working in parallel need one source of truth and cheap cross-checking in CI. Rules (enforced via CODEOWNERS + CI path checks):
1. Each chunk owns an explicit path list (`apps/staff-web`, `apps/patient-app`, `apps/phlebo-app`, `services/api`, `services/worker`, `agents/bridge`, `packages/db`, `packages/contract`). **No chunk edits outside its paths.** CI fails PRs touching foreign paths.
2. Shared code only via published-in-repo generated packages (`packages/contract-ts`, `packages/contract-dart`, `packages/shared-types`); never by importing another chunk's source.
3. Contract changes go through a **change-request protocol**: a chunk files a CR (markdown issue + proposed spec diff) → contract owner merges spec change + regenerates clients in one PR → dependent chunks rebase. Spec is versioned (semver; breaking = new path version only after v1 freeze). `oasdiff` (v1.35.0, Oct 2026; has a breaking-change `checker`) (or `openapi-diff`) runs in CI to classify every spec change as breaking/non-breaking.
4. Each chunk gets its own CI job; cross-chunk integration tested nightly against real API + migrated DB.

### 8.3 CI gates

- typecheck + lint per chunk; **contract diff check** (oasdiff breaking=fail without CR label); **migration lint** (atlas lint: destructive change / missing concurrent index detection — *Pass 1: requires Atlas Pro since v0.38; see §3.5 / D7*); **RLS isolation tests** (fixture: two tenants, every endpoint hit with tenant-A token must return zero tenant-B rows — generated from the spec's path list so new endpoints can't dodge it); runtime response-validation in staging; seed-data smoke boot of full docker-compose.

---

## 9. Delivery integrations

### 9.1 WhatsApp Business Platform

- Current model (verified direction): Meta moved from conversation-based to **per-message pricing for template messages effective July 1, 2025** — marketing/utility/authentication templates are charged per delivered message; **utility (and service) messages sent within an open 24-hour customer-service window are free**; service conversations free ([Meta pricing updates](https://developers.secure.facebook.com/docs/whatsapp/pricing/updates-to-pricing), [360dialog summary](https://360dialog.com/partner-updates/2024-insights-and-meta-updates-2025), [bot.space summary of July 1 2025 change](https://www.bot.space/blog/whatsapp-business-api-pricing-update---effective-july-1-2025)). Exact NPR/INR-region utility rate: look up current card — **changes frequently, re-verify at integration time**. *Pass 1, from Meta's pricing page:* per-message pricing effective 1 Jul 2025 is CONFIRMED, and "Utility templates delivered within an open customer service window are free" is CONFIRMED. Meta updates prices only on 1 Jan, 1 Apr, 1 Jul and 1 Oct. *Pass 3:* Meta's page lists a 1 Oct 2026 rate-card update giving Nepal its own lower utility/authentication rates. It does not list in-window utility charging. Nepal's actual rate figure is UNVERIFIED (download the current rate card). *Pass 2 (consistency with 01 §4.5):* Meta's current documentation path ([developers.facebook.com/documentation/business-messaging/whatsapp/pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing)) shows rate cards "effective April 1, 2026" and still says in-window utility templates and non-template messages are free. Three BSPs (respond.io, baat.ai, Zoho) report that from **1 Oct 2026** in-window utility templates are chargeable from the first message and service messages get a 1,000/number/month free allowance. These changes are **reported by BSPs, not confirmed on Meta's pricing page — UNVERIFIED**. Budget for the BSP-reported (worse) case; do not design anything that depends on in-window messages being free.
- Implications: "your report is ready" = **utility template** (pre-approved, charged per message; whether in-window sends are free is UNVERIFIED, see above). Design templates early (approval takes days), keep a template catalog table, log Meta message-status webhooks. Access via Cloud API (hosted by Meta — note: message *transit* leaves Nepal; policy call needed on what PHI goes in the message → send "report ready + link", never results inline).
- **Fallback SMS** via Nepali aggregator (Sparrow SMS / Aakash SMS — Nepali companies; *Pass 2:* whether their API servers are hosted in Nepal is UNVERIFIED, so treat them as cross-border per 00-scope §7.1 until confirmed; **UNVERIFIED current pricing**): trigger when WhatsApp delivery status not `delivered` within N minutes, or patient has no WhatsApp.

### 9.2 Email

Transactional only (reports-ready, invoices, password resets). Self-hosting SMTP from a Nepal VM = deliverability death (IP reputation). **Use a relay (Brevo/Postmark/SES-type) for notification email** — acceptable because email content is "report ready + link", not PHI; PDFs stay behind authenticated download in Nepal. Document this in the data-residency policy.

### 9.3 Payment webhooks behind Nepal-only hosting

Fonepay/eSewa/Khalti server-to-server callbacks need a **public HTTPS endpoint** — fine: Nepal hosting ≠ no public endpoint; it means the TLS terminator + app run on Nepal infra with a Nepal-reachable public IP and a proper domain + cert (Let's Encrypt works). You cannot put Cloudflare in front of PHI endpoints per the residency rule — so you also lose its DDoS/WAF (*Pass 2:* per 02 REQ-SEC-135 and 00-scope "traffic stays in Nepal", **no** foreign CDN by default even for non-PHI static content without explicit founder approval); compensate with rate-limiting at the edge (nginx — *Pass 2: single edge choice, matching 02 REQ-SEC-078*), fail2ban, and keeping webhook endpoints signature-verified + idempotent. Never trust webhook payloads alone: always confirm via the provider's verification/lookup API before marking paid.

---

## 10. Decisions table

| # | Decision | Options considered | Chosen | Why | Confidence |
|---|---|---|---|---|---|
| D1 | Backend platform | Self-hosted Supabase full-stack; plain Postgres+API; hybrid | Hybrid: Supabase for Auth/Storage/Realtime, Fastify API as sole write path, Supabase removable | Buy auth/storage, keep workflows in code, limit blast radius | High |
| D2 | Client data access | PostgREST direct; API-only | API-only for writes + clinical reads; PostgREST at most for low-risk internal reads, via curated `api`-schema views only (02 REQ-SEC-032/033); staff web = server-only BFF, no browser Supabase client (*Pass 2, 02 REQ-SEC-068*) | Contract stability, auditability, complex workflows, HttpOnly session | High |
| D3 | Pooling | Supavisor; pgbouncer | pgbouncer (transaction mode) for API; direct conns for workers | Simpler, battle-tested; SET LOCAL pattern is pool-safe (*Pass 1: the self-host stack defaults to Supavisor, with PgBouncer offered as an option — the choice is supported. Pass 3: use the official `docker-compose.pgbouncer.yml` override and disable Supavisor*) | Medium |
| D4 | Multi-tenancy | DB-per-tenant; schema-per-tenant; shared+RLS | Shared schema, tenant_id + RLS + composite FKs | Ops simplicity at N<100 tenants; defense in depth | High |
| D5 | Partitioning | partition now; later | None now; time-partition-ready columns | ~91M rows/yr at 10 labs is fine unpartitioned | High |
| D6 | Audit | triggers; logical decoding | JSONB diff triggers → audit_log | Transactional, simple; volume tiny | High |
| D7 | Migrations | supabase CLI; sqitch; Atlas; graphile-migrate | Plain SQL, Atlas runner + lint, single owned package | Decoupled from Supabase; CI lint gate | Medium-High — **⚠ revisit (Pass 1):** `atlas migrate lint` and its concurrent-index analyzer require Atlas Pro (login, paid) since v0.38. Either budget for Pro or pair a free runner (Atlas/sqitch) with a separate linter. |
| D8 | Job queue | pg-boss; Graphile Worker; BullMQ+Redis | Graphile Worker | Transactional enqueue = outbox; cron; no Redis | High |
| D9 | Invoice numbers | sequence; gapless counter row | Gapless per (tenant, fiscal year) counter row, cancel-not-delete | IRD CBMS expectation; contention negligible (≈1 invoice / 29 s at peak) | Medium (IRD text UNVERIFIED in detail; *Pass 1: the community source says "chronological order", not "gapless". Gapless is the safe superset, so the decision stands pending legal review. Pass 2: no edit/no delete of issued invoices is backed by the 2072 Procedure's NPR 500,000 fine for software that permits modifying or deleting invoice data (Pioneer Law, 01 §4.1).*) |
| D10 | PDF engine | Chromium pool; Typst; WeasyPrint; react-pdf | Playwright+Chromium pool behind render interface | HTML templates, Devanagari fonts, team skills; swappable | Medium-High |
| D11 | Report QR | HMAC token; random token lookup | Random 128-bit token lookup | Revocable, no key mgmt, same cost | High |
| D12 | Bridge agent language | Go; .NET 8; Node | Go (static binary, windows/svc, go.bug.st/serial) | Deployability on 20+ Windows 10/11 / Server 2016+ PCs (*Pass 2: Go ≥1.21 does not run on older Windows*) | Medium |
| D13 | Bridge reliability | fire-and-forget; local queue | SQLite WAL queue, at-least-once, server idempotency key | Analyser data must never be lost offline | High |
| D14 | Phlebo offline | PowerSync; ElectricSQL; custom drift sync | Custom drift + append-only idempotent mutations, server-wins | Tiny sync scope; no extra service/license in Nepal | Medium-High — **⚠ revisit (Pass 1):** the "license" part of the rationale is OUTDATED, because the PowerSync Service was relicensed FSL → Apache 2.0 on 3 Nov 2026 (*Pass 2: VERIFIED on powersync.com and the GitHub LICENSE*). The "extra service to operate in Nepal" and "tiny scope" reasons still hold. |
| D15 | Repo strategy | monorepo; polyrepo | Monorepo, owned paths + CODEOWNERS, contract pkg single source, CR protocol, oasdiff CI | AI-agent parallelism needs one truth + cheap gates | High |

---

## 11. Open questions

1. Which Nepal datacenter/VM provider (Datahub, Silver Lining, WorldLink colo, own hardware?) meets uptime + NVMe + bandwidth needs; what are real SLAs and DR-site options inside Nepal?
2. IRD: does a *diagnostic lab's* billing fall under the e-billing mandate thresholds for the anchor client, and what exactly does CBMS listing/approval of the software require (Nepali Procedure text review; test CBMS API access)?
3. Exact LIS interface specs for the anchor client's instrument list (Autobio/Mindray/Getein models, serial vs TCP, ASTM vs HL7, host-query support) — request vendor host-interface manuals now.
4. PowerSync current self-host license terms (if offline scope grows) — verify before any dependency. *(Pass 1: the PowerSync Service was relicensed to Apache 2.0 on 3 Nov 2026; confirm that the legal pages catch up.)*
5. WhatsApp Cloud API: current utility-template price for Nepal numbers, and whether sending via Meta's infra conflicts with the client's/regulator's reading of data residency (message transit leaves Nepal).
6. Legal retention period for lab reports/records in Nepal (NHRC / DoHS rules) — drives storage lifecycle.
7. GoTrue fit for *patient* auth at scale (phone OTP cost via which SMS provider; rate limiting) vs staff-only GoTrue + custom patient OTP.
8. Mirth/NextGen Connect current license — reference only, but confirm before borrowing code. *(Pass 1: 4.6+ is commercial/proprietary only, and 4.5.2 is the last open-source release. The license text of 4.5.2 was not re-checked.)*
11. *(Pass 1)* Atlas Pro cost vs an alternative free migration linter for the CI gate (D7).
12. *(Pass 1)* Measure real rendered report-PDF sizes, then size object storage (§1.2 and §1.3).
9. Backup/DR drill cadence and who owns 2am pages — staffing plan for a 24/7 clinical system with a small team.
10. nepali date library freeze: confirm maintenance recency of `@remotemerge/nepali-date-converter` (JS; *Pass 3: `medic/bikram-sambat` dropped as primary — range ends 2090 B.S.*) and `nepali_date_picker`/`nepali_utils` (Dart); pin + wrap behind internal module with shared golden tests.

---

## 12. Requirements checklist

### Capacity & infrastructure
- [ ] REQ-ARCH-001 | Size v1 for ≥10 labs × 500 patients/day (≈120 req/s sustained peak, bursts ≈500 req/s; ≈250 writes/s as a headroom target ≈5× the derived ≲50 writes/s) | load model §1.1 | internal math (Pass 1 corrected)
- [ ] REQ-ARCH-002 | VM-1: 8 vCPU / 32 GB / NVMe ≥10k IOPS for Postgres + pooler | OLTP headroom, checkpoint spikes | [PG tuning wiki](https://wiki.postgresql.org/wiki/Tuning_Your_PostgreSQL_Server)
- [ ] REQ-ARCH-003 | VM-2: 8 vCPU / 16 GB for API, workers, Chromium pool, Storage; **object storage on a separately growable volume** (PDFs ≈33 GB/yr/lab; 200 GB is insufficient past a few labs — Pass 1) | isolate DB from render memory spikes | §1.2, §1.3
- [ ] REQ-ARCH-004 | shared_buffers ≈ 25% RAM; effective_cache_size ≈ 70%; tune via PGTune baseline | standard sizing rules | [PostgreSQL docs](https://www.postgresql.org/docs/current/runtime-config-resource.html), [PGTune](https://pgtune.leopard.in.ua/)
- [ ] REQ-ARCH-005 | Third location in Nepal for streaming replica + backups (DR) | single-DC risk; residency keeps DR in-country | §1.3
- [ ] REQ-ARCH-006 | WAL archiving + nightly base backup (pgBackRest or WAL-G), PITR ≤ 15 min RPO | clinical data loss tolerance | tool docs
- [ ] REQ-ARCH-007 | Monthly restore drill with documented RTO | backups unproven until restored | ops practice
- [ ] REQ-ARCH-008 | Object-storage (report PDFs) replicated to DR site separately from DB backups | Supabase Storage objects not covered by pg_dump | §2.2
- [ ] REQ-ARCH-009 | Capacity dashboard: DB size, IOPS, connections, queue depth, PDF latency | catch growth before pain | ops
- [ ] REQ-ARCH-010 | No Vercel/Cloudflare or foreign CDN in path of PHI; public IP + LE certs on Nepal infra. *Pass 2:* no foreign CDN for any traffic by default; non-PHI static content behind a foreign CDN only with explicit founder approval (02 REQ-SEC-135) | data residency | client constraint (00-scope header + §7.1)

### Supabase / platform
- [ ] REQ-ARCH-011 | Run self-hosted Supabase docker-compose: Postgres, GoTrue, PostgREST, Realtime, Storage, API gateway (Envoy default; Kong optional — Pass 1), Studio; HTTPS via reverse proxy. *Pass 3:* override the stock port bindings (:8000, :5432, :6543 published on 0.0.0.0) to 127.0.0.1/private interface + host firewall; PgBouncer via the official `docker-compose.pgbouncer.yml` override with Supavisor disabled (D3) | official stack | [Supabase self-hosting](https://supabase.com/docs/guides/self-hosting/docker)
- [ ] REQ-ARCH-012 | Pin all Supabase service image versions; upgrade as a tested set in staging first | coupled-version upgrades are the top self-host pain | [community](https://dev.to/lambopoewert/moved-from-hosted-supabase-to-self-hosted-on-a-single-vps-heres-what-i-learned-after-weeks-in-2om1), [WZ-IT](https://wz-it.com/en/knowledge/supabase/self-hosting-pros-cons/)
- [ ] REQ-ARCH-013 | Fastify API is the only write path for clinical/billing data; clients never write via PostgREST | workflow integrity, audit | §2.4
- [ ] REQ-ARCH-014 | Keep GoTrue/Storage/Realtime swappable (no schema coupling beyond auth.uid FKs behind a view/claim mapping) | de-risk Supabase ops | §2.5
- [ ] REQ-ARCH-015 | pgbouncer (≥1.21) transaction mode for API pool, deployed via the official `docker-compose.pgbouncer.yml` override with Supavisor (stock default) disabled — Pass 3; workers/migrations on direct connections | SQL PREPARE, session advisory locks, LISTEN need sessions (protocol-level prepared stmts OK with `max_prepared_statements` > 0 — Pass 1) | [pgbouncer features](https://www.pgbouncer.org/features.html)
- [ ] REQ-ARCH-016 | All per-request context via `SET LOCAL`/`set_config(..., true)` inside the transaction; ban bare `SET` in code review lint | transaction-pool safety for RLS | [pooling pitfalls](https://www.netdata.cloud/guides/pgbouncer/pgbouncer-transaction-vs-session-pooling/)
- [ ] REQ-ARCH-017 | Supabase API gateway (Envoy/Kong) exposed only behind the nginx edge (Pass 2: nginx is the single edge, matching 02 REQ-SEC-078) with rate limits + fail2ban; Studio/pg-meta never publicly reachable (02 REQ-SEC-037); *Pass 3:* gateway :8000 and Supavisor/Postgres :5432/:6543 bound to 127.0.0.1/private interface (stock compose binds 0.0.0.0), infra test asserts closed externally | no Cloudflare WAF available | §9.3
- [ ] REQ-ARCH-018 | SMTP for GoTrue via transactional relay, PHI never in email bodies | deliverability from Nepal IPs is poor | §9.2

### Database
- [ ] REQ-ARCH-019 | `tenant_id uuid NOT NULL` on all tenant tables + RLS `tenant_id = (SELECT app.current_tenant_id())`, the helper reading the verified JWT claims from `request.jwt.claims`, set by the API via `set_config(..., true)` (*Pass 2: replaces `current_setting('app.tenant_id')`; aligned with 02 REQ-SEC-013/022*); API/worker roles non-BYPASSRLS; tables owned by a NOLOGIN non-BYPASSRLS owner + FORCE RLS (02 REQ-SEC-012) | isolation | §3.1
- [ ] REQ-ARCH-020 | Composite FKs `(tenant_id, id)` to parents with `UNIQUE(tenant_id,id)` | cross-tenant reference impossible by construction | §3.1
- [ ] REQ-ARCH-021 | UUIDv7 primary keys, app-generated (Pass 3: PG 17.6 in the self-hosted image has no native `uuidv7()`; 04 D9) | index locality + mergeable across agents | §3.1
- [ ] REQ-ARCH-022 | No table partitioning v1; results/audit tables carry timestamp partition-key column for later | 91M rows/yr fine; keep door open | §3.2
- [ ] REQ-ARCH-023 | Partial indexes on hot statuses for worklists; pg_trgm for patient name search | dashboard latency | §3.3
- [ ] REQ-ARCH-024 | Dashboard counts from worker-maintained `daily_stats` rollups, not fact scans | predictable load | §3.3
- [ ] REQ-ARCH-025 | JSONB old/new audit triggers on clinical+billing tables into `audit_log` with actor, tenant, centre, IP, user agent and request id from request context, plus an app-level append-only `access_log` for view/print/download/export (Pass 2: = 02 REQ-SEC-096/097) | medico-legal traceability | §3.4
- [ ] REQ-ARCH-026 | Forward-only SQL migrations in `packages/db`, run via Atlas; `atlas migrate lint` in CI (**requires Atlas Pro since v0.38 — ⚠ see D7**) | single schema source; destructive-change gate | [Atlas](https://atlasgo.io/)
- [ ] REQ-ARCH-027 | Zero-downtime rules: additive-first, `CREATE INDEX CONCURRENTLY`, `lock_timeout` in runner, no exclusive locks in peak | 24/7 lab ops | §3.5
- [ ] REQ-ARCH-028 | Store UTC only; B.S. conversion in app layer behind one internal module per codebase | single conversion truth | §3.6
- [ ] REQ-ARCH-029 | JS B.S. lib: `@remotemerge/nepali-date-converter` (pin 1.2.7; covers 1975–2099 B.S.). *Pass 3:* `medic/bikram-sambat` is not acceptable as the primary lib — its table ends at 2090 B.S. (04 D13) | exists on npm/GitHub | [npm](https://www.npmjs.com/package/@remotemerge/nepali-date-converter), [medic](https://github.com/medic/bikram-sambat)
- [ ] REQ-ARCH-030 | Dart B.S. libs: `nepali_date_picker` 8.x (+`nepali_utils` 3.0.8, a dependency; last release Apr 2025 — Pass 1) wrapped, golden-tested against shared TS fixtures (*Pass 3:* one shared golden-test table, 2000–2099 B.S., run in CI on both sides; `nepali_utils` covers 1969–2100 B.S.) | TS/Dart conversion parity | [pub.dev](https://pub.dev/packages/nepali_date_picker)
- [ ] REQ-ARCH-031 | Fiscal-year boundaries (Shrawan 1) computed from B.S. module; invoice series keyed on (tenant, fiscal_year) | IRD fiscal year is B.S. | §3.7
- [ ] REQ-ARCH-032 | Gapless invoice number: counter row `UPDATE ... RETURNING` in the invoice transaction; number allocated last | IRD sequential expectation; short lock window | §3.7, [Frappe IRD thread](https://discuss.frappe.io/t/compliance-requirement-that-must-be-fulfilled-to-get-approval-from-tax-authority-in-nepal/34532)
- [ ] REQ-ARCH-033 | Invoices cancel-only (status + reason + audit), never delete; cancellation synced to CBMS | IRD rule pattern | [ERPNext approval thread](https://discuss.frappe.io/t/finally-got-approval-for-e-billing-from-ird-nepal-erpnext-v13-28-saas/93072)
- [ ] REQ-ARCH-034 | Legal review of current IRD Electronic Billing Procedure before billing module freeze (UNVERIFIED details) | compliance risk | [Nepal e-invoicing booklet](https://www.vatupdate.com/2026/09/20/nepal-e-invoicing-e-reporting-country-booklet/)
- [ ] REQ-ARCH-035 | Test catalog: global master + per-tenant overrides (prices, ref ranges by age/sex) | multi-tenant reality | §3.1
- [ ] REQ-ARCH-036 | Reference ranges and units versioned; result rows snapshot the range used | reports must be reproducible | clinical QA practice

### Async work
- [ ] REQ-ARCH-037 | Graphile Worker as job queue (Postgres-backed) | transactional enqueue, cron, no Redis | [worker.graphile.org](https://worker.graphile.org/docs/performance)
- [ ] REQ-ARCH-038 | Outbox rule: all external side-effects enqueued in the same transaction as the domain write | no lost/duplicated notifications | §4.2
- [ ] REQ-ARCH-039 | Every job idempotent with explicit idempotency key; retries with backoff+jitter; dead-letter queue + alert | at-least-once semantics | §4.2
- [ ] REQ-ARCH-040 | Delivery-status table per notification (channel, provider id, status, attempts) visible to tenant admins | support burden reduction | §4.2
- [ ] REQ-ARCH-041 | Outbound webhooks: HMAC-SHA256 signature header, backoff schedule, 24h dead-letter, per-endpoint circuit breaker, delivery log | B2B portal reliability | §4.2
- [ ] REQ-ARCH-042 | All cron schedules defined in code/migrations, none hand-configured on servers | reproducible ops | §4.3

### PDF generation
- [ ] REQ-ARCH-043 | Playwright-managed Chromium pool: 1 browser, 2–4 contexts, recycle every N renders, container memory cap, render timeout | memory creep control | §5.1
- [ ] REQ-ARCH-044 | HTML print-CSS templates with embedded Noto Sans Devanagari; per-tenant letterhead config | Nepali text fidelity | §5.1
- [ ] REQ-ARCH-045 | Renderer behind `render(templateId, data)` interface; Typst as documented fallback | swappability | §5.1
- [ ] REQ-ARCH-046 | Inbound outsourced PDFs sanitized/merged via qpdf in sandboxed worker with timeout; pdf-lib-API stamping via a maintained fork (`@cantoo/pdf-lib` or `@pdfme/pdf-lib`), since upstream pdf-lib was last released in 2021 (Pass 1) | untrusted input | §5.2
- [ ] REQ-ARCH-047 | Report files immutable+versioned: `reports/{tenant}/{yyyy}/{mm}/{id}-v{n}.pdf`, sha256 stored in DB | amendments auditable | §5.3
- [ ] REQ-ARCH-048 | Retention default 5 yr online then archive; per-tenant configurable pending legal answer (UNVERIFIED) | storage cost vs law | §5.3
- [ ] REQ-ARCH-049 | QR on report = random ≥128-bit CSPRNG server-stored token → public verify page showing minimal fields (lab name, masked name/initials, panel names, issue date/time + version, valid/superseded — Pass 2, = 02 REQ-SEC-093) | revocable, private | §5.4
- [ ] REQ-ARCH-050 | PDF generation async (queue) with status on UI; never block the result-verification request on rendering | UX + resilience | §5.1

### Instrument interfacing
- [ ] REQ-ARCH-051 | Bridge implements ASTM E1381/E1394 (LIS1-A/LIS2-A2): ENQ/ACK handshake, STX/FN/ETB/ETX frames, mod-256 hex checksum, 1–7,0 frame numbers, EOT | instruments whose manuals specify ASTM (Autobio/Getein protocol UNVERIFIED — Pass 2) | CLSI LIS01/LIS02 specs
- [ ] REQ-ARCH-052 | Bridge implements HL7 v2 (v2.3.1 minimum, the version in the Mindray BC-5380 and BS-120/200 manuals) over MLLP (0x0B…0x1C 0x0D): ORU^R01 in, ORM^O01/OML^O21 out, **instrument-initiated host query in** (ORM^O01 → ORR^O02; QRY^Q02 → QCK^Q02 + DSR^Q03 — Pass 2, per 01 §3.1), ACK original+enhanced modes | Mindray class (BC-5380, BS-120/200 HL7 per unofficial Scribd copies — UNVERIFIED from primary, 05 T11; obtain official Mindray manuals, 04 B2) | HL7 v2 spec; 01 §3.1–3.2
- [ ] REQ-ARCH-053 | Per-instrument driver layer isolating vendor quirks (delimiters, units, flags, query mode) | every vendor deviates | §6.1
- [ ] REQ-ARCH-054 | Obtain vendor host-interface manuals for anchor client's instrument list before build | schedule risk #1 | §6.1
- [ ] REQ-ARCH-055 | Write ASTM framing in-house (no healthy OSS lib found — re-verify first); reuse `node-hl7-client` patterns / Mirth as design reference only | thin ecosystem | [node-hl7-client](https://github.com/Bugs5382/node-hl7-client)
- [ ] REQ-ARCH-056 | Bridge agent in Go: static .exe, `windows/svc` service, `go.bug.st/serial` | 20+ unmanaged Windows PCs | [go-serial](https://github.com/bugst/go-serial)
- [ ] REQ-ARCH-057 | Persist raw message to local SQLite (WAL) before ACKing instrument; uploader drains with backoff | zero message loss | §6.4
- [ ] REQ-ARCH-058 | Server idempotency: HL7 by (instrument_id, MSH-10); ASTM by (instrument_id, sha256(raw)) | at-least-once dedupe | §6.4
- [ ] REQ-ARCH-059 | Store instrument timestamp AND server received_at; display server time; track clock offset per site | lab PC clock drift | §6.4
- [ ] REQ-ARCH-060 | Signed remote config + signed self-update for agents; no RDP for routine changes | 20+ sites | §6.4
- [ ] REQ-ARCH-061 | Agent heartbeat (version, queue depth, per-instrument last-message, disk, clock offset) + "instrument silent" alerting dashboard | headline ops feature | §6.4
- [ ] REQ-ARCH-062 | Raw analyser message archive retained (compressed) ≥ 1 yr for dispute/debug, **server-side in Nepal** (the agent's local queue is truncated after upload — 02 REQ-SEC-117; Pass 2) | traceability | §1.2
- [ ] REQ-ARCH-063 | Result-ingest pipeline: parse → map to catalog → flag (ref range/delta checks) → pending-verification queue; auto-verify only per configurable rules (*Pass 2: auto-verification is Phase 2 per 01 §6 row 11 and depends on the Phase-2 QC engine; in Phase 1 every result goes to manual first verification*) | clinical safety | LIS practice
- [ ] REQ-ARCH-064 | Simulator harness: replay captured ASTM/HL7 sessions in CI against bridge + ingest | test without instruments | engineering

### Mobile / offline
*Pass 2 phasing:* 01 §6 recommends Phase 3 for the native patient and phlebotomy apps, against the client's own formula, which includes them (00-scope §1). Their phase is BLOCKED pending the client's module priority ranking (00-scope §6 item 4). Phase 1 ships the responsive web patient portal.
- [ ] REQ-ARCH-065 | Patient app online-only; thin client on OpenAPI contract | scope control | §7
- [ ] REQ-ARCH-066 | Phlebotomy app: drift(SQLite) local store, pull day-route dataset, append-only mutation log upload | offline-first minimal | [drift](https://pub.dev/packages/drift)
- [ ] REQ-ARCH-067 | Mutations carry client UUID; server applies idempotently; server-wins conflicts; no CRDT | simplicity matches ownership model | §7
- [ ] REQ-ARCH-068 | Re-evaluate PowerSync (service relicensed to Apache 2.0 on 3 Nov 2026 — Pass 1) / ElectricSQL (read-path only, Apache-2.0) only if offline scope grows | avoid premature infra | [PowerSync](https://www.powersync.com/blog/showcase-powersync-for-supabase-and-flutter), [Electric](https://electric.ax/docs)
- [ ] REQ-ARCH-069 | Barcode scan + GPS + timestamp captured offline at collection; sync marks sample-in-transit | chain of custody | domain
- [ ] REQ-ARCH-070 | App token lifetime handles multi-hour offline (refresh before route start; on reconnect, refresh the session with the rotating refresh token, then upload queued mutations). *Pass 2 correction:* the original "grace on expiry" contradicted 02 REQ-SEC-065/066, which require strict `exp` verification. The server never accepts an expired access JWT. If refresh fails, the user re-authenticates, and the encrypted queue survives because logout is blocked while unsynced (02 REQ-SEC-103) | field reality | §7

### Contract-first / parallel AI development
- [ ] REQ-ARCH-071 | Hand-written OpenAPI 3.1 spec in `packages/contract` is the single API source of truth; runtime request/response validation in dev/CI | frozen contract | §8.1
- [ ] REQ-ARCH-072 | TS client via openapi-typescript + openapi-fetch; Dart via openapi-generator dart-dio (verify 3.1 handling; keep spec 3.0-compatible constructs) | verified tools | [openapi-typescript](https://www.npmjs.com/package/openapi-typescript), [openapi-generator](https://openapi-generator.tech/)
- [ ] REQ-ARCH-073 | Generated client packages committed; only contract-owner regenerates | agents build without codegen step | §8.1
- [ ] REQ-ARCH-074 | Prism mock server from spec examples for frontend/app chunks; MSW in web tests | parallel build against mocks | [Prism](https://github.com/stoplightio/prism), [MSW](https://mswjs.io/)
- [ ] REQ-ARCH-075 | Monorepo; CODEOWNERS per chunk path; CI fails PRs touching foreign paths | merge-conflict avoidance | §8.2
- [ ] REQ-ARCH-076 | Cross-chunk sharing only via generated packages; importing another chunk's source is CI-banned | decoupling | §8.2
- [ ] REQ-ARCH-077 | Contract change-request protocol: CR issue + spec diff → owner merges spec+clients atomically → chunks rebase | change discipline | §8.2
- [ ] REQ-ARCH-078 | oasdiff in CI classifying spec changes (pin stable 1.35.x; OAS 3.1 support exists only in the v2.2.0-openapi31 beta line — Pass 3 — so the spec stays 3.0-compatible); breaking change without CR label fails | contract safety | [oasdiff](https://github.com/oasdiff/oasdiff)
- [ ] REQ-ARCH-079 | RLS isolation test suite: two-tenant fixture, every endpoint asserted zero cross-tenant leakage; endpoint list derived from spec | tenant safety gate | §8.3
- [ ] REQ-ARCH-080 | Migration lint (atlas lint — Atlas Pro required, ⚠ D7; or a free alternative) + staging migration rehearsal on prod-size snapshot | zero-downtime discipline | §8.3
- [ ] REQ-ARCH-081 | Nightly full-stack integration run (compose up, migrate, seed, smoke every chunk against real API) | catch cross-chunk drift | §8.3

### Delivery integrations
- [ ] REQ-ARCH-082 | WhatsApp Cloud API with pre-approved utility templates; per-message pricing model (post-July-2025). In-window utility sends are free per Meta's page, but BSPs report charges from 1 Oct 2026 (reported by BSPs, not confirmed on Meta's pricing page — UNVERIFIED; Pass 2). Cost model assumes charged. *Pass 3:* Meta's rate-card update effective 1 Oct 2026 gives Nepal its own lower utility/authentication rates (figure UNVERIFIED — use the current rate card) | current Meta model | [Meta pricing updates](https://developers.secure.facebook.com/docs/whatsapp/pricing/updates-to-pricing)
- [ ] REQ-ARCH-083 | Messages contain "report ready" + authenticated link only; never results/PHI inline | residency + privacy | §9.1
- [ ] REQ-ARCH-084 | Template catalog table + Meta status webhooks logged; template approval lead time in project plan | ops reality | §9.1
- [ ] REQ-ARCH-085 | SMS fallback via Nepali aggregator (Sparrow/Aakash — pricing UNVERIFIED) when WhatsApp undelivered in N min or no WhatsApp | reach | §9.1
- [ ] REQ-ARCH-086 | Transactional email via relay provider; no PHI in bodies; link-only | deliverability | §9.2
- [ ] REQ-ARCH-087 | (Phase 1.5–2, when live gateways ship — 01 §6 row 5; Pass 2) Payment webhooks: public HTTPS on Nepal infra, signature verification + provider lookup confirmation before marking paid, idempotent | fraud/replay safety | §9.3
- [ ] REQ-ARCH-088 | Edge hardening in lieu of Cloudflare: nginx rate limits, fail2ban, TLS 1.2+, security headers, IP allowlists for admin | no foreign CDN allowed | §9.3
- [ ] REQ-ARCH-089 | Payment reconciliation job comparing provider statements vs DB daily | money correctness | ops
- [ ] REQ-ARCH-090 | Fonepay/eSewa/Khalti behind one internal `PaymentProvider` interface with sandbox-mode fixtures | parallel dev + swapability | §8

---

## Sources (primary links used)

Supabase/ops: [Supabase self-hosting docker docs](https://supabase.com/docs/guides/self-hosting/docker) · [dev.to self-host experience](https://dev.to/lambopoewert/moved-from-hosted-supabase-to-self-hosted-on-a-single-vps-heres-what-i-learned-after-weeks-in-2om1) · [WZ-IT pros/cons](https://wz-it.com/en/knowledge/supabase/self-hosting-pros-cons/)
Postgres: [runtime-config-resource](https://www.postgresql.org/docs/current/runtime-config-resource.html) · [Tuning wiki](https://wiki.postgresql.org/wiki/Tuning_Your_PostgreSQL_Server) · [PGTune](https://pgtune.leopard.in.ua/) · [pgbouncer features](https://www.pgbouncer.org/features.html) · [netdata pooling guide](https://www.netdata.cloud/guides/pgbouncer/pgbouncer-transaction-vs-session-pooling/) · [pooling pitfalls](https://dev.to/merbayerp/pgbouncer-connection-pooling-modes-and-pitfalls-4f39) · [PostgREST](https://postgrest.org/en/stable/)
Queues: [Graphile Worker performance](https://worker.graphile.org/docs/performance) · [pg-boss](https://github.com/timgit/pg-boss) · [postgres-ai queue benchmark](https://gitlab.com/postgres-ai/postgresql-consulting/tests-and-benchmarks/-/issues/77)
IRD/CBMS: [Frappe compliance thread](https://discuss.frappe.io/t/compliance-requirement-that-must-be-fulfilled-to-get-approval-from-tax-authority-in-nepal/34532) · [ERPNext IRD approval](https://discuss.frappe.io/t/finally-got-approval-for-e-billing-from-ird-nepal-erpnext-v13-28-saas/93072) · [Odoo CBMS module](https://apps.odoo.com/apps/modules/18.0/l10n_np_cbms_ebilling) · [Nepal e-invoicing booklet](https://www.vatupdate.com/2026/09/20/nepal-e-invoicing-e-reporting-country-booklet/) · [ictframe mandate](https://ictframe.com/?p=114453)
HL7/ASTM: [node-hl7-client](https://github.com/Bugs5382/node-hl7-client) ([npm](https://npmjs.com/package/node-hl7-client)) · [python-hl7](https://python-hl7.readthedocs.io/)
Serial/agents: [go.bug.st/serial](https://github.com/bugst/go-serial) · [node serialport](https://serialport.io/)
Dates: [@remotemerge/nepali-date-converter](https://www.npmjs.com/package/@remotemerge/nepali-date-converter) · [@sbmdkl/nepali-date-converter](https://www.npmjs.com/package/@sbmdkl/nepali-date-converter) · [medic/bikram-sambat](https://github.com/medic/bikram-sambat) · [nepali_date_picker](https://pub.dev/packages/nepali_date_picker) · [bikram_sambat (pub.dev)](https://pub.dev/documentation/bikram_sambat/latest) · [nepali_kit](https://pub.dev/packages/nepali_kit)
Offline: [PowerSync Supabase+Flutter](https://www.powersync.com/blog/showcase-powersync-for-supabase-and-flutter) · [powersync-ja GitHub](https://www.github.com/powersync-ja) · [ElectricSQL docs](https://electric.ax/docs) · [Electric v1.1](https://electric.ax/blog/2025/08/13/electricsql-v1.1-released) · [drift](https://pub.dev/packages/drift)
Contract tooling: [openapi-typescript](https://www.npmjs.com/package/openapi-typescript) · [openapi-generator](https://openapi-generator.tech/) · [Prism](https://github.com/stoplightio/prism) · [MSW](https://mswjs.io/) · [oasdiff](https://github.com/oasdiff/oasdiff) · [Atlas](https://atlasgo.io/)
WhatsApp: [Meta pricing updates](https://developers.secure.facebook.com/docs/whatsapp/pricing/updates-to-pricing) · [360dialog 2025 updates](https://360dialog.com/partner-updates/2024-insights-and-meta-updates-2025) · [July 1 2025 per-message change](https://www.bot.space/blog/whatsapp-business-api-pricing-update---effective-july-1-2025)

---

## Verification log — Pass 1 (2026-11-05)

Method:
- Capacity arithmetic was recomputed by hand.
- Package claims were checked against the live registries: the npm registry API, the PyPI JSON API, the crates.io API, and pub.dev and pkg.go.dev pages.
- Docs claims were checked by opening the primary pages.
- GitHub API, proxy.golang.org and metacpan were unreachable from this environment, so repo-only claims were checked through registry or docs pages where possible, or left UNVERIFIED.

| # | Claim | Verdict | Correction | Source |
|---|---|---|---|---|
| 1 | 500 patients × 10 = 5,000 orders/day | CONFIRMED | Row relabelled "billable test orders" (the original said "analytes") | arithmetic |
| 2 | Result values 3–5× orders = 15k–25k/day | CONFIRMED (arithmetic; inputs are assumptions) | Noted ≈30–50 analytes/patient | arithmetic |
| 3 | Analyser msgs 500 × 2–4 = 1,500–3,000/day | WRONG | 500 × 2–4 = 1,000–2,000; the multiplier was changed to 3–6 to keep 1,500–3,000 | arithmetic |
| 4 | Peak 125 registrations/h ≈ 1 per 29 s | CONFIRMED | — | 500 × 25% = 125; 3600/125 = 28.8 s |
| 5 | Peak result rows ~5,000/h ≈ 1.4/s | CONFIRMED (midpoint) | Range 5,000–6,250/h ≈ 1.4–1.7/s shown | arithmetic |
| 6 | Peak analyser msgs ~600/h ≈ 1 per 6 s | CONFIRMED (midpoint) | Range 375–750/h shown | arithmetic |
| 7 | 60 staff sessions → 6–12 req/s | CONFIRMED | — | 20×2+20 = 60; 60/10–60/5 |
| 8 | N=10: 60–120 req/s sustained peak | CONFIRMED | Bursts at N=10 ≈ 500 req/s added | arithmetic |
| 9 | N=10: ~250 writes/s worst case | WRONG (not derivable) | Derived ≲50 writes/s; 250 kept as a labelled headroom target (§1.1, REQ-ARCH-001) | arithmetic |
| 10 | Result storage 5 MB/day → ×5 → 9 GB/yr/lab | CONFIRMED | — | 25k×200 B; ×5×365 = 9.1 GB |
| 11 | PDFs 600 × 150 KB = 90 MB/day ≈ 33 GB/yr | CONFIRMED (arithmetic) | 150 KB/PDF marked UNVERIFIED — needs measuring | arithmetic |
| 12 | Raw archive 15 MB/day ≈ 5.5 GB/yr | CONFIRMED | — | 3,000×5 KB×365 |
| 13 | "<50 GB/year" sizing rationale | WRONG (scope) | That figure is per lab (≈47.5 GB/yr); total ≈475 GB/yr at 10 labs | arithmetic |
| 14 | VM-2 200 GB hosts MinIO/Storage | WRONG (inconsistent with §1.2) | Separate growable object-storage volume required; REQ-ARCH-003 amended | arithmetic |
| 15 | 25k × 10 × 365 ≈ 91 M rows/yr | CONFIRMED | — | = 91.25 M |
| 16 | 18 GB + indexes ≈ 50 GB/yr | WRONG (inconsistent with §1.2's ×5) | Range 50–90 GB/yr | arithmetic |
| 17 | 500 invoices/day ≈ 1 per 2 min peak | WRONG | Peak ≈ 1 per 29 s; contention still negligible | arithmetic |
| 18 | Jobs ~2–5/s peak | CONFIRMED (as an upper bound at N=10) | Basis added: ~0.1–0.2/s anchor, ~1–2/s at N=10 | arithmetic |
| 19 | 600–1,000 PDFs/day ⇒ ~2/min peak | WRONG | Aligned to §1.1 (500–700, ≤1,000) ⇒ 2–4/min | arithmetic |
| 20 | shared_buffers ≈ 25% of RAM (8 GB of 32 GB) | CONFIRMED | Docs: "reasonable starting value", and >40% is unlikely to help | [PG docs](https://www.postgresql.org/docs/current/runtime-config-resource.html) |
| 21 | Supabase self-host compose includes Kong and Logflare | OUTDATED | Envoy is the default gateway (Kong optional); logs/analytics is an opt-in add-on; imgproxy is removable | [Supabase self-hosting](https://supabase.com/docs/guides/self-hosting/docker) |
| 22 | Supavisor is the stack's pooler | CONFIRMED | PgBouncer is an optional alternative | same |
| 23 | No automatic TLS | CONFIRMED | HTTP on :8000; docs recommend a reverse proxy | same |
| 24 | No PITR UI / no branching / single-node | UNVERIFIED — needs confirmation | Not contradicted, not explicitly stated | same |
| 25 | Coupled service versions make upgrades risky | CONFIRMED | Docs: mixing image tags is "not guaranteed"; monthly snapshots; `update.sh` | same |
| 26 | Txn pooling breaks SET, LISTEN, session advisory locks | CONFIRMED | List extended (PREPARE, WITH HOLD, temp tables) | [PgBouncer features](https://www.pgbouncer.org/features.html) |
| 27 | Prepared statements break only on "older pgbouncer" | CONFIRMED (refined) | Protocol-level prepared stmts need `max_prepared_statements` > 0 (≥1.21); Supabase shared pooler txn mode: disable | [PgBouncer features](https://www.pgbouncer.org/features.html), [Supabase connecting](https://supabase.com/docs/guides/database/connecting-to-postgres) |
| 28 | `SET LOCAL` / `set_config(...,true)` is transaction-scoped | CONFIRMED | — | [PG SET](https://www.postgresql.org/docs/current/sql-set.html) |
| 29 | PostgREST: one transaction per request, transaction-local claims | CONFIRMED | — | [PostgREST transactions](https://docs.postgrest.org/en/stable/references/transactions.html) |
| 30 | Postgres 18 has native `uuidv7()` | CONFIRMED | *Pass 3: but the self-hosted image is PG 17.6 (no `uuidv7()`), so IDs are app-generated* | [PG18 UUID functions](https://www.postgresql.org/docs/18/functions-uuid.html) |
| 31 | Atlas `migrate lint` usable as a CI gate | OUTDATED | Pro-only since v0.38 (`atlas login`); D7 ⚠ revisit | [Atlas lint](https://atlasgo.io/versioned/lint) |
| 32 | Atlas detects missing CONCURRENTLY | CONFIRMED (Pro) | PG101/PG102/PG103 analyzers | [Atlas analyzers](https://atlasgo.io/lint/analyzers) |
| 33 | graphile-migrate "maintained" | OUTDATED | Stable 1.4.1 (Dec 2022); 2.0.0-rc.6 (Oct 2026) | npm registry |
| 34 | sqitch exists and is maintained | UNVERIFIED — needs confirmation | Site exists; release recency not reachable (metacpan blocked) | [sqitch.org](https://sqitch.org/) |
| 35 | `@remotemerge/nepali-date-converter` exists | CONFIRMED | 1.2.7, 31 Oct 2026, MIT | npm registry |
| 36 | `@sbmdkl/nepali-date-converter` exists | CONFIRMED | 2.0.5, May 2026 | npm registry |
| 37 | `bikram-sambat` (JS) exists | CONFIRMED | 1.8.1, Jun 2026, Apache-2.0 | npm registry |
| 38 | bikram-sambat maintained by Medic (CHT) | UNVERIFIED — needs confirmation | GitHub not reachable | — |
| 39 | `nepali_date_picker` "v7.x line" | OUTDATED | Latest 8.0.0 (Sep 2026) | [pub.dev](https://pub.dev/packages/nepali_date_picker) |
| 40 | `nepali_utils` maintenance status (was UNVERIFIED) | CONFIRMED (resolved) | 3.0.8, Apr 2025; not discontinued; a dependency of nepali_date_picker 8.0.0 | [pub.dev](https://pub.dev/packages/nepali_utils) |
| 41 | `bikram_sambat` (Dart) exists | CONFIRMED | 1.2.0 (~3 months old) | [pub.dev](https://pub.dev/packages/bikram_sambat) |
| 42 | `nepali_kit` exists | CONFIRMED | 1.1.0, Oct 2026 | [pub.dev](https://pub.dev/packages/nepali_kit) |
| 43 | `nepali_date_converter_plus` is 0.0.1 | UNVERIFIED — needs confirmation | Not re-checked | — |
| 44 | IRD: chronological numbering, no deletion, cancel + report, real-time CBMS sync, audit trail | CONFIRMED (community source, not IRD text) | Reprint "copy of original" + print count added | [Frappe thread](https://discuss.frappe.io/t/compliance-requirement-that-must-be-fulfilled-to-get-approval-from-tax-authority-in-nepal/34532) |
| 45 | IRD requires *gapless* numbering / restricts post-print edits | UNVERIFIED — needs confirmation | The source says "chronological order"; gapless kept as the safe superset; D9 note | same |
| 46 | Nepal e-invoicing booklet (vatupdate) | UNVERIFIED — needs confirmation | Fetch failed this pass | — |
| 47 | pg-boss: mature, cron, retries | CONFIRMED | 12.38.0, Oct 2026, MIT | npm registry, [releases](https://github.com/timgit/pg-boss/releases) |
| 48 | pg-boss "archival built in" | UNVERIFIED — needs confirmation | v12 notes describe a retention sweep and deletion only | same |
| 49 | Graphile Worker ~10k jobs/s claimed | OUTDATED | Docs now claim ~183k jobs/s (i9 desktop, batching) and <5 ms latency | [perf docs](https://worker.graphile.org/docs/performance) |
| 50 | Graphile Worker: LISTEN/NOTIFY, crontab, `add_job()` from SQL/triggers | CONFIRMED | `add_job` needs owner privilege or a SECURITY DEFINER wrapper | [docs](https://worker.graphile.org/docs), [add_job](https://worker.graphile.org/docs/sql-add-job) |
| 51 | Graphile Worker transactional enqueue (outbox) | CONFIRMED (inferred) | Docs cite "Postgres' transactional guarantees"; add_job is SQL in the caller's txn; no explicit commit-visibility sentence found | same |
| 52 | BullMQ exists (Redis-based) | CONFIRMED | 6.7.0, Nov 2026 | npm registry |
| 53 | Playwright exists | CONFIRMED | 1.64.1, Oct 2026 | npm registry |
| 54 | Typst exists | CONFIRMED | typst-cli 0.15.1, Jul 2026 | crates.io |
| 55 | WeasyPrint exists | CONFIRMED | 70.0, Sep 2026 | PyPI |
| 56 | pdf-lib "pure JS, maintained" | WRONG | Last release 1.17.1 (Nov 2021); maintained forks @cantoo/pdf-lib 2.11.1, @pdfme/pdf-lib 6.2.8; REQ-ARCH-046 amended | npm registry |
| 57 | qpdf battle-tested, supports linearization | CONFIRMED | 12.4.2, Sep 2026 | [qpdf release notes](https://qpdf.readthedocs.io/en/stable/release-notes.html) |
| 58 | ASTM low-level frames: FN 1–7,0; checksum FN..ETB/ETX mod 256 as 2 hex chars; ENQ/ACK/NAK/EOT | CONFIRMED | Added 247-character max frame (240 data) | [Beckman Coulter LIS spec](https://www.beckmancoulter.com/download/file/wsr-228138/C03112AE?type=pdf), [iNTERFACEWARE](https://help.interfaceware.com/kb/1340) |
| 59 | ENQ contention: instrument wins | CONFIRMED | Instrument retries after 1 s; host defers 20 s | Beckman Coulter LIS spec |
| 60 | E1381/E1394 renamed CLSI LIS1-A/LIS2-A2 | UNVERIFIED — needs confirmation (*Pass 2: LIS2 ↔ E1394 now CONFIRMED by 01 Pass 1 via the CLSI LIS2-A2 preview, "LIS2 is a revision of the former ASTM E1394-97"; LIS1 ↔ E1381 still UNVERIFIED*) | CLSI pages not opened | https://webstore.ansi.org/preview-pages/CLSI/preview_LIS2-A2.pdf |
| 61 | MLLP framing 0x0B … 0x1C 0x0D | CONFIRMED | — | [HL7 MLLP spec](https://www.hl7.org/documentcenter/public/wg/inm/mllp_transport_specification.PDF) |
| 62 | ACK original vs enhanced; MSH-15/16; AA/AE/AR, CA/CE/CR | CONFIRMED | — | [Medplum ack modes](https://www.medplum.com/docs/agent/acknowledgement-modes) |
| 63 | ORM^O01 legacy / OML^O21 newer order | CONFIRMED | OML^O21 introduced in v2.4; some profiles still mandate ORM | [HL7 Australia OO](https://hl7.org.au/archive/hl7v2wg/5-Observation-Ordering_1278282.html) |
| 64 | node-hl7-client / node-hl7-server exist, active | CONFIRMED | 4.1.2, 29 Oct 2026 | npm registry |
| 65 | hl7-standard exists ("check recency") | OUTDATED | Last release 1.0.4, May 2022 | npm registry |
| 66 | python-hl7 maintained | OUTDATED | Last PyPI release 0.4.5, Mar 2022 | PyPI |
| 67 | Mirth/NextGen Connect license (was UNVERIFIED) | CONFIRMED (resolved) | 4.6+ commercial/proprietary only; 4.5.2 last open-source | [NextGen announcement](https://www.nextgen.com/blog/industry-news/a-new-era-for-mirth-connect-by-nextgen-healthcare) |
| 68 | Python `astm` old/unmaintained | CONFIRMED | 0.5.0, 2013 | PyPI |
| 69 | No maintained Go/C#/JS ASTM lib | UNVERIFIED — needs confirmation (kept) | Partial prior art: the Medplum agent's ASTM channels (TCP-only, no checksum validation/NAK) | [Medplum ASTM](https://www.medplum.com/docs/agent/astm-channels) |
| 70 | go.bug.st/serial maintained | CONFIRMED | v1.8.0, Jul 2026, BSD-3 | [pkg.go.dev](https://pkg.go.dev/go.bug.st/serial) |
| 71 | tarm/serial stale | UNVERIFIED — needs confirmation | GitHub/Go proxy unreachable | — |
| 72 | golang.org/x/sys/windows/svc for Windows services | CONFIRMED | x/sys v0.49.0, Oct 2026 | [pkg.go.dev](https://pkg.go.dev/golang.org/x/sys/windows/svc) |
| 73 | node serialport mature | CONFIRMED | 13.0.0, Dec 2024 | npm registry |
| 74 | PowerSync core FSL source-available | OUTDATED | Relicensed to Apache 2.0 on 3 Nov 2026 (repo LICENSE is Apache 2.0); SDKs Apache/MIT; legal overview page still says FSL; D14 ⚠ revisit | [PowerSync blog update](https://powersync.com/blog/new-open-era-for-powersync), [fair-source post](https://www.powersync.com/blog/powersync-supports-fair-source), [legal overview](https://powersync.com/legal/overview), powersync-service LICENSE |
| 75 | PowerSync Supabase+Flutter showcase page | UNVERIFIED — needs confirmation | Not opened | — |
| 76 | ElectricSQL read-path only; writes via own API | CONFIRMED | — | [Electric writes guide](https://electric.ax/docs/guides/writes), [repo](https://github.com/electric-sql/electric) |
| 77 | ElectricSQL Apache-2.0; v1.1 release post | CONFIRMED | No official Dart client listed | same, [v1.1](https://electric.ax/blog/2025/08/13/electricsql-v1.1-released) |
| 78 | drift is the mature Flutter SQLite ORM | CONFIRMED | 2.35.3 (~12 days old) | [pub.dev](https://pub.dev/packages/drift) |
| 79 | openapi-typescript + openapi-fetch maintained | CONFIRMED | 7.13.0 / 0.17.0, Feb 2026 | npm registry |
| 80 | fastify-openapi-glue exists | CONFIRMED | 4.12.0, Oct 2026 | npm registry |
| 81 | openapi-generator dart-dio OAS 3.1 completeness | UNVERIFIED — needs confirmation (kept) | Docs list OAS2/OAS3 only; `not` unsupported | [dart-dio docs](https://openapi-generator.tech/docs/generators/dart-dio) |
| 82 | Prism active | CONFIRMED | v5.16.0, Jul 2026 | [Prism releases](https://github.com/stoplightio/prism/releases), npm |
| 83 | Prism supports OAS 3.1 | UNVERIFIED — needs confirmation | Release page says "OpenAPI2/3" | same |
| 84 | MSW active | CONFIRMED | 3.0.3, Oct 2026 | npm registry |
| 85 | oasdiff classifies breaking changes | CONFIRMED | v1.35.0, Oct 2026 | [pkg.go.dev](https://pkg.go.dev/github.com/oasdiff/oasdiff) |
| 86 | WhatsApp per-message pricing since 1 Jul 2025 | CONFIRMED | — | [Meta pricing](https://developers.facebook.com/docs/whatsapp/pricing) |
| 87 | Utility templates free inside an open service window | CONFIRMED | — | same |
| 88 | Any Oct 2026 WhatsApp pricing change | WRONG (Pass 3) | Meta lists 1 Oct 2026 rate-card updates: Nepal (with Bangladesh, Iraq, Sri Lanka) gets its own lower utility/authentication rates + a new authentication-international rate. In-window utility charging is not on Meta's page | https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing.md |
| 89 | Nepal-region WhatsApp utility rate | UNVERIFIED — needs confirmation | — | — |
| 90 | Sparrow/Aakash SMS pricing | UNVERIFIED — needs confirmation | Not checked | — |
| 91 | Nepal lab-report legal retention period | UNVERIFIED — needs confirmation | Not checked | — |

**Totals:** 91 checked · 59 confirmed · 8 wrong · 8 outdated · 16 unverifiable.

**Internal consistency fixes:**
- §1.1 vs REQ-ARCH-001 (writes/s)
- §1.2 vs §3.2 (DB growth multiplier)
- §1.1 vs §5.1 (PDF counts)
- §1.2 vs §1.3 / REQ-ARCH-003 (object-storage disk)
- §3.5 / §8.3 / REQ-ARCH-026 / REQ-ARCH-080 vs Atlas Pro gating
- §7 / REQ-ARCH-068 vs PowerSync license
- REQ-ARCH-011 / REQ-ARCH-017 vs Envoy default gateway

**Decisions flagged ⚠ revisit:** D7, D14. D3 and D9 received notes only; their facts were not wrong.

---

## Verification log — Pass 2 (consistency, 2026-11-05)

Scope: cross-file consistency of 01/02/03 against each other and against 00-scope-baseline.md. The authoritative resolved values are now in `04-consolidated-decisions.md`. No REQ-ARCH IDs renumbered; Pass 2 text is marked inline.

| Topic | Files involved | Conflict | Resolution | Source |
|---|---|---|---|---|
| WhatsApp 1 Oct 2026 changes | 03 §9.1 / REQ-ARCH-082 / log #88, 01 §4.5 | 03 said in-window sends are free with no Oct-2026 change; 01 stated the changes as BSP-confirmed fact | Both say "reported by BSPs, not confirmed on Meta's pricing page — UNVERIFIED". Meta's new docs path shows rate cards effective 1 Apr 2026 (03's "1 Oct 2025" came from the old path). The cost model assumes charged | https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing ; https://respond.io/blog/whatsapp-pricing-change-2026.md |
| Staff web BFF vs client Supabase access | 03 §2.5 / D2, 02 REQ-SEC-068 | 03 allowed client PostgREST reads and browser Realtime; 02 requires HttpOnly via server-only BFF | BFF, no browser Supabase client; SSE/polling for live staff UI; Realtime only for Flutter | https://supabase.com/docs/guides/auth/server-side/advanced-guide |
| RLS tenant source | 03 §3.1 / REQ-ARCH-019, 02 REQ-SEC-013 | `app.tenant_id` GUC vs tenant from JWT | `app.current_tenant_id()` reads `request.jwt.claims`, set transaction-locally by the API after its own JWT verification | internal |
| Owner/BYPASSRLS roles | 03 §3.1 / §3.5 / §4.1, 02 REQ-SEC-012/131 | Owner/migrator/API/worker roles unspecified; the postgres default bypasses FORCE RLS | NOLOGIN non-BYPASSRLS owner; migrator SET ROLE; separate non-BYPASSRLS API and worker roles | https://www.postgresql.org/docs/current/ddl-rowsecurity.html |
| Graphile Worker privileges | 03 §4.1, 02 REQ-SEC-019/020 | `add_job` from triggers needs owner privilege or a DEFINER wrapper, but the wrapper rules were not referenced | DEFINER wrapper in an unexposed schema, `search_path=''`; least-privilege running UNVERIFIED | https://worker.graphile.org/docs/sql-add-job (per Pass 1) |
| ASTM "dominant on Autobio/Getein" | 03 §6.1 / REQ-ARCH-051, 01 §3.1–3.2 | Stated as fact; 01 marks Autobio/Getein protocol UNVERIFIED and ASTM dominance as judgement | Marked UNVERIFIED; both stacks from sprint 1 | 01 Pass 1 #31/#35/#36 |
| Mindray host-query direction | 03 §6.1 / REQ-ARCH-052, 01 §3.1 | 03 listed ORM only as outbound; the Mindray manuals use instrument-initiated ORM^O01→ORR^O02 and QRY^Q02→QCK^Q02+DSR^Q03 | REQ-ARCH-052 adds inbound queries; HL7 v2.3.1 minimum (*Pass 3: UNVERIFIED from primary — unofficial copies only*) | https://www.scribd.com/document/562151986/LIS-BC5380 ; https://www.scribd.com/document/467496962/Comunicacion-BS120-BS200-pdf (secondary) |
| CLSI LIS2 ↔ E1394 | 03 log #60, 01 §3.1 | 03 UNVERIFIED; 01 Pass 1 CONFIRMED | LIS2 ↔ E1394 CONFIRMED; LIS1 ↔ E1381 UNVERIFIED | https://webstore.ansi.org/preview-pages/CLSI/preview_LIS2-A2.pdf |
| Ingest idempotency | 03 §6.4, 01 §3.3 | Different keys | Message-level + result-level keys; batched uploads | internal |
| Agent OS | 03 §6.3 / D12, 01 §3.3 | "Ancient lab PCs" / "Windows/Linux"; Go ≥1.21 requires Win10/Server 2016 | Windows 10/11, Server 2016+ only | https://go.dev/doc/go1.21 |
| Raw archive location | 03 REQ-ARCH-062, 02 REQ-SEC-117 | Location unstated vs 72 h local retention | Server-side archive | internal |
| IRD numbering / immutability | 03 §3.7 / D9, 01 §4.1 | 03 lacked the 2072 Procedure, penalties and developer certification; 01 stated "gapless" as verified | No edit/no delete VERIFIED (Pioneer Law); gapless = design choice, UNVERIFIED as law; both files aligned. *Pass 3: legal basis corrected to Procedure 2074 + VAT Act s.29(1)(g2) (IRD primary); 2072 is historical* | https://pioneerlaw.com/?p=551 ; https://www.ird.gov.np/public/pdf/175356524.pdf |
| pdf-lib decision line | 03 §5.2 vs REQ-ARCH-046, 02 REQ-SEC-087 | Decision line still said upstream pdf-lib | Fork named; versions re-checked on npm 2026-11-05 | https://registry.npmjs.org/@cantoo%2Fpdf-lib ; https://registry.npmjs.org/@pdfme%2Fpdf-lib |
| Renderer SSRF | 03 §5.1, 02 REQ-SEC-086 | No egress rule in 03 | Egress-restricted Chromium, bundled assets only | internal |
| QR verify fields | 03 §5.4 / REQ-ARCH-049, 02 REQ-SEC-093 | "Initials + test names + status" vs the 02 list | One list (04 §7) | internal |
| Audit log | 03 §3.4 / REQ-ARCH-025, 02 REQ-SEC-096 | Missing centre/IP and access events | Fields + access_log added | internal |
| Redis | 03 D8, 02 REQ-SEC-078 | "No Redis" vs Redis rate counters | Ephemeral rate-limit cache only | internal |
| Edge proxy | 03 REQ-ARCH-017 / §9.3, 02 REQ-SEC-078 | nginx/HAProxy vs nginx | nginx only | internal |
| Foreign CDN | 03 REQ-ARCH-010, 02 REQ-SEC-135, 00-scope | PHI-only ban vs default-none | Default none; founder approval for non-PHI static | 00-scope §7.1 |
| Offline token grace | 03 REQ-ARCH-070, 02 REQ-SEC-065/066 | Grace on expired tokens | Removed; refresh-then-upload | https://www.rfc-editor.org/rfc/rfc8725 |
| SMS "local" | 03 §9.1, 00-scope §7.1 | Baseline flags SMS as routing abroad | Hosting UNVERIFIED; treated as cross-border | 00-scope §7.1 |
| B.S. range | 03 §3.6, 01 §4.8 | Unsourced "1970–2100 B.S." | UNVERIFIED per library | internal |
| Auto-verify phase | 03 REQ-ARCH-063, 01 §6 row 11 | Untagged vs Phase 2 | Phase 2; Phase 1 = manual first verification | 01 §6 |
| App / payment phasing | 03 §12 Mobile, REQ-ARCH-087, 01 §6, 00-scope §1 | Untagged | Tagged; apps BLOCKED pending client priority | 00-scope §6.4 |
| PowerSync relicense date | 03 §7 / D14 / REQ-ARCH-068 | Needed a primary-source check | VERIFIED: "Licensing update November 3, 2026" on powersync.com (post originally 31 May 2024) + GitHub `powersync-service` LICENSE = Apache 2.0. No conflict | https://powersync.com/blog/new-open-era-for-powersync ; https://raw.githubusercontent.com/powersync-ja/powersync-service/main/LICENSE |
| Atlas lint paid | 03 §3.5 / D7 / REQ-ARCH-026 / 080 | Only 03 mentions it; consistent internally. Added: squawk-cli 2.70.0 exists (coverage UNVERIFIED) | No conflict; decision BLOCKED on the founder (04) | https://registry.npmjs.org/squawk-cli |
| Storage path | 03 §5.3, 02 REQ-SEC-034 | Ambiguous whether `reports` is a bucket | Clarified: `reports` = private bucket, `tenant_id` = first path segment | internal |

AST interpretation check: 03 contains no AST data-model text that hard-codes S/I/R (grep 2026-11-05); 04 records the extensible coded set from 01 §2.3.

**Pass 2 totals for this file:** 24 cross-file conflicts touched 03 and were fixed; 3 checks (PowerSync, Atlas, storage path) needed no conflict fix. Full cross-set list: 27 (see 04).

---

## Verification log — Pass 2b (primary-source corrections, 2026-11-05)

Source of every change: `05-pass2-critical-recheck.md` (05). Precedence: 04 overrides this file.

| Item | Old | New | Source (from 05) |
|---|---|---|---|
| Log #88 | CONFIRMED none listed; cards effective 1 Oct 2025 | WRONG (Pass 3): 1 Oct 2026 update, Nepal own lower utility/auth rates; in-window charging not on Meta's page | 05 T1, item 44 |
| §9.1 | No 1 Oct 2026 change is listed | Meta lists 1 Oct 2026 update for Nepal; not in-window charging | 05 T1, item 45 |
| REQ-ARCH-082 | BSP-reported charges | + Nepal 1 Oct 2026 rate update (figure UNVERIFIED) | 05 T1 |
| §3.7 first bullet | Software must be listed/approved by IRD | listed with IRD (cl.3) + taxpayer permission (cl.4); cl.7(ख) for central servers; Procedure 2074 text pointer | 05 T3, item 46 |
| §3.7 Pass 2 paragraph | 2072 Procedure basis; NPR 1,000 per instance; supersession UNVERIFIED | Procedure 2074 + VAT Act s.29(1)(g2)/(c) fines corrected; billing isolatable per tenant (04 D16/B17) | 05 T3 (L1/L5 rows) |
| §3.1 IDs; REQ-ARCH-021; log #30 | PG 18 uuidv7() natively, else app-generated | PG 17.6.1.136 image → no native uuidv7(); app-generated UUIDv7 | 05 T6, item 47 (mirror 18) |
| §3.6; REQ-ARCH-029/030; open item 10 | B.S. range UNVERIFIED; bikram-sambat as option | Ranges per library; bikram-sambat ends 2090 (not primary); @remotemerge 1.2.7 + nepali_utils 3.0.8; shared golden table 2000–2099 | 05 T13, item 47 (mirror 22) |
| §2.1; REQ-ARCH-011/017 | no port-binding note | stock compose binds :8000/:5432/:6543 on 0.0.0.0 → 127.0.0.1/private + firewall + infra test | 05 T6, item 48 (mirror 20) |
| §2.1; REQ-ARCH-015; D3 | PgBouncer optional | official docker-compose.pgbouncer.yml override, Supavisor disabled; PgBouncer ≥1.21 | 05 T6, item 48 (mirror 21) |
| §6.3 Go toolchain | Go ≥1.21 only | + Go ≥1.26 (x/sys v0.49.0 go.mod), pinned consistently | 05 T13 |
| REQ-ARCH-078 | oasdiff in CI | + pin stable 1.35.x; 3.1 only in beta line | 05 T13 |
| REQ-ARCH-052; Pass 2 Mindray conflict row | confirmed HL7 via secondary copies | UNVERIFIED from primary — unofficial copies only | 05 T11 (leftover-grep fixes) |
| Pass 2 IRD conflict row | 2072 Procedure basis | + Procedure 2074 + VAT Act s.29(1)(g2); 2072 historical | 05 T3 (leftover-grep fix) |
