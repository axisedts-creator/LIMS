# Environment variables (LIMS_*)

T0B-OPSDOC-1 (audit RS-16, LD-277). Every `LIMS_*` name that the API (`services/api/src`), the worker
(`services/worker/src`) and the web app (`apps/web/src`) read. **Names only: this file never holds a value, an example
value or a secret.** Secrets are provided as files (`*_KEY_FILE`, `*_TOKEN_FILE`) or by the hosting secret store; see
`spec/` and `infra/` for where each one comes from.

How this list is kept complete:

- `node tests/docs/lims-env-scan.mjs` (run from the repository root) prints every `LIMS_*` name the code reads, with the
  files that read it. Comments, tests and fixtures are skipped.
- `services/api/src/__tests__/env-doc.test.ts` fails when the scan finds a name that is not a row below.
- Limit: the scan cannot see a name built at run time. Two modules build their names from a prefix
  (`modules/payments/config.ts`: `LIMS_PAYMENTS_` + suffix; `modules/engagement/config.ts`: `LIMS_ENGAGEMENT_` + suffix).
  Those rows were added by hand from those two files; check them when either file changes.

Columns:

- **Module**: `core`, `worker`, `web`, or the API module that owns the name.
- **Required**: `required` = the API cannot serve its main flows in a deployed environment (dev, staging, production)
  without it. `GET /v1/core/health/ready` answers `degraded` and lists the unset required names in `missing_env`
  (names only). `optional` = a default applies or only one feature is affected. Names that only the worker or the web
  read are marked `optional` here because the API readiness check cannot see their process; their "When unset" column
  says what their own process does.
- **When unset**: what the code does when the name is missing or empty.

## Clean checkout

`dist` folders are not committed (LD-284). From a clean checkout, build the worker's dependencies before starting the
worker or running the registry sync:

```
pnpm install
pnpm --filter "@lims/worker^..." run build --if-present
```

Without it the worker or `registry-sync` stops with `ERR_MODULE_NOT_FOUND` (for example `@lims/shared-ts` `dist/`).

## Core (API platform)

| Name | Module | Required | When unset |
|---|---|---|---|
| `LIMS_CORE_ENV` | core | required | The API, the reporting module and the worker refuse to start: one of dev, ci, staging, production must be given. The web treats it as not dev. |
| `LIMS_CORE_DATABASE_URL` | core | optional | Needed in every deployed environment. Marked optional only because readiness already reports it through its own check: no database pool is opened, readiness reports db and ratelimit down (503) and every database-backed operation fails. |
| `LIMS_CORE_RATELIMIT_KEY_FILE` | core | required | With a database URL set, the API refuses to start (the rate limiter needs its key file). |
| `LIMS_CORE_JWT_ALG` | core | required | All four JWT names unset: no staff bearer token is accepted and bearerJwt operations are refused. One of the four set without the others: the API refuses to start. |
| `LIMS_CORE_JWT_ISSUER` | core | required | Same as LIMS_CORE_JWT_ALG: staff sign-in tokens are not accepted. |
| `LIMS_CORE_JWT_AUDIENCE` | core | required | Same as LIMS_CORE_JWT_ALG: staff sign-in tokens are not accepted. |
| `LIMS_CORE_JWT_KEY_FILE` | core | required | Same as LIMS_CORE_JWT_ALG: staff sign-in tokens are not accepted. |
| `LIMS_CORE_STORAGE_KEY_FILE` | core | required | Every file upload or download through core storage fails with an internal error (no storage credential). |
| `LIMS_WEB_BFF_KEY_FILE` | core | required | API: no staff web BFF key is accepted, so every staff web call is rejected. Web: the web refuses BFF calls unless a dev or ci environment provides LIMS_WEB_BFF_KEY. |
| `LIMS_PARTNER_BFF_KEY_FILE` | core | optional | No partner BFF key is accepted: calls from the partner app are rejected. Set it when the partner app is deployed. |
| `LIMS_PORTAL_BFF_KEY_FILE` | core | optional | No portal BFF key is accepted: calls from the patient portal app are rejected. Set it when the portal is deployed. |
| `LIMS_ORIGIN_API` | core | required | Web: every server-side API call throws (API origin not set). API: messaging admin links cannot be built. |
| `LIMS_ORIGIN_STAFF_WEB` | core | required | Analytics schedules fail (no absolute link), staff notification links cannot be built, and the payments return-URL default cannot be built so the API refuses to start unless LIMS_PAYMENTS_RETURN_URL_ALLOWLIST is set. |
| `LIMS_ORIGIN_PORTAL` | core | required | Portal links in report delivery, engagement links and portal payment tasks cannot be built; the payments return-URL default cannot be built (same as LIMS_ORIGIN_STAFF_WEB). |
| `LIMS_CORE_RESPONSE_VALIDATION` | core | optional | Default: on everywhere except production, off in production. |
| `LIMS_CORE_LOAD_SAMPLE_MODULE` | core | optional | Default 0: the ci-only sample module is not mounted. |
| `LIMS_CORE_LOG_LEVEL` | core | optional | Default info (API and worker). |
| `LIMS_CORE_TRUSTED_PROXY_CIDRS` | core | optional | No trusted proxy: the client IP is the direct peer address and forwarded headers are ignored. |
| `LIMS_CORE_TX_RETRY_MAX` | core | optional | Default 3 whole-request retries on serialization failure or deadlock. |
| `LIMS_CORE_IDENTITY_AUTH_OPS` | core | optional | The built-in list of identity authentication operations is used. |
| `LIMS_CORE_WITH_TENANT_SCOPE_OPS` | core | optional | The built-in list of tenant-scope operations is used. |
| `LIMS_CORE_METRICS_PORT` | core | optional | Default 9464 for the internal metrics listener (API and worker). |
| `LIMS_CORE_DB_POOL_MAX` | core | optional | Default pool size 10 per process (fits the Supabase pooler; 1..60 accepted, T0B-PERF-1). |
| `LIMS_CORE_STATEMENT_TIMEOUT_MS` | core | optional | Default 5000 ms statement timeout for read requests (GET, HEAD). |
| `LIMS_CORE_STATEMENT_TIMEOUT_WRITE_MS` | core | optional | Default 15000 ms statement timeout for write requests (T0B-PERF-1). |
| `LIMS_CORE_LOCK_TIMEOUT_MS` | core | optional | Default 3000 ms lock timeout. |
| `LIMS_CORE_AUTHZ_MODE` | core | optional | Default shadow in every environment (LD-261): the central permission check logs denials and does not block; an unknown value stops boot. |
| `LIMS_CORE_FAKE_PORTS` | core | optional | No port is replaced by a fake (fakes are allowed in dev and ci only). |
| `LIMS_CORE_RATELIMIT_BACKEND` | core | optional | Default postgres. The redis choice is refused at boot (not wired yet). |
| `LIMS_CORE_REDIS_URL` | core | optional | Not used while the rate-limit backend is postgres. |
| `LIMS_CORE_TENANT_RPS` | core | optional | Default 100 requests per second per tenant. |
| `LIMS_CORE_TENANT_BURST` | core | optional | Default burst of 200 requests per tenant. |
| `LIMS_CORE_SCANNER_URL` | core | optional | The built-in default address of the clamd virus scanner on the internal network is used. If no scanner answers there, every scanned upload is treated as scan unavailable and refused. |
| `LIMS_CORE_SCANNER_TIMEOUT_MS` | core | optional | Default 30000 ms per scan; a scan that takes longer is treated as unavailable. |

Client address (LD-296): the web sends the browser's address (first `x-forwarded-for` entry, else `x-real-ip`, bare IP only) and user agent on every API call. The hosting proxy in front of the API appends its own peer, so with a verified BFF key the API uses the LEFTMOST `X-Forwarded-For` entry; without the key it uses the TCP peer, and a trusted proxy peer (the CIDR list above) still needs a single IP. If sign-in events show 127.0.0.1 or user agent `node`, the web has no BFF key file or is out of date.

## Worker and web processes

| Name | Module | Required | When unset |
|---|---|---|---|
| `LIMS_CORE_WORKER_DATABASE_URL` | worker | optional | The worker refuses to start (it is required by the worker process; the API does not read it). |
| `LIMS_MIGRATOR_DATABASE_URL` | worker | optional | The registry-sync command has no migrator connection and cannot sync the task registry. |
| `LIMS_CORE_WORKER_CONCURRENCY` | worker | optional | Default 10 concurrent jobs. |
| `LIMS_CORE_SHUTDOWN_GRACE_S` | worker | optional | Default 55 seconds before a forced exit on shutdown. |
| `LIMS_CORE_VERSION` | worker | optional | Worker log lines carry version 0.0.0. |
| `LIMS_WEB_BFF_KEY` | web | optional | Only a dev or ci fallback when LIMS_WEB_BFF_KEY_FILE is unset; ignored in staging and production. |
| `LIMS_WEB_FEATURES_DIR` | web | optional | The navigation is built from the web app's own features folder. |

## Identity

| Name | Module | Required | When unset |
|---|---|---|---|
| `LIMS_IDENTITY_EMAIL_HMAC_KEY` | identity | required | Tenant provisioning, user management, MFA verification and sign-in fail with an internal error (email HMAC key missing). |
| `LIMS_IDENTITY_GOTRUE_URL` | identity | required | Every call to the auth server fails: sign-in, sign-out, user creation and MFA answer as dependency unavailable. |
| `LIMS_IDENTITY_GOTRUE_SERVICE_KEY` | identity | required | Admin calls to the auth server (user creation, tenant provisioning) are rejected by the auth server. |
| `LIMS_IDENTITY_GOTRUE_PUBLISHABLE_KEY` | identity | optional | No apikey header is sent on non-admin auth calls; needed only for a hosted auth server that requires it. |
| `LIMS_IDENTITY_TOKEN_ENC_KEYS` | identity | required | Auth events and MFA enrolment fail with an internal error (token encryption keys missing). |
| `LIMS_IDENTITY_PLATFORM_ALLOWED_CIDRS` | identity | optional | No global network restriction for platform staff sign-in; only each staff member's own CIDR list applies. |
| `LIMS_IDENTITY_PLATFORM_IDLE_MINUTES` | identity | optional | Default 15 minutes idle timeout for platform sessions. |
| `LIMS_IDENTITY_PLATFORM_ABSOLUTE_HOURS` | identity | optional | Default 8 hours absolute lifetime for platform sessions. |
| `LIMS_IDENTITY_MOBILE_ABSOLUTE_HOURS` | identity | optional | Default 12 hours absolute lifetime for staff mobile sessions. |
| `LIMS_IDENTITY_TOUCH_INTERVAL_SECONDS` | identity | optional | Default: a session is touched at most once every 60 seconds. |
| `LIMS_IDENTITY_BREACHED_LIST_PATH` | identity | optional | Worker: the breached-password import job fails with an internal error (list path not set). |

## Reporting

| Name | Module | Required | When unset |
|---|---|---|---|
| `LIMS_REPORTING_OTP_HMAC_KEY_FILE` | reporting | required | The API refuses to start (the reporting module checks the key file at load); the worker cannot send portal OTPs. |
| `LIMS_REPORTING_RENDERER_URL` | reporting | optional | The API boots; any operation that renders a report answers reporting.render_unavailable (the renderer needs both this and its token file). |
| `LIMS_REPORTING_RENDERER_TOKEN_FILE` | reporting | optional | Same as LIMS_REPORTING_RENDERER_URL: rendering answers reporting.render_unavailable. |
| `LIMS_REPORTING_ALLOW_REAL_PROVIDERS` | reporting | optional | Default false: outside production no real SMS or email is sent; in production the API refuses to start unless it is true. |
| `LIMS_REPORTING_OTP_MAX_ATTEMPTS` | reporting | optional | Default 5 (the only accepted value). |
| `LIMS_REPORTING_OTP_TTL_SECONDS` | reporting | optional | Default 600 seconds (also the maximum). |
| `LIMS_REPORTING_PORTAL_SESSION_IDLE_MINUTES` | reporting | optional | Default 15 minutes idle timeout for portal sessions. |
| `LIMS_REPORTING_PORTAL_SESSION_ABSOLUTE_MINUTES` | reporting | optional | Default 60 minutes absolute lifetime for portal sessions. |
| `LIMS_REPORTING_ASSEMBLY_DEBOUNCE_SECONDS` | reporting | optional | Default 30 seconds debounce before report assembly. |
| `LIMS_REPORTING_PRINT_TTL_HOURS` | reporting | optional | Default 24 hours lifetime of a print file. |
| `LIMS_REPORTING_TRANSPORT_TIMEOUT_MS` | reporting | optional | Default 10000 ms per delivery transport call. |

## Engagement

| Name | Module | Required | When unset |
|---|---|---|---|
| `LIMS_ENGAGEMENT_OTP_HMAC_KEY_FILE` | engagement | required | The API refuses to start (key file of at least 32 bytes is checked at load). |
| `LIMS_ENGAGEMENT_LINK_HMAC_KEY_FILE` | engagement | required | The API refuses to start (key file of at least 32 bytes is checked at load). |
| `LIMS_ENGAGEMENT_PHONE_HMAC_KEY_FILE` | engagement | required | The API refuses to start (key file of at least 32 bytes is checked at load). |
| `LIMS_ENGAGEMENT_OTP_ENC_KEYS_FILE` | engagement | required | The API refuses to start (a JSON key file is checked at load). |
| `LIMS_ENGAGEMENT_OTP_TTL_SECONDS` | engagement | optional | Default 300 seconds (allowed 120 to 600). |
| `LIMS_ENGAGEMENT_OTP_MAX_ATTEMPTS` | engagement | optional | Default 5 (the only accepted value). |
| `LIMS_ENGAGEMENT_OTP_LENGTH` | engagement | optional | Default 6 digits. |
| `LIMS_ENGAGEMENT_LINK_REDEEM_FAILURES_PER_HOUR` | engagement | optional | Default 5 failed link redemptions per hour. |
| `LIMS_ENGAGEMENT_ORDER_POLL_SECONDS` | engagement | optional | Default 30 seconds order status poll. |
| `LIMS_ENGAGEMENT_DISPLAY_POLL_SECONDS` | engagement | optional | Default 5 seconds queue display poll. |
| `LIMS_ENGAGEMENT_BACKFILL_MAX_ORDERS` | engagement | optional | Default 1000 orders per backfill. |
| `LIMS_ENGAGEMENT_PROJECTION_RECONCILE_DAYS` | engagement | optional | Default 30 days reconcile window. |

## Payments

| Name | Module | Required | When unset |
|---|---|---|---|
| `LIMS_PAYMENTS_PUBLIC_BASE_URL` | payments | required | The API refuses to start (an https base URL is required for gateway callbacks). |
| `LIMS_PAYMENTS_KEK_FILE` | payments | required | The API refuses to start (the key-encryption key file is required). |
| `LIMS_PAYMENTS_GATEWAY_ENV` | payments | optional | API: default uat; it must be production exactly when NODE_ENV is production or the API refuses to start. Web: the payments settings page fails to render. |
| `LIMS_PAYMENTS_ESEWA_FORM_URL` | payments | optional | Production: the built-in default is used. UAT: there is no default, so the API refuses to start. |
| `LIMS_PAYMENTS_ESEWA_STATUS_URL` | payments | optional | The built-in default for the gateway environment is used. |
| `LIMS_PAYMENTS_KHALTI_BASE_URL` | payments | optional | The built-in default for the gateway environment is used. |
| `LIMS_PAYMENTS_KHALTI_REFUND_ORIGIN` | payments | optional | The built-in default for the gateway environment is used. |
| `LIMS_PAYMENTS_RETURN_URL_ALLOWLIST` | payments | optional | Built from LIMS_ORIGIN_STAFF_WEB, LIMS_ORIGIN_PORTAL and the public base URL; the API refuses to start if those are unset. |
| `LIMS_PAYMENTS_HTTP_TIMEOUT_INITIATE_MS` | payments | optional | Default 1200 ms for payment initiation calls. |
| `LIMS_PAYMENTS_HTTP_TIMEOUT_INREQUEST_MS` | payments | optional | Default 2500 ms for in-request gateway calls. |
| `LIMS_PAYMENTS_HTTP_TIMEOUT_JOB_MS` | payments | optional | Default 10000 ms for gateway calls from jobs. |
| `LIMS_PAYMENTS_ESEWA_INTENT_TTL_MINUTES` | payments | optional | Default 30 minutes lifetime of an eSewa intent. |
| `LIMS_PAYMENTS_EXPIRY_GRACE_MINUTES` | payments | optional | Default 10 minutes grace after expiry. |
| `LIMS_PAYMENTS_POLL_SCHEDULE_SECONDS` | payments | optional | Default poll schedule of 120, 300, 600, 1200 and 2400 seconds. |
| `LIMS_PAYMENTS_VERIFY_MIN_INTERVAL_SECONDS` | payments | optional | The built-in default minimum interval between verifications is used. |
| `LIMS_PAYMENTS_RECON_LOOKBACK_SETTLED_DAYS` | payments | optional | The built-in default reconcile lookback for settled payments is used. |
| `LIMS_PAYMENTS_RECON_LOOKBACK_CLOSED_DAYS` | payments | optional | The built-in default reconcile lookback for closed payments is used. |
| `LIMS_PAYMENTS_RECON_CONCURRENCY` | payments | optional | The built-in default reconcile concurrency is used. |

## Billing

| Name | Module | Required | When unset |
|---|---|---|---|
| `LIMS_BILLING_CBMS_MODE` | billing | optional | Default stub: invoices are not sent to the tax authority; the live mode is refused until a live client exists. |
| `LIMS_BILLING_COUNTER_LOCK_TIMEOUT_MS` | billing | optional | Default 3000 ms lock timeout on invoice counters. |
| `LIMS_BILLING_EXPORT_KEY` | billing | optional | Worker: the tenant billing export job fails (it needs a 32-byte key to encrypt the export). |
| `LIMS_BILLING_EXPORT_MAX_ROWS` | billing | optional | Default 100000 rows per export (API and worker). |
| `LIMS_BILLING_EXPORT_PDF_MAX_ROWS` | billing | optional | Default 5000 rows per PDF export (API and worker). |
| `LIMS_BILLING_EXPORT_TTL_HOURS` | billing | optional | Default 24 hours lifetime of an export file (API and worker). |

## Analytics

| Name | Module | Required | When unset |
|---|---|---|---|
| `LIMS_ANALYTICS_MAX_RANGE_DAYS` | analytics | optional | Default 366 days maximum report range. |
| `LIMS_ANALYTICS_DEBOUNCE_SECONDS` | analytics | optional | Default 60 seconds refresh debounce. |
| `LIMS_ANALYTICS_SWEEP_CHUNK_DAYS` | analytics | optional | Default 7 days per sweep chunk. |
| `LIMS_ANALYTICS_NIGHTLY_DAYS` | analytics | optional | Default 40 days recomputed nightly. |
| `LIMS_ANALYTICS_STALE_DIRTY_MINUTES` | analytics | optional | Default 20 minutes before dirty data counts as stale. |
| `LIMS_ANALYTICS_STALE_SUCCESS_MINUTES` | analytics | optional | Default 30 minutes before refreshed data counts as stale. |
| `LIMS_ANALYTICS_BACKLOG_LOOKBACK_DAYS` | analytics | optional | Default 30 days backlog lookback. |
| `LIMS_ANALYTICS_YESTERDAY_UNTIL_LOCAL` | analytics | optional | Default: yesterday is the default range until 06:00 local time. |
| `LIMS_ANALYTICS_MANUAL_REFRESH_MINUTES` | analytics | optional | Default 5 minutes between manual refreshes. |
| `LIMS_ANALYTICS_EXPORTS_PER_USER_HOUR` | analytics | optional | Default 10 exports per user per hour. |
| `LIMS_ANALYTICS_EXPORTS_PER_TENANT_DAY` | analytics | optional | Default 50 exports per tenant per day. |
| `LIMS_ANALYTICS_EXPORT_MAX_ROWS` | analytics | optional | Default 100000 rows per export. |
| `LIMS_ANALYTICS_EXPORT_MAX_BYTES` | analytics | optional | Default 20 MiB per export. |
| `LIMS_ANALYTICS_EXPORT_TTL_HOURS` | analytics | optional | Default 24 hours lifetime of an export file. |
| `LIMS_ANALYTICS_EXPORT_DOWNLOADS` | analytics | optional | Default 3 downloads per export. |
| `LIMS_ANALYTICS_PDF_ENABLED` | analytics | optional | Default false: PDF export is off (API and web). |
| `LIMS_ANALYTICS_MAX_SCHEDULES_PER_TENANT` | analytics | optional | Default 20 schedules per tenant. |
| `LIMS_ANALYTICS_TAT_RETENTION_FY` | analytics | optional | Default 3 fiscal years of turnaround data kept. |

## Anatomic, frontdesk, homecollection

| Name | Module | Required | When unset |
|---|---|---|---|
| `LIMS_ANATOMIC_IMAGE_MAX_BYTES` | anatomic | optional | Default 15 MiB per image (also the maximum). |
| `LIMS_ANATOMIC_IMAGE_MAX_MEGAPIXELS` | anatomic | optional | Default 50 megapixels per image. |
| `LIMS_ANATOMIC_LIST_MAX_LIMIT` | anatomic | optional | Default 200 rows per list page (also the maximum). |
| `LIMS_FRONTDESK_TRF_MAX_BYTES` | frontdesk | optional | Default 15 MiB per request-form attachment. |
| `LIMS_FRONTDESK_SEARCH_MAX_RESULTS` | frontdesk | optional | Default 20 search results. |
| `LIMS_FRONTDESK_APPROVAL_TTL_MINUTES` | frontdesk | optional | Default 15 minutes lifetime of an approval. |
| `LIMS_FRONTDESK_TRF_DRAFT_TTL_HOURS` | frontdesk | optional | Default 24 hours lifetime of a request-form draft. |
| `LIMS_FRONTDESK_PAYMENT_RESULT_URL` | frontdesk | optional | Read into the front-desk config only; no code uses it yet, so nothing changes. |
| `LIMS_HOMECOLLECTION_PUSH_MAX_MUTATIONS` | homecollection | optional | Default 100 mutations per sync push. |
| `LIMS_HOMECOLLECTION_PUSH_MAX_BYTES` | homecollection | optional | Default 512 KiB per sync push. |
| `LIMS_HOMECOLLECTION_SNAPSHOT_MAX_VISITS` | homecollection | optional | Default 60 visits per snapshot (also the maximum). |
| `LIMS_HOMECOLLECTION_SPECIMEN_REFRESH_SECONDS` | homecollection | optional | Default 60 seconds between specimen refreshes. |

## Instruments

| Name | Module | Required | When unset |
|---|---|---|---|
| `LIMS_INSTRUMENTS_ALLOW_SKETCH_DRIVERS` | instruments | optional | Default true outside production, false in production; true in production is refused at boot. |
| `LIMS_INSTRUMENTS_ATTACHMENT_BUCKET` | instruments | optional | Read into the instruments config only; no code uses it yet. An empty value is refused at boot. |
| `LIMS_INSTRUMENTS_MAX_MESSAGE_BYTES` | instruments | optional | Default 1 MiB per instrument message. |
| `LIMS_INSTRUMENTS_MAX_BATCH_BODY_BYTES` | instruments | optional | Default 4 MiB per batch body. |
| `LIMS_INSTRUMENTS_BATCH_TIME_BUDGET_MS` | instruments | optional | Default 8000 ms time budget per batch. |
| `LIMS_INSTRUMENTS_ENROLMENT_CODE_TTL_HOURS` | instruments | optional | Default 24 hours lifetime of an enrolment code (maximum 72). |
| `LIMS_INSTRUMENTS_CREDENTIAL_TOUCH_SECONDS` | instruments | optional | Default 300 seconds between credential touches. |
| `LIMS_INSTRUMENTS_OFFLINE_AFTER_INTERVALS` | instruments | optional | Default: an agent is offline after 3 missed intervals. |
| `LIMS_INSTRUMENTS_HOST_QUERY_MAX_BARCODES` | instruments | optional | Default 50 barcodes per host query. |
| `LIMS_INSTRUMENTS_CONFIG_SIGNING_KEY_FILE` | instruments | optional | Production: the API refuses to start. Elsewhere: agent configs are not signed and the worker cannot sign them. |
| `LIMS_INSTRUMENTS_CONFIG_SIGNING_KEY_ID` | instruments | optional | Production: the API refuses to start. Elsewhere: agent configs are not signed and the worker cannot sign them. |
| `LIMS_INSTRUMENTS_RELEASES_DIR` | instruments | optional | Production: the API refuses to start. Elsewhere: no agent release files are offered. |

## Inventory, lab, micro, partners

| Name | Module | Required | When unset |
|---|---|---|---|
| `LIMS_INVENTORY_REPORT_MAX_DAYS` | inventory | optional | Default 366 days maximum report range. |
| `LIMS_INVENTORY_REPORT_SCREEN_ROWS` | inventory | optional | Default 5000 rows shown on screen. |
| `LIMS_INVENTORY_EXPORT_MAX_ROWS` | inventory | optional | Default 50000 rows per export. |
| `LIMS_INVENTORY_RESOLVE_BATCH` | inventory | optional | Default 1000 rows per resolve batch. |
| `LIMS_INVENTORY_FIXED_CATCHUP_DAYS` | inventory | optional | Default 7 days of fixed-consumption catch-up. |
| `LIMS_INVENTORY_RESOLUTION_STEPS` | inventory | optional | Default resolution steps 1, 2 and 5. |
| `LIMS_LAB_AUTOVERIFY_HOOK_ENABLED` | lab | optional | Default false: the quality auto-verify hook is not called. |
| `LIMS_LAB_CATALOG_CACHE_MAX_ENTRIES` | lab | optional | Default 20000 catalog cache entries per process. |
| `LIMS_LAB_LABEL_WAIT_SECONDS` | lab | optional | Default 15 seconds the label page waits for specimens (API and web). |
| `LIMS_LAB_WORKLIST_MAX_ROWS` | lab | optional | Default 500 rows per worklist. |
| `LIMS_MICRO_IMPORT_MAX_BYTES` | micro | optional | Default 5 MiB per instrument import file. |
| `LIMS_MICRO_IMPORT_MAX_LINES` | micro | optional | Default 20000 lines per import. |
| `LIMS_MICRO_IMPORT_TIMEOUT_MS` | micro | optional | Default 60000 ms per import. |
| `LIMS_MICRO_RECONCILE_BATCH` | micro | optional | Default 200 rows per reconcile batch. |
| `LIMS_MICRO_SPECIMEN_LOOKUP_PORT` | micro | optional | Default false: the specimen lookup port is off (API and web). |
| `LIMS_PARTNERS_CONVERTING_STALE_MINUTES` | partners | optional | Default 30 minutes before a converting request counts as stale. |
| `LIMS_PARTNERS_RECONCILE_BATCH` | partners | optional | Default 500 rows per reconcile batch. |
| `LIMS_PARTNERS_STATEMENT_MONTHS` | partners | optional | Default 24 months of statements. |
| `LIMS_PARTNERS_DOWNLOAD_SIGNED_URL_MAX_SECONDS` | partners | optional | Default 300 seconds maximum lifetime of a signed download link. |

## Quality, smartreport

| Name | Module | Required | When unset |
|---|---|---|---|
| `LIMS_QUALITY_ENABLED` | quality | optional | Default false: the quality module is switched off (phase 2). |
| `LIMS_QUALITY_SYNC_BATCH` | quality | optional | Default 500 rows per sync batch. |
| `LIMS_QUALITY_SYNC_OVERLAP_SECONDS` | quality | optional | Default 600 seconds sync overlap. |
| `LIMS_QUALITY_SYNC_DEBOUNCE_SECONDS` | quality | optional | Default 5 seconds sync debounce. |
| `LIMS_QUALITY_SYNC_TIME_BUDGET_SECONDS` | quality | optional | Default 25 seconds time budget per sync. |
| `LIMS_QUALITY_RULE_CACHE_MAX` | quality | optional | Default 200 cached rules. |
| `LIMS_QUALITY_LJ_MAX_POINTS` | quality | optional | Default 2000 points per Levey-Jennings chart. |
| `LIMS_SMARTREPORT_PREBUILD_ENABLED` | smartreport | optional | Default true: smart reports are prebuilt. |
| `LIMS_SMARTREPORT_PREBUILD_DELAY_SECONDS` | smartreport | optional | Default 120 seconds before a prebuild. |
| `LIMS_SMARTREPORT_LLM_ADAPTER` | smartreport | optional | Default disabled: no language model is called. |
| `LIMS_SMARTREPORT_LLM_ENDPOINT` | smartreport | optional | No endpoint: the language model adapter cannot be used. |
| `LIMS_SMARTREPORT_LLM_ALLOWED_HOSTS` | smartreport | optional | No host is allowed, so any configured endpoint is refused. |
| `LIMS_SMARTREPORT_LLM_MODEL_REF` | smartreport | optional | No model reference is sent. |
| `LIMS_SMARTREPORT_LLM_TIMEOUT_MS` | smartreport | optional | Default 20000 ms per model call. |
| `LIMS_SMARTREPORT_LLM_MAX_CONCURRENCY` | smartreport | optional | Default 1 concurrent model call. |
