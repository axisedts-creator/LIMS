# C13 — B2B Partner Portal — 06 Implementation Plan

Status: DECISION draft, 2026-11-06. One task ≈ one PR (02-CV §12). Branch `c13/<kebab-topic>`. Every task's tests must pass and its mapped acceptance criteria (01-PRD) must be demonstrated (05-DoD §2). Fakes from `packages/fakes` until the owner merges (02-CV §8.2); production boot fails if a fake is registered.

## 1. Prerequisites (owned by others; C13 starts against fakes/mocks)

| Need | Provided by | Until then |
|---|---|---|
| `partners` DDL + RLS + `app.current_partner_id()` and `partners.redact_lines` with their owner policies (05-SCHEMA §8; CR-C13-004; 08 A10.5, A19 P-41) | C0-0B | local migration branch of the spec in the compose stack (never committed by C13) — integration tests wait for C0 |
| `contracts/openapi/partners.yaml` (02-TRD §5) + generated clients + Prism mock | C0-0C | Prism on a draft spec in the C13 PR description; CR-C13-002/008/009 |
| Permission codes/partner roles (CR-C13-002), routes (CR-C13-008), error codes (CR-C13-009), access actions (CR-C13-012) | C0-0C/0B | fakes accept the codes |
| Partner sessions/login/provisioning (CR-C13-003); `updatePartnerMembership.expectedVersion` optional (08 A19 D-100); `identity.self.manage` in the partner fixed sets (D-101) | C2 (+ C0-0C) | `IdentityPort` fake with partner actors (both roles, aal1/aal2) + MSW mocks of `/v1/identity/auth/partner/*` and `/v1/identity/auth/*` (partner BFF key, 08 R10) |
| `FrontdeskPort.createOrderFromBooking` + `partnerId` (CR-C4-006/CR-C13-010) | C4 | `FrontdeskPort` fake (03 §4.3 behaviours + `failNext`) |
| `ReportingPort` (+ `openReleasedReportFile`, CR-C13-005) | C6 | `ReportingPort` fake (synthetic PDF) |
| `CatalogPort` consumer listing (CR-C13-007), `getReferrer`/`getCreditParty` (CR-C3-001) | C3 | `CatalogPort` fake |
| Events `lab.specimen.status_changed.v1`, `reporting.report.released.v1` (+ CR-C13-006) | C5, C6, C4, C3 | event fixtures from 03 examples |
| `lab.v_pub_specimen_timeline.replaces_specimen_id` (08 A19 D-106, CR-C16-022) | C5 | reconcile keeps the event-delivered value |
| Partner BFF key secret `LIMS_PARTNER_BFF_KEY_FILE` (08 A19 P-45) | C1 (secret store), C0 (`LIMS_CORE_BFF_KEY_FILES`) | compose dev secret file |
| `RenderPort` template `partners.access_slip` (08 A5.1, CR-C13-014; QR drawn by C6) | C6 | `RenderPort` fake (synthetic PDF, records `templateKey` + `data`); feature flag off until C6 ships the template |
| Partner origin + nginx site (`partner_enabled`) | C1 | compose dev service |

## 2. Tasks

| ID | Goal | Files / paths | Depends on | Done when | Tests | Maps to |
|---|---|---|---|---|---|---|
| T01 | Module scaffold (API + worker + partner app + staff feature) | `services/api/src/modules/partners/{index,permissions,config}.ts`, `services/worker/src/jobs/partners/index.ts`, `apps/partner/package.json`, `next.config.ts`, `apps/web/src/features/partners/nav.manifest.ts` | C0 cores | API boots with empty handler map against draft spec (handler stubs return 501 in dev only); worker manifest loads; partner app renders a placeholder; nav build check passes | boot test | — |
| T02 | Schema review with C0 (spec → migration) | `05-SCHEMA.md` feedback in CR thread | C0-0B | C0 migration merged; `db/tests` probes for every `partners.*` table pass (C0); 05-SCHEMA §8 "DEFINER tests" 1–4 green with FORCE RLS on (owner policies, `app.maintenance` gating, partner column guards, 3/4-column partner FKs) | C0 RLS probes incl. partner/staff/system claims; A12.7-style DEFINER tests | US-15.5 |
| T03 | Partner context + authz helpers | `service/partner-context.service.ts`, `handlers/getPartnerContext.ts`, `mappers/partner.dto.ts` | T01, T02 | A1 works; inactive partner/deactivated user → 403; invited → active flip; staff token → 403 | unit + integration + probes | US-02.6, US-15.3/4 |
| T04 | Domain state tables + tracking derivation | `domain/*.state.ts`, `domain/tracking-status.ts`, `domain/manifest-number.ts`, `domain/line-validation.ts` | T01 | every transition in 03-APP-FLOW §2 allowed + one forbidden per state; every rule T1–T7 incl. precedence | unit | US-04.7/10, US-07.1/5 |
| T05 | Partner BFF session layer + auth pages | `apps/partner/src/core/{session,api,auth-guard,csrf}.ts`, `src/app/(auth)/auth/**` | T01; C2 MSW mocks | login → cookie set, no JWT in browser (assert response bodies + `document.cookie` HttpOnly); MFA/enrol redirects; session-expired redirect; Origin check on POST | component + E2E (mock) | US-03.1–5, US-02.7 |
| T06 | Partner users (partner admin + staff) | `service/partner-user.service.ts`, handlers U1–U6, SA8–SA10 | T03; IdentityPort fake | provisioning in same tx (rollback test: port throws → no partner_users row); last-admin + self-action guards; aal1 → mfa_required; U3–U5/SA10 `If-Match` = `partner_users.version`, row locked `FOR UPDATE`, port called without `expectedVersion`, returned `status` stored (08 A19 D-100); member under partner claims cannot write another user's row (trigger, D-103) | unit + integration + probes | US-02.1–6 |
| T07 | Partner accounts (staff) | `service/partner.service.ts`, handlers SA1–SA7 | T03; CatalogPort fake | create/update/suspend/reactivate; duplicate code/credit party; foreign credit party → 404; syncs enqueued | integration + probes | US-01.1–6 |
| T08 | Manifest drafting | `service/manifest.service.ts`, `repository/{manifests,manifest-lines,counters}.repo.ts`, handlers M1–M7, M10, P2 | T04, T07 (price projection seeded) | numbering format + per-partner uniqueness under concurrency (20 parallel creates); If-Match; orderable-not-offered; line limit; DELETE only draft | unit + integration + probes (partner X vs Y ids) | US-04.1–3, 7, 8 |
| T09 | Submit / withdraw / print | handlers M8, M9, M11; access log | T08 | all-errors-at-once; idempotent submit replay (no duplicate jobs); withdraw race with receive serialised; print access-log row | integration | US-04.4–6, 9, 10; US-05.1–2 |
| T10 | Conversion task + staff receipt | `service/conversion.service.ts`, `tasks/partners.convert_manifest_line.ts`, handlers SI1–SI5 | T09; FrontdeskPort fake | BookingOrderInput exactly as 02-TRD §6.2 (snapshot test of the fake's recorded call); port call inside a savepoint — marker-row test: fake writes a marker then `failNext('createOrderFromBooking','frontdesk.patient_duplicate_suspected')` → marker absent after commit (08 A19 P-44); business vs infra failure split; duplicate job no-op; retry with patient_id; centre scoping; on_submit receipt flags, *pending receipt* closure and `has_missing_samples` filter (D-104) | unit + integration (fake `failNext` for each code) + probes (centre C1 vs C2) | US-06.1–11 |
| T11 | Referrers + mapping | `service/referrer.service.ts`, handlers F1–F5, SR1–SR3 | T08; CatalogPort fake | duplicate rule; member 403; mapping validates via `getReferrer`; mapping re-enqueues failed lines; samples_this_month | integration + probes | US-13.1–6 |
| T12 | Event consumers + reconcile | `consumers/lab.specimen.status_changed.v1.ts`, `consumers/reporting.report.released.v1.ts`, `tasks/partners.{reconcile_orders,enrich_report}.ts` | T10; ReportingPort fake | each 03 example; duplicate; stale seq; unknown order; partner_id mismatch ignored + metric; reconcile fills rejection reason and cancellations from views | consumer contract + integration | US-07.1–5, 7; US-08.1 |
| T13 | Tracking + reports API | `service/{tracking,report}.service.ts`, handlers O1–O3, R1–R3 | T12; ReportingPort fake (CR-C13-005) | partner isolation on lists/search/detail; POST search (no PHI in URL — asserted on BFF request log); download streams with sha256 check, access log allowed/denied (denied committed), rate tier + daily cap | integration + probes + log-scan | US-07.6, 8; US-08.2–7 |
| T14 | Access slip (08 A2.1; D-105 no-phone warning) | handlers R4–R6; `partners.access_slips` (05-SCHEMA §3.7a); `service/access-slip.service.ts`; `tasks/partners.{issue_access_slip,purge_access_slips}.ts`; `apps/partner` slip page (polling) | T13; ReportingPort fake; RenderPort fake (template `partners.access_slip`, 08 A5.1); bucket `partners-slips` (08 §4.8, A5.2); C13 adds no QR library | feature flag 403; R4 makes no port call (partner claims); worker calls `issuePortalLink` as system with exact args; worker calls `RenderPort.renderPdf` with `templateKey 'partners.access_slip'` and exactly the seven A5.1 data keys; slip PDF stored once in `partners-slips` at the registered path; URL/token absent from every column, job payload, log (logger spy), R4/R5/R6 response and `core.idempotency_keys`; poll every 1 s, give up after 30 s (08 A5.3) → `issued` typically < 5 s [CONV]; purge 02:50 at `link_expires_at` (08 A5.3); access-log row on every download; R6 with no file → `404 common.not_found` (08 A5.3); no-phone warning on PR-2 (D-105) | integration + log-scan + probes | US-09.1–6 |
| T15 | Pickups | `service/pickup.service.ts`, handlers K1–K4, SP1–SP4 | T09 | window rules; one open pickup per manifest (concurrent create test); state machine; manifest in_transit_at | unit + integration + probes | US-10.1–5 |
| T16 | Staff screens | `apps/web/src/app/(staff)/partners/**`, `apps/web/src/features/partners/**` (SP-1…SS-1) | T06, T07, T10, T11, T15; CR-C13-001/008 | every screen with loading/error/empty; nav entries; BarcodeInput matching; patient search dialog via C4 API (MSW) | component (MSW) + E2E | US-01, US-06, US-10.3/4, US-13.3 |
| T17 | Projections: price list + statements | `service/{catalog-projection,statement}.service.ts`, `tasks/partners.{sync_price_list,sync_statements}.ts`, handlers P1, S1, S2; consumer `catalog.changed.v1` (behind CR-C13-006) | T07 | precedence partner > standard; no other party's prices projected (test with 3 credit parties); delete-insert atomic; statement upsert + `is_stale`; outstanding = latest closing balance | integration (views seeded in compose DB) | US-11.1–5, US-12.1–4 |
| T18 | Dashboard | `service/dashboard.service.ts`, handler A2, PH-1 | T13, T15, T17 | counts correct on seeded data; empty state | integration + component | US-14.1–2 |
| T19 | Partner app screens | `apps/partner/src/app/(app)/**`, `src/features/**` (PH-1…PX-1) | T05, T08–T18 | every screen per 04-UI-UX with all states; 320 px reflow; cards on phones | component (MSW/Prism) + E2E | US-04, US-07, US-08, US-10–14, US-16.1 |
| T20 | PWA + headers | `public/manifest.webmanifest`, `public/sw.js`, `next.config.ts` headers | T19 | sw caches only hashed static assets + /offline (test enumerates Cache Storage after browsing PHI pages: no HTML/JSON entries); `Cache-Control: no-store` on all authenticated responses; CSP report-only then enforced | E2E (browser automation) | US-16.2 |
| T21 | Housekeeping jobs | `tasks/partners.{expire_drafts,redact_expired_lines}.ts`, `cron.ts` | T08 | every cron task `tenantScope: 'per_tenant'` (A13 P-6); drafts discarded + redacted after TTL; redaction via the owner function `partners.redact_lines` gated by `app.maintenance = 'partners_redact_lines'` with non-zero rows under FORCE RLS (08 A10.5, A12.2); trigger blocks redaction columns outside it; download counters past `expires_at` deleted by the system actor (A17 P-18(c)) | integration | 05-SCHEMA §6 |
| T22 | Security test pack | `__tests__/probes/**`, `apps/partner/tests/e2e/security.*` | T03–T21 | every item of 07-SECURITY §6 present and green | probes, E2E, log-scan | US-15.1–5 |
| T23 | Observability | metrics/alerts registration (C1 hand-off doc in PR), log fields | T10–T17 | metrics in 02-TRD §13 emitted; alert rules delivered to C1 | unit (metric spies) | PRD §6 |
| T24 | Integration with real implementations | swap fakes per §4 | owners' chunk gates | contract suites of consumed ports pass with real impls; E2E 05-DoD §5 partner journey green on staging; systemPermissions adjusted (02-TRD §9.3) | E2E staging | all |
| T25 | Manual + in-app help | `docs/manual/partners/**`, `apps/partner/src/features/*/help`, `apps/web/src/features/partners/help` | T16, T19 | every `PageHeader.helpKey` has a help file (build check); manual pages for partner and staff roles | build check | 01 §2 training note |

## 3. Milestones

| Milestone | Tasks | Demo |
|---|---|---|
| M1 Foundations | T01–T05 | partner signs in (mocks), sees empty home; state tables green |
| M2 Intake | T06–T11, T15 | partner admin invites a member; manifest submitted; staff receives; orders created in the C4 fake; pickup cycle |
| M3 Visibility | T12–T14, T17, T18 | tracking from fixture events; report list + download (fake PDF); price list; statement |
| M4 Product | T16, T19–T21, T25 | full UI on phone and desktop; PWA; housekeeping |
| M5 Integrated | T22–T24 | security pack green; real ports; staging E2E |

## 4. Fake → real swap points

| Port / dependency | Swap when | Check |
|---|---|---|
| IdentityPort (+ CR-C13-003) | C2 chunk gate + CR merged | IdentityPort contract suite + C13 partner cases; staging login on partner origin |
| FrontdeskPort | C4 chunk gate + CR-C4-006 merged | FrontdeskPort contract suite; `orders.partner_id` populated; `collection_mode = partner` |
| ReportingPort | C6 chunk gate + CR-C13-005 merged | contract cases incl. partner isolation; sha256 equality on staging |
| CatalogPort | C3 chunk gate + CR-C13-007 | contract suite |
| Events | producers' gates | consumer tests replayed against staging event log |
| Views | C0 DDL of producers | integration queries against migrated DB |

## 5. CR candidates already foreseen (not raised yet — raise when the need is confirmed)

| Candidate | To | Why |
|---|---|---|
| C13 as `NotificationPort` consumer + templates `partners.report_ready`, `partners.pickup_scheduled` (non-PHI params: lab name, link to partner origin) | C0-0C, C6 | partners want e-mail/SMS alerts (out of scope v1) |
| Outbound webhooks for partner systems (REQ-ARCH-041) | C0-0C + founder | integration with partner LIS/HIS |
| `catalog.v_pub_specimen_type` and `lab.v_pub_rejection_reason` label views | C3, C5 | human labels instead of humanised codes |
| Current consent text version from C4 to other modules | C4 | single consent source |
| `RegistrationDraft.partner_id` at C4 front desk | C4 | samples walked in without a manifest become visible to the partner |
| **CR-C13-015** candidate: `BookingOrderInput.clinicalNote?` (≤ 300) and `collectedAt?` (08 A19 D-102; collection time would also need a C5 specimen path) | C4 (+ C5) | raise only if the client asks for the partner's clinical note / collection time on the lab order |
| Partner TRF upload | C4 / C0 upload pipeline | 00 A7 equivalent for partners |
| Monthly-bill PDF download via a C4 port | C4 | partners want the bill itself, not only the statement |
| Native partner app | founder CR (B1 closed, 08 A11.2) | 00 §3 item 10 "mobile app" |

08 Addendum A2/A3 applied 2026-11-06 (A2.1 access slip via worker; A2.3 no SmartReportPort for partners).

08 Addendum A4/A5 applied 2026-11-06 (A5.1 RenderPort `partners.access_slip`; A5.2 `partners-slips` bucket; A5.3 accepted values; A5.5 no C13 HMAC column).

Review fix pass 2026-11-06 applied (review/C13-b2b-partner-portal.md + 08 A19; A13/A17 rules).

## 6. Risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| R1 | CR-C13-003 (identity) lands late → no real partner login | Build against the IdentityPort fake and MSW auth mocks; partner BFF isolates auth calls in `core/session.ts`; the swap is one task (T24) |
| R2 | C6 rejects partner RLS / new port (CR-C13-005) | Fallback design already in docs: download disabled ("Ask the lab to send the report"), list still works from projections; escalate to lead |
| R3 | Projection drift (missed events, view changes) | reconcile job every 10 min; `resyncPartnerProjections`; projection lag alerts; consumer mismatch alert |
| R4 | Wrong partner attribution of an order (would expose PHI to another partner) | partner_id comes only from C13's own manifest line → C4 stamps it (CR-C4-006) → C6 snapshots it; consumer double-checks payload `partner_id` against our mapping and drops mismatches; probe tests for X vs Y on every endpoint |
| R5 | Reconcile marks a slow-but-alive conversion as failed | threshold configurable; job guard prevents double conversion; staff retry |
| R6 | Partner-attested consent legally insufficient (B16) | consent version + attestation stored; tenant edits the statement; flag in manual; revisit when B16 answered |
| R7 | Partners treat the statement as a tax invoice | permanent banner text (US-12.3); no invoice numbers on partner screens |
| R8 | PWA caches PHI on shared clinic PCs | static-only service worker; `no-store`; logout cache purge; E2E check (T20) |
| R9 | Scope creep toward a full B2B CRM / native app | out-of-scope list in PRD §4.2; CR + founder approval required |
| R10 | pg_trgm absent in the pinned image | fallback prefix index specified (05-SCHEMA §8) |
