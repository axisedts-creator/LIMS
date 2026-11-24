# Patient app: hand-off to the coding agent (Antigravity)

Written 2026-11-23 by the deploy orchestrator (Claude Code) for the operator. Synthetic data only. This file contains NO secret value; if you ever need one, ask the operator, never invent, print or commit one.

## 0. UPDATE 2026-11-23 evening: patient sign-in now WORKS on the server (host-only build)

The operator approved the migration, a new signing keypair and a demo shortcut, and the orchestrator applied them. State now:
- Server api is **r11** = the running r9 source + commits `324e2cd3f` and `ded0ec00a` (patient writers, EdDSA/Ed25519 patient access JWT signer + verifier, three DEFINER functions) + a **host-only demo shortcut**. The draft's own resolver wiring (commit `a9e6c408c`, `fda7b874e`) was deliberately NOT used: it is weaker than the host's (no pre-DB cap on the credential, not a READ ONLY transaction): see section 3.1 of the review in `NIGHT45-REPORT.md` on the server; the owners should add the cap and a pre-DB regex check before merging upstream.
- Database: migration `20261117000000_identity__patient_provision_and_session_definers.sql` is applied (Atlas non-linear, revision count 67): functions `app.identity_patient_create_membership(uuid)`, `app.identity_patient_open_session(jsonb)`, `app.identity_patient_membership(uuid)` (owner lims_owner, SECURITY DEFINER, `search_path` empty, EXECUTE only for `lims_owner` and `lims_api`) and three INSERT policies.
- New secrets: Ed25519 keypair (side file `prod.patient.enc.yaml`), mounted read-only into api-a/api-b as `LIMS_IDENTITY_PATIENT_JWT_KEY_FILE` (private), `LIMS_CORE_PATIENT_JWT_PUBLIC_KEY_FILE` (public), kid `LIMS_IDENTITY_PATIENT_JWT_KID=pat-2026-11`.
- Demo shortcut: tenant `demo_lab4`, phone `+9779800000099` only; the fixed 6-digit code is NOT in this file (the operator reads it from `NIGHT46-REPORT.md` on the server, section "Demo test code"). Everything else (rate limits, app_enabled, prefix, 5-attempt limit) is unchanged. **Remove before real patients.**
- Verified live (no real data): config 200 -> request code 202 -> verify 200 (session + access token) -> `GET /v1/engagement/me` 200 -> `GET /v1/engagement/me/profiles` 200 -> wrong code 401 `auth.otp_invalid`.
- Your remaining server-side work is therefore: get the same behaviour into the repo properly (clean branch from `origin/main`, owner review, the security findings above, the real-database integration test, edge exposure marks, a supported test OTP mode), then replace the host-only build. Your app work can start now against `https://api.metrolmis.com:8443` with tenant `demo_lab4` and the test phone.

## 1. Summary (read this first)

- A production-style LIMS stack runs on the office server and is PUBLIC with real Let's Encrypt certificates:
  - staff web: `https://app.metrolmis.com:8443/auth/login`
  - patient portal: `https://portal.metrolmis.com:8443/`
  - **api origin for the mobile apps: `https://api.metrolmis.com:8443`**
  - The HTTPS port is 8443 because the office router sends public port 443 to another device that must not be touched. HTTP (80) only redirects to the 8443 address. Put `:8443` in every URL.
- Demo tenant for the app: tenant code **`demo_lab4`** ("Demo Lab (dev)"), synthetic data only. The tenant setting `app_enabled` is now **true**; `GET /v1/engagement/app/config` answers 200 with `features.app = true`, bookings and home collection true, payments / membership / enquiries / smart report false, allowed phone prefix `+977`.
- What the server runs today: api **r9** (main at an older base plus host-only patches), web r9 (new UI), worker r5, portal r2. These come from a deploy copy on the server, NOT from `origin/main` as it is now.
- **The patient app cannot sign in on this server yet.** First call works; the sign-in does not complete. Reasons, all verified live:
  1. The api only has the `patientPreAuth` resolver wired by a **host-only patch** (CR-C1-DEPLOY-013 item 0); main still has it unwired.
  2. After a correct code, `POST /v1/engagement/auth/otp-challenges/verify` answers **500 `common.internal`**: main has no patient account/session writers and no patient access-token signer (CR-013 item 0b; `identity/index.ts` says "not wired").
  3. No sign-in code can be delivered: SMS is off for `demo_lab4`, the branch's built-in test OTP code is refused when `LIMS_CORE_ENV=production` (the server runs as production), and the demo shortcut used earlier was removed on purpose.
- The fix already exists in draft on branch `feat/mhn-v1.1-approved-slices` (four commits: `a9e6c408c`, `fda7b874e`, `ded0ec00a`, `324e2cd3f`: resolver in core, patient writers + EdDSA/Ed25519 patient JWT + verifier, DB DEFINER functions migration `20261117000000_identity__patient_provision_and_session_definers.sql`, membership fix, test OTP code). It is unreviewed by the owners. It needs on the server: **a database migration**, **a new Ed25519 keypair (new secrets)**, and **an OTP delivery decision**. The operator chose the **demo shortcut** for OTP (see 4.3).
- Your job: take the patient app from the repo to a working, tested sign-in and the main journeys on `demo_lab4`, owning the code (repo, tests, contracts, app) end to end, and giving the operator exact, small server run-sheets for the steps only the server owner can do (section 5).

## 2. What is already done on the server (do not redo)

- Public edge (nginx container `lims-edge` on the VM `lims`, address 192.168.1.73): real certificates, redirects keep `:8443`, no HSTS on the new names, default-deny on the api origin: only routes in `infra/edge/public-routes.yaml` are proxied. **Host-only interim entries** exist for the app: `GET /v1/engagement/app/config` (exact), `POST /v1/engagement/auth/otp-challenges*` (prefix), `GET|PATCH /v1/engagement/me` (exact), `/v1/engagement/me/*` (prefix, GET POST PUT PATCH). They are the stop-gap for CR-013 items 1-3; the real fix is contract marks + `gen-routes.sh` TABLE entries.
- Rate limiting at the edge (per IP zones) and **fail2ban** at the VM firewall (jails: staff login POST flood, api abuse on the OTP/mobile-session routes; documentation/office/private addresses are never banned). Mobile carriers share NAT addresses: expect the otp zone (60 r/m per IP) to be tight for many users; CR-013 item 3.
- App-side TLS: the api origin has a publicly trusted certificate, so the app does NOT need the internal CA or the `DEV_HOST_OVERRIDE` workaround any more. The phlebo app pins certificates (separate decision).
- Monitoring probes the new names; storage and payments base URL were switched to the new origins.
- Verification probes you can run from anywhere (no login):
  - `curl -s -H "X-Lims-App-Version: 0.1.0" -H "X-Lims-App-Platform: android" -H "X-Lims-Patient-PreAuth: t.demo_lab4" https://api.metrolmis.com:8443/v1/engagement/app/config` -> 200, `features.app` true.
  - same with `t.nosuchtenant`, or without the pre-auth header -> 401. Without the two `X-Lims-App-*` headers -> 400.
  - `POST /v1/engagement/auth/otp-challenges` with body `{}` -> 400 (never send a valid body from scripts you do not control: it creates a challenge row and queues an SMS job).
- Open items already written as change requests in `.orchestra/cr/`: `DEPLOY-AXIS-011..014.nonblocking.md` (013 = mobile app, 014 = report QR verify 500 and ops probe addresses).

## 3. The repo state you should build on

- `origin/main` tip is `0e7428bc3` (the UI commit). `feat/mhn-v1.1-approved-slices` contains main plus ~29 commits of patient-app flows ("through T23") and the four sign-in commits above, plus "Deploy snapshot" commits.
- **Do not deploy or merge that whole branch to the server in one step.** The server runs an older, patched base; a big merge brings unrelated changes and migrations. Produce a **clean branch from `origin/main`** that contains only what the sign-in and the app need, with tests, and open it for owner review. Keep commits small and named by the CR item they close.
- Closing the loop in the repo (this removes every host-only patch on the server):
  1. CR-013 item 0 / 0b: resolver wiring + patient writers + patient token signer/verifier (start from the four commits; review them as if written by someone else; this is **authentication code**, security review required; verify every failure path fails closed, token claims, audience/issuer, kid rotation, expiry, no secret in logs/errors).
  2. CR-013 items 1-3, 5: `x-edge-exposure: public` on exactly the patient-app operations, `gen-routes.sh` TABLE entries (use exact match for `/v1/engagement/app/config`: the prefix `/v1/engagement/app` would also match the staff path `/v1/engagement/app-links/...`), regenerate `infra/edge/public-routes.yaml`, edge zones, and a CI check that every path the two mobile apps call is either allowlisted or internal.
  3. CR-013 item 4: a **supported test sign-in mode** that cannot run in production (the branch has `LIMS_ENGAGEMENT_OTP_TEST_CODE`, refused when `LIMS_CORE_ENV=production`; decide with the owners how a demo deployment is meant to run, for example a non-production environment value with its own boot rules, since the payments gateway rule ties `LIMS_PAYMENTS_GATEWAY_ENV` to the core env).
  4. An integration test that boots the real app and runs requestPatientOtp -> verifyPatientOtp -> getMyAccount against a real database (the unit tests passed while the live flow returned 500 because they fake the port).
- Also useful: CR-014 (report QR verification answers 500 with zero DB calls: likely a missing key/config).

## 4. The app side (your main ownership)

4.1 Connect to the public server (no code changes needed for the address):
```
flutter run -t lib/main_dev.dart --dart-define=API_BASE_URL=https://api.metrolmis.com:8443 --dart-define=PORTAL_ORIGIN=https://portal.metrolmis.com:8443 --dart-define=TENANT_CODE=demo_lab4
```
(add `--flavor dev` if the project defines flavors). Remove or leave disabled the `DEV_HOST_OVERRIDE` / internal CA code paths for this target; public certificates validate normally on Android. The app sends `X-Lims-App-Version`, `X-Lims-App-Platform` and the pre-auth header `X-Lims-Patient-PreAuth: t.<tenant_code>` (E1/E2) and `c.<tenant_code>.<challenge_token>` (E3). Without the app headers the api answers 400.

4.2 Sign-in flow to make work: app config -> request OTP (`phone_e164`, `app_instance_id` uuid, `app_platform`) -> verify (`code`) -> access token + session token -> `GET /v1/engagement/me` and the `/me/*` journeys (profiles, orders, reports and downloads, bookings, slots, addresses, payment requests, notifications, memberships, enquiries, coded sets). Test them against `demo_lab4` once the server steps in section 5 are done. Features that are off for the tenant (`payments`, `membership`, `enquiries`, `smart_report`) must show the disabled state, not an error screen. The generic "We can't reach <lab> right now" screen appears when the first config call fails: make it show the HTTP status class in debug builds so the cause is visible.

4.3 The agreed way to get a sign-in code on this server (operator decision, 2026-11-23): a **demo-only, host-only shortcut** for ONE synthetic phone number on `demo_lab4` only, to be removed before any real patient uses the app. It was built once (api r10) as: in `requestOtp`, when tenant id and phone both match constants, use a fixed 6-digit code and do not enqueue the SMS job; every other gate (app_enabled, prefix, rate limits, 5-attempt limit) and `verifyOtp` unchanged. It was rolled back after the discovery that sign-in cannot complete without 0b. The phone used was a synthetic number (+977 98000000 99); the code is NOT in this file: ask the operator to generate a fresh random one when the server step is done. Do not put the shortcut in the repo (host-only patch, never merged).

4.4 Tests: unit + widget tests, an integration test against the dev server, and a manual device checklist. Never use real patient data; phone numbers in tests are synthetic.

## 5. Server steps only the operator/orchestrator can run (give small, exact run-sheets)

The server is operated by unattended agents that Claude Code launches over ssh; you normally do not have server access. For each step below produce a precise request (files to copy, commands, expected results, rollback) and hand it to the operator. Nothing here is pre-approved; **each needs the operator's explicit yes**:
1. **Database migration** `..._identity__patient_provision_and_session_definers.sql` (and its DEFINER inventory entry): applied through the normal migration job; check timestamp ordering (it is older than migrations already applied) and the grants (the runtime role `lims_api`/`lims_app` must get EXECUTE only on what the code needs; write DEFINER functions with a fixed search_path).
2. **New Ed25519 keypair for patient tokens** (new secrets): private key file for the signer, public key file for the verifier (`LIMS_CORE_PATIENT_JWT_PUBLIC_KEY_FILE`, and the signer's own setting: check `services/api/src/modules/identity` and `core/config.ts`); stored encrypted like the other runtime secrets, mounted read-only into the api containers, never printed; key id `pat-YYYY-MM` rotation plan. The operator's earlier answer on this was unclear: ask him before preparing it.
3. **Build and roll a new api image** (candidate from the reviewed branch, tests green) with rolling restart of the two api replicas, rollback ready; environment variables only as names, never values.
4. **The demo shortcut** (section 4.3) as a separate host-only patch on top, removed later.
5. Later: a real SMS provider (credentials entered by the operator himself), then remove the shortcut.

## 6. Rules (do not break)

- Synthetic data only; no real patient names, phone numbers or reports. No secrets in files, prompts, logs, commits or chat: the operator enters secrets himself.
- Traffic and data stay in Nepal: no CDN or proxy in front of the public site.
- Never touch the router, the other device on public port 443, DNS/Cloudflare settings, the firewall rules, or the platform-admin access restriction (platform administrator stays reachable only from the WireGuard/loopback network).
- Do not change tenant settings other than through the owner-approved path; the only tenant setting changed so far is `app_enabled` for `demo_lab4`.
- No force-push, no direct push to `main` unless the operator says so; small reviewed commits; CR files go in `.orchestra/cr/` with the CR template.
- Authentication code: fail closed, test every denial path, log request ids and error classes only.

## 7. Definition of done

1. A clean branch from `origin/main` with the sign-in fix, edge exposure marks, tests (including the real-database integration test) and the CI check for app-versus-edge paths, ready for owner review.
2. On `demo_lab4`, from a real Android device or emulator over mobile data: config -> request code -> verify -> signed in -> `/me` -> at least profiles, orders and a report download work; wrong code gives a clear message; the app survives restart (session resolve).
3. Run-sheets for section 5 delivered, executed by the operator, and verified with the probes in section 2 plus the app flow.
4. The host-only patches (resolver wiring, demo shortcut, interim edge entries) are listed for removal once the repo release is deployed.
5. A short final report: what changed, what was verified, what was not, known risks.

## 8. Contacts and artifacts

- Change requests: `.orchestra/cr/DEPLOY-AXIS-011..014.nonblocking.md` (013 and 014 are the relevant ones). Server run notes: the orchestrator keeps reports under `/home/metrolmis/lims-deploy/NIGHT*-REPORT.md` on the server (not in the repo).
- The operator pushes to GitHub himself; the orchestrator confirms what landed on `origin/main`.
