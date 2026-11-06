# C16 — Patient Engagement — 07 Security

Status: DECISION draft, 2026-11-06. Phase rule (04 §12): REQ-SEC §1, §3, §4, §6, §7 apply from the first C16 release (M1, Phase 2); §5 (mobile) applies when the patient app ships (Phase 3); §2 gateway requirements apply to the payment flow (C15-owned controls; C16 consumes them). IDs are cited, not copied (02-CV §10).

## 1. Applicable requirements

| REQ | How it applies in C16 | Where |
|---|---|---|
| REQ-SEC-001/002 | ASVS L2; BOLA is the primary threat: every patient endpoint resolves objects through the caller's links | TRD §9.1; §6 below |
| REQ-SEC-003 | MASVS groups for the patient app; MASTG-based pentest before launch | §2; T-SEC1 |
| REQ-SEC-004 | per-column classification | 05-SCHEMA §10 |
| REQ-SEC-005 | consent captured at link-code issuance (desk) and self-registration (app) with text version; NotificationPort enforces channel consent | TRD §4.3; 05-SCHEMA `link_consents` |
| REQ-SEC-006 | no third party sees reports: links require per-patient proof; staff revocation | D-LINK (§3) |
| REQ-SEC-007 | SMS (OTP, reminders) is a cross-border-flagged channel (04 §11) — no PHI in texts; no push (foreign) | TRD §4.9; CR-C16-009 |
| REQ-SEC-011…016, 022, 023 | ENABLE+FORCE RLS on every `engagement` table; per-command policies `TO lims_app`; helpers wrapped in `(SELECT …)`; tenant-leading indexes | 05-SCHEMA §3, §5 |
| REQ-SEC-017 | centre scoping for staff on bookings/slots/queues; patient and display predicates are separate | 05-SCHEMA §5.1 |
| REQ-SEC-019/020/021 | DEFINER helpers/resolvers/purges: `SET search_path = ''`, schema-qualified, inventoried, no caller-supplied tenant; every table they touch has a narrow `__owner_only` policy `TO lims_owner` (tenant claim, `app.pre_engagement_*` GUC or `app.maintenance`), with FORCE-RLS contract tests (08 A10.5, A12, A19 P-41/D-121) | 05-SCHEMA §6.5–§6.6 |
| REQ-SEC-024 | explicit `tenant_id` and `account_id` filters in repositories | TRD §9.1 |
| REQ-SEC-026 | composite FKs `(tenant_id, …)` | 05-SCHEMA §3 |
| REQ-SEC-034/035 | report PDFs reached only via C6's `openReleasedReportFile` with C6's server credentials; signed URL never leaves the API | TRD §6.2; US-EN-08 |
| REQ-SEC-036 | Realtime not used (D-RT) — no channel exposure | TRD §4.6 |
| REQ-SEC-040/041/042/044 | probes for every operation and table, two synthetic tenants, negative policy tests, mixed-id bulk tests | §6 |
| REQ-SEC-045, 133 | alerts: OTP failure spikes, link redemption failures, link issuance volume per staff, daily OTP cap | TRD §13 |
| REQ-SEC-046 | no amount in payment requests; booking prices indicative, C4 prices at registration | TRD §4.7, §4.8 |
| REQ-SEC-059 | "Paid" only from server state (worker `getIntent` as system actor → `payment_requests` `completed`; 08 R8) | US-EN-10.3 |
| REQ-SEC-064/065/066/067 | C2 sessions; access JWT ≤ 1 h; strict JWT checks (C0); claims resolved server-side, no patient ids in claims | TRD §4.1; CR-C16-004 |
| REQ-SEC-069/070 | OTP ≥ 6 digits CSPRNG, TTL ≤ 10 min (default 5), 5 attempts, ≤ 3 sends/phone/hour, constant-time compare, no PHI in the message | TRD §4.1; 04 A9 |
| REQ-SEC-074 | auth events → `access_log`: `auth.otp_sent` (send task), `auth.otp_failure` (`outcome: denied`, persisted on the `401` by `ctx.commitOnError()`, 08 A19 P-42), `app_link.redeem` on success; redemption failures are counted in the durable `linkfail:` counter (also persisted by `commitOnError`) | TRD §4.1, §4.3, §9.4 |
| REQ-SEC-078/079 | rate limits per 04 §4 + DECISION limits (tenant OTP cap, link failures); per-IP on OTP routes is an edge flood guard 60 r/m/IP burst 20 (08 A19 D-122, carrier NAT) | TRD §11 |
| REQ-SEC-080 | strict schemas; no `patient_id` accepted from patients (only `profile_id`); unknown fields rejected | TRD §5 |
| REQ-SEC-081 | DTO allowlists per actor (patient vs staff vs display); rejection reasons, specimen types, analyte ids never sent to the app | TRD §5.1 |
| REQ-SEC-088/089/091/092 | staff web + display page: shell CSP, no `dangerouslySetInnerHTML`, BFF origin checks; display cookie `SameSite=Strict` | 04-UI-UX; TRD §4.10 |
| REQ-SEC-093/094 | report links stay OTP-gated at the portal; app redemption requires the account's OTP-verified phone to equal the link destination (C6) | TRD §4.3.3 |
| REQ-SEC-095 | problem+json without internals; identical errors for all invalid-code causes | TRD §5 |
| REQ-SEC-096/097 | `access_log` for code issue/redeem/revoke, report download, smart summary view, membership lookup, account deletion | CR-C16-019 |
| REQ-SEC-098 | no PHI in URLs (path params are UUIDs only; booking/card numbers never in paths); logger denylist additions | TRD §13 |
| REQ-SEC-099 | every route in `engagement.yaml`; pre-auth/display operations declared with their security schemes; no undocumented routes | TRD §5 |
| REQ-SEC-100 | booking caps per profile/account/day; open enquiries cap; OTP caps | TRD §4.8, §11 |
| REQ-SEC-101 | C16 consumes no third-party API directly (all via C6/C15 ports) | — |
| REQ-SEC-102 | session token only in `flutter_secure_storage`; access JWT in memory | TRD §3.5, §4.1 |
| REQ-SEC-103 | patient app has no offline database; nothing to encrypt beyond secure storage; PDF temp files deleted | TRD §3.5 |
| REQ-SEC-104 | **no pinning in v1** (§2 D-PIN) with documented trade-off | §2 |
| REQ-SEC-017 (device) | the queue display is a `device` actor (`device_kind = queue_display`) reaching only `getQueueBoard`; C0's A19.1 probe ("device claims get 401/403 on every non-agent route") must exempt that one operation (hand-off) | TRD §4.10 |
| REQ-SEC-105 | CI grep forbids `badCertificateCallback`, insecure HTTP client options, `http://` base URLs in non-dev flavours | T-SEC1 |
| REQ-SEC-106 | no push (B11); in-app notifications carry no text; SMS templates carry no PHI | TRD §4.9 |
| REQ-SEC-107 | no secrets in the binary (only public endpoints, tenant code, app ids) — release `strings` scan | T-SEC1 |
| REQ-SEC-108 | patient app: warn-only posture; no detection library unless C0 pins one that makes no foreign calls (UNVERIFIED which qualify) — documented deviation until then | §2 |
| REQ-SEC-109 | `LimsSecureScreen` on PHI screens (Android screenshot + recents protection; iOS snapshot masking) | 04-UI-UX §1.1 |
| REQ-SEC-110 | app lock (biometric/PIN) after > 5 min background for PHI screens; no device lock → OTP re-login | TRD §4.1 |
| REQ-SEC-111 | `enableSuggestions:false`, `autocorrect:false` on phone/OTP/code fields | 04-UI-UX §1.1 |
| REQ-SEC-112 | obfuscated release builds; symbol files in the C1 store | TRD §2.3 |
| REQ-SEC-113 | minimum supported version per platform → `426 engagement.app_version_unsupported` | US-EN-20 |
| REQ-SEC-128/129 | secrets from the secret store (§8); exact pins and lockfiles (`pubspec.lock`) | TRD §2, §10 |
| REQ-SEC-136 | non-prod uses C0's synthetic phone prefix; no real provider credentials (C6) | 05-SCHEMA §8 |
| REQ-SEC-139 | read models deleted when no link remains; self-registration personal fields redacted after 30 days; account deletion | 05-SCHEMA §9 |
| REQ-SEC-141 | SMS gateway (via C6) is the only external channel C16 causes; app stores (distribution only, no PHI) recorded for the founder | §8 |

## 2. Mobile decisions

| Decision | Choice | Rationale / trade-off |
|---|---|---|
| D-PIN certificate pinning | **Not in v1** | REQ-SEC-104 makes pinning optional for the patient app and requires a remote kill switch if shipped. The API certificate rotates every 90 days (04 I5); a pinning mistake bricks every installed app with no in-app recovery. Unmanaged consumer phones and corporate proxies amplify that. Compensating controls: TLS 1.2+/1.3 with system trust only, no TLS bypass anywhere (REQ-SEC-105), access JWT ≤ 1 h, session tokens revocable server-side, no long-lived bearer secrets on the device beyond the session token. Revisit (CR candidate) with SPKI pinning of our own key plus a backup pin and remote config. |
| Root/jailbreak | warn-only (REQ-SEC-108); detection only via a C0-approved library without foreign calls | many RASP SDKs report to vendor servers — a foreign touchpoint (04 §11); detection is not a security boundary (REQ-SEC-108) |
| Push | none until B11 approved | REQ-SEC-106; Google/Apple transit; foreign SDK ban (02-CV §15.3) |
| Storage | session token in secure storage; nothing else persisted except transient PDFs | REQ-SEC-102/103 |
| Screens | screenshot/recents protection on PHI screens | REQ-SEC-109 — trade-off: patients cannot screenshot reports; they can save the PDF after a warning |
| WebViews | none for payments or reports | gateway pages open in the system browser (C15 F-04); no JavaScript bridge attack surface |
| Deep links | only routes from `routes.yaml` with UUID params (03-IC §7); unknown links ignored; app links verified via platform association files (CR-C16-010) | REQ-SEC-098 |

## 3. Identity proofing (D-LINK) — rationale

The question: which app account may see which lab patient's reports?

| Option | Why rejected / accepted |
|---|---|
| Phone match: show every patient whose record has the verified phone | **Rejected.** Families share phones (06-GLOSSARY "Patient"); a sibling, spouse or a later owner of a recycled number would see everyone's reports — a s.12(4) disclosure (04 L17). |
| Phone + knowledge factor (name + DOB) | **Rejected as sole proof.** DOB and name are known to family members and guessable. |
| **Phone + lab-issued single-use code bound to that phone, issued after an in-person ID check with recorded consent** | **Accepted (full history).** Combines possession of the phone (OTP) with an act by the lab that verified the person and recorded consent (REQ-SEC-005). The code alone is useless without the bound phone; the phone alone is useless without the code. |
| **Phone + report link sent by the lab to that phone** | **Accepted (from that report onwards).** The lab already sends every report link to this phone (C6), and the portal grants access to whoever holds the phone and the OTP (04 A9/A10); linking grants nothing for reports released later that the phone holder could not already open via each link. Earlier reports may have gone to an earlier number, so they are excluded (`visible_from`). |
| **Self-registration creates a new record** | **Accepted (no history).** The account only ever sees what it created and what happens after. It never attaches to an existing record, even on a perfect name/phone match. |

Continuing safety: automatic suspension on record phone change, record merge/anonymisation and account dormancy; monthly OTP re-authentication; app lock; staff revocation; per-account and per-patient link limits; issuance volume alert for insider misuse.

Residual risks (accepted, documented): (a) staff collusion (issuing a code for a patient to an attacker's phone) — mitigated by access logging, consent attestation, volume alert, and the patient's right to see access (C2 audit viewer); (b) a stolen unlocked phone — mitigated by app lock and server-side revocation; (c) the `report_link` method has no SQL-level proof (05-SCHEMA §5.2 `PAT_LINK_INS`, and `app.engagement_apply_report_link`, which can reactivate only the caller's own suspended link) — covered by service tests and probes P-L4.

## 4. Threat model (STRIDE per asset / entry point)

| Entry point / asset | S (spoofing) | T (tampering) | R (repudiation) | I (information disclosure) | D (denial of service) | E (elevation of privilege) |
|---|---|---|---|---|---|---|
| E2 OTP request | number of another person | — | `auth.otp_sent` access log | phone-existence oracle → identical responses | SMS pumping → prefix allowlist, per-phone/IP/tenant caps | — |
| E3 OTP verify | brute force the code → 5 attempts, TTL ≤ 10 min, constant-time compare | replay a verified challenge → status check | `auth.otp_failure` log | challenge rows of others → RLS PRE_TOK | lock-out of a victim by burning attempts → only that challenge dies; victim requests a new one | pre-auth claims reading data → no membership, all patient predicates false |
| Patient session token (device) | stolen token → idle 14 d / absolute 30 d, revocation, app lock | — | C2 session log | token in logs/backups → never logged, secure storage only | — | token used on the staff/partner surface → kind bound to endpoint family `/v1/identity/auth/patient/*` (08 R10; no origin header is trusted) |
| E14/E15 linking | someone else's code → bound-phone check; someone else's report link → destination-phone check | altered `patient_id` → never accepted from client; link ids immutable | link access-log entries | code validity oracle → identical 422 for every cause | brute force → 5 failures/hour/account, 50-bit codes | linking unlimited profiles → limits per account and per patient |
| L1 code issuance (staff) | staff acting for a non-present person → attestation + consent required | — | `link_code.issue` access log with membership | code shown once, slip without name | — | front desk of centre A issuing for any tenant patient → allowed tenant-wide by design; monitored |
| Read models / E20–E24 | — | — | report download access log | another account's data → PAT_VIS/PAT_PID RLS + service filters; `visible_from` | heavy polling → 304 path, general tier | — |
| E23 PDF stream | — | corrupted file → sha256 verified before completing | access log | signed URL exposure → stays server-side | download floods → 20/hour/link | — |
| Bookings | booking for another person → only own active profiles; staff centre scope | capacity overflow via race → conditional update; price tampering → indicative only | booking transitions table | booking list of others → PAT_ACC | slot hoarding → per-profile/account caps; no-show auto-cancel | patient cancelling a staff booking → PAT_ACC only covers own account's bookings |
| Payments | paying someone else's order → order must be in own projections | amount tampering → no amount field; C15 computes | C15 ledger + intent transitions | action URL leakage → returned only to owner, scrubbed after use | intent spam → one open request per order; idempotency | — |
| Queue display token | copying the cookie to another browser → `__Secure-lims_qdisp`, HttpOnly, `Path=/queue-display`; token only reads P0 board | — | pairing/revocation logged | board shows no PHI | polling load → 304, 5 s | display token on other endpoints → `403`; device kind permission set has one code |
| Queue console | — | token state misuse → state machine | transitions via `updated_by` + audit trigger | tokens carry no patient data | — | centre staff of C1 operating C2's queue → STAFF_C |
| Reminders | — | message content injection → template params validated by C6 | reminder rows | test names in SMS → params limited to `lab_name`, `datetime`, `booking_no` | reminder floods → staff-created only + system rules | — |
| Enquiries | — | — | append-only messages | P3 free text → never logged, never in notifications | open-enquiry cap | patient reading others' threads → PAT_ACC |
| Event consumers | forged events → only the worker core enqueues from the outbox | stale/out-of-order → seq guards | inbox | projecting unlinked patients → skipped | event storms → idempotent, batched | — |
| Membership card QR | photographed QR → staff lookup requires `engagement.membership.read`; card grants a price list only via C4's decision | — | lookup access log | card token reveals nothing without staff access | — | — |

## 5. Abuse cases (each has a test)

| # | Abuse | Expected result |
|---|---|---|
| AB-1 | Attacker enters a victim's phone number and guesses OTPs | 5 wrong → challenge dead; ≤ 3 challenges/hour/phone; alert on failure spike |
| AB-2 | SMS pumping with many foreign numbers from one IP | prefix allowlist rejects; per-IP nginx limit; tenant daily cap + alert |
| AB-3 | Family member with the shared phone tries to see a sibling's reports | no link without the sibling's code/report link; probes P-L1/P-L2 |
| AB-4 | Attacker obtains a printed code slip but not the bound phone | redemption fails (`422`), identical to unknown code |
| AB-5 | Attacker with a recycled number signs in months later | links suspended (dormant > 180 d or phone changed on record); nothing visible |
| AB-6 | App user tampers `profile_id` / `order_id` / `report_id` to another account's ids | `404 common.not_found` everywhere (probes) |
| AB-7 | App user sends `patient_id` in a booking body | `400 common.validation_failed` (unknown field) |
| AB-8 | Display token replayed against `listQueueTokens` or patient endpoints | `403 auth.forbidden` |
| AB-9 | Front-desk insider issues many codes to own phone | issuance volume alert; bound phone visible in access log; per-patient account limit 3 |
| AB-10 | Patient books every slot of a day | per-account/day and per-profile caps (`429 engagement.booking_limit_reached`) |
| AB-11 | Patient edits the return URL to `outcome=settled` | still pending until the worker's `getIntent` says settled |
| AB-12 | Malicious report link pasted (other origin, `javascript:`) | `400 common.validation_failed`, no port call |
| AB-13 | Staff try to read patient read models directly | no staff policy on read models → zero rows (SQL probe) |
| AB-14 | Pre-auth credential `t.<code>` used against `/me/*` | `403 auth.forbidden` (permission set `engagement.auth.challenge` only) |
| AB-15 | Concurrent "call next" from two counters | different tokens |

## 6. Required security tests

### 6.1 Cross-tenant probes (every operation, generated + hand-written; 02-CV §11.3)
For every operationId in TRD §5 (E*, S*, Q*, L*, R*, M*, N*, T*): authenticate in tenant A (patient, staff, display, pre-auth as applicable) and use tenant B's ids in path, body, query and bulk arrays → `404 common.not_found` / per-id not_found, no B data, no side effect in B (owner-role DB check). Pre-auth with B's `tenant_code` but A's challenge token → resolver fails (`401`).

### 6.2 Table probes (every `engagement` table)
SQL with claims of tenant A for each actor kind (user all-centres, user centre-A1, system, patient account A1, patient pre-auth, device display A1): SELECT sees zero B rows; INSERT with B `tenant_id` fails; UPDATE/DELETE of B rows affect 0 rows. CI asserts no DELETE grant except on the four read-model tables.

### 6.3 Cross-account probes (same tenant) — the D-LINK tests

| # | Probe | Expected |
|---|---|---|
| P-L1 | Account A1 (linked to patient X) vs account A2 (not linked): A2 calls E20/E21/E22/E23/E24/E41/E47 with X's order/report ids | 404 |
| P-L2 | A2's phone equals X's record phone, no code | E13 lists nothing for X; no endpoint returns X data |
| P-L3 | A2 redeems X's code bound to A1's phone | 422 identical to unknown |
| P-L4 | Service-level: `redeemReportLink` with a C6 fake returning success for patient X but phone mismatch flag → service never inserts; RLS: patient claims inserting a `link_code` link without a redeemed code → `42501` → 404 | as stated |
| P-L5 | Suspended link (each reason): every read of X → 404 | 404 |
| P-L6 | `visible_from` boundary: report released 1 ms before vs at `visible_from` | hidden / visible |
| P-L7 | Patient UPDATE of `account_patient_links.patient_id` via SQL | `immutable_row` |
| P-L8 | Revoked link then same account redeems an old (redeemed) code | 422 |
| P-L9 | Patient claims (outside a DEFINER): UPDATE `account_patient_links` setting `status` suspended → active, or `visible_from` → NULL, `method`, `link_code_id` (review C16 #14) | `immutable_row` (05-SCHEMA §4); relationship change and revoke succeed |

### 6.4 Centre-scope probes (staff)
Staff scoped to centre C1: bookings, slot templates/blackouts/occupancy, queue definitions/counters/tokens/displays of C2 → 404 on object ops, zero rows on lists; `createBookingForPatient` at C2 → `403 auth.forbidden` (assertRole with centre) or 404.

### 6.5 Actor-confusion and privilege-escalation tests

| Test | Expected |
|---|---|
| Patient token on every staff operation | 403 |
| Staff token on every patient (`/me/*`) operation | 403 |
| Display token on every non-board operation | 403 |
| Pre-auth credential on every non-pre-auth operation | 403 / 401 |
| Partner or portal claims on any engagement operation | 403; SQL: zero rows on every table |
| `updateEngagementSettings` and `createMembershipPlan` at aal1 | `403 auth.mfa_required` |
| front_desk without `engagement.link.issue` (role removed) | 403 |
| Patient-only permission granted to a tenant role in `permissions.yaml` | CI rule fails |
| Bulk `markMyNotificationsRead` mixing own and foreign ids | own updated, foreign `not_found` |

### 6.6 Other required tests
- OTP: entropy/format, TTL boundary, attempt limit, constant-time comparison used (code review + unit test that the compare function is the crypto helper), rate limits (fail-closed when the rate-limit backend is down — C0 §6.7).
- Log scan: planted phone, OTP, code, tokens, names, address, enquiry text → absent from logs (05-DoD §1.8).
- Event payload PHI: `engagement.booking.*` payloads contain only the 03-IC fields (schema validation with `additionalProperties: false`).
- Mobile (T-SEC1): device dump shows no tokens outside secure storage; screenshot blocked on PHI screens (Android); release binary has no secrets (`strings` scan) and no push/analytics SDK (dependency tree check); `--obfuscate` present; no TLS bypass (grep).
- Display cookie attributes asserted in BFF tests: name `__Secure-lims_qdisp`, `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/queue-display`, no `Domain` (a `__Host-` cookie with a non-`/` path is rejected by browsers; review C16 #3).
- P-42 persistence: OTP mismatch (`attempts`, `failed`, `auth.otp_failure`) and link-code `linkfail:` counter survive their 4xx; the `409` limit path after redemption rolls back.
- FORCE-RLS DEFINER tests 1–6 of 05-SCHEMA §6.6 (including: a `lims_app` session that sets `app.pre_engagement_*`, `app.pre_tenant_id` or `app.maintenance` itself sees nothing).
- Storage: the PDF path never exposes a signed URL to the client (response header and body inspection).

## 7. PHI handling and logging rules

1. Patients never send or receive `patient_id`; they use `profile_id` (link id). Staff endpoints may use `patient_id` (UUID, P1).
2. Never in logs, metrics labels, traces, URLs or error details: phone numbers, OTPs, challenge/session/display/card tokens, link codes, report link URLs, payment action URLs, names, DOB, addresses, panel names, smart-summary text, enquiry text, booking numbers, card numbers (02-CV §9.2; TRD §13 denylist additions).
3. Masking: phones are shown as `phone_masked` (country prefix + `•••••` + last 2 digits) to patients and staff; staff never see the full phone of an app account in C16 screens.
4. Notifications store no text; SMS templates declare only non-PHI params (CR-C16-009).
5. Smart summaries are stored only when approved, copied from the C6 report-version snapshot read via `ReportingPort` (C16 never calls `SmartReportPort`; `smartreport.*` has no patient RLS — 08 A2.3); copies are deleted when the last link to the patient is revoked.
6. Enquiry bodies are P3; staff UI warns against sending results in replies.
7. Access logging (`ctx.audit.access`; codes per 08 §4.4): code issue (`link_code.issue`), code/report-link redemption (`app_link.redeem`), link revoke (`app_link.revoke`), report download (`report.download`), smart-summary view (`smart_summary.view`), membership lookup (`patient_membership.lookup`), account deletion (`patient_account.delete`).
8. Error responses for invalid codes/links are identical regardless of cause (REQ-SEC-095).

## 8. Secrets used

| Secret | Purpose | Storage / rotation |
|---|---|---|
| `LIMS_ENGAGEMENT_OTP_HMAC_KEY_FILE` | HMAC of OTP codes | secret store (REQ-SEC-128); rotation = new key for new challenges (old challenges expire ≤ 10 min) |
| `LIMS_ENGAGEMENT_OTP_ENC_KEYS_FILE` | AES-256-GCM of OTP codes until sent | key-id map; newest encrypts; rotate quarterly [CONV] |
| `LIMS_ENGAGEMENT_LINK_HMAC_KEY_FILE` | HMAC of linking codes | rotation invalidates unredeemed codes (≤ 7 days) — rotate with notice |
| `LIMS_ENGAGEMENT_PHONE_HMAC_KEY_FILE` | HMAC of phones (accounts, OTP challenges, codes, links); every stored HMAC is raw 32-byte `bytea`, compared bytea = bytea (08 A2.4/A5.5) | rotation requires a re-HMAC job over accounts/codes/links (runbook T-OPS1) |
| Display tokens, card tokens, challenge tokens, session tokens | credentials | CSPRNG (`@lims/shared-ts/crypto`); only SHA-256 hashes stored as 32-byte `bytea` (display, challenge; 08 R24); card token stored as lookup (04 A11 pattern); session tokens are C2's |
| App signing keys, store credentials | distribution | client-owned store accounts, listings and signing keys (founder decision 2026-11-06, research/04 §13); keys held in the C1 secret store, never in the repo |

No C16 code reads the Supabase service-role key (02-CV §10.2 default). No gateway secret is ever visible to C16 (C15 holds them; the app receives only signed launch URLs — C15-TRD §7.2).
