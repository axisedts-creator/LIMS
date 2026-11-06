# Triage — review batch 4 (C0–C2) and final-sweep work lists

Date 2026-11-06. Inputs: `review/C0-foundation-contracts.md`, `C1-infrastructure-ops.md`, `C2-identity-admin.md`, `review/_handoffs.md` (incl. the "From C16" section). Authority applied: 00 > research/04 > 08 (§2 + Addenda A1–A24; later overrides earlier; A13/A17/A19 = P-1…P-23, P-40…P-46, D-1…D-136; A20 and A23 decided for C0/C2, not yet applied; A24 = `CatalogPort.getPriceListStatus`) > 03-IC > 01-CM / 02-CV > research/01–03 > chunk docs. Founder rules respected: no new foreign touchpoint, all data in Nepal, synthetic data only. **No spec file was edited.**

Scope of verification: every BLOCKER and MAJOR of the three reviews, and every "Needs lead decision" item. The C2 lead list names two MINORs, C2 #52 and C2 #57, so those were verified too. Each item was checked by opening the cited file, or by grep where the finding is an absence. MINORs not on a lead list were **not** re-verified. They go into the work lists as reported, and the work lists say so.

Result: 79 items verified. **76 CONFIRMED, 2 CONFIRMED-PARTIAL (C0 #3, C1 #11), 1 ALREADY-FIXED (C1 #12), 0 FALSE.** See (h). Of these, C0 #1/#2/#3 (first half) and C0 #19 were **already decided by A23**, and C1 #13 by **A14.2**. They are still CONFIRMED, because the documents are unfixed, so the deliverable is "apply". Classification: **LOCAL 44 · CROSS 11 · DECISION 23 · fixed 1.**

Main pattern (verified by grep):
- **C0** carries no addendum after A15. The only A13 hit is in the §17 table, and A16/A17/A19/A20/A23 have 0 hits. The program docs above C0 (03-IC §13.3/§13.6, 08 §4.7) already hold the A13 halves.
- **C1** carries none of A13/A14/A19 (its "A14" hits are research/04 A14 references).
- **C2** has 0 hits for `commitOnError`, `getStaffNotificationContact`, `identity.centre.read`, `scan_state` and `neutraliseFormula`.
- **Program docs:** the A13 halves are applied (verified: D-10 fields, P-12 comment, D-42 signature and B15, D-16/D-18/D-19/D-21, P-6/P-9 rows). **None of the A17/A19/A21–A24 program-doc halves is applied.** `02-CV` has 0 hits for P-16…P-23 and P-40…P-46. 08 §3 has no row for any CR registered after A13.

Numbering: rules **P-60…P-61**, decisions **D-200…D-220**. This avoids collisions with batches 1–3. `[CONV]` = a value chosen in this triage. "Instance of P-n/D-n (apply)" = already decided, not yet applied; no new rule.

---

## (a) New program-wide rules

**P-60 — Every chunk records each addendum as applied or not applicable.** (C0 #29)
Text for 05-DEFINITION-OF-DONE (new item) and 01-CM §4 "Must": "Each chunk's 02-TRD change-history table has one row per 08 Addendum (A1 onward). The row is either 'applied <date> — <P-/D-/A-items that touch this chunk, with the files changed>' or 'not applicable'. A chunk whose table stops before the latest addendum is not 'done'. The final sweep checks this by script (every chunk × every addendum id)."
Why: C0's table (02-TRD §17) stops at A15. That hid 23 unapplied rules behind documents that agents read as current. No other mechanism catches this.

**P-61 — The client IP comes from the trusted edge only.** (C2 #25; refines A13 D-32 / 08 R10 BFF-key paragraph)
Text for 08 R10 item 1 (replaces the sentence "The core sets `app.client_ip` from that header only on requests with a valid BFF key; otherwise it uses the peer address") and 02-CV §10.3: "The core sets `app.client_ip` from `X-Forwarded-For` (single hop; nginx overwrites it, C1 TRD §6.6) only when (a) the request carries a valid `X-Lims-Bff-Key`, or (b) the TCP peer address is in `LIMS_CORE_TRUSTED_PROXY_CIDRS` [CONV; C1 sets it to the nginx container address on `edge_net`]. Otherwise the core uses the peer address. Module code reads only `ctx.clientIp`; it never parses a header."
Why: `openMobileSession`, `refreshMobileSession` and the patient routes are `x-edge-exposure: public` and have no BFF. Under D-32 as written, their peer is nginx, so every phone in every tenant would share one A1 per-IP failure counter. A1's placement rule ("client IP as seen at the public edge") already requires (b). No new secret and no new header are added.

---

## (b) Decisions

**D-200 — Running the core retention purge.** Refs: C0 #20, C0 lead 5.
- Problem: `statement_timeout` defaults to 5000 ms (C0 TRD l.557). `core.retention_purge` (l.789) declares no `taskOptions`, and the five purge functions loop for up to 5 minutes. Each `SELECT app.purge_*()` is therefore cancelled with `57014`.
- Decision (no new manifest feature; it uses the existing CR-C8-012 `taskOptions`):
  - `core.retention_purge` declares `taskOptions: { statementTimeoutMs: 300000 }`.
  - It calls each purge function in **its own transaction**.
  - The loop cap inside each function is `clock_timestamp() - now() > interval '4 minutes'`, which stays under the 300 s ceiling.
  - A function that hits its cap returns its count, and the next day's run continues. A metric `lims_core_retention_purge_capped_total{table}` [CONV] records it, and C1 alerts when it is > 0 for 3 days in a row.
  - New test: a 10k-row expired seed per table completes, and a capped run resumes.
- Files: C0 TRD §7.2/§7.6, 05-SCHEMA §10 purge bodies, 06 T0D-09, C1 alert intake.

**D-201 — No standing CREATE for queue and lookup owners.** Refs: C0 #21, C0 lead 4.
- Problem (confirmed): `GRANT lims_queue TO lims_worker WITH INHERIT TRUE` (C0 SCH l.54), together with `GRANT CREATE ON DATABASE … TO lims_owner, lims_queue` (l.65) and `GRANT CREATE ON SCHEMA app TO lims_queue, lims_reporting_lookup` (l.115), gives `lims_worker` CREATE on the database and on `app`.
- Decision:
  - The migration that creates `lims_queue`- or `lims_reporting_lookup`-owned objects does `GRANT CREATE … TO <role>` → `SET ROLE <role>` → create → `RESET ROLE` → `REVOKE CREATE … FROM <role>`, all in the same migration file. No standing CREATE remains. (PostgreSQL also needs CREATE on the schema for `ALTER … OWNER TO`, so "create as owner, then ALTER OWNER" does not avoid the grant.)
  - The `graphile_worker` schema is installed by the migration runner in the same grant/revoke window. If SP-2 shows that Graphile Worker must run its own migrations at worker start, C0 records that residual privilege as the SP-2 outcome in `DECISIONS.md` and in 07 §6. It is not silently kept.
  - Role tests: `has_database_privilege('lims_worker', current_database(), 'CREATE') = false`; `has_schema_privilege('lims_worker','app','CREATE') = false`; the same for `lims_api`.
- Files: C0 05-SCHEMA §1/§2, 06 SP-2/T0B-02, 07 §6.

**D-202 — Idempotency keys are not stored for 4xx.** Refs: C0 #30, C0 lead 6.
- Status < 400: the response is stored and replayed (K2).
- Status ≥ 400: the response is not stored. The `in_progress` row goes with the rollback. When the handler called `ctx.commitOnError()` (P-42), the core deletes the key row in the same transaction before commit.
- A retry with the same key re-runs the handler. For P-42 security counters, this means a retried wrong password counts again, which is the intended behaviour.
- Edits: C0 TRD §6.6 steps 4–5 ("for status < 400"), §6.2 stage 10, APP-FLOW K2/K3, AC-0D-4.5, plus one test for each branch (4xx rollback, 4xx `commitOnError`, 5xx).

**D-203 — Container networks that need the database or SMTP.** Refs: C1 #1, C1 lead 3.
- Problem (confirmed): `app_net`, `auth_net` and `render_net` are `internal: true` (C1 TRD §3.2). The worker (`app_net`, `render_net`), `auth`, `rest` and `storage` must reach `data-1:5432` on another VM. GoTrue must reach its SMTP relay. `edge_net` is a normal bridge, so api/web/portal have an unfiltered route out.
- Decision (no host networking):
  - (1) New non-internal bridge `db_net`. Members: api-a/b, worker-a/b, auth, rest, storage. `DOCKER-USER` allows forwarding from `db_net` only to the data-1 wg IP on 5432/6432, and to the dr-1 wg IP on the same ports after failover (inventory variable). Everything else from `db_net` is dropped.
  - (2) `DOCKER-USER` drops all forwarded traffic from `edge_net` except to and from the nginx container.
  - (3) GoTrue SMTP: an nftables allow from the `auth` container IP to the relay FQDN:587 only, listed in `infra/edge/egress-allowlist.yaml`. Squid cannot proxy SMTP, and an ops-1 smarthost would add a new service. This is the transactional relay C1 §7.3 already names (REQ-ARCH-018), so it adds no new touchpoint. It must appear in the F-01 egress register.
  - Update §3.2 table, §5.5, AC-09.1, `egress_probe.sh`, and the T-05 fallback text.

**D-204 — `pdf-sandbox` is owned and built by C6.** Refs: C1 #3, C1 lead 1.
- 08 A13 P-13 (binding) names "the renderer's `/internal/sanitize`". C6 TRD l.78/195/457 builds the sandbox as an HTTP service from `services/renderer`, and 01-CM §3 gives `services/renderer` to C6. C1's spool and `network_mode: none` design contradicts this.
- Decision:
  - C6 owns the image and its HTTP interface.
  - C1 provides only the runtime envelope: network `render_net` only, inbound from the worker only, no egress; non-root; `read_only`; `tmpfs /work`; 1 CPU / 512 MiB; `pids_limit: 64`; its inbound auth token as the only secret; health check = C6 `GET /internal/health`.
  - The 08 §3 row CR-C1-005 Notes gain: "spool contract (C1 TRD §7.5) superseded by CR-C6-013 / A13 P-13 (batch-4 D-204); envelope part stands".
  - C1 deletes §1 `images/pdf-sandbox`, §7.5, AF §14, AC-10.2, the T-16 image work and the `lims_ops_pdf_sandbox_*` metrics.

**D-205 — RPO parameters.** Refs: C1 #4, C1 lead 5.
- One set everywhere:
  - `archive_timeout = 60s` (config `archive_timeout_s: 60`).
  - Metric `lims_ops_wal_repo2_newest_age_seconds` = now − time of the newest WAL segment in repo2 (from `pgbackrest info --output=json`). It is no longer measured from the `check` completion time.
  - `WalArchiveLagging` > 600 s (warn).
  - `RpoAtRisk` > 840 s (page; one minute before the 04 I2 15-minute RPO).
  - `WalArchiveFailing` = 2 failed checks in a row (page).
- `RpoBreached` and the 1200 s threshold are deleted. The WAL-volume arithmetic in TRD §9.4 is redone for 60 s switching (1,440 forced segments/day worst case + 96 `check` switches), and C1 PLAN R8 tracks it.
- Files: C1 PRD AC-12.1/12.2, TRD §7.7/§9.4/§11.3/§15, AF §3.1, UI D1/§8.

**D-206 — `X-Lims-Background` at the edge.** Refs: C1 #5, C1 lead 10.
- The header can only make the BFF call `resolveSession` with `touch: false`. Spoofing it only shortens the sender's own session.
- Decision: nginx **passes it through unchanged** on the staff_web, partner and portal origins (BFF origins; C13 AF l.181 and C16 UI l.229 set it in the browser). It keeps stripping it on the api origin.
- C2 resolves its own inconsistency (TRD l.124 "set by C0's BFF proxy" vs l.676 "the browser request carries"): the browser sets it through the `@lims/ui` polling/SSE helpers, and the BFF maps it to `touch: false`.
- C1 rewrites §6.6, AF §1.5 row 2 and SEC AB-14 ("can only reduce touching; not stripped on BFF origins").

**D-207 — app-1 memory.** Refs: C1 #14, C1 lead 9.
- Confirmed: Σ `mem_limit` = 16.8 GiB on a 16 GB VM before Supabase services, exporters and the OS.
- research/04 I1 labels the sizing "DECISION (sizing = assumptions)". Default to build: **CR to research/04 I1: VM-2 app = 8 vCPU / 32 GB.** This keeps clamd next to the uploads (no PHI scan traffic to site B, and scanning keeps working during a site-B outage).
- `container_hardening.py` asserts Σ `mem_limit` ≤ 85 % of host RAM.
- Founder confirmation is needed because of the cost; this is added to the F-08 list. If refused, the fallback is to lower api/worker to 1.5 GiB each and move Squid (0.5 GiB) to ops-1. That still has to pass the 85 % test with Supabase services counted, or the stack is not deployable.

**D-208 — One Supabase snapshot pin.** Refs: C1 #16, C1 lead 4.
- `infra/compose/supabase/upstream/UPSTREAM.lock` (C1) is the single source of image digests.
- C0's dev stack (`tools/devstack/compose.yaml`) reads them from it, and a CI check (C0-0A, wired per P-14) fails when the digests differ.
- SP-1 records the lock commit it ran against.
- Files: C0 TRD §3 devstack row (CR from C0's side, ACCEPT), 01-CM §3 note (C0 reads a C1 file; ownership unchanged), C1 TRD §2/§7.1.

**D-209 — Scanner address.** Refs: C1 #17.
- `clamd` listens on `3310` on `app_net` with `StreamMaxLength 20M` and `MaxFileSize 20M` (above the 16 MB attachment route).
- C0-0D adds config keys `LIMS_CORE_SCANNER_URL` (default `tcp://clamd:3310`) and `LIMS_CORE_SCANNER_TIMEOUT_MS` (default 30000) [CONV]. C1 sets them. The protocol is INSTREAM.
- C1 fixes the PRD §8 reference (§7.6 → §7.4).
- Files: C0 TRD §11, C1 TRD §7.4/§15, 08 §4.11 row.

**D-210 — Degraded mode after DR promotion.** Refs: C1 #18, C1 lead 6.
- Promotion to dr-1 leaves no second-site WAL archive (04 I2) and no separate-host audit store (04 D11).
- Decision:
  - (a) Within 4 h of promotion [CONV], `dr-promote.yml` creates a pgBackRest repo on ops-1. That is a different host on the same site, and only an interim measure.
  - (b) A new alert `NoOffsiteArchive` (page) fires until a repo on a site other than dr-1's site is configured.
  - (c) The incident record names the period.
  - (d) PRD AC-22.1 states the degraded mode explicitly: RPO holds against host loss, but not against site-B loss.
- No new site is ordered here. A third site stays a B12 procurement item.

**D-211 — `lims-scan` jail removed.** Refs: C1 #19, C1 lead 7.
- Same reasoning as 08 A1/A3.2: a 404-count ban hits a lab's shared NAT, and with C1 #2 it would ban every lab with a bridge agent.
- The edge is already default-deny.
- Decision: delete the `lims-scan` jail. Replace it with warn alert `EdgeNotFoundSpike` (404 rate per IP above 30/5 min for 15 min; no ban) [CONV].
- New AC mirroring AC-04.6: 30 agent 404s in 5 min from one IP → no ban.

**D-212 — Transactions for pre-auth and session operations.** Refs: C2 #1, C2 lead 1.
- Problem (confirmed): C0 TRD l.453 gives public operations no transaction except `anonymousTx()` (reporting only). `withTenantScope` is platform-only (R10.4). The `__own` INSERT policy needs a session id that does not exist yet. The bffSession operations have neither `x-permission` nor `x-public` (C2 TRD l.151–157).
- Decision (one core API, bounded by an allowlist):
  - New `ctx.db.identityAuthTx(fn)`. It exists only for module `identity` operations tagged `x-context: identity_auth` and listed in core config.
  - The list: `loginStaff`, `loginPartner`, `openMobileSession`, `refreshMobileSession`, `logoutMobileSession`, `confirmEmailToken`, `requestPasswordRecovery`, `verifyMfaChallenge`, `startMfaEnrolment`, `completeMfaEnrolment`, `resolveSession`, `logoutSession`, `setPasswordFromSetup`, `resolvePatientSession`, `logoutPatientSession`.
  - It opens the request transaction with claims `{sub: <identity system actor>, actor_type: 'system'}` and **no** `tenant_id`. Only the inventoried DEFINERs and the tenant-less `auth_events` insert work in that state.
  - `tx.bindTenant(tenantId)` may be called **once**, after a DEFINER (`identity_login_context` / `identity_session_by_token` / `identity_resolve_session`) has chosen the membership. It rewrites the transaction-local claims to `{…, tenant_id}`, so the ordinary `__tenant` policies (with the P-16 guard, which admits system) apply.
  - The C0 authz guard (stage 9) exempts `x-context: identity_auth`. Every listed operation carries `x-public` with a justification.
  - The `__own` session INSERT policy is not used by these paths. C2 SCH §5.2 states which policy admits each pre-auth write.
  - Least-privilege bound: only the listed operationIds, only the identity system actor, at most one tenant per transaction, and an access-log or auth event on every success path (existing C2 events).
- Files: C0 TRD §6.2 stage 7/9, §6.3, 08 §4.11 and R10 item 4, 02-CV §6; C2 TRD §5.1, SCH §5.2; AC in C0 T0D-03 and C2 T6.

**D-213 — Idempotency for platform-context operations.** Refs: C2 #17, C2 lead 2.
- Keeps P-8 for `provisionTenant`, `openSupportSession` and `invitePlatformStaff`.
- `core.idempotency_keys.tenant_id` becomes NULLable. `PRIMARY KEY (tenant_id, actor_id, key)` is replaced by `CONSTRAINT idempotency_keys__tenant_id_actor_id_key__uq UNIQUE NULLS NOT DISTINCT (tenant_id, actor_id, key)` (PostgreSQL ≥ 15; the target is 17).
- New policies `idempotency_keys__{select,insert,update}__platform TO lims_app USING / WITH CHECK (tenant_id IS NULL AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.is_platform_actor()))`.
- The purge predicate (`expires_at`) already covers NULL-tenant rows.
- 03-IC §12 row and 08 §4.11 note. C0 schema test: the same key from two platform actors makes two rows, and the same actor and key replays.

**D-214 — `withTenantScope` allowlist (08 R10 item 4).** Refs: C2 #18, C2 lead 3; also records A23.1/A23.2.
- New R10 item 4 list: the existing eight operationIds (the void `setTenantEgressIps` entry is struck, per A1) plus `openSupportSession`, `activateSupportSession`, `endSupportSession`, `revokeSupportSession` (only where C2 TRD §5.10 runs them in platform context) and `getDeadLetter`.
- Each use writes a tenant access-log row. The codes already exist in the C0 seed: `support_session.open` / `.activate` / `.close` / `.revoke`, `dead_letter.view`.
- New sentence: "Core-internal uses outside module `identity`: the worker-core cron fan-out (A23.1) and `ctx.core.deadLetters.replay` of a tenant row (A23.2), each under the owning module's system actor. No module code calls `withTenantScope`."
- Files: 08 R10, C0 core config and TRD §6.3, C2 AF §8/§9.3.

**D-215 — Audit of NULL-tenant rows in mixed tables.** Refs: C2 #19, C2 lead 4.
- Extends A12.5 without splitting tables.
- `app.tg_row_audit` writes **no** `audit_log` row when the row's `tenant_id` is NULL **and** the table is not `core.tenants`. It never raises for this case.
- C2 writes `identity.platform_events` for these changes. The existing kinds `platform_staff_invited`, `platform_mfa_reset` and `annex_1_changed` stay; C2 adds `platform_mfa_enrolled` to its kind CHECK.
- Tests: C0 schema test (NULL-tenant UPDATE → 0 `audit_log` rows), C2 SCH §11 (one `platform_events` row).
- Files: C0 05-SCHEMA `tg_row_audit`, C2 SCH §3.1/§4.x/§11.

**D-216 — Annex readiness reads the platform Annex 1 row.** Refs: C2 #20, C2 lead 8.
- Least surface: a policy, with no new column and no allowlist growth.
- `CREATE POLICY ird_annex_records__select__tenant_platform_ref ON identity.ird_annex_records FOR SELECT TO lims_app USING (tenant_id IS NULL AND annex_code = 'annex_1' AND id = (SELECT ts.ird_annex_1_record_id FROM identity.tenant_settings ts WHERE ts.tenant_id = (SELECT app.current_tenant_id())) AND (SELECT app.is_staff_or_system()));`
- SCH §11 test 2 is amended: only the referenced Annex 1 row is visible, and no other platform row is.

**D-217 — A1 "alert the tenant admins of every targeted tenant".** Refs: C2 #23, C2 lead 5.
- A1 is a founder decision, so it is implemented, not narrowed.
- (1) C0 adds `core.users.email_hmac bytea NULL CHECK (octet_length = 32)`. C2 writes it on user create and on email change with the existing `LIMS_IDENTITY_EMAIL_HMAC_KEY`.
- (2) New DEFINER `app.identity_tenants_for_email_hmacs(p_hmacs bytea[]) RETURNS SETOF uuid`:
  - owner `lims_owner`, EXECUTE `lims_worker` only, `SET search_path = ''`;
  - at most 100 values;
  - owner policy `users__select__owner_only` ORed with `current_setting('app.maintenance', true) = 'identity_tenants_for_email_hmacs' AND email_hmac IS NOT NULL` (A12.2);
  - inventory row and A12.7 tests.
- (3) Worker task `identity.notify_ip_throttle` (platform, enqueued when the throttle fires). It collects the `email_hmac` values of that IP's failure window from `auth_events`, resolves the tenants, and for each tenant inserts `admin_notices` (kind `login_ip_throttled`, `subject_id` NULL) under `withTenantScope(tenant, identity system actor)`.
- (4) `admin_notices.subject_id` becomes NULLable for this kind only (CHECK).
- No HTTP response can observe the mapping, so there is no oracle. The LIMS provider on-call is alerted as before.

**D-218 — Patient session kind against GoTrue.** Refs: C2 #24, C2 lead 6.
- No R10 change now.
- C2 TRD §8 lists, as UNVERIFIED T1 items: `adminCreateUser` without email, and an admin path that issues a session/access JWT for a credential-less user.
- Default: "patient session kind blocked until T1 confirms". If T1 refutes both, a CR to 08 R10 for a LIMS-issued patient access JWT goes to the lead and founder (it touches 04 A5/A7).
- C16 build continues against the fake resolver (as R10 item 6 does for SP-1).

**D-219 — Recovery-link TTL fallback.** Refs: C2 #26, C2 lead 9.
- The `recovery_issued_at` fallback is deleted (it has no storage).
- "GoTrue recovery/invite TTL configurable to ≤ 60 min (04 A12)" becomes a C2 T1 verification and a **release precondition**. If T1 refutes it, a CR adds `identity.recovery_requests` (class E) before release.
- C2 PRD §10, AF §3.7 note and TRD §10 follow. C1 §7.3 keeps the UNVERIFIED label.

**D-220 — Re-inviting someone who was staff at another lab.** Refs: C2 #57, C2 lead 10.
- Client and product question. Least surface in v1: the current restriction (`identity.user_exists`) stays.
- It is recorded as client question C-07 in 08 §5.2: "May a person deactivated at one lab be invited by another lab with the same e-mail? Default: no in v1."
- C2 PRD §11 Q5 cites it.

---

## (c) C0 work list (fix agent)

### (i) Rules, decisions and addendum items to apply
- **A23.1 / P-6**:
  - TRD §7.2 `per_tenant` semantics (P-6 text) and the tick loop (`app.cron_tenant_ids()` → per tenant `withTenantScope(tenantId, module system actor)` → `app.enqueue_job(identifier, {tenant_id}, '<identifier>:<tenant_id>:<tick ISO minute>')`).
  - 05-SCHEMA §4.3 inventory row, as 03-IC l.3310.
  - §10 body: plpgsql, `SET search_path = ''`, `set_config('app.maintenance','cron_tenant_ids',true)` → `SELECT id FROM core.tenants WHERE status IN ('active','suspended')` → reset; `REVOKE … FROM PUBLIC; GRANT EXECUTE … TO lims_worker`.
  - `tenants__select__owner_only` gains the `cron_tenant_ids` branch.
  - A12.7 test; 06 T0B-05 / T0D-09. (C0 #1)
- **A23.2**:
  - `core.dead_letters.job_key text NULL` (written by the wrapper from `helpers.job.key`).
  - Replay key `'<job_key or task_identifier:id>:replay:<version>'`.
  - Tenant-row replay inside `withTenantScope(row.tenant_id, owning module's system actor from g_task_registry)`.
  - §3.5, DDL, schema test 7, AC "tenant-row replay in platform context enqueues exactly one job". (C0 #2, #19)
- **A23.3**:
  - `db/meta/tables.yaml` `shared_with: [partner, portal, patient]` for `core.event_log`, `core.idempotency_keys`, `audit.access_log`.
  - Actor INSERT policies `WITH CHECK (tenant_id = app.current_tenant_id() AND actor_id = app.current_actor_id())`; idempotency SELECT/UPDATE on own `actor_id`; no non-staff SELECT on `event_log` / `access_log`.
  - Add the guard to `tenants__*__tenant`, `audit_log__select__tenant` and every other core `__tenant` policy, and replace the l.391 note. (C0 #3)
- **A20.1–A20.4** (decided, applied in this pass): `current_lims_session_id()` moves to C0 with `GRANT EXECUTE … TO lims_app, lims_api, lims_worker`; `enforce_mutable_columns` uses `coalesce(TG_ARGV::text[], '{}')` plus a schema test; A20.1 support-session `pre_tenant_id` (C2 SQL; C0 policy branch if it touches core); A20.4 no change.
- **P-16**: `tables.yaml` field `shared_with`; `check-registry.ts` fails a `__tenant` / `__tenant_centre` policy without `app.is_staff_or_system()` unless `shared_with` + an actor policy exist; probe step 9 (partner/portal/patient claims of the same tenant read 0 rows); T0B-07/08. (C0 #4)
- **P-9**: TRD §3.1 spreadsheet row with both signatures + rule + round-trip golden; new task **T0A-12** `packages/shared-ts/src/{decimal,formula,spreadsheet}` (M2). (C0 #5)
- **P-2 + D-67**: `ctx.download.stream(...)` helper (TRD §6.3, tree `core/storage/download.ts`) with the P-2 headers, the `clean` check → `422 common.upload_quarantined`, and an access-log row; the D-67 inline exception for re-encoded PNG/JPEG; 07 §5.7 last sentence replaced. (C0 #6)
- **P-19 / R12b**: new **T0D-17** "uploads, files.scan, storage adapter, download helper (API + worker)"; TRD §7.1 tree gains `storage/` and `uploads/`; `JobContext` gains `storage`, `files`, `audit`. (C0 #7)
- **D-32 / P-45 / P-61**:
  - BFF key kinds `staff_web`, `partner`, `portal` (TRD §6.1, §6.5, §11).
  - `LIMS_CORE_BFF_KEY_FILES` lists `LIMS_WEB_BFF_KEY_FILE`, `LIMS_PARTNER_BFF_KEY_FILE`, `LIMS_PORTAL_BFF_KEY_FILE`, old and new accepted during the overlap.
  - `app.client_ip` rule per P-61, with the new key `LIMS_CORE_TRUSTED_PROXY_CIDRS`; test.
  - 07 §6 gains the three key files. (C0 #8)
- **P-3 + A2.9 + D-11 + D-53**: §3.7 seed generated from 03-IC §13.1 with an equality test; `tools/codegen/check-access-actions.ts` in the `contracts` job; T0B-04. (C0 #9)
- **P-46**: `PORT_CONSUMERS` generated from the 03-IC §4.x headings; the registry refuses unlisted modules (`port_consumer_not_listed`); CI static check; AC. (C0 #10)
- **A19.1**: `gen-probe-manifest` device / `staff_mobile` probe on every non-`/v1/instruments/agent/` route → 401/403, **exempting operations secured by `queueDisplayToken` (`getQueueBoard`, C16 hand-off)**; 07 §4; T0C-09. (C0 #11)
- **D-47 / P-17**: §6.8 `MembershipRow` + widened `memberships.list` (08 l.2307–2313) + six semantics bullets; AC in T0D-08. (C0 #12; also hand-offs C8, C10, C11)
- **D-121**:
  - Replace `app.engagement_resolve_tenant_code(text)` with `app.core_resolve_tenant_code(p_code text) RETURNS TABLE (tenant_id uuid, status text)`: owner `lims_owner`, EXECUTE `lims_api`, plpgsql body (GUC `app.pre_tenant_code` → select → reset).
  - `tenants__select__owner_only` gains the `pre_tenant_code` branch.
  - GUC list; A12.7 test. (C0 #13)
- **A2.4 / D-110**: `app.engagement_redeem_link_code(bytea)`. (C0 #14)
- **D-42**: `app.purge_instruments_archive(p_raw_retention_days integer)` (≥ 365), `per_tenant`, `app.maintenance = 'purge_instruments_archive'`. (C0 #15)
- **Inventory completeness (P-41(d))**: rows for `app.reporting_redeem_link_for_app(bytea, bytea)` (plus `lims_reporting_lookup` "Owns" cell, §1), `app.cron_tenant_ids()`, `app.core_resolve_tenant_code`, `app.identity_purge_auth_events()`, `app.identity_purge_sessions`, `app.identity_expire_{support_sessions,invitations,audit_exports}`, `app.identity_load_breached_batch`, `app.identity_finish_breached_import`, `app.identity_tenants_for_email_hmacs` (D-217), and the hand-off rows below. (C0 #16)
- **P-23**: lint rule 4 accepts the owner of a port the module consumes; lint fixture. (C0 #17)
- **R10 / CR-C0-003**: APP-FLOW §2.1/§3.3 redrawn (`__Host-lims_sid` → BFF → `resolveSession` + BFF key); §11 default `__Host-lims_sid`; AC-0D-7.2 relays C2's `401 auth.session_expired`; 07 §6 row replaced; `BffSessionStore` dev-only. (C0 #18)
- **D-200** (retention purge execution). (C0 #20)
- **D-201** (grant/revoke CREATE; role tests). (C0 #21)
- **R12b**: 07 §7 grep allowlist gains `services/{api,worker}/src/core/storage/**`; 07 §6 row "Storage service credential (`LIMS_CORE_STORAGE_KEY_FILE` [CONV])". (C0 #22)
- **A16.1**: TRD §4.2 forbidden-construct list gains the uncast `= ANY ((SELECT app.current_centre_ids()))`; §9 rule 2 treats it as non-translatable (CR back to the chunk). (C0 #23)
- **P-14 / A16.2**: §15.1 "Chunk-supplied jobs" mechanism; CR-C7-013 jobs (Windows runner) wired; new T0A task. (C0 #24)
- **08 §4.6 components**: new T0D-12b (web components of §2.8) and T0D-15 extended with the CR-C16-016 widgets and CR-C17-010 pins; stories, axe, tests. (C0 #25)
- **Fixtures**: 10 tenant roles × 2 tenants, plus per tenant partner_member, partner_admin, patient, portal link actor, bridge_agent device, queue_display device; PRD §2 and SCH §11 changed to match. (C0 #26)
- **`ctx.noRetry()`** in `HandlerContext` + retry-policy line + AC in T0D-03. (C0 #27)
- **D-17 / CR-C3-007**: §3.5 `catalog/` fixture row (starter workbooks, SYNTHETIC); task in T0A-05 or the C3 contract-wave PR. (C0 #28)
- **P-60**: §17 rows for A13, A16, A17, A18, A19, A20, A21, A22, A23, A24, each listing the C0 items (as in this list) or "not applicable". (C0 #29)
- **D-202** (no 4xx storage). (C0 #30)
- **D-208**: dev stack reads digests from C1 `UPSTREAM.lock`; CI equality check.
- **D-209**: config keys `LIMS_CORE_SCANNER_URL`, `LIMS_CORE_SCANNER_TIMEOUT_MS`.
- **D-212**: `ctx.db.identityAuthTx` + `bindTenant`; `x-context: identity_auth`; authz-guard exemption; core-config allowlist.
- **D-213**: `core.idempotency_keys` NULL tenant + `UNIQUE NULLS NOT DISTINCT` + `__platform` policies + test.
- **D-214**: core-config allowlist update for `withTenantScope` (C2 operationIds + core-internal uses).
- **D-215**: `tg_row_audit` skips NULL-tenant rows of tables other than `core.tenants`; schema test.
- **D-217**: `core.users.email_hmac` column + DEFINER `app.identity_tenants_for_email_hmacs` (DDL transcribed from C2) + owner-policy branch.
- **A18.1**: 07 REQ-SEC-089 CSP `img-src 'self' data:` + header test (C0 m#31).
- **A24.1** (contracts): `CatalogPort.getPriceListStatus` in `contracts/ports`, the C3 fake and the contract suite; consumer C16.
- **A21.2**: `IdentityPort.readSignatureImage` in `contracts/ports` / fake / contract suite.
- **D-100**: `updatePartnerMembership.expectedVersion?` in the port type and fake.

### (ii) Hand-offs addressed to C0 (from `_handoffs.md`)
- C4:
  - `03-IC §13.3 / 08 §4.7 / definer-inventory`: `frontdesk.purge_trf_drafts(p_older_than interval, p_ids uuid[]) RETURNS integer` (owner `lims_owner`, EXECUTE `lims_worker`, `search_path ''`, owner policies on `trf_attachments` gated by `app.maintenance = 'frontdesk_purge_trf_drafts'`).
  - Trigger inventory: `tg_row_audit` on `frontdesk.patients` with excluded columns `full_name, name_search, birth_on, phone_e164, email, address_text` (D-27a).
  - `ctx.core.centres` (`CentreRow`) includes `phone_display` (the column exists in SCH l.157/529; the return shape must state it).
  - CSP `img-src 'self' data:` (A18.1).
  - C0-0A CI job `c04-copy-scan`.
  - Seed `patient.demographics_access`: **verified, no user** (grep: only the C0 SCH l.263 seed; not in 03-IC §13.1; C4 has none). Remove it from the seed.
- C6:
  - D-32 BFF key kind `portal` and `app.client_ip` (now P-61).
  - CR-C6-019 library pins (DOMPurify + server DOM, SMTP client; C0 pins versions after the licence/no-egress check, A21.3).
  - Audit inventory: **no** default `tg_row_audit` on `reporting.portal_links` (C6 own conditional triggers, A21.3).
- C7: the C0-owned rows of D-42 (above) and CR-C7-013 CI jobs (above).
- C8:
  - `MembershipRow` (above).
  - C0-0C `contracts/render/analytics.report.schema.json` from C8 TRD §10.2 step 6a; operation #30 in `analytics.yaml`.
  - C0-0B C8 mandatory-column exceptions → `db/meta/tables.yaml`.
  - CI job `c8-no-commission`.
- C10: `MembershipRow` (above); `tables.yaml` exceptions for `micro.specimen_isolate_counters` and `event_inbox` (P-18(b)).
- C11:
  - `MembershipRow` (above).
  - Confirm `btree_gin` + `pg_trgm` in the DB image. `pg_trgm` is already created at SCH l.70; `btree_gin` has 0 hits, so confirm it in SP-3, else add an index exception for the `cs_diagnoses` trigram index.
  - `tables.yaml` exception `accession_counters`.
  - Confirm `anatomic.event_inbox` policies in §3.9.
  - Seed codes D-53 (above).
- C9: seed codes `autoverify_decision.view`, `autoverify_simulation.view` (above).
- C13:
  - Inventory `partners.redact_lines(uuid, timestamptz)` (owner `lims_owner`, EXECUTE `lims_worker`, `app.maintenance = 'partners_redact_lines'`, tenant-bound) + note on owner policies for `app.current_partner_id()`.
  - `LIMS_CORE_BFF_KEY_FILES` adds `portal` (P-45).
  - `QrCode` row: **verified unused.** CR-C13-013 was withdrawn by C13 (C13 TRD l.583), and no other web chunk uses it (C16 `LimsQrCode` is Flutter). Delete C0 04-UI-UX §2.5 `QrCode` row.
  - `partners-slips` bucket: add it to SCH §8 (C0 m#32) with the rule "write-once per successful issue; a retry before the row is `issued` may replace (upsert)".
- C14: C0-0C `getSmartLibraryCodedSet` (#35) in `contracts/openapi/smartreport.yaml`; D-111 fake/contract suite: `buildSummary` never throws `summary_not_ready`.
- C15: inventory row for the C15 DEFINER with policy name and GUC `app.pre_payments_callback_token_sha256` (A12.1, batch-3 m#14); C4 fake/contract suite adds C15 as a FrontdeskPort caller (CR-C15-014).
- C16:
  - Replace the C16 inventory with C16 05 §6.6: add `app.engagement_apply_report_link(uuid, timestamptz)`, `engagement.purge_payment_requests()`, `engagement.purge_queue()`; `engagement_redeem_link_code(bytea)`; remove `app.engagement_resolve_tenant_code` (→ `app.core_resolve_tenant_code`).
  - A19.1 probe exempts `getQueueBoard`.
- C17:
  - Inventory `app.homecollection_anonymise_retired_visits(timestamptz)` (owner `lims_owner`, EXECUTE `lims_worker`, `app.maintenance = 'homecollection_anonymise_retired_visits'` + tenant claim; policies `visits__select/update__owner_only`, `handover_items__select/update__owner_only`).
  - C0-0A CI jobs `c17-no-bad-cert-callback`, `c17-db-forensics`, `c17-release-binary-scan`.
  - C0-0B transcription notes: visits transition-guard maintenance exception; `handover_items` `mutable_columns` WHEN clause; `mutations__batch__fk DEFERRABLE INITIALLY DEFERRED`; generate `homecollection.event_inbox`.
- C3: CR-C3-008 probe generator skips stub ops listed in `__tests__/probes/pending.json` (stubs → 503 `common.service_unavailable`; list empty at M6); CR-C3-009 CI job wiring (P-14).
- C1/C0: D-208 (`UPSTREAM.lock`) and D-209 (scanner keys), above.

### (iii) LOCAL findings
- Verified LOCAL items without a rule tag: #7, #18, #22, #25, #26, #27, #28.
- MINORs, as reported and not re-verified: #31 (A18.1), #32 (`partners-slips`), #33 (PG 17 re-verification in T0B-08), #34 (metric `lims_core_storage_deletes_total{bucket,reason}`, P-12), #35 (P-8 `x-idempotency-justification` lint), #36 (SP-3 CONNECT for Supabase roles), #37 (`app.queue_depth()` body: counts only), #38 (core tables in the mandatory-column exception list + `tables.yaml` field `mandatory_column_exceptions`, P-18(b)), #39 (`FIXED_ACTOR_PERMISSIONS` + three 08 §4.1 CI rules), #41 (AC-0D-5.3 key includes `tenant_id`).
- #40 is CROSS: 03-IC §12 `request_sha256` → `bytea (octet_length 32)`, matching C0 DDL. A2.4 allows either form, and the DDL owner's form wins (A3.3 principle). See (f).

---

## (d) C1 work list (fix agent)

### (i) Rules, decisions and addendum items to apply
- **A14.2 / P-2**: remove the files origin.
  - Files: TRD §6.1 `LIMS_ORIGIN_FILES` row, §6.3 files row, `sites/files.conf.j2`, `snippets/headers-files.conf`, §6.6 body-size "files 1m".
  - Flows and tests: AF §1.3, PRD AC-03.1 (files host) and AC-03.2, AC-06.1 files hosts, `lims-scan` (deleted per D-211).
  - Security: SEC REQ-SEC-085 row, A3 Storage row.
  - `api-gw` stays reachable on `app_net` only. (C1 #13)
- **D-43 / CR-C7-012**:
  - api prefix `/v1/instruments/agent/` (owner C7, Wave 1).
  - Zone `limit_req_zone $binary_remote_addr zone=agent:10m rate=600r/m;`, `limit_req zone=agent burst=200 nodelay;`.
  - Delete the `$device_key` / `ingest` zone (the per-device tier is app-side).
  - `client_max_body_size 4m` on the prefix and `16m` on `^~ /v1/instruments/agent/attachments`.
  - AC-04.3: "601st request within 60 s from one IP → 429"; AF §1.2; SEC AB-4. (C1 #2, m#28)
- **CR-C7-012 (accepted)**: TRD subsection "C7 infra":
  - Ed25519 config-signing key, offline release-signing key and the client-owned Authenticode certificate. The latter two live only on the ops-1 release service.
  - Read-only mount `LIMS_INSTRUMENTS_RELEASES_DIR` on api-a/b.
  - `infra/ci/agent-release.sh` + playbook step.
  - Scrape note: agent series come from worker-a/b.
  - Wire `services/worker/src/jobs/instruments/alerts/instruments.rules.yml`.
  - PLAN task; CR table row. (C1 #9)
- **CR-C6-013 (accepted) + D-32 / P-61**:
  - api prefix `POST /v1/reporting/provider-callbacks/` (owner C6, phase 1), zone `callback` 60 r/m/IP, burst 20.
  - §6.7 route-map template without the token segment.
  - Secrets: `reporting_otp_hmac_key`, `renderer_inbound_token`, `pdf_sandbox_inbound_token`, `reporting_channel_<secret_ref>`.
  - nginx 10 r/m/IP only on portal `^~ /v/` (already so in §6.5; **do not** add a `/v1/reporting/verifications` limit).
  - Portal BFF key secret; wire the C6 alert rules; CR table row. (C1 #10)
- **P-45**: secrets `bff_key_staff_web`, `bff_key_partner`, `bff_key_portal` (consumers: api + the matching BFF; rotation 365 d) in §8.2, SEC §7 and the secrets schema. §6.6: "on staff_web, partner **and portal** the BFF forwards this value". (C1 #8)
- **P-61**: set `LIMS_CORE_TRUSTED_PROXY_CIDRS` to the nginx container address on `edge_net`.
- **D-122**: `zone=otp` becomes a flood guard of 60 r/m/IP with burst 20 (currently `rate=5r/m`, TRD l.324); the binding OTP limits stay in the app.
- **D-116 / CR-C15-008 items (1)–(6), verbatim**: public payment nginx locations (10 r/s/IP burst 20), token-path log masking, egress allowlist, SOPS KEK file, alert routing; config `LIMS_FRONTDESK_PAYMENT_RESULT_URL` = `<payments public base>/v1/payments/result` (D-113).
- **D-203** networks, **D-204** sandbox envelope, **D-205** RPO, **D-206** `X-Lims-Background`, **D-207** sizing CR + Σ-limit test, **D-208** `UPSTREAM.lock` single source, **D-209** clamd listener and keys, **D-210** post-failover degraded mode + `NoOffsiteArchive`, **D-211** delete `lims-scan`, add `EdgeNotFoundSpike`.
- **D-200**: alert on `lims_core_retention_purge_capped_total` (> 0 for 3 days, warn).
- **A18.1**: no C1 change. Verified: TRD §6.4 l.316 says nginx sets no CSP and does not overwrite the upstream CSP. **DONE.**
- **P-60**: C1 TRD change-history rows for A1–A24.
- **P-16**: not applicable. C1 05-SCHEMA defines indexes on audit-store replicas and no `__tenant` policies (grep).

### (ii) Hand-offs addressed to C1 (from `_handoffs.md`)
- C7: D-43 (above); wire `instruments.rules.yml` (CR-C7-012, above); remove `LIMS_ORIGIN_FILES` (A14.2, above).
- C5: TRD §11.3 intake row `services/worker/src/jobs/lab/ops/lab.rules.yml` (CR-C5-010).
- C4: wire `services/worker/src/jobs/{billing,frontdesk}/alerts/*.yaml`; CSP (verified DONE, above).
- C6: CR-C6-013 per D-32 (above).
- C10: alert `increase(lims_micro_unmapped_received_total[1h]) > 0`.
- C12: intake row `services/worker/src/jobs/inventory/ops/inventory.rules.yml` (4 rules; CR-C12-011); metric `lims_inventory_unresolved_oldest_age_seconds` (gauge) in the C1 metric registry.
- C14: intake row `services/worker/src/jobs/smartreport/ops/smartreport.rules.yml` (6 rules; CR-C14-010).
- C9: intake row `services/worker/src/jobs/quality/ops/quality.rules.yml` (CR-C9-008).
- C8: alert rules `services/worker/src/jobs/analytics/ops/analytics.rules.yml` (CR-C8-015).
- C13: secret inventory lists the three BFF key names (P-45, above).
- C15: CR-C15-008 items (1)–(6) + `LIMS_FRONTDESK_PAYMENT_RESULT_URL` (above). The A22.4 gauges and alert table arrive from C15 in the sweep; C1 takes them into intake when they land.
- C17: wire `services/worker/src/jobs/homecollection/alerts.yaml` (5 rules).

### (iii) LOCAL findings
- Verified: #6 (`LIMS_CORE_RATELIMIT_BACKEND=redis`, `LIMS_CORE_REDIS_URL` via `*_FILE`, secret `valkey_lims_api_password`), #7 (`ValkeyDown` → page, "logins/OTP fail closed"; remove the fallback claim; C0 TRD l.620), #11 (intake rows C6, C7, C8 and all hand-off rows above; AC-17.2 "every alert proposed in C0, C2–C18 TRDs as they land"; T-21 rule files. The duplicate-agent-alert part is already fixed, see (h)), #15 (AC-06.1 per origin, explicit denies on staff_web/portal).
- MINORs, as reported and not re-verified: #20–#43. Of these, #28 is absorbed by D-43 (zone removed) and #19's AC is replaced by D-211.
- Additional notes from the review:
  - AC-26.1 must exempt `resolvePatientSession` (`x-edge-exposure: public`).
  - `tenant_ops_contacts` must move out of git `group_vars` into the secrets repo.

---

## (e) C2 work list (fix agent)

### (i) Rules, decisions and addendum items to apply
- **D-212**: TRD §5.1 marks every listed operation `x-context: identity_auth` + `x-public` (justification), and uses `ctx.db.identityAuthTx` / `bindTenant` in the flows (AF §3.1/§3.2/§3.5/§3.7). SCH §5.2 states the admitting policy per pre-auth write. (C2 #1)
- **P-42**: `ctx.commitOnError()` after the failure auth event, `mfa_failed_attempts`, the throttle event or the notice writes. This covers `loginStaff`, `loginPartner`, `openMobileSession`, `verifyMfaChallenge`, `completeMfaEnrolment`, `changeOwnPassword` (wrong current password) and the refresh-reuse revoke. Integration tests in T6/T7/T31. D-202 applies to the key row. (C2 #2)
- **P-16**:
  - `AND (SELECT app.is_staff_or_system())` in USING / WITH CHECK of every `__tenant` policy (SCH §5.2, §10.1).
  - `__own` policies stay without the guard; add `sessions__select__own_user`.
  - `shared_with: [partner]` for `sessions` and `mfa_factors`.
  - SCH §11 test: partner/patient/portal claims read 0 rows except their `__own` rows. (C2 #3)
- **A4.2**: `getStaffNotificationContact` in TRD §7, "eight methods" in §9; renumber C2 contract cases C2-1…C2-6 (incl. D-100); T5 done-when "IC 1–12 + C2-1…C2-6". (C2 #4)
- **D-101**: TRD §5.2 header "Accepted session kinds: `tenant_staff`, `partner`"; partner `getMe` shape; SEC test (own records only; another member's session id → 404). (C2 #5)
- **D-100**: `expectedVersion?: number` + JSDoc; contract case C2-6. (C2 #6)
- **D-26 / A14.1**: `readBrandingAsset` comment "any user or system actor of the tenant; kinds `logo`, `letterhead_header`, `letterhead_footer` only; a signature asset id → `common.not_found`"; contract cases. (C2 #7)
- **A21.2**: `readSignatureImage(ctx, { membershipId })`: system actor holding `identity.signatory.read`; `common.not_found`; contract case (CR-C6-020).
- **D-119**: TRD §7.3 bullet: for actor types `patient`, `portal`, `partner`, `keys` must be given and ⊆ {`timezone`, `calendarDisplay`}, else `auth.forbidden`; contract case. **A22.2**: the partner-admin writes `provisionPartnerMembership` / `updatePartnerMembership` are allowed. (C2 #8)
- **D-16**: `listCentres` → `identity.centre.read`; UI AD-7 guard; PRD §2 list. (C2 #9)
- **D-13(2) + D-63 + C11 hand-off**: `Banner` [CONV] on AD-2, AD-3 (Roles, Centre access) and AD-5 when the selected roles grant any of `lab.specimen.receive`, `lab.result.*`, `micro.culture.read`, `micro.culture.work`, `anatomic.case.read`, `anatomic.case.work`, `anatomic.case.signout` and `all_centres = false`; TRD §5.3 note (warning only). (C2 #10)
- **P-15**: timezone `'Asia/Kathmandu'` only; DDL `tenant_settings__timezone__ck`; `422 identity.setting_out_of_range` at `/timezone` in `updateSettings` / `provisionTenant` / `updateTenantSettingsAsPlatform`; UI AD-8/PL-2 read-only text. (C2 #11)
- **D-8**: `barcode_pattern` default `'{prefix}{yy}{seq:8}'` (SCH §4.6 l.194, DDL l.908). (C2 #12)
- **Roles**: "nine/9 default roles" → "the default roles of `contracts/permissions.yaml` (currently 10)" in PRD l.31, AC-E1.1, AF l.427 and SCH l.474. (C2 #13)
- **P-1**: five ACs → `400 common.validation_failed`. (C2 #14)
- **P-9**: CSV via `@lims/shared-ts/spreadsheet`; AC-D4.6 includes a leading `'`; drop the `service/csv.ts` guard. (C2 #15)
- **P-8**: Idem column in §5.4–§5.9; `required` for `createRole`, `createBranch`, `createCentre`, `uploadBrandingAsset`, `uploadUserSignature`, `recordAccessReview`, `createPlatformIrdAnnex`, `uploadIrdAnnexDocument`; `optional` for state actions; `none` for reads. (C2 #16)
- **D-213**: TRD §5.10 platform operations keep `required`; cite the C0 NULL-tenant store. (C2 #17)
- **D-214**: AF §8/§9.3 cite the extended R10.4 list. (C2 #18)
- **D-215**: SCH §3.1 states that NULL-tenant rows of `invitations` / `mfa_factors` / `ird_annex_records` are recorded in `platform_events`; add `platform_mfa_enrolled` to the kind CHECK; SCH §11 test. (C2 #19)
- **D-216**: policy `ird_annex_records__select__tenant_platform_ref`; amend SCH §11 test 2. (C2 #20)
- **P-6**: `identity.apply_pending_numbering` and `identity.access_review_due` → `per_tenant` (system actor, `job_key '<identifier>:<tenant_id>:<tick>'`); `access_review_due` inserts `admin_notices` kind `access_review_due`. (C2 #21)
- **P-19**:
  - `scan_state` on `identity.branding_assets` and `identity.ird_annex_documents`, added to `enforce_mutable_columns`.
  - Task `identity.rescan_upload` (≤ 5 attempts, backoff).
  - Non-clean content → `422 common.upload_quarantined` (also in `readBrandingAsset`). (C2 #22)
- **D-217**: write `core.users.email_hmac`; DEFINER SQL `app.identity_tenants_for_email_hmacs` in SCH §6/§10.3 (P-41: body, owner policy, inventory row, A12.7 tests); task `identity.notify_ip_throttle`; `admin_notices.subject_id` NULL for `login_ip_throttled`. (C2 #23)
- **D-218**: TRD §8 UNVERIFIED T1 items; default "patient kind blocked until T1". (C2 #24)
- **P-61**: TRD §4 item 11 "client IP = `ctx.clientIp` (C0), never a header read by C2". (C2 #25)
- **D-219**: delete the `recovery_issued_at` fallback; T1 release precondition. (C2 #26)
- **A3.3**: SCH §3.2 relabelled "mirror of C0 05-SCHEMA §10 — C0 wins" with C0 column names (`schema_name`, `old_values`, `new_values`, `outcome`, `purpose_code`); SEC §5.5. Keep the `request_id` / `support_session_id` filters; the indexes go to C0 (see (f)/(c)). (C2 #27)
- **P-41(d)**: SCH §6 table adds `app.identity_finish_breached_import`; the inventory rows go to the program docs (f). (C2 #28)
- **D-220**: PRD §11 Q5 cites C-07. (C2 #57)
- **A16.1**: SCH l.62 → `centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])` (C2 m#37). A grep found this as one of the two remaining uncast chunk occurrences.
- **A20.1–A20.3**: apply in the C2 SQL. `identity_resolve_session` sets `app.pre_tenant_id` to `support_tenant_id` for a support session, so `support_tenant_status` is filled; it is reset before return, and test 22 asserts it. Callers of `current_lims_session_id()` / `is_platform_actor()` reference C0.
- **P-60**: C2 TRD change-history rows for A1–A24.
- **P-14** (C2 m#55): "Alert rules for C1" and "CI jobs for C0-0A" tables.
- **P-10** (C2 m#34): `listAuditExports` "+ others' rows when caller holds `audit.log.read`".

### (ii) Hand-offs addressed to C2 (from `_handoffs.md`)
- C5 / C10 / C11: D-13 warning, incl. the micro and anatomic permissions (above).
- C4: D-23 grammar note in TRD §7 ("`registrationNoPattern`: C4 grammar applied by C2 — must contain `{branch}`; invoice `{branch}` vs series scope is checked by C4") (= C2 m#47); P-15 timezone (above).
- C6: `readSignatureImage` (A21.2, above).
- C13: `updatePartnerMembership` `expectedVersion?` + contract case (D-100); `partner_member` += `identity.self.manage` (program half in (f)), and C2 accepts session kind `partner` on self-service operations (D-101).
- C16: note on CR-C16-004 in TRD §7: "account id = challenge id; `provisionPatientMembership` is idempotent per `accountId`". The existing comment says "idempotent per accountId"; add the account-id = challenge-id statement.
- C3/C16: none further. D-119 key filter (above).

### (iii) LOCAL findings
- Verified, with residual text from C0 #3: C2 TRD §7.1 builds partner/patient/portal profiles from the fixed sets without core reads. The source of `<partner role>` (claims or C13 data) must be stated in §7.1.
- MINORs, as reported and not re-verified: #29–#51 and #53–#56.
  - #37 = A16.1 (above); #38 = P-2; #40 = P-3 (TRD §9 operation → action → entityType table; AF codes `support_session.open`, `tenant.lifecycle_change`); #41 = BFF kind `portal` on `/v1/identity/*` → 401 `auth.unauthenticated`; #45 = A18.1; #47 = D-23 (above); #53: use C0's `ctx.rateLimit.consume()` and its key prefixes; a `peek(key)` C0 CR only if T6 needs it; #55 = P-14; #56 = P-18(c) / A12.2 maintenance delete.
- #52 is CROSS (01-CM §5.1 `getStaffNotificationContact`), see (f).

---

## (f) Final-sweep work list — program docs (deduplicated; verified 2026-11-06 against the current files)

"NOT DONE" = grep found the text missing or still old. "DONE" = present. Sources: `_handoffs.md` sections, plus items found by this triage (marked †).

### 02-CONVENTIONS
1. **A16.1**: §5.8 template l.660–673, 4 uncast occurrences → `::uuid[]`. NOT DONE.
2. **P-16** §5.8 text (replaces the CR-C13-011 bullet); **P-17** §8; **P-18** §5.2/§5.6/§5.11; **P-19** §10.2 Uploads; **P-20** §8.2; **P-22** §5. NOT DONE (0 hits) †.
3. **P-40** §4.5; **P-41** §5.9; **P-42** §4.7; **P-43** §4.12; **P-44** §8.1; **P-45** §6. NOT DONE (0 hits) †.
4. **D-67** inline-image exception in §10.2 (C11 hand-off; also the 08 A13 P-2 text). NOT DONE.
5. **D-119 + A22.2** §8.5 item 1 (C13, C14). NOT DONE.
6. **§4.1** bulk bodies `items[{id,version}]` (CR-C5-011). NOT DONE.
7. **§10.2** C3 exception for catalog import/export files in `catalog.files`, scanned via `ctx.files.scan`. NOT DONE.
8. **D-116** §10.3 variant under `general` †. NOT DONE.
9. **P-61** §10.3 †.
10. **P-60** reference in 05-DoD †.

### 03-INTERFACE-CATALOG
11. §4.2: `@throws common.not_found` on getTest, getPanel, resolveOrderables, priceFor, referenceRangeFor, criticalLimitsFor (C3). Lead to check line by line in the sweep (not counted here).
12. §4.2 `RangeQuery.ageDays` optional + A17.1 semantics (l.1223 still `readonly ageDays: number`). NOT DONE.
13. **§4.2 A24.1 `getPriceListStatus`** + consumer C16 in the heading. NOT DONE.
14. §4.3 heading: FrontdeskPort consumers = C5, C6, C10, C11, C13, C14, C15, C16, C17 (l.1304 lists C5, C6, C13, C16, C17); contract case (12) `booking_cancelled_after_registration` (A2.12). NOT DONE.
15. §4.5 A17.2 in `getOrderItemProcessingState` semantics (`result_entered` 0 hits); D-61 contract cases (35)(36) + §3.17 note. NOT DONE.
16. §4.5 D-10 fields — DONE (`agentId`, `mappingStatus`, `processingKind` present). D-2/D-4/D-5/D-6/D-7/D-8/D-11/D-14/D-15 program halves — DONE (spot-checked: `module_resubmitted`, `seq:8`, `specimen_label.print`, `lab_result_history.view`, `instruments.instrument.read`, S14 From list).
17. §4.6:
    - `updatePartnerMembership` `expectedVersion?` + JSDoc (l.1647 still `expectedVersion: number`, D-100);
    - `readSignatureImage` (A21.2).
    NOT DONE.
18. §4.8:
    - `requiredPermission` sentence → "C8 always sends `analytics.dashboard.read` (08 A7.6); per-report permissions only filter pack content";
    - templates `reporting.dues_due` (purpose `dues_reminder`; params `lab_name`, `amount_text` `short_text`, `url`) and `homecollection.visit_scheduled`.
    NOT DONE.
19. §4.9: verify JSDoc (eSewa PENDING/NOT_FOUND and Khalti Initiated non-terminal before `expires_at` + grace, case 5); "Tenant context" → D-115 text. NOT DONE (D-115 phrase absent).
20. §4.10: remove `smartreport.summary_not_ready` from `buildSummary` `@throws` (l.1864 still lists it; D-111). NOT DONE.
21. §4.15 BillingCommandPort: copy C4 TRD §6.3 (`baseFingerprint`, `fiscal_year_rollover`, `numbering_pattern_invalid`, contract cases 12–15) (`baseFingerprint` 0 hits). NOT DONE.
22. §3.18 `delivery_created_at` (D-48) and §6.4 note "business_date = delivery creation date". NOT DONE.
23. §3.23: optional `booking_id` (if/then on visit kind) + consumer C16; §3.25 row 23 += C16 (D-120; C16, C17). NOT DONE.
24. §3.24 cancelled-event trigger "from `confirmed` or `checked_in`" (C16). Not checked line by line; lead to confirm.
25. §6 header P-15 text; §6.2 `v_pub_credit_party_statement` consumers = C13 (D-51); §6.3 `v_pub_specimen_timeline` += `replaces_specimen_id`, `specimen_version` (D-106; the l.2164 view row lacks both). NOT DONE.
26. §7 routes:
    - `staff.lab.ingest_exceptions` (CR-C7-014), `staff.analytics.collections` (D-46), portal `/r/{token}/dues`, API P7 `GET /portal/dues`, C15 P7b `recheckPaymentRefund`, P11b `failManualPaymentRefund`, P24b `listPaymentCancelReasons`, coded set `payments.refund_fail_reasons`;
    - remove origin `files` (l.2240, A14.2).
    All NOT DONE.
27. §8:
    - `catalog.import_invalid` `retired: true` (l.2458);
    - `anatomic.image_not_ready` retired (l.2606);
    - emission note → P-23 text.
    NOT DONE.
28. §11:
    - `partner_member` += `identity.self.manage` (D-101; fixed set l.2942 lacks it);
    - `micro.culture.read` roles += `lab_manager` (D-64; l.3071);
    - `reporting.report.read` roles += `radiologist` (A21.3; l.3026).
    NOT DONE.
29. §12 `core.idempotency_keys`:
    - `request_sha256 text` → `bytea (octet_length 32)` (C0 #40 †; l.3164);
    - `tenant_id` NULL for platform rows (D-213 †).
    NOT DONE.
30. §13.1 access-log block: D-53 codes (C9: `autoverify_decision.view`, `autoverify_simulation.view`; C11: six `anatomic_*` codes). NOT DONE (0 hits).
31. §13.3 DEFINER inventory:
    - Replace `app.engagement_resolve_tenant_code(text)` with `app.core_resolve_tenant_code` (D-121).
    - Add `frontdesk.purge_trf_drafts`, `partners.redact_lines`, `app.homecollection_anonymise_retired_visits`, the C16 §6.6 set (`engagement_apply_report_link`, `engagement.purge_payment_requests`, `engagement.purge_queue`), the C15 row with policy + `app.pre_payments_callback_token_sha256`, and the C6 rows with A21.4 GUC names + the `provider_events__select__lookup` policy.
    - D-30 row: `reports` / `report_versions` / `deliveries` `__select__owner_only` + column grant `UPDATE (redeem_failures, updated_at, version) ON reporting.portal_links TO lims_reporting_lookup`.
    - C2 rows `identity_purge_sessions`, `identity_expire_{support_sessions,invitations,audit_exports}` (`app.maintenance`, A15.3), `identity_load_breached_batch`, `identity_finish_breached_import` (C2 #28 †).
    - `app.identity_tenants_for_email_hmacs` (D-217 †).
    All NOT DONE. `cron_tenant_ids`, the D-42 signature and the D-30 base row are DONE.
32. §13.4: `reporting-inputs` path `{tenant_id}/instrument-sanitized/{yyyy}/{mm}/{sha256}.pdf` (A21.3). NOT DONE.
33. §13.6:
    - P-12 `delete` comment — DONE (`lims_core_storage_deletes_total` present);
    - `restoreNeutralised` — DONE;
    - `ctx.core.centres` shape incl. `phone_display` (C4) — NOT DONE (0 hits in 03-IC).
34. §7 + 08 §4.3: `origins.files` removed (A14.2) — NOT DONE (see 26, 47).

### 01-CHUNK-MAP
35. §5.1 port table:
    - CatalogPort methods += `getTaxRate` (0 hits) and `getPriceListStatus`; consumers += C16 (already listed);
    - FrontdeskPort consumers = C5, C6, C10, C11, C13, C14, C15, C16, C17 (l.283);
    - IdentityPort methods += `getStaffNotificationContact` (0 hits; C2 #52 †) and `readSignatureImage`;
    - SmartReportPort consumers = "C6" (l.290 still "C6, C16"; C14, C16);
    - RenderPort consumers += C13 (l.293 "C4, C8").
    - P-46 header note.
    All NOT DONE.
36. §6 matrix: C10×C4 = `p`; C11 row `p` under C4, `e` under C5; C14×C4 = `p`; C15 `p`, `v` under C4 + C1 dependency; C13 `v` under C3, C4, C5; C9 row C5 `e,v`, C6 `e,v` (incl. `reporting.v_pub_order_report_tat`), C7 `e,v`, drop `p` under C5. Not checked cell by cell; treat as NOT DONE.
37. §3: map `apps/web/tests/e2e/<module>/` to the module owner (C9). §2 row C8: "B2C dashboard … after C16" (D-123) †. §3 note: C0 reads C1 `UPSTREAM.lock` (D-208 †).
38. §4 "Must": P-41 sentence †, P-60 †.

### 07-BLOCKERS
39. B7 "Chunks affected" → "C4, C12 (`inventory.settings.vat_in_cost`, default true)" (D-57; l.15 still "C4"). NOT DONE.
40. B14 → "C14, C5, C9 (…)" (l.22 "C14, C5"); B15 += C9 (l.23 lacks C9). NOT DONE.
41. C-06 client question (A19.4) and C-07 (D-220 †): check 07 / 08 §5.2 in the sweep.

### 06-GLOSSARY
42. Westgard lines 176–179 → point to D-58 (N = 3 rules, 8x, 12x = DECISION / UNVERIFIED). NOT DONE (lines still say "04/01 do not spell out").

### 08-CR-REGISTER
43. §1 decision summary: recount from the §3 table by script (expected ACCEPT 139, ACCEPT-MODIFIED 56, DEFER 10, per the 08-sync hand-off, before the new rows below are added; recount after adding them).
44. §3 rows, all missing from the table (they exist only in addenda text):
    - CR-C3-008, CR-C3-009, CR-C5-010, CR-C5-011, CR-C5-012, CR-C7-013, CR-C7-014, CR-C8-015, CR-C9-008, CR-C12-011, CR-C14-009, CR-C14-010, CR-C15-014, CR-C15-016, CR-C16-022, CR-C16-023, CR-C17-014, CR-C6-019, CR-C6-020 — all ACCEPT.
    - The CR-C1-005 Notes amendment (D-204 †).
    NOT DONE.
45. R1 seed += `module_preliminary_update` (D-61) — not in §2 R1 (it appears only in A17 text). R9 append P-20; R25 append P-21; R10 item 1 → P-61 †; R10 item 4 → D-214 †. NOT DONE.
46. §4.1: `partner_member` += `identity.self.manage` (D-101); `lab_manager` += `micro.culture.read` (D-64).
47. §4.3: routes as item 26; remove `files` origin from the l.961 intro (A14.2).
48. §4.4: D-53 codes.
49. §4.6: delete the `QrCode` row l.1180 (CR-C13-013 withdrawn; no other user — verified).
50. §4.7: same rows as item 31.
51. §4.8: `partners-slips` row gains "write-once per successful issue; a retry before the row is `issued` may replace (upsert)"; `reporting-inputs` instrument-sanitized path.
52. §4.9: `v_pub_specimen_timeline` columns (D-106); `v_pub_credit_party_statement` consumers C13 (D-51).
53. §4.10: templates `reporting.dues_due`, `homecollection.visit_scheduled`.
54. §4.11: `MembershipRow` + widened `memberships.list` (D-47; C8, C10, C11); `identityAuthTx` (D-212 †); scanner keys (D-209 †); NULL-tenant idempotency (D-213 †).
55. A7.6 clarifying note (D-70: stored column `tax_code NULL`; wire field `is_exempt`).
56. §5.1 F-08 list += D-207 (app-1 sizing) †; §5.2 += C-07 (D-220) †.

### research/04 (sweep, doc owner)
57. P3/P4 Source cells: "re-read 2026-11-06; details and open points in C15 02-TRD §0 (V1–V15)" (D-117). NOT DONE (0 hits).
58. I1 VM-2 = 32 GB, if the founder confirms D-207 †.

---

## (g) Final-sweep work list — other chunks (second touch)

- **All chunks — A16.1 grep**: remaining uncast forms are C2 05 l.62 (in the C2 list) and **C4 05-SCHEMA l.75, l.77**. `engagement_patient_ids()` has no uncast hit left (C6 hand-off: DONE).
- **All chunks — P-60**: change-history rows A1–A24.
- **C3** (second touch):
  - Implement A17.1 (age-unrestricted rows only when `ageDays` is absent).
  - Implement **A24.1 `getPriceListStatus`** (C3's status set wins).
  - Confirm a blank `_meta.tenant_catalog_revision` is accepted in a fresh `price_list` template (C18 hand-off).
  - Its own 03-IC §4.2 `@throws` rows (f-11).
- **C4** (second touch):
  - D-4 text "after 200, open `staff.lab.order_labels` in a print frame; panel 'Labels ready — printing'".
  - CR-C15-016 / D-113: B12 `returnUrl = cancelUrl = ${LIMS_FRONTDESK_PAYMENT_RESULT_URL}`; `form_post` dialog with QR of `launchUrl` + "Open on this PC"; "Cancel payment" → C15 P5 + P24b via the staff BFF; B12 `x-error-codes` += `payments.amount_not_supported`, `payments.return_url_not_allowed`.
  - D-128: the `collection.synced` consumer never dead-letters on a tenant-inactive method and raises a finance review item instead.
  - D-120: tolerate `booking_id`.
  - Publish the B26 `getCreditNoteRegister` row shape (field `net`, C8).
  - Fake and contract suite add callers C14 and C15.
  - A16.1 l.75/77.
- **C5** (second touch):
  - D-61 seed `module_preliminary_update` + guard.
  - D-106 view columns `replaces_specimen_id`, `specimen_version` (CR-C16-022).
  - TRD/UI note for route `staff.lab.ingest_exceptions` (CR-C7-014).
  - D-120 tolerate `booking_id`.
- **C6** (second touch):
  - A21.1 dues link + A21.4 GUC renames.
  - D-61 report-kind rule exclusion set + `preliminary` label.
  - P-44 savepoint (`ctx.db.tx`) around `buildSummary` calls that catch `smartreport.*`, with the fake marker test.
  - D-48 `v_pub_delivery_daily` += `centre_id` (group by it) and always set `delivery_created_at`; per-status anchors.
  - D-115 portal payment worker uses `createIntent` / `getIntent` as the reporting system actor, return URL `<PORTAL>/r/payments/{id}/done`, no event-only ledger expectation.
  - CR-C16-008 policy uses `patient_id = ANY ((SELECT app.engagement_patient_ids())::uuid[])` — grep shows no uncast form left, so DONE pending a C6 read.
  - Seeds `homecollection.visit_scheduled` (CR-C17-014) and `reporting.dues_due`.
  - P-42 `commitOnError` on the `redeem_failures` increment (A19 P-42 consequence).
- **C8**: D-1 consumer note (periodic credit bills have no `centre_id`); D-29 absolute staff URL for `linkUrl`; D-48 consumer side.
- **C14**: A22.1. The staff `getSummary` response includes `reviews[]` (action, actor display name, reason code, at) from `summary_reviews`; no new endpoint.
- **C15**:
  - A22.4 gauges (`lims_payments_held_for_review_oldest_age_seconds`, `lims_payments_reconciliation_stalled_runs`) [CONV] + the "Alert rules for C1" table.
  - Return-URL allowlist += `<LIMS_ORIGIN_PORTAL>/r/payments/`.
  - Replace the DEFERRED text (TRD l.271, l.555; PRD l.28, l.65, l.75, US-PG-11, l.214).
- **C16**: non-standard policy scope names normalised only if trivial, otherwise documented (lead note); CR-C16-023 consumer text matches A24.1.
- **C7**: none beyond what is above (C7's metrics and alert table already match CR-C1-003; see (h)).
- **C18** (design only, B4): deferred items recorded only (`lims_migration` EXECUTE on `core_resolve_tenant_code` / `cron_tenant_ids`; schema exceptions; CR-C18-002/003/004).

---

## (h) FALSE / ALREADY-FIXED / PARTIAL

- **C1 #12 — ALREADY-FIXED (C7 fix pass).** C7 02-TRD l.881–886 now exports `lims_instruments_agent_state{tenant_id,centre_id,agent_id,state}`, `…_last_heartbeat_timestamp_seconds`, `…_silent_instruments` and `…_agent_info` with the CR-C1-003 names and labels. C7 l.905 states that the agent-state alerts are C1's (`BridgeAgent*`) and are not repeated. No C7 change is needed.
- **C1 #11 — CONFIRMED-PARTIAL.** The intake gap is real: C1 TRD §11.3 still says "C6–C18 when their TRDs land", and the hand-offs add C4, C5, C8, C9, C12, C14 and C17. The "C7 duplicates C1's agent alerts with other thresholds" half is fixed (see #12). C7 proposes only additional alerts (`InstrumentsAgentUpdateFailed`, `InstrumentsDeviceAuthFailureSpike`, …, l.909–911). C1 lead item 8 therefore needs no decision.
- **C0 #3 — CONFIRMED-PARTIAL.** The `shared_with` half is confirmed and decided by A23.3. The second half ("how C2's IdentityPort reads `core.memberships` for partner/patient actors") is answered by C2 TRD §7.1: partner, patient, portal and device profiles are built from the fixed permission sets with no core read. The only residual is the source of `<partner role>`, a C2 LOCAL clarification.
- **C1 #13** — CONFIRMED and already decided by **A14.2**; not a lead item any more.
- **C0 #1, #2, #19, #3 (first half)** — CONFIRMED and already decided by **A23.1–A23.3**; not lead items any more.
- **Reviewer proposals corrected** (the findings stand):
  - C0 #21 option "create as owner and `ALTER … OWNER`" does not avoid the CREATE grant, because PostgreSQL requires the new owner to have CREATE on the schema. Hence D-201's grant/revoke-in-migration.
  - C0 #2 option (b), a new `app.dl_replay_tenant` DEFINER, is superseded by A23.2 (no new DEFINER).
  - C1 #10: its 10 r/m `/v1/reporting/verifications` item is superseded by D-32 (the reviewer says so too).
  - C2 #17 option (b) cannot work for `provisionTenant` (the tenant id is unknown before the claim), so D-213 takes option (a).
  - C2 #23: an e-mail → tenant lookup needs an HMAC column that `core.users` does not have today (`auth_events.email_hmac` exists, C2 SCH l.129). D-217 adds it.
- No finding is FALSE.
