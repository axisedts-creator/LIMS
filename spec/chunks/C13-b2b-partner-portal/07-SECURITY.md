# C13 — B2B Partner Portal — 07 Security

Status: DECISION draft, 2026-11-06. REQ IDs are cited from `research/02-security.md`, not copied (04 precedence rule 4). Phase 2: REQ-SEC §1, §3, §4, §6, §7 apply (04 §12 rule); §2 (gateways) and §5 (mobile apps) do not apply — no payments and no native app in C13.

## 1. Applicable requirements

| REQ | How it applies in C13 |
|---|---|
| REQ-SEC-001/002 | ASVS L2 target; BOLA is the primary threat — every partner endpoint is probed with other partners' and tenants' ids (§6) |
| REQ-SEC-004 | Column classification in 05-SCHEMA §3/§6 |
| REQ-SEC-005/006 | Partner attests patient consent per line with a stored text version; channel consents are opt-in; C4 enforces `frontdesk.consent_required`. Reports reach the partner only when C6 put `partner` in the release audiences (partner = ordering organisation) |
| REQ-SEC-007 | No new foreign touchpoint; partner app serves all assets locally (no CDN fonts/scripts — 04 §11) |
| REQ-SEC-011–016 | RLS ENABLE+FORCE on every `partners.*` table, per-command policies to `lims_app`, no `USING (true)`, default deny (05-SCHEMA §8) |
| REQ-SEC-017 | Staff access to manifests/lines/pickups/projections is receiving-centre scoped (SC predicate) |
| REQ-SEC-019–021 | Two DEFINERs: helper `app.current_partner_id()` (CR-C13-004) and `partners.redact_lines` — `SET search_path = ''`, schema-qualified, no caller tenant parameter trusted (redact checks claims), each with its `__owner_only` policies `TO lims_owner` (08 A10.5, A19 P-41): the helper on `partner_users`/`partners` bound to the tenant + claims `membership_id`; the redaction on `manifest_lines`/`order_reports`/`order_tracking` bound to `app.maintenance = 'partners_redact_lines'` + tenant (A12.2). Both inventoried (08 §4.7 / 03-IC §13.3; the `redact_lines` row is handed off to the lead) |
| REQ-SEC-022/023/024 | Helpers wrapped in `(SELECT …)`; tenant_id leads every index; explicit tenant + partner filters in repositories |
| REQ-SEC-025 | Load test with 100 partners × 10,000 orders (02-TRD §12) |
| REQ-SEC-026/027/028 | Composite FKs everywhere; tenant_id no default; UUIDv7 ids in URLs; `manifest_no`/`registration_no` never in URLs |
| REQ-SEC-029/030 | No service-role key in C13 |
| REQ-SEC-031 | C13 reads only `security_invoker` views, as system actor |
| REQ-SEC-034/035 | Report bytes fetched server-side by the API from C6's internal signed URL (TTL ≤ 300 s); the URL never reaches the browser or logs |
| REQ-SEC-040–042, 044 | Probe suite §6; negative tests per policy ship with the C0 migration |
| REQ-SEC-045, 133 | Metrics + alerts: denied-download spikes, download volume per user, consumer mismatch (02-TRD §13) |
| REQ-SEC-061/062/064/065/066/067/068/073/074/075/076 | Partner login through C2 (CR-C13-003): same password policy, lockout/backoff, JWT verification, server-side claims, HttpOnly cookie BFF, idle/absolute timeouts, auth events, reset tokens, invitations; **MFA mandatory for partner_admin** (A4 extended); privileged `partners.partner_user.manage` re-validates membership and needs aal2 |
| REQ-SEC-078/079 | Rate tiers: login (as amended by 08 Addendum A1: per-account limits + per-IP failed-attempt throttle, edge flood guard; no static-IP dependency), report_download (20/h per user+report), general; daily download cap per user |
| REQ-SEC-080/081/082 | Spec validation with `additionalProperties: false` (no `partner_id`, `tenant_id`, `state`, prices in request bodies); per-audience DTO allowlists; parameterised SQL only |
| REQ-SEC-085 | PDF served with `Content-Disposition: attachment`, `nosniff`, `no-store` |
| REQ-SEC-088–092 | No `dangerouslySetInnerHTML`; nonce CSP (+ `worker-src 'self'`, `manifest-src 'self'`); headers per C1; CSRF via Origin/Sec-Fetch-Site in the partner BFF; exact-origin CORS (partner BFF is same-origin; the API is not called from browsers) |
| REQ-SEC-094 | Access slips use C6 links (≥128-bit, OTP-gated, TTL 30–90 d, revocable), issued by the C13 worker as the partners system actor (08 A2.1); no partner HTTP response contains the token or link |
| REQ-SEC-095 | Problem bodies only; partners never see failure codes that reveal other patients (03-APP-FLOW §3) |
| REQ-SEC-096/097 | Access log: `report.download`, `report.access_slip`, `manifest.print`, `statement.view`, `patient.view` (staff inbound manifest) — CR-C13-012; audit triggers on master/record tables |
| REQ-SEC-098 | Patient search by POST body; no PHI in paths/queries; logger denylist covers partner fields (02-TRD §13) |
| REQ-SEC-099 | Every operation in `partners.yaml` has `x-permission`; no `x-public` operation in C13 (partner login is C2's) |
| REQ-SEC-100 | Daily download cap; manifest line limit; pickup limits; no bulk export |
| REQ-SEC-128/129/130 | No secrets in C13 code; no new dependencies; partner app image built and scanned like others (C1) |
| REQ-SEC-136 | Synthetic data only; partner e-mails `@*.invalid` in fixtures |
| REQ-SEC-139/140 | Retention redaction of manifest PHI; partner admins and lab admins can deactivate partner users immediately (live on next request) |

## 2. Assets and entry points

| Asset | Class | Where |
|---|---|---|
| Partner patients' identity + tests (manifest lines) | P2/P3 | `partners.manifest_lines` |
| Report PDFs | P3 | C6 Storage via ReportingPort |
| Tracking (specimen status, rejection reasons) | P1/P3 | projections |
| Partner organisation finance (statements, prices) | commercially sensitive | projections |
| Partner user accounts | credentials (GoTrue), sessions (C2) | C2 |
| Access-slip links | bearer secret | never in a column, log, job payload or HTTP response; only inside the RenderPort input (worker memory) and the slip PDF in the `partners-slips` bucket until `link_expires_at` (08 A2.1, A5.1, A5.2) |

Entry points: partner BFF (`apps/partner`, public origin) → API `/v1/partners/*` (partner ops); staff BFF → API `/v1/partners/admin/*`; worker consumers/jobs; C2 auth operations on the partner network.

## 3. STRIDE threat model

| Entry point / asset | S | T | R | I | D | E |
|---|---|---|---|---|---|---|
| Partner login (C2 op via partner BFF) | credential stuffing → login tier + backoff + MFA for admins (REQ-SEC-064) | — | auth events (C2) | account enumeration → generic errors (REQ-SEC-075) | login flood → nginx flood guard 60 req/min/IP + identity per-IP failure counter (≥ 10 failures/10 min → 5/min for 30 min + alert; 08 Addendum A1) | staff credentials on partner origin (or reverse) → session kinds bound by the BFF key (08 R10) |
| Partner API (all reads) | stolen cookie → HttpOnly/Secure/SameSite, idle timeout | — | access log on PHI views/downloads | **cross-partner read (BOLA)** → PT predicate in RLS + explicit filters + 404 indistinguishable; **cross-tenant** → tenant claim from verified JWT only | scraping → general tier + caps | partner token on staff/other-module endpoints → partner permission set contains no staff codes; tenant-only foreign tables guarded by authz today, by actor-type RLS guard after CR-C13-011 |
| Manifest writes | CSRF → Origin/Sec-Fetch-Site + SameSite | edits after submit → lifecycle trigger + service; cross-partner links (Y's referrer on X's line, Y's manifest on X's pickup) → 3/4-column partner FKs | `created_by`/`submitted_by` + audit_log | — | huge manifests → 200-line cap, 1 MB body | partner sets `state`/`partner_id`/`order_id`/receipt or pickup facts → not in request schema; under partner claims triggers `guard_partner_transitions` (states) and `guard_partner_columns` (column allowlists, every state; 08 A19 D-103) reject it |
| Staff receipt | — | receive lines of another manifest → per-line ownership check | `received_by` + audit | centre leakage → SC predicate | — | non-receiving-centre staff → 404 + `assertRole(centreId)` |
| Conversion job | — | wrong partner on order → partner_id only from line row | job logs (ids) | — | poison line → business failure path, no retry storm | job runs as system (all centres) — only on rows it locked by id from its own payload; payload contains ids only |
| Event consumers | forged events → only C0 outbox fan-out enqueues `evt.*` jobs | — | inbox | **report attributed to wrong partner** → partner_id cross-check with our mapping; mismatch dropped + alert | event floods → indexed miss path (≤ 20 ms) | — |
| Report download | link sharing → no public links; partner session required | tampered PDF → sha256 verified while streaming | access log allowed/denied | id guessing → 404 + denied log + alert | download abuse → 20/h per report, daily cap | partner RLS on C6 tables limited to `partner_id = current_partner_id()` (CR-C13-005) |
| Access slip | — | partner forcing state → INSERT only `requested` (RLS), UPDATE system only + guard trigger | access log on each PDF download | URL leakage → token/URL never stored in a column, never logged, never in an HTTP response; PDF only from the `partners-slips` bucket, server-side read, `no-store`; deleted at link expiry; `portalUrl` only in worker memory, the RenderPort input and the PDF — never logged or stored as text (08 A5.1); render data has no results and no PHI beyond name and order ref | slip-request floods → general tier | partner calling `issuePortalLink` → not possible: R4 makes no port call; the worker calls it as system (08 A2.1) |
| PWA / browser | — | — | — | PHI in caches on shared PCs → static-only SW, no-store, logout purge | — | — |
| Partner user management | — | — | audit_log + access_log `role.change`/`membership.lock` (C2) | — | — | partner admin escalating to staff roles → only partner roles exist in the port (CR-C13-003); last-admin/self guards; a **member** writing `partner_users` (role, status) under partner claims → trigger `guard_partner_users` requires the caller's own row to be an active `partner_admin` (only exception: own `invited → active` flip; D-103) |

## 4. Abuse cases (each has a test in §6)

| # | Abuse | Expected |
|---|---|---|
| AB1 | Member of partner X enumerates order UUIDs of partner Y | 404 every time; denied downloads logged; alert after 20 in 10 min |
| AB2 | Partner X user sends `partner_id: Y` in a body (manifest, pickup, invite) | 400 `common.validation_failed` (unknown field) |
| AB3 | Partner X user puts Y's manifest id into a pickup request | 404, nothing created |
| AB4 | Partner X user mixes X and Y report ids in `mark-seen` | only X rows updated; count excludes Y; no error revealing Y |
| AB5 | Partner token calls `GET /v1/catalog/credit-parties/{id}` or `/v1/frontdesk/orders/{id}` | 403 `auth.forbidden` |
| AB6 | Staff token calls `/v1/partners/me` / `/v1/partners/orders` | 403 `auth.forbidden` |
| AB7 | Partner admin of X invites a user and then changes role to staff-like role code | 400 (enum only `partner_admin|partner_member`) |
| AB8 | Suspended partner user keeps an open tab | next request 403 `partners.partner_inactive`; helper NULL ⇒ zero rows even if a handler bug skipped the check |
| AB9 | Deactivated partner user replays an old access JWT | C2 resolver rejects (401/403); SQL helper NULL |
| AB10 | Partner downloads 600 reports in a day | 429 after cap; metric/alert |
| AB11 | Partner edits a submitted line via direct API, or (handler bug / direct SQL with partner claims) sets `order_id`, `registration_no`, `converted_at`, `failure_code`, `sample_received_at`, `received_by` on a line, `received_at`/`in_transit_at` on a manifest, or `scheduled_*`/`assignee_text`/`picked_up_at` on a pickup — in any state, draft included | API: 409 `partners.manifest_not_editable`; SQL: `guard_partner_columns` → `immutable_row` (08 A19 D-103) |
| AB12 | Partner forges `state: received`, or moves a line `draft → converting` in mode `on_receipt`; a partner **member** sets its own `partner_role = partner_admin` or deactivates another user | not in schema; under partner claims `guard_partner_transitions` blocks transitions other than the allowed ones, `guard_partner_columns` admits `draft → converting` only when the manifest is `on_submit`, and `guard_partner_users` rejects member writes → `immutable_row` (D-103) |
| AB13 | Attacker replays a partner session through the staff BFF (or a staff session through the partner BFF) | kind is bound by the calling BFF's `X-Lims-Bff-Key`, never by a client header → C2 resolve → `401 auth.session_expired` (08 R10) |
| AB14 | Event `reporting.report.released.v1` with `partner_id` X for an order mapped to Y | ignored + mismatch metric; X sees nothing |
| AB15 | Staff of centre C2 opens a manifest received at C1 | 404 |
| AB16 | Search term with PHI placed in the URL by a modified client | API has no such query param → 400; BFF never builds it |
| AB17 | Partner pastes `<script>` in notes/patient name | stored as text, rendered as React text nodes; print view escapes |

## 5. PHI handling and logging rules

- Never log (02-CV §9.2 + 02-TRD §13): patient name/sex/DOB/age/phone/consents, `partner_sample_ref`, `registration_no`, `manifest_no`, panel/test names linked to a line, clinical notes, search `q`, access-slip URLs, signed URLs, partner contact details, e-mails (even masked).
- Allowed in logs: UUIDs (tenant, partner, partner_user, manifest, line, order, report), state names, error codes, counts, durations.
- Problem `detail` texts are generic (no names, no codes of other modules' patients).
- Staff failure text for `frontdesk.patient_duplicate_suspected` never shows the matched patient's data in C13; staff search C4 with their own permission.
- Print views are rendered server-side with `Cache-Control: no-store`. Access slips are rendered once by the worker through `RenderPort` template `partners.access_slip` (08 A5.1) into a PDF in the `partners-slips` bucket (08 A5.2); the slip URL never appears in any HTTP response, column or log (08 A2.1); the PDF download is `no-store`.
- Smart summaries: partner actors never call `SmartReportPort`; any summary shown to partners would come only from the C6 report-version snapshot via `ReportingPort` (08 A2.3).
- Exports: none in C13 (no CSV/Excel of patients).
- Data minimisation: the partner sees its own patients' names (it entered them) but the lab's patient code, other orders of the same patient, results and demographics held by C4 are **not** exposed.

## 6. Required security tests

| # | Test | Layer |
|---|---|---|
| ST1 | Cross-tenant probe for every operationId in `partners.yaml` (generator): tenant A credentials + tenant B ids in path/body/query/batch → 404, no B data, no B side effect (owner-role DB check) | probes |
| ST2 | Cross-partner probe for every partner-facing operationId (hand-written list: A1–U6): partner X credentials + partner Y ids → 404 (or per-item skip for R2); lists with Y data present return zero Y rows; Y manifest id as filter → empty list | probes |
| ST3 | Centre probe for every staff operation on receiving-centre objects (SI*, SP*, staff reads of projections): staff of C2 vs C1 objects → 404; staff with all_centres → visible | probes |
| ST4 | Actor-type probes: partner token on every staff operationId of `partners.yaml` and on a sample of 1 operation per other module → 403; staff token on every partner operationId → 403; portal/patient/device tokens → 403 | probes |
| ST5 | SQL RLS probes on every `partners.*` table with claims: partner X, partner Y, partner of suspended partner, deactivated partner user, staff centre C1, staff all-centres, system, portal, patient, device, support session — SELECT counts, INSERT with foreign `partner_id`/`tenant_id` fails, UPDATE/DELETE of foreign rows affects 0 | db (C0 + C13 cases) |
| ST6 | `app.current_partner_id()` truth table (CR-C13-004 tests), run with FORCE RLS on (08 A10.5 CI): returns the id only through the `__owner_only` policies; a `lims_app` session cannot use them (policies `TO lims_owner`) | db |
| ST7 | Write/FK probes (DB-enforced by the 3/4-column partner FKs, review #5): line referencing Y's referrer; pickup link joining X's pickup to Y's manifest; `tracked_specimens`/`order_reports`/`access_slips` row whose `partner_id` differs from its `order_tracking` row; `access_slips` pointing at a report version of another partner; `download_counters` with a `partner_id` other than its partner user's; partner_user with Y's partner id; order_tracking with a tenant-B order id → rejected | db + integration |
| ST8 | Privilege escalation: member → U2/U3 403; admin at aal1 → `auth.mfa_required`; last admin guard; self demotion guard; role enum | integration |
| ST9 | Immutability: lifecycle triggers block content changes after submit (partner and staff claims); partner column allowlists (generated from the `guard_partner_columns` arrays: each column outside the list, per table and state, → `immutable_row` under partner claims; D-103); `guard_partner_users` member/admin cases; redaction allowed only inside `partners.redact_lines` — a `lims_app` session that sets `app.maintenance = 'partners_redact_lines'` itself still gets `immutable_row`/0 rows, and the GUC is `''` after the function returns (A12.7); `has_table_privilege(lims_app, …, 'DELETE') = false` for every table except `manifest_lines`, `price_list_items`, `download_counters` | db |
| ST10 | Idempotency: submit/receive/retry replay → no duplicate jobs/orders; different body same key → 422 | integration |
| ST11 | Download path: sha256 mismatch aborts stream; denied attempt logged with `commitOnError`; signed URL never in response headers/body/logs (log-scan + response scan); rate tier + daily cap | integration + log-scan |
| ST12 | Access slip (08 A2.1): flag off → 403; R4 under partner claims makes zero ReportingPort calls; R4/R5/R6 responses, every `partners.access_slips` column, job payloads, logs and `core.idempotency_keys` contain no URL/token (response + DB + log scan with a planted fake token); partner claims cannot UPDATE `access_slips` or INSERT a non-`requested` row; partner Y cannot read/download X's slip (404); PDF `no-store`; object deleted after `link_expires_at`; RenderPort `data` contains exactly `tenantDisplayName, partnerName, patientDisplayName, orderRef, portalUrl, expiresAtLocal, issuedAtLocal` (no result values; 08 A5.1); planted URL absent from logs of the render call; access-log row on every download (08 A5.3) | integration + log-scan + probes |
| ST12a | SmartReportPort is never called with partner claims (fake asserts zero calls) (08 A2.3) | integration |
| ST13 | Log-scan with planted synthetic PHI in every partner field → none in logs/metrics/traces | log-scan (C0 harness) |
| ST14 | Browser: no JWT in JS-accessible storage or responses; cookie flags; CSRF (cross-origin POST rejected); CSP present; service worker cache contains no HTML/JSON after a PHI session; logout purges caches | E2E |
| ST15 | Event consumer abuse: partner_id mismatch (AB14), duplicate, stale seq | consumer tests |
| ST16 | XSS: stored script in notes/name/referrer renders inert in partner, staff and print views | component + E2E |
| ST17 | Session kind binding (with C2 real impl): staff session on partner BFF and vice versa → rejected | E2E (T24) |
| ST18 | Conversion savepoint (08 A19 P-44): fake writes a marker row then fails with a business code → marker absent after commit; line `conversion_failed`; no orphan C4 rows with the real C4 impl (T24) | integration |
| ST19 | Retention purge: `download_counters__delete__tenant` deletes only `expires_at < now()` rows and only for the system actor (A17 P-18(c)) | db |

## 7. Secrets used

| Secret | Where | Notes |
|---|---|---|
| `LIMS_PARTNER_BFF_KEY_FILE` (08 A19 P-45) — the partner BFF's `X-Lims-Bff-Key` (kind `partner`, 08 R10) | `apps/partner` server memory only; file-mounted from the C1 secret store | never logged, never sent to a browser, never in client bundles; rotation per the C1 runbook with an old/new overlap window accepted by the core (`LIMS_CORE_BFF_KEY_FILES`); a leak would let an attacker resolve partner sessions outside the partner BFF, so it is listed in the C1 secret inventory |
| C2 session token (cookie `__Host-lims_psid`) and short-lived access JWTs | partner BFF server memory / HttpOnly cookie | owned by C2; API base URL is internal config (not a secret) |
| Storage signed URLs (from C6 port) | API memory during one request | never persisted/logged (04 A14) |

## 8. Residual risks (accepted, documented)

- Until CR-C13-011 merges, tenant-only RLS policies in other modules admit partner claims; protection there is IdentityPort authz (ST4 covers it).
- Partner-attested consent sufficiency is UNVERIFIED (B16).
- Self-hosted Storage claim behaviour is UNVERIFIED (04 D3); C13 avoids depending on it by never letting partner claims touch Storage directly.
- GoTrue redirect support for a second origin (partner) is UNVERIFIED for the pinned version (CR-C13-003 (d), C2 T1).
