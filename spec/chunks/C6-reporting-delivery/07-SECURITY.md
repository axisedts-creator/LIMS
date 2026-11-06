# C6 Reporting & Delivery — 07 Security

Status: DECISION, 2026-11-06. C6 owns most of the system's **public and outbound surfaces**: the QR verify page, the patient portal, provider callbacks, and every message that leaves for WhatsApp/SMS/email providers. It also parses untrusted PDFs. REQ IDs are from `research/02-security.md`, cited and not copied. Phase applicability per 04 §12.

## 1. Applicable requirements

| REQ | How it applies in C6 | Where implemented / tested |
|---|---|---|
| REQ-SEC-002 | BOLA is the primary threat on every report/version/delivery/file id | handlers load via RLS repo first; probes §4 |
| REQ-SEC-004 | column classification in 05-SCHEMA §2, §10 | schema review |
| REQ-SEC-005 | consents read from C4 (FrontdeskPort) before every send, re-checked at send time | NotificationPort, send task; AC-09.4 |
| REQ-SEC-006 | referrer deliveries and critical alerts require `shareWithReferrer`; portal links bound to recipient | release audiences, NotificationPort; AC-08.3 |
| REQ-SEC-007 | WhatsApp/SMS/email carry no PHI, link only; providers treated as cross-border (04 §11) | template param validators; AC-08.1 |
| REQ-SEC-011..016, 022..024 | RLS on every `reporting` table, per-command policies to `lims_app`, no `USING (true)`, tenant-leading indexes, explicit tenant filter in repos | 05-SCHEMA §4–§6 |
| REQ-SEC-017 | centre scoping on reports, versions, items, files, narratives, deliveries, prints | `__tenant_centre` policies; AC-08.4 |
| REQ-SEC-018 | QR verify (public) reads only through a DEFINER function returning the minimal fields | `app.reporting_verify_qr` |
| REQ-SEC-019..021 | four DEFINER functions (`reporting_verify_qr`, `reporting_resolve_portal_credential`, `reporting_ingest_provider_callback`, `reporting_redeem_link_for_app` — 08 A13 D-30), `search_path = ''`, owned by `lims_reporting_lookup` (no BYPASSRLS), token-bound policies `TO lims_reporting_lookup` on transaction-local GUCs set inside the function | CR-C6-002; 05-SCHEMA §6.2 |
| REQ-SEC-026 | composite FKs everywhere | 05-SCHEMA DDL |
| REQ-SEC-028 | no sequential ids in QR/links; random tokens | 02-TRD §4.7 |
| REQ-SEC-031 | `v_pub_*` security_invoker | 05-SCHEMA §7 |
| REQ-SEC-034/035 | private buckets with tenant first segment; no signed URLs handed to browsers — API streams files | CR-C6-009; R5/P4 |
| REQ-SEC-040/041/044 | cross-tenant + cross-centre probes, mixed-id bulk release/print | §4 |
| REQ-SEC-045, 133 | alerts on OTP failures, QR not-found spikes, bulk downloads, renderer blocked requests | 02-TRD §12 |
| REQ-SEC-069 | OTP 6 digits CSPRNG, ≤ 10 min, 5 attempts, ≤ 3 sends/destination/hour, bound to link + channel, constant-time HMAC compare | portal.service; AC-11.1–11.4 |
| REQ-SEC-070 | OTP message has only code, lab name, minutes | template `reporting.portal_otp` |
| REQ-SEC-074 | `auth.otp_sent`, `auth.otp_failure`, `portal.session_start` in access_log | portal.service |
| REQ-SEC-078/079 | tiers `otp_request` (P1 key `otp:l:<link_id>`, NotificationPort key `otp:p:<hex>` — 08 A13 D-31), `otp_verify`, `qr_verify` (keyed on `app.client_ip`, set from `X-Forwarded-For` only with a valid portal BFF key — D-32), `report_download`, `general`; nginx per-minute part on the portal's `/v/*` only (C1) | 02-TRD §6.6/§6.7; CR-C6-013 note |
| REQ-SEC-046/059 | portal dues payment (08 A11.1): amount never from the request (C15 computes it from `BillingPort.getOrderBalance`); the return page never trusts `outcome`; portal actors never call BillingPort/PaymentProviderPort | 02-TRD §6.6 PP1/PP2; AC-18.3/18.6 |
| REQ-SEC-080/081 | strict schemas; mappers with per-role field lists; delivery views mask destinations | mappers |
| REQ-SEC-083/084/085 | outsourced PDFs and images: allowlist, magic bytes, 15 MB, scan + quarantine, re-encode/sanitise, served as attachment with nosniff + CSP sandbox | O1–O5, N6/N7 |
| REQ-SEC-086 | renderer: JS off, only `data:` URLs, no user URLs, container egress denied | 02-TRD §5.1; AC-03.8 |
| REQ-SEC-087 | qpdf 12.4.2 + `@cantoo/pdf-lib` 2.11.1 in a sandbox container (no network/secrets, timeouts, memory caps); CVE tracking via dependency scan | 02-TRD §5.2 |
| REQ-SEC-088 | narrative HTML sanitised server-side (DOMPurify allowlist) and re-sanitised at render; React text nodes elsewhere | T17; AC-05.2 |
| REQ-SEC-089/090 | portal CSP (nonce), HSTS, nosniff, Referrer-Policy `no-referrer` on token pages, frame-ancestors none | `apps/portal/src/middleware.ts` |
| REQ-SEC-091/092 | portal state changes POST only; Origin check in the portal BFF; no CORS on API for portal origin (server-to-server) | portal server |
| REQ-SEC-093 | QR token ≥ 128-bit, minimal field set, identical response for revoked/unknown | AC-10.1–10.5 |
| REQ-SEC-094 | link ≥ 128-bit + OTP, TTL 30–90 d, revocable, re-request flow | AC-11.5 |
| REQ-SEC-095 | problem+json without internals; `link_invalid`/`verify_not_found`/`callback_rejected` identical bodies | handlers |
| REQ-SEC-096/097 | access_log for view/print/download/bulk download/release/narrative sign/token revoke; audit triggers on tables | CR-C6-008 |
| REQ-SEC-098 | no PHI or tokens in URLs to the API, logs or metrics; `/r/`, `/v/`, callback paths excluded from access logs | portal header credential; CR-C6-013 |
| REQ-SEC-099 | public operations inventoried with `x-public` justification (Q1, CB1, CB2) | spec |
| REQ-SEC-100 | bulk release and bulk download privileged (aal2), capped at 200 | R7, R13 |
| REQ-SEC-101 | provider responses untrusted, TLS verified, timeouts, circuit breaker | transports |
| REQ-SEC-128 | provider credentials only as `secret_ref`; renderer/sandbox tokens, OTP HMAC key in secret store | 02-TRD §10.1 |
| REQ-SEC-129/130 | renderer/sandbox images pinned by digest, non-root, read-only rootfs, trivy scan | Dockerfiles; C1 |
| REQ-SEC-136 | non-production uses only the recording transport; boot fails otherwise | config; AC-09.5 |
| REQ-SEC-139 | retention per tenant; no deletion of reports (B15) | 05-SCHEMA §9 |
| REQ-SEC-141 | WhatsApp BSP/Meta, SMS gateway, email relay listed in the vendor register with data touched = phone/email, template text, link | doc deliverable to founder |
| REQ-ARCH-043..050, 082..086 | renderer pool, versioned storage, QR design, async render, link-only messaging, SMS fallback, relay email | 02-TRD |

## 2. Assets and entry points

| Asset | Class | Where |
|---|---|---|
| Report PDFs and snapshots | P3 | `reports` bucket, `report_versions.content_snapshot` |
| Narrative text/images, outsourced PDFs | P3 | `reporting-inputs` bucket, narrative tables |
| Tokens (QR, link, session, callback), OTP codes | credentials | hashes/HMAC in DB; plaintext only in transit/memory |
| Patient contact details | P2 | read from C4 only by the send task (system actor); never stored except `phone_otp` until terminal |
| Provider credentials | secret | secret store |
| Signature images, letterhead | P2 / P0 | C2 bucket `identity-assets` (08 R26), read via `IdentityPort.readBrandingAsset` |

Entry points: staff API (bearerJwt via BFF), portal API (`portalSession`), public QR verify, provider callbacks, worker→renderer, worker→sandbox, outbound transports, event consumers, port calls from C4/C13/C16, `RenderPort.renderPdf` from C4/C8 worker tasks (system actors only, 08 R12c), partner/patient actor reads through `ReportingPort` (08 R8 rule 1).

## 3. Threat model (STRIDE)

| # | Asset / entry | S | T | R | I | D | E | Threat → control |
|---|---|---|---|---|---|---|---|---|
| T1 | QR verify | | | | ● | ● | | Token enumeration → 128-bit tokens, rate limits 10/min + 100/day/IP, identical 404, QR not-found alert. Data leak → minimal snapshot fields only |
| T2 | QR forgery (fake report with a real-looking QR) | ● | ● | | | | | Verify page shows lab, masked name, panels, issue time, version → mismatch is visible. The token is server-side, so a forged QR does not resolve |
| T3 | Portal link | ● | | | ● | | | Forwarded/leaked link → OTP to the contact on file (the link's known destination, else the patient's phone on file, resolved by the worker — 08 A13 D-31; no masked destination returned, so P1 is no contact oracle); link TTL; revocation (one-way, `tg_portal_links_guard`); no OTP on page load (link-preview bots) |
| T4 | OTP | ● | | | | ● | | Brute force → 5 attempts, 10 min TTL, 1 M code space; SMS bombing → 3/hour/destination, button-triggered only; alert |
| T5 | Portal session | ● | | | ● | | ● | Theft → HttpOnly Secure `__Host-` cookie on a separate origin, 15/60 min, hash-only storage; scope = one report via RLS `__portal` policies (cannot read other reports even in the same tenant) |
| T6 | Cross-tenant token reuse | | | | ● | | ● | Lookup by global hash returns the token's own tenant; claims derived server-side; probes prove A's token never yields B's data |
| T7 | Staff BOLA on versions/deliveries/files | | | | ● | | ● | RLS tenant + centre, 404 indistinguishable, mixed-id bulk probes |
| T8 | Renderer SSRF / script | | ● | | ● | | ● | JS disabled, request guard allows only data:, container egress denied, templates static, user text escaped, narrative HTML sanitised twice |
| T9 | Malicious outsourced PDF / image | | ● | | ● | ● | ● | Scan, magic bytes, sandbox (no network, no secrets, tmpfs, timeouts, caps), never Chromium, served as attachment + CSP sandbox |
| T10 | PHI leaving Nepal via messages | | | | ● | | | Declared non-PHI params only (validators), template texts tenant-editable but cannot add params; tests forbid names/tests/results; email link-only, no attachments code path |
| T11 | Message template abuse by tenant admin (putting PHI in static text) | | ● | | ● | | | Static text cannot contain per-patient data (no params); privileged permission; audit of text changes |
| T12 | Forged provider callback | ● | ● | | | ● | | Per-account 256-bit path token + adapter signature check (UNVERIFIED mechanism per provider; adapter must implement it before go-live, T27/T28), dedupe, no backwards transitions, per-IP limit, raw body ≤ 256 KB |
| T13 | Release without payment | | ● | ● | | | ● | Only `BillingPort.getReleaseEligibility` decides; overrides by C4 with privileged permission and reason; release basis + override id stored; event + access log |
| T14 | Tampering with released reports | | ● | ● | | | | write-once storage path + sha256; DB triggers freeze content; amendments only as new versions; QR shows superseded |
| T15 | Signatory misuse (printing an approval that did not happen) | ● | | ● | | | | approvers from LabPort/narrative signatures; `nominated` mode requires nominees with approve/sign permission and prints the tenant disclaimer; narrative sign needs aal2 |
| T16 | Bulk exfiltration by staff | | | ● | ● | | | bulk download privileged + aal2 + cap 200 + access_log `report.bulk_download` + alert |
| T17 | Delivery to wrong recipient | | | | ● | | | contacts resolved at send time from C4/C3 by id (callers never pass phone numbers, except `phone_otp`); consent re-check; masked destination in logs |
| T18 | Renderer DoS (huge reports) | | | | | ● | | page limit 60, timeout 30 s, 20 MB bundle cap, queue backpressure |
| T19 | Callback / verify flood | | | | | ● | | nginx limits, app daily limit, fail-closed rate limiter on brute-force tiers (C0 §6.7) |
| T20 | Insider repudiation | | | ● | | | | access_log + audit_log on every release, print, download, sign, revoke |
| T21 | Portal dues payment (08 A11.1) | ● | ● | | ● | | ● | Amount tampering → no amount field (`additionalProperties: false`), C15 computes it; forged return (`?outcome=settled`) → ignored, status only from `getIntent`; gateway URL leakage → `action_json` only while `ready`, only to the same link's session, scrubbed on leaving `ready`, logger denylist; referrer/centre/partner link → no payment (404); double charge → one open request per order (unique index) + Idempotency-Key + C15 one open intent per order; portal never touches the ledger |
| T22 | App-link redemption brute force (`redeemPortalLinkForApp`) | ● | | | ● | | | 5 wrong phones per link → locked (`redeem_failures`, DEFINER-only write); identical `reporting.link_invalid`; token + phone both 32-byte hashes, bytea compare (08 A13 D-30) |
| T23 | Dues link (08 A21.1) | | | | ● | | ● | A dues link must never expose the report: dues sessions are excluded by claim `portal_link_purpose = 'report'` on `report_versions`/`qr_tokens` policies and P3/P4 return 404; message carries only lab name, amount and link; links revoked on release; cannot be redeemed in the app (`purpose = 'report'` in the redeem DEFINER) |

## 4. Abuse cases (each one is a test)

| # | Abuse | Expected result |
|---|---|---|
| A1 | Iterate 10,000 random QR tokens from one IP | 429 after 10/min; 100/day cap; never a 200; alert fires |
| A2 | Use a revoked QR token and an unknown token | byte-identical 404 bodies and headers |
| A3 | Request OTP 4 times in an hour for one link | 4th → 429 |
| A4 | Submit 6 OTP guesses | 6th refused; challenge exhausted; correct code afterwards fails |
| A5 | Use a portal session of report X to download version id of report Y (same tenant) | 404 |
| A6 | Tenant A staff opens tenant B report id / version PDF / delivery / input file | 404 |
| A7 | Centre-A user bulk-releases ids including centre-B versions | per-id `not_found` for B; A ids processed |
| A8 | NotificationPort call with param `test_names` or `patient_name` | `reporting.notification_params_invalid` |
| A9 | Narrative draft with `<img src=x onerror=alert(1)>`, `<iframe>`, `javascript:` link | stripped; render shows text only |
| A10 | Snapshot containing a patient name `<script>…</script>` | rendered as text |
| A11 | Template preview with a crafted config referencing `http://169.254.169.254/` | config rejected (no URL fields) and renderer guard blocks if reached |
| A12 | Outsourced upload: EICAR, polyglot PDF/HTML, encrypted PDF, 200-MB file, PDF with JavaScript action | quarantined / rejected; never reaches Chromium; size → 413 |
| A13 | Provider callback with a valid token but tampered signature | `400 reporting.callback_rejected`; no state change |
| A14 | Release with dues, no override | 409 `release_blocked_due`; no event |
| A15 | Staff without `reporting.report.bulk_download` or at aal1 calls R13 | 403 `auth.forbidden` / `auth.mfa_required` |
| A16 | Non-production environment configured with a real provider | boot fails |
| A17 | Link token placed in an API URL query by a buggy client | API spec has no such param → 400; nothing logged with the token |
| A18 | Expired-link reissue requested 10 times | always 202 identical; at most `link_reissue_max_per_day` messages sent |
| A19 | `redeemPortalLinkForApp` with 5 wrong phones, then the right one | 6th call `reporting.link_invalid`; `redeem_failures = 5`; no audit_log row for the counter. Run through the HTTP path (C16 `redeemReportLink` → `422`), each wrong phone's increment is still present after the request ends (`ctx.commitOnError()`, 08 A19 P-42) |
| A20 | `lims_app` session sets any C6 `app.pre_*` GUC (`app.pre_portal_token_sha256`, `app.pre_qr_token_sha256`, `app.pre_portal_credential_sha256`, `app.pre_callback_*` — 08 A21.4) itself and selects `portal_links`/`reports`/`deliveries` | 0 rows (policies are `TO lims_reporting_lookup` only) |
| A21 | OTP request on a link whose recipient has no phone on file | `202` identical to a sent code; challenge `failed`; P2 answers `auth.otp_invalid` |
| A22 | PP1 body `{gateway: "esewa", amount_paisa: 1}` | `400 common.validation_failed`; nothing queued |
| A23 | Return page opened with `?outcome=settled` for an unpaid intent | shows "Checking your payment…"; status changes only after `getIntent` says `settled` |
| A24 | Portal session of link X calls PP2 for a request of link Y | `404 common.not_found` |
| A26 | Dues-link session calls `GET /portal/report`, the PDF download, or selects `report_versions`/`qr_tokens` | `404` / 0 rows (08 A21.1) |
| A27 | `redeemPortalLinkForApp` with a dues link and the right phone | `reporting.link_invalid` |
| A25 | Portal actor tries to un-revoke its link or change `expires_at` | `P0001 immutable_row` (`tg_portal_links_guard`) |

## 5. Required security tests

1. **Cross-tenant probe for every operation** in `reporting.yaml` (02-CV §11.3 steps 1–4), including bulk endpoints with mixed ids, and token-based endpoints with tenant B tokens under tenant A sessions.
2. **Cross-centre probes** for all centre-scoped tables and endpoints (reports, versions, items, files, narratives, deliveries, prints, centre contacts).
3. **Table probes** for every `reporting` table: SELECT sees 0 rows of B; INSERT with B tenant fails; UPDATE/DELETE affect 0 rows.
4. **Portal scoping**: portal actor cannot select any row outside its `portal_report_id`/link; link-stage actor cannot read reports. Portal handlers never call BillingPort/PaymentProviderPort (08 R8).
4a. **Partner/patient scoping** (CR-C13-005, CR-C16-008): a partner actor sees only reports with `partner_id = app.current_partner_id()`, a patient actor only `patient_id ∈ app.engagement_patient_ids()`, both only released/superseded versions; neither matches any `__tenant`/`__tenant_centre` policy (`app.has_all_centres()` false, `app.is_staff_or_system()` false — 08 R3/R10); `openReleasedReportFile` for another partner/patient → `common.not_found` identical to unknown; `redeemPortalLinkForApp` with wrong phone / referrer link / expired link → identical `reporting.link_invalid`, link unchanged, 5-failure lock.
4b. **RenderPort**: user, portal, patient, partner and device actors → `auth.forbidden`; schema-invalid data never reaches the renderer; output is returned to the caller and never written to a C6 bucket.
5. **Lookup role**: with the function's `app.pre_*` GUC (08 A21.4) unset or wrong, `lims_reporting_lookup` sees zero rows; function inventory equals CR-C6-002 list plus D-30 with `bytea` signatures (08 §4.7: `reporting_verify_qr(bytea)`, `reporting_resolve_portal_credential(text, bytea)`, `reporting_ingest_provider_callback(text, bytea, jsonb)`; 08 A13 D-30: `reporting_redeem_link_for_app(bytea, bytea)`); a hash argument that is not 32 bytes returns no row; functions have `search_path = ''`. **A12.7 / D-30 FORCE-RLS contract test** for `app.reporting_redeem_link_for_app`: (a) expected row returned, (b) a `lims_app` session that sets the same GUC directly sees nothing, (c) the GUC is `''` after return (abuse cases A19, A20). 08 A21.4: the same three-part test runs for `reporting_verify_qr`, `reporting_resolve_portal_credential` and `reporting_ingest_provider_callback` (incl. its early `-1` return).
6. **Privilege escalation**: `lims_app` has no DELETE on C/A tables; immutability triggers reject content updates of released versions, signed narratives, qr tokens; `release_basis` cannot be supplied by the client (not in spec).
7. **Rate limits** exactly 04 §4 values (A1, A3, A4, download 21st request). D-32: two client IPs behind the portal server have separate `qr_verify` budgets; `X-Forwarded-For` without a valid portal BFF key is ignored (peer address used).
8. **OTP**: CSPRNG source = `@lims/shared-ts/crypto`; uniform distribution check on 100k samples (no modulo bias); HMAC constant-time compare. `otp_challenges.code_hmac` is `bytea` with `octet_length = 32` (08 Addendum A2.4); a 31- or 33-byte value is rejected. 08 A5.5: this is C6's only HMAC compared for authentication/redemption/phone matching; comparison is bytea = bytea (constant-time in `domain/otp.ts`), no `decode(…,'hex')` on HMACs.
8a. **Smart summary for non-staff (08 A2.3/A2.8)**: portal, partner and patient reads of smart-summary content come only from `report_versions.smart_summary_json` (P3) under the existing `report_versions` SELECT policies (4, 4a); a spy proves zero `SmartReportPort` calls from those request paths; the three snapshot columns are all-or-none and immutable after insert.
8b. **Staff e-mail for scheduled reports (08 A2.6, A4.2, A4.3)**: only purpose `scheduled_report_ready` resolves a staff e-mail, via `IdentityPort.getStaffNotificationContact({membershipId, requiredPermission})` called as the reporting system actor, with `requiredPermission` taken from the request (the permission the scheduled report requires); `eligible: false` or `email: null` → `suppressed_no_contact`; every other purpose with a `staff` recipient stays `suppressed_no_contact`; the e-mail body is link-only, `schedule_name` is `label_text` (≤ 80, no URLs, escaped) and is checked by the message PHI test (10).
8c. **`issuePortalLink` callers (08 A2.1)**: partner, portal and patient actors → `auth.forbidden` [CONV error]; C13 access slips succeed only from the C13 worker (partners system actor), and no partner HTTP response carries a token or URL.
8d. **Access-slip rendering (08 A5.1)**: RenderPort `partners.access_slip` accepts system actors only (C13 worker); `portalUrl` never appears in any log (planted-URL log scan) and C6 stores neither the URL nor the PDF.
8e. **Portal "Health summary" (08 A4.7)**: rendered only from `report_versions.smart_summary_json` of the session's version (8a); hidden when NULL; text escaped; no links in the section.
8f. **Portal dues payment (08 A11.1)**: abuse cases A22–A24; spy proves zero `BillingPort`/`PaymentProviderPort` calls from portal request paths; `action_url` absent from logs (planted-URL scan) and from the row once it leaves `ready`; `createIntent` called only from `reporting.create_portal_payment_intent` as the reporting system actor with `returnUrl = cancelUrl = <PORTAL>/r/payments/<id>/done`; referrer/centre/partner links cannot create requests.
8g. **OTP destination (08 A13 D-31)**: A21; P1 never returns a destination mask; the per-destination key `otp:p:<hex>` is consumed once per actual send.
8h. **Secrets not replayed (08 A13 P-8 E1)**: after `rotateChannelCallbackToken`, `core.idempotency_keys` holds no row containing the token; a replay without `If-Match` → `428 common.precondition_required`, a stale one → `409 common.version_conflict`.
8i. **`staff_url` (08 A13 D-29)**: only purpose `scheduled_report_ready` to a `staff` recipient accepts it; any other origin, a non-route path or a query string → `reporting.notification_params_invalid`.
9. **PHI log scan** with planted name/phone/token/OTP/URL in all C6 code paths (03-APP-FLOW sequences) — zero hits.
10. **Message PHI tests**: every seeded template rendered with fixture params contains no field from the PHI list (02-CV §9.2).
11. **Renderer**: SSRF canaries, JS disabled, blocked-request metric; container egress test (connect to an external IP fails).
12. **Sandbox**: malformed corpus; no-network container test; timeout kill.
13. **Headers** on portal pages and file downloads (CSP, HSTS, nosniff, Referrer-Policy, Content-Disposition, Cache-Control).
14. **Identical responses** for `link_invalid`, `verify_not_found`, `callback_rejected` across all invalid cases (byte compare).

## 6. PHI handling and logging rules

- Never log, emit in metrics/events, or put in error details: patient names, phones, emails, registration numbers, barcodes, test/panel names linked to an order, results, report content, tokens, link URLs, OTPs, message bodies, provider callback bodies (02-CV §9.2). Log `report_id`, `version_no`, `delivery_id`, `link_id`, error codes.
- Events carry ids/codes only (`reporting.report.released.v1` P1, `delivery.status_changed.v1` P1).
- Delivery rows: destination masked + hash; full destination only for `phone_otp` and only until terminal; secret params scrubbed ≤ 1 h after terminal.
- The renderer and sandbox log job ids and durations only; PDF bytes and HTML are never logged or written outside tmpfs.
- Template previews use synthetic data only (`preview-sample.ts`); real patient data is never used to preview.
- Real client report PDFs are never used as fixtures or test inputs (00 §7.5).

## 7. Secrets used

| Secret | Holder | Notes |
|---|---|---|
| `LIMS_REPORTING_OTP_HMAC_KEY_FILE` | API + worker | rotation invalidates open challenges only |
| `LIMS_REPORTING_RENDERER_TOKEN_FILE`, `_SANDBOX_TOKEN_FILE` (worker, client); `LIMS_RENDERER_TOKEN_FILE`, `LIMS_RENDER_SANDBOX_TOKEN_FILE` (renderer / pdf-sandbox, server — 08 A27.3) | worker (client) + renderer/sandbox (server) | internal auth, constant-time compare; renderer `/internal/metrics` is read by the worker with the same token and re-exported (A27.3) |
| Channel account secrets (`secret_ref`) | worker only | WhatsApp/SMS credentials, SMTP relay credentials; never in DB/API |
| Storage server credentials | via C0 `ctx.storage` | not held by C6 code directly |
| Callback tokens | DB holds SHA-256 only (32-byte `bytea`, 08 R24); plaintext shown once to the admin and never stored for idempotent replay (`x-idempotency: none`, 08 A13 P-8 E1) | rotate via `rotateChannelCallbackToken` |
| Portal BFF key (kind `portal`) | `apps/portal` (sender) + API core (verifier) | lets the core trust the forwarded `X-Forwarded-For` (08 A13 D-32); secret store (C1) |
| Gateway action URLs (portal payment) | `portal_payment_requests.action_json` only while `ready` | credential-like; scrubbed on leaving `ready`; never logged (08 A11.1) |

No Supabase `service_role` key is used by C6 (02-CV §10.2 default).
