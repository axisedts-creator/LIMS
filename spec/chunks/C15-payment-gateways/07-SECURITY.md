# C15 — Payment Gateways — 07 Security

Status: DECISION draft, 2026-11-06. REQ-SEC §2 (payments) applies from Phase 1.5–2; §1, §3, §4, §6, §7 apply as for every chunk (04 §12 rule). IDs are cited, not copied (02-CV §10).

## 1. Applicable requirements

| REQ | How C15 applies it | Where / test |
|---|---|---|
| REQ-SEC-046 | amount = `BillingPort.getOrderBalance.balanceDue`; port and HTTP have no amount input for payments | TRD §6.1; ST-01 |
| REQ-SEC-047 | settle only on eSewa status `COMPLETE` / Khalti lookup `Completed`; redirect/callback values never change state | TRD §6.2–§6.3; ST-02 |
| REQ-SEC-048 | exact paisa match (no floats); mismatch → `held_for_review` + page alert | TRD §7.2.4/§7.3.4; ST-03 |
| REQ-SEC-049 | eSewa callback HMAC recomputed constant-time; `signed_field_names` must include the three fields; identity fields compared | TRD §7.2.2; ST-04 |
| REQ-SEC-050 | idempotency key per checkout, unique `(tenant_id, idempotency_key)`; port-key grammar `^[A-Za-z0-9_.:-]{1,200}$` (08 A19 P-40); replay returns same intent | TRD §6.1; ST-05 |
| REQ-SEC-051 | conditional UPDATE + `FOR UPDATE`; ledger/event only on transition; BillingPort idempotent | TRD §3.2, §6.2; ST-06 |
| REQ-SEC-052 | pull model (callbacks authenticated by per-intent token, then verified by gateway lookup); stale/mismatch/rate-limited recorded; redacted append-only `payments.callbacks` (deviation from "raw payloads" recorded as DECISION, §2 item 6) | TRD §6.3; CR-C15-004/008; ST-07 |
| REQ-SEC-053 | partial unique index on open statuses + row lock on settle | 05-SCHEMA §4; ST-08 |
| REQ-SEC-054 | daily per-tenant reconciliation, findings, alerts | TRD §6.7; ST-09 |
| REQ-SEC-055 | refunds privileged (aal2), two-person above threshold (default always), amount ≤ captured and ≤ refundable, idempotent, audited | TRD §6.6; ST-10 |
| REQ-SEC-056 | no card/wallet credentials; only gateway refs; Khalti `mobile` dropped; redaction allowlists | TRD §7.6; 05 `callbacks__no_mobile__ck`; ST-11 |
| REQ-SEC-057 | ledger stays C4's append-only table; C15's own logs are append-only (no UPDATE/DELETE grants) | 05-SCHEMA §3; ST-12 |
| REQ-SEC-058 | per-tenant secrets AES-256-GCM under SOPS-managed KEK, write-only UI, rotation (RB-6/RB-7), UAT keys refused in production (deviation from "in the secrets manager" recorded as DECISION, §2 item 5) | TRD §6.9; ST-13 |
| REQ-SEC-059 | consumers (C4, C6 portal worker, C16) show "Paid" only from server state (`getIntent`/balance) | 03-APP-FLOW §2.4, §2.5; consumer guide |
| REQ-SEC-128 | KEK from secret store; no secret in repo/env literals; gitleaks | TRD §9 |
| REQ-SEC-136 | environment guard (URLs, `EPAYTEST`, env column); non-prod has only UAT/sandbox keys | TRD §9.3; ST-14 |
| REQ-SEC-013/067 | tenant only from verified JWT or the token resolver; never from path/body | CR-C15-004; ST-15 |
| REQ-SEC-011–016, 023, 026, 031 | FORCE RLS on every table, `TO lims_app`, staff-actor guard `is_staff_or_system()` in every `__tenant` policy (08 A17 P-16), tenant-leading indexes (one justified exception with its tenant-leading companion), composite FKs | 05-SCHEMA §3–§4; ST-20 |
| REQ-SEC-019/020 | one DEFINER lookup, `search_path=''`, inventoried, owner policy bound only to the pre-tenant GUC `app.pre_payments_callback_token_sha256` (08 A12.1, A19 P-41) | 05-SCHEMA §3, §6; ST-21 |
| REQ-SEC-040/044 | probes for every operation and table | §4 |
| REQ-SEC-062 / 04 A4 | privileged codes (resolve, refund, merchant config) require aal2 | CR-C15-005 |
| REQ-SEC-078/079 | public routes `x-rate-limit-tier: general` with the documented callback/launch variant: 10 r/s burst 20 per IP at nginx + app key per intent (08 A19 D-116) | CR-C15-008; TRD §5.2, §6.3 |
| REQ-SEC-080/081 | strict schemas, `additionalProperties: false`; DTO allowlists, secrets never mapped | TRD §5 |
| REQ-SEC-089/090 | public pages: CSP `default-src 'none'`, no JS, nosniff, no-referrer, no-store, HSTS | TRD §7.2.3, §7.5 |
| REQ-SEC-095/098 | errors generic; no tokens/secrets/PII in logs, URLs logged masked | TRD §7.6; CR-C15-008 |
| REQ-SEC-096/097 | view/print/download-type events → `access_log`; modifications → row audit (08 A19 D-112). `access_log` with registered codes only: P4 and P16 → `payment_intent.resolve` (`payment_intent` / `reconciliation_finding`); P21 and P23 → `settings.change` (`payment_merchant_account` / `payment_settings`; field names only, never the secret). Refund request/approve/reject/confirm/fail, static-QR worksheets and P22 credential tests → `app.tg_row_audit` only (secret columns excluded, CR-C15-013) | TRD §5.1 table, §6.5, §6.6, §6.9; 05-SCHEMA §1 |
| REQ-SEC-099 | public operations enumerated with `x-public`/scheme justification (P30–P34) | TRD §5.2 |
| REQ-SEC-101 | gateway responses treated as untrusted: TLS verified, timeouts, strict parsing, size caps | TRD §3.2, §7 |
| REQ-SEC-133 | alerts per TRD §11 | C1 |
| REQ-SEC-141 | payment gateways (Nepali providers, 04 §11): only order ref (intent id), amount, product label; no PHI | TRD §7.2.3, §7.3.2 |

## 2. Design decisions the security reviewer must sign off

1. `payments.intents`/`refunds` are tenant-scoped (not centre-scoped) in RLS; centre authorisation is in the API (05-SCHEMA §3).
2. One non-tenant-leading unique index (`callback_token_sha256`) for pre-context credential lookup (CR-C15-004).
3. Network calls inside an open DB transaction (no row lock held during the call) (TRD §3.2).
4. Manual refunds rely on finance's reference + gateway status for confirmation; gateways do not report partial-refund amounts (TRD §6.6 step 7).
5. **DECISION against REQ-SEC-058** (accepted by the lead, 08 A19 D-118): gateway secrets are stored as AES-256-GCM ciphertext in `payments.merchant_accounts` under a KEK held in the C1 secret store (SOPS); the KEK never enters the DB. Rationale: per-tenant secrets are tenant data edited by tenant admins at run time, and the secret store holds the one key that protects them (envelope encryption).
6. **DECISION against REQ-SEC-052** (accepted by the lead, 08 A19 D-118): callback and gateway payloads are stored **redacted** (allowlisted keys; Khalti `mobile` dropped per REQ-SEC-056) in append-only tables, not raw. Rationale: raw storage would retain PII.
7. Refund and configuration modifications are evidenced by row audit, not access log (08 A19 D-112); no new access-log codes exist for C15.

## 3. Threat model (STRIDE per asset / entry point)

| Asset / entry | S | T | R | I | D | E |
|---|---|---|---|---|---|---|
| Public callbacks P31–P33 | forged "success" redirect → ignored; only lookup decides | tampered `data`/query → signature check + lookup | callbacks logged append-only | token reveals nothing; responses identical for invalid tokens | flood → nginx limit + per-intent throttle; gateway calls capped | token grants only verification of one intent |
| Launch page P30 | phishing look-alike (out of our control) | form fields signed; amount bound in signature | — | shows amount + lab name only; no-referrer stops token leak to eSewa | rate limit | — |
| `PaymentProviderPort` | caller impersonation impossible (in-process, ctx from core) | caller-supplied amount not accepted | intent transitions logged | P1 only | gateway slowness → timeouts | caller must authorise actor for order (documented); callers staff/system only — patient/portal contexts never call the port (08 R8); the web portal pays only through the C6 worker as reporting system actor (08 A11.1) |
| Portal dues payment (C6 → C15) | portal actor calls the port directly → `auth.forbidden` | return URL fixed to `portal.payment_done` under the allowlisted portal origin | C6 request row + C15 transitions | portal page shows only server state | — | portal actor never reaches BillingPort/PaymentProviderPort (08 R8) |
| Gateway responses | DNS/TLS spoof → TLS verify, fixed hosts, egress allowlist | malformed / float amounts → strict decimal parse, unknown → hold | gateway_calls log | stored redacted | gateway outage → retry, no state change | — |
| Merchant secrets | — | ciphertext swap between rows → AAD binds row | config changes audited | write-only; never logged; KEK outside DB | — | only `payments.merchant_config.manage` at aal2 |
| Refund workflow | approver impersonation → aal2 + membership revalidation | amount inflation → bounds re-checked at approve | two actors recorded | — | — | self-approval blocked; front desk lacks permission |
| Held-queue resolve | — | "settle" without proof → forced gateway check | resolve note + access log | — | — | privileged |
| Reconciliation | — | silent ledger edits → never (findings only; idempotent re-call) | run + findings rows | — | job failure → alert 26 h | runs as system actor, tenant-bound |

## 4. Abuse cases

| ID | Abuse | Control | Test |
|---|---|---|---|
| AB-1 | Patient edits return URL `outcome=settled` | server state only | ST-02 |
| AB-2 | Attacker replays an old valid eSewa success payload for a new intent | `transaction_uuid` must equal the intent; status check on the new intent | ST-04 |
| AB-3 | Pay NPR 10 for NPR 2,250 order via edited form amount | signature covers `total_amount`; status check with our amount; returned amount compared | ST-03 |
| AB-4 | Two counters start payments for the same order; both QR scanned | one open intent; second → `intent_open_exists` | ST-08 |
| AB-5 | Insider marks a held payment "paid" | settle needs gateway success + exact amount | ST-16 |
| AB-6 | Insider refunds to self | two-person, aal2, bounds, gateway confirmation, audit | ST-10 |
| AB-7 | Insider confirms a partial manual refund larger than performed | approved amount is the recorded amount (second approver), reference stored, reconciliation finding if gateway status inconsistent; residual risk documented | ST-10 |
| AB-8 | Tenant admin of lab A configures lab B's secret / reads it | RLS tenant; write-only | ST-13, ST-15 |
| AB-9 | Enumerating callback tokens | 256-bit tokens, identical responses, rate limits | ST-07 |
| AB-10 | Using UAT keys in production to fake payments | env guard + boot checks | ST-14 |
| AB-11 | Open redirect through returnUrl | allowlist exact origin + prefix | ST-17 |

## 5. Required security tests

| ID | Test |
|---|---|
| ST-01 | request bodies containing `amount`/`amount_paisa` to any payment-creating path → 400 `common.validation_failed`; intent amount = due |
| ST-02 | forged callback (any query) with gateway sim returning `PENDING` → intent not settled; no ledger spy call |
| ST-03 | sim returns `COMPLETE`/`Completed` with off-by-one paisa and `22.5` vs `2250` → `held_for_review amount_mismatch`, alert counter +1 |
| ST-04 | callback signature: altered field, missing name, reordered names, truncated signature, other intent's uuid → `signature_valid=false` |
| ST-05 | 50 parallel `createIntent` same key → 1 row; same key different order → `common.idempotency_key_reused` |
| ST-06 | 10 concurrent callbacks + polls on a paying intent → 1 transition, 1 ledger call `duplicate:false`, 1 event |
| ST-07 | invalid/expired/other-tenant tokens → identical `303 …outcome=unknown`; no DB row of the other tenant touched |
| ST-08 | concurrent creates with different keys → exactly one open intent |
| ST-09 | injected discrepancies (each finding kind) detected by one run |
| ST-10 | refund: front_desk → 403; aal1 → `auth.mfa_required`; self-approve → `payments.refund_self_approval_forbidden`; over captured/refundable → error; replay → same refund |
| ST-11 | Khalti callback with `mobile` → stored row has no `mobile`; log scan finds no phone pattern |
| ST-12 | `has_table_privilege('lims_app', t, 'DELETE') = false` for all payments tables; UPDATE on append-only tables denied |
| ST-13 | secret never in any HTTP response, log line, metric, audit row (planted-secret scan); AAD swap → decrypt fails |
| ST-14 | production config with `dev.khalti.com`/`uat.esewa.com.np`/`EPAYTEST` → boot or save rejected |
| ST-15 | cross-tenant probe for every operation P1–P34 and every table (02-CV §11.3) |
| ST-16 | resolve `settle` with sim returning anything but success+exact → `payments.intent_not_verifiable` |
| ST-17 | returnUrl variants (other host, userinfo, `http:`, path outside prefix, encoded tricks) → `payments.return_url_not_allowed` |
| ST-18 | centre-scoped finance user cannot read/resolve an intent of another centre (API check) → 404 |
| ST-19 | public pages: CSP, no-store, no-referrer, nosniff headers present; no script tags; P34 with `intent_id` → `200` and the id is not in the body |
| ST-20 | staff-actor guard (08 A17 P-16): partner, portal and patient claims of the same tenant read 0 rows of every `payments.*` table and cannot insert; C0-0B `check-registry` passes |
| ST-21 | callback DEFINER (08 A12.7): returns the live token's intent only; a `lims_api` session that sets `app.pre_payments_callback_token_sha256` itself sees 0 rows; the GUC is `''` after the call; tokens > 30 days → nothing |
| ST-22 | permission floors (08 A19 P-43): `front_desk` → P5 and P24b allowed, P24 → 403; P7b requires `payments.intent.resolve`, P11b `payments.refund.approve` at aal2 |
| ST-23 | portal/patient actor context calling any `PaymentProviderPort` method → `auth.forbidden` (C6 and C16 worker fakes succeed as system actors) |
| ST-24 | access-log rows: P4/P16 write `payment_intent.resolve`, P21/P23 write `settings.change` whose detail holds field names only (planted secret absent); refund operations write row-audit rows and no access-log row |

## 6. PHI and logging rules

No P2/P3 data enters C15 tables, gateway requests or logs. Allowed in logs: intent/refund/order ids, gateway, status strings, error codes, durations, amounts **only** in `payments.*` tables (not general logs — 02-CV §9.2 financial row). Never: callback tokens, return URLs, `payment_url`, signatures, secrets, `mobile`, Base64 payloads.

## 7. Secrets used

| Secret | Holder | Storage | Rotation |
|---|---|---|---|
| eSewa merchant secret key (per tenant, per env) | `credentials.ts` | `payments.merchant_accounts` ciphertext | RB-6 on staff departure / suspicion (REQ-SEC-058) |
| Khalti secret key (per tenant, per env) | same | same | RB-6 |
| KEK (per environment) | API + worker | SOPS-managed file (C1, CR-C15-008) | RB-7 with `payments.rewrap_credentials` |
| Callback tokens | intents | SHA-256 only | per intent; 30-day acceptance window |
