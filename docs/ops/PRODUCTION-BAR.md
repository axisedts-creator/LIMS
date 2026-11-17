# API production bar

Owner: C0 (core). Source: T0B-PERF-1 under LD-310 (founder request 2026-11-17 04:54 and 05:00 NPT: light on low end PCs,
no lag, fast upload and download, production grade backend). Baseline measured by the lead on 2026-11-17 05:20 NPT
(staging, warm): two analytics reads of an EMPTY lab took 591 ms and 648 ms; the free tier API sleeps and the first call
after a sleep takes 60 to 90 s.

Status words: **met** (already true before this task), **met by this task**, **needs a founder or hosting step**
(money, provider or hosting settings: prepared here, not done by a task), **not met** (open engineering work).
Rows marked **met** were checked by locating the mechanism in the repo; T0B-PERF-1 did not re-test them on staging.

## The bar

| Item | Bar (numbers) | Status | Evidence / next step |
|---|---|---|---|
| p95 latency of list reads | p95 under 300 ms for list reads, measured at the API (Server-Timing `total`) | needs a founder or hosting step | Measure on always on hosting; a sleeping free tier instance cannot meet it. Server-Timing and the request log now give the number per call. |
| p95 latency of writes | p95 under 800 ms for writes, measured at the API | needs a founder or hosting step | Same as list reads. |
| Cold start | zero cold start: the first call answers like any other | needs a founder or hosting step | Paid always on API hosting, or an external keep warm ping of `/v1/core/health/live` every few minutes. Money decision (LD-310 (e)); only described here. |
| Daily backups and a tested restore | automatic daily backup, one restore tested end to end | needs a founder or hosting step | Supabase plan item; restore drill to be run and recorded by the founder. |
| Audit trail on every write | every write leaves an audit row in the same transaction | met | Module audit writes in the request transaction (core/audit, module audit tables). |
| Row level tenant isolation | row level security on every tenant table, tenant from the verified token only | met | `ENABLE ROW LEVEL SECURITY` in db/migrations; claims set transaction-local per request (core/db/tx.ts). |
| Rate limits on login and public endpoints | per tier limits on login and public operations, HMAC keyed buckets | met | core rate limiter (stage 5), `x-rate-limit-tier` per operation. |
| Queue retries with dead letters | failed jobs retry with backoff, then land in a dead letter list | met | Worker retries; dead letters screen (docs/manual/platform/dead-letters.md). |
| Secrets only in environment | no secret in the repo; keys from env or key files | met | docs/runbooks/environment.md lists names only. |
| TLS only | HTTPS only between browser, web and API; HTTP redirected | needs a founder or hosting step | Hosting terminates TLS; confirm the HTTPS only switch in the hosting settings (cloud setting, founder). |
| Security headers | nosniff, frame denial, HSTS, referrer policy on every page | met | Web middleware and the edge nginx header snippets. |
| Dependency audit clean of high findings | `pnpm audit --audit-level high` reports no high or critical finding | not met | 2026-11-17 run: 2 high, 3 critical (dev tooling chains such as prism-cli); CI triages them against the triage file. Needs a dependency upgrade task. |
| Response compression | every JSON response over 1 KB is gzip or brotli compressed when the client accepts it | met by this task | core/observability/http-perf.ts; 1 KB or less and non JSON bodies stay as they are. |
| Server-Timing and request log | every response carries `Server-Timing: total;dur=, db;dur=, rid;desc=`; one log line per request with route, status, duration_ms, db_count, db_ms, request_id and no personal data | met by this task | http-perf.ts and observability/logging.ts. |
| No N+1 (static scan of the four modules) | no query per row in list paths of identity, catalog, frontdesk and billing | met by this task | Per request query counter (observability/request-stats.ts, fed by core/db/tx.ts); static scan of the four modules: no N+1 found. |
| At most 4 queries for an empty list on real endpoints | a list endpoint issues at most 4 queries for an empty list | **not met** | Counter and query-budget helper in place; not yet measured on the real list endpoints (needs DB-backed test or staging log of db_count). |
| Statement timeout and pool | statement timeout 5 s (5000 ms) for reads, 15 s (15000 ms) for writes; pool sized for the Supabase pooler | met by this task | See the settings below. |
| Readiness, liveness and graceful shutdown | readiness and liveness answer in under 200 ms with no auth detail and `Cache-Control: no-store`; a hung check still ends in 503 within 3 s; SIGTERM drains in-flight requests | met by this task | core/health.ts, core/shutdown.ts, main.ts. |

## Settings (environment, safe defaults)

| Name | Default | Meaning |
|---|---|---|
| `LIMS_CORE_STATEMENT_TIMEOUT_MS` | 5000 | Statement timeout of read requests (GET, HEAD). |
| `LIMS_CORE_STATEMENT_TIMEOUT_WRITE_MS` | 15000 | Statement timeout of every other request. |
| `LIMS_CORE_DB_POOL_MAX` | 10 | Connections per API process; 1 to 60 accepted. Keep processes x pool under the Supabase pooler limit of the plan. |
| `LIMS_CORE_LOCK_TIMEOUT_MS` | 3000 | Lock wait bound. |

Fixed in code: pool idle timeout 30 s, connect timeout 10 s, HTTP keep-alive 72 s (above a 60 s proxy idle time),
headers timeout 75 s, shutdown grace 25 s.

## Cold start and the waking screen

The web app shows a friendly waking screen (T0D-WAKE-1) and polls `/v1/core/health/ready`. main.ts runs nothing but
bootstrap before `listen` (no migrations, seeds or warm up), so the readiness route is the first thing that answers.
Migrations run through push-cloud.ps1 by the founder, never at boot. Real zero cold start needs always on hosting or a
keep warm ping (founder money decision, LD-310 (e)).

## How to read the numbers

`Server-Timing` is visible in the browser network panel: `total` is the API time, `db` the database time of the
request. A slow call with a small `db` is API or network time; a large `db` with a high `db_count` in the log is a
query budget problem.
