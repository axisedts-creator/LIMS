# MASTER DEVELOPMENT DIRECTIVE — MY HEALTH NOW / METROLABS
## Evidence-gated, repeated vertical-slice implementation loop (v1.1 UI + existing LIMS)

**Copy this entire file as the coding agent's task.** Attach the two original PDFs and `MHN_v1.1_155_Screen_Traceability_Ledger.csv` in the same session, and give the agent access to the **actual existing LIMS monorepo**. This directive is a development specification and workflow; it is **not evidence that changes have been made**.

**Source A — existing system:** `LIMS-features-and-architecture(1).pdf`, 18 pages, dated 22 November 2026, branch `deploy` as reported in the document. **Source B — visual intent:** `MyHealthNow_v1.1_Healthians_layout_wireframes(1).pdf`, 184 PDF pages, 155 unique screen IDs: 17 H* layouts and 138 S* reskins/states. **Machine-readable source index:** `MHN_v1.1_155_Screen_Traceability_Ledger.csv` extracted directly from source B page headers. **Previous approved baseline (if present in workspace):** frozen patient-app wireframe v1.0 (five tabs Home / All Tests / Bookings / Reports / Profile); source B's alternative navigation is **not** automatically approved.

## Absolute mission and truth rule

Update **the existing Flutter patient application** to the selected, approved v1.1 appearance; implement or wire **every approved, implementable patient-facing action** through the **existing** LIMS contracts, services, database, background jobs and operational apps. Build missing business logic only where a demonstrable gap exists. Account for all 155 IDs in a traceability ledger, including blocked and Phase-2 designs, without presenting speculative functionality as finished.

**Never assume a screen means a backend is implemented. Never assume a reported backend module means its patient endpoint is enabled or deployed. Never invent endpoints, database tables, DTOs, provider credentials, prices, discounts, diagnostic advice, clinical thresholds, real-time feeds, OTP delivery, API responses, patient data, or outcomes.** An inability to verify an action is recorded as a blocker, not turned into plausible-looking implementation. The real working source and tested deployment behavior outrank source A's descriptions; source B establishes visual intent only, not product/legal approval.

**Do not scaffold a second backend, replace the monorepo, add a duplicate auth system, create competing payments/reporting tables, bypass RLS, or install new packages without finding an actual need.** Use the existing modular-monolith boundaries and generated typed clients. Don't send real patient records to an AI model or commit them to the repository.

**The user has explicitly excluded VIP, premium, subscription plans and paid memberships from this patient app.** The backend's `membership` word can refer to identity/tenant account membership; that is not a paid tier. Keep operational identity membership where required but DO NOT expose premium tier UI or benefits. **Do not remove existing data/schema solely because a UI feature is out of scope.**

## 0. Ponytail skill — mandatory prerequisite and guardrails

Official origin: `https://github.com/DietrichGebert/ponytail.git`. Review the current official `README.md`, `INSTALL.md`, `skills/ponytail/SKILL.md` and the repository's current revision before installing. Confirm repository ownership, files and version/commit; prefer a reviewed and recorded revision. **Do not use arbitrary mirrors, copied installers, `curl | sh`, or execute unreviewed hooks.** The skill's purpose is minimum **complete** code, not missing functionality.

If the host is **Antigravity CLI** and its `agy` command supports plugin installation, the official documented command is:

```sh
agy plugin install https://github.com/DietrichGebert/ponytail
```

Antigravity does not retain Ponytail mode across turns through lifecycle hooks. Also load the skill's official `AGENTS.md` as workspace instructions, **merging with existing project instructions without overwriting them**. Confirm the installed skill is listed, invoke `/ponytail` or `/ponytail-review` if supported by the active host, and record the installed revision and invocation evidence. If unsupported, load the verified `skills/ponytail/SKILL.md` into agent context and say `PONYTAIL_INSTRUCTION_ONLY`; **do not claim plugin activation**.

If the host is **Claude Code**, the official documented interactive commands are two separate actions:

```text
/plugin marketplace add DietrichGebert/ponytail
/plugin install ponytail@ponytail
```

Verify completion before proceeding. If the skill cannot be installed or read, declare `BLOCKED_SKILL_NOT_LOADED`, explain the exact host limitation and continue only with user authorization or the verified instruction-only fallback. Never claim any skill is active merely because its URL was pasted.

Apply Ponytail `full`: inspect existing code and callers first; reuse existing widgets/services/contracts; prefer the smallest complete change; retain security, clinical validation, authorization, accessibility, retry/idempotency and error handling; accompany every nontrivial branch/loop/security/financial rule with a focused test; report skipped checks and risks. Review the changed code with the installed `/ponytail-review` if available; do not cite an unrun review.

## 1. START HERE: repo preflight (read-only first)

1. Find the **actual** LIMS repository root. Require `services/api`, `apps/patient_app`, `apps/phlebo_app`, `contracts`, `db`, `packages` as expected from source A; if paths differ, discover and document reality. If no repository is accessible, STOP with `BLOCKED_REPO_MISSING`; do not fabricate an implementation.
2. Record `git status`, current branch, HEAD commit, remotes (redact credentials), uncommitted changes, installed tool versions and build scripts. Do NOT reset, clean, stash, force-push, modify production databases or overwrite unrelated developer changes. Use an isolated feature branch/worktree if possible.
3. Locate and read actual repository instructions (`AGENTS.md`, `CLAUDE.md`, package docs), current UI tokens, `apps/patient_app/lib/app` routing, `apps/patient_app/lib/features/mhn` and its `MhnController` (if present), Flutter generated API client, authentication session code, `packages/ui-flutter`, feature flags, contract inventory, API modules, worker, DB migrations and RLS policies. Treat the document paths as hints, not guarantees.
4. Verify the app's **real** baseline with existing unit, Flutter and contract tests, without indiscriminately running destructive reset scripts. Capture each command, exit code, environment and limitations. Do not report success from a test that could not run. Preserve baseline failures distinctly.
5. Source A reports: TypeScript/Fastify modular-monolith API (17 modules), Graphile Worker, Postgres/Supabase RLS, report renderer, Flutter patient/collector apps, OpenAPI contracts, generated clients, and staging OTP sign-in. These are **reported states** dated 22 Nov 2026, not independent checkout verification. Source A also reports the My Health Now UI is sample-data-driven; tenant `tenant_a` has bookings and payments disabled; staging OTP uses a test code that must not ship. Verify each before modifying code.
6. Assess actual tenant feature flags and configuration. No bypassing a disabled booking, payment, consultation or membership feature to make demos look functional. Never change production tenant settings without an approved change request.
7. Distinguish `EXISTS_IN_CODE`, `TESTED_LOCALLY`, `CONNECTED_TO_STAGING`, `WORKS_END_TO_END`, `DEPLOYED`, and `UNKNOWN` for every candidate capability; use dated evidence links rather than umbrella labels such as “all modules done.”

### Non-destructive discovery examples (adapt; don't blindly assume scripts exist)

```sh
git status --short --branch
git rev-parse --show-toplevel
git rev-parse HEAD
rg --files apps/patient_app services/api contracts db packages | head -150
rg -n 'MhnController|GoRouter|ProviderScope|features/mhn' apps/patient_app
rg -n 'booking|patient|report|homecollection|specimen|payment' contracts/openapi contracts/routes.yaml
rg -n 'feature_flag|enabled|tenant_a' services/api apps/patient_app spec
```

If `rg`, paths or scripts are missing, use available tools; log the discrepancy. Do not show example commands as if they have been executed. Only run targeted tests verified in package manifests or project docs.

## 2. Evidence and anti-hallucination gates (mandatory for every task)

For **each of the 155 source-B IDs** and every button/interaction within it, maintain **one evidence-backed row** with:

`screen_id | pdf_page | feature | approved_phase | UI_action | UI_route/widget real path | current_data_source | current_state | contract_file + operationId | method + path verified in OpenAPI | auth scheme | permission check | backend module/handler real path | database table/RLS policy real path | worker/event/provider dependency | business rule | API error codes | tests (paths + results) | screenshots | reviewer | blocker | completion_evidence`.

Start with `MHN_v1.1_155_Screen_Traceability_Ledger.csv`; extend it without changing the original screen ID/title/page. Use these verified classifications:

- `BUILT_AND_VERIFIED`: real code plus passing relevant tests and observed expected behavior.
- `PARTIAL`: concrete existing code; missing clearly identified integration/behavior.
- `SAMPLE_ONLY`: UI/fixtures only, not a production API.
- `NOT_IMPLEMENTED`: proven absent after actual code and contract search.
- `NOT_SPECIFIED`: the wireframe names it but requirements/behavior aren't given.
- `BLOCKED_APPROVAL`: explicit business, policy, clinical, privacy or legal decision is missing.
- `BLOCKED_EXTERNAL`: no credentials, network service, device capability, map provider or test hardware.
- `OUT_OF_SCOPE_PHASE_2`: reference feature not authorized for initial release.
- `UNVERIFIED`: no sufficient source or test evidence.

**Never upgrade an item to BUILT_AND_VERIFIED from documentation, a static wireframe, a mock service, a generated SDK, a successful typecheck alone, or a guessed API.** A placeholder card must not claim transaction/medical capability. If API contract is missing, design a proposed operation in `docs/decisions/` with explicit status `PROPOSED`, **not** a guessed production endpoint. Never call a proposed schema a working endpoint.

### Source precedence

1. Actual repository code + contract + schema + current running behavior (when safely available).
2. Source A: reported existing backend architecture, intended module boundaries, and deployment limitations.
3. Source B: required UI/state names/visual style, with its own Phase-2/placeholder warnings.
4. Previously frozen v1.0: previously approved flows and exclusion of paid membership.
5. Open product decisions: **STOP/GATE**; do not silently pick a policy just to finish the graph.

## 3. Scope reconciliation: the explicit conflict you MUST NOT conceal

Source B proposes floating tab bar **Home | Call | Community | MyCare | Profile** and moves All Tests behind Home search and Reports under Profile. Frozen v1.0 specifies **Home | All Tests | Bookings | Reports | Profile**. Source B marks Community and MyCare **Phase 2**, includes proposals for wallet, refer-and-earn, lucky draw, corporate verification, own-package builder, personalized diet plans, health scores and health discussions, and reports text approximately 11 px and touch targets 33 px when drawn at 75%. These are **not** authorization to ship them.

Make `ADR-UI-NAV-001` before editing navigation:
- Document both alternatives, what each sacrifices (e.g. removal of prominent Bookings and Reports), user journeys affected, accessibility and Phase-2 dependencies.
- Request a product-owner decision on v1.1 navigation. Until an explicit decision is available: **retain functioning v1.0 tab navigation in the production build**, apply approved v1.1 styling only where it can coexist, and keep the v1.1 navigation as **read-only review/feature-flagged design work** with no inaccessible Bookings/Reports or fake functional tabs. Do NOT silently choose the alternative.
- Confirm desired launch scope in `ADR-SCOPE-001`; treat Phase-2 as **designed but not built/activated** unless each clinical, staffing, moderation, legal, data and operational prerequisite is signed off. No premium/subscription UI irrespective of reference screenshots.
- Accessibility floor is non-negotiable: reflow layout rather than shrinking text to 75%. Minimum tappable targets per project design system (prefer >=44 logical px; check platform/Flutter rules); 100%, 130% and 200% text scaling, 360/390/430 logical pixel references, correct scroll + safe-area behavior. Confirm fonts (source A says prototype Plus Jakarta Sans vs bundled Poppins) against available licensed assets and visual acceptance; never add unauthorized fonts.
- Document copyright/design provenance: **do not extract or copy Healthians images, text, marks, promotional claims or exclusive artwork.** The source explicitly uses its layout as inspiration; use original MetroLabs-owned or licensed imagery and factual copy.
- **No real-money lucky draw / gambling, rewards, wallet, referrals, corporate claims, health scores, diagnoses or diet plans without explicit policy + applicable legal/clinical review.** Do not invent a clinician or moderation team.

## 4. Dependency graph / vertical-slice loop

Follow `MHN_Agent_Implementation_Loop.mmd` strictly: **PRECHECK → EVIDENCE AUDIT → SCOPE GATE → SELECT ONE APPROVED SLICE → REUSE/EXTEND → TEST → REVIEW → LEDGER UPDATE → NEXT SLICE**. On failing tests, loop to root-cause fix; on approvals/third-party blockers, log and proceed to other **approved** slices. Never mark blocked work complete.

Topological slice order (dependency-driven; may be reordered based on audited code):

- **T00**: preserve git state, install/verify Ponytail, reconcile v1.1/v1.0 scope, enumerate all 155 IDs, baseline QA.
- **T01**: Flutter design system, app shell, all enabled navigation, responsive/screen-reader foundation, error/empty/loading/offline patterns; no misleading mock fallbacks outside preview.
- **T02**: verified existing OTP identity/session and profile data, secure token storage, auth redirects, logout/revocation.
- **T03**: real catalog, packages, categories, search/sort/filter, prices, favorites, service-area/city, only approved promotions; preserve server price calculation.
- **T04**: profile/family members/addresses/guardian consent and access delegation; bind to verified identity/engagement endpoints, audit report permissions.
- **T05**: cart, patient selection (one patient per booking), quotes, collection methods, address eligibility, available slots, booking/rebooking/cancel, idempotency.
- **T06**: payment path only if enabled for tenant and verified; statuses, failed-but-paid reconciliation, refunds where policy requires.
- **T07**: phlebotomist app integration: actual staff auth/route sync/outbox, assignment and visit statuses, location feed only if real GPS source exists.
- **T08**: specimen barcode/custody/handovers to lab, specimen-level timelines and rejected/delayed/recollection flows; respect offline sync.
- **T09**: LIMS result status, approval, PDF release, secure patient/guardian/delegate access, linked report history and missing-report recovery.
- **T10**: notifications, prescription uploads, support tickets, contact/FAQs/legal content, settings, push permissions, telemetry without PHI.
- **T11**: entire 155-ID traceability audit, linked E2E flows, real Android QA, staged rollout preparation, unresolved external approvals. Phase-2 **requirements-only** ledger until approved.

Each slice can require frontend, backend, contract, RLS migration, event consumer, deployment config and tests; do **all actually necessary parts together**, not UI first with a nonfunctional button. Do not unnecessarily touch lab analyzers, staff billing or tenant operations unrelated to the slice.

## 5. Exact functional acceptance by area — screen IDs and logic

Every subsection below is mandatory for all **approved** IDs; cross-reference the CSV to check no state is lost. Terms in these lists are **requirements to verify or implement**, not assertions of existing APIs.

### A. App shell, launch, home and campaigns — H01 H02 H03 H11 H11b S07–S09b

- Splash/loading: authenticated startup and token expiration handled deterministically; handle offline and cold-start, no infinite spinner; auth/deep-link redirects correctly restore intended route; restore supported navigation state.
- Home: official MetroLabs mark; personalized greeting from verified patient record; selected city/branch; tests/packages search; camera prescription entry; cart, favorites, notifications; profile completion conditional; dynamic verified catalog; previously booked/tested items where authorized; verified campaign slot only; primary booking/tracking path accessible whatever approved navigation. Remove any fictional price, membership upsell or hard-coded `Rs. 0` reward.
- H02 city switch: distinguish current browsing location from lab/tenant identity; verify serviceable area and lab branch against actual backend; switching city must refresh catalog availability, slots and pricing, not change tenant to another lab implicitly; persist supported preference and handle unsupported location without pretending coverage.
- H03 campaign popup: show only published/active/approved campaigns from a verified source; show dismiss, expiry, server-enforced terms and safe display frequency. If no campaign, hide it. No campaign configuration invented.
- Search S07/S07b/c/d: actual server-backed or explicitly documented local indexing from returned approved catalog; filtering/sorting semantics and pagination; debounce/cancellation/empty/error/loading; Unicode-safe search for Nepal names; stable query and selected-city state. Do not invent availability or counts. Search icon/voice search only activates if supported and permissions handled.
- Favorites S08/S08b: persist with authenticated user if endpoint exists; remove/add idempotent; reflect across Home, catalog and Profile; prevent cross-tenant leakage; guest state defined without unauthorized storage.
- S09/S09b offers: only verified, eligible, time-bounded actual offers, server computes discount; empty offers should be valid UI, not fake offers.

### B. Clinical catalog and prescription — S10–S16c, H16 placeholder

- Test and package list: single authoritative catalog + price-list version + applicable tenant/location/effective date; correct code, name, specimen, panel inclusion, analyte count, method, turnaround where clinically approved; pagination/filter/sort; disabled/archived tests cannot be booked.
- Test detail S12 and packages S13/S13a/S14/S15: clinically approved preparation/fasting/specimen instructions, turnaround caveats, included/excluded items, package components, total as returned by server. Preventive checkups are **catalog browse categories**, not software diagnosis or an unsupported age/gender test recommendation.
- Preserve server-side `CatalogPort.priceFor` as documented; money in decimal strings/integer minor units; no float price math in Flutter. If source lacks patient pricing operation, propose contract (do not fabricate route) and obtain review before implementation.
- Prescription upload S16/S16a/b/c: camera or file selection, validated type and size per **actual** API contract, request signed upload/scan if supported, preview/remove/retry/abandon, virus scan or file safety, review queue, allowed status transitions and notifications. **An uploaded prescription does not automatically become a clinical order without approved review logic.** No OCR or diagnosis unless supported/approved.
- H16 Create Your Own Package: the PDF shows a placeholder only. Record `NOT_SPECIFIED` and do not invent a pricing algorithm, included-test rules or UI flow. Supply a requirements stub and blocked acceptance checklist instead.

### C. Identity, OTP, sessions — S01–S04b, H11b

- Reuse the documented patient OTP implementation; verify challenge creation, pre-auth header, limits, code storage strategy, code expiry, resend, rate limiting, session creation, Ed25519 JWT verification, token refresh/relogin behaviors, rejection/revocation, logout, locked accounts, invalid phone, no network; inspect live contract before using names/headers.
- Source A describes patients as **not GoTrue users**; do not introduce a second Supabase Auth login. Preserve tenant-scoped identity and current session semantics. No staging fixed-code behavior outside the isolated test environment.
- Phone entry supports Nepali format and existing contract; do not invent accepted numbers. For profile completion use server-controlled fields and validations, audited clinical data; handle DOB, consent, repeated submit, update conflicts; mask private phone in lists/logs/screenshots appropriately.

### D. Family/profile/address/delegated report access — S18/S18b/S18c, S37b/c, S42–S47b, H08

- One patient per booking, including when selecting parent/child; separate booking, reference, charges, specimen IDs and reports. Prevent mixed-patient cart or stale patient identity after user changes selection. Verify guardian/minor identity and eligibility from actual policy.
- CRUD profile/family/addresses: real APIs, concurrency versioning where present, backend validation, audit history, secure deletion policy and tenant isolation. Addresses require geocoding/map only if provider available; server validates collection service area, not just client pin; editing addresses must not silently rewrite existing bookings.
- Report delegation/access: differentiate self, guardian, adult delegate and account owner. **Explicit consent to grant; verified account-owner action to revoke**; permission scopes checked on **each protected read** and signed download; OTP wrong/expired/resend/lockout/recovery states S44a–S44l. Policy values remain configurable from approved backend, never hardcoded from mockups. Access revocation should invalidate future server access; downloaded copies already held by others cannot be retroactively deleted—do not promise otherwise.
- H08 merged Profile is a **layout reference** only; no membership/paid tiers, no phantom functionality. Ensure saved tests, addresses, notifications, FAQ/help, bookings and reports remain reachable under selected navigation.
- S43a BS dates: reuse shared BS/AD date utilities if supported; store canonical dates from backend, avoid manual Gregorian conversion or ambiguous time-zone parsing.

### E. Cart → booking → payment — H10, S17–S27a and S25a/b

- Cart: tenant, patient, test codes, package inclusion and duplicate/conflict handling, persistence policy, actual backend quote; never present Flutter-calculated checkout totals as authoritative. Price changes and invalid/out-of-service items trigger explicit re-confirmation.
- S17/S18/S19/S20/21: select one patient, approved home vs lab collection, validated address/service area, staff/slot capacity, date/slot timezone Asia/Kathmandu, past slots disabled server-side, inventory/operating hours constraints if source supports them; handle two devices booking the same slot.
- S22 review: show canonical patient, codes, effective price, approved fees/taxes, slot, payment mode and cancellation terms. If quote/version/slot expires, return to correction; do not silently change details.
- S23/S23a payment: use existing payments module and gateway adapters **only when tenant enabled and credentials tested**. Verify callback signatures, provider status, amount/currency, replay resistance, pending/failed/settled/unknown reconciliation. Never trust client callback or make duplicate bookings on retry. If payment unavailable, clearly block or offer an **approved** pay-at-collection path; never fabricate authorization.
- S24/S25/S25a/b: idempotent booking create and stable booking reference; payment captured but order not confirmed MUST show pending reconciliation without re-charging; retry with same idempotency key when required, user-safe fallback, support ticket and audit; link booking confirmation to actual created record.
- Booking lists S26 etc: filter upcoming/past/cancelled according to backend state; persist and refresh on return; offline cached view labeled as stale if policy permits.
- S27 and variants: rights to reschedule/cancel conditional on status, deadlines, refunds and staff assignment; backend enforces, UI mirrors. Compact Collector → Samples → Report stepper opens relevant detail or helpful pending explanation; tests and charges tied to the same booking; never mismatched confirmation/sample data.

### F. Home collection, collector route and live location — S28–S32a

- **Do not treat an animated map or saved sample coordinates as GPS.** Source A describes a partly wired offline-first phlebo app and homecollection module; it does NOT prove a live collector GPS feed exists. Audit this independently.
- From booking: verify dispatch assignment, visit identity, route sync, arrival, patient identity check, consent, scan, payment and completion. Integration with `apps/phlebo_app` must respect its existing outbox, encrypted local databases, mutation idempotency and sync retry semantics. Do not bypass the collector's required visit guards.
- Establish an actual **approved** GPS source and location ingest contract before exposing production live tracking. Authenticate device/staff and active assignment; tenant + booking authorization; GPS freshness and sequence validation, clock drift, location consent/policy, privacy retention, bounded rate/frequency, appropriate routing provider credentials; avoid precision exposure after reassignment or completion. No collector location published to unauthorized patients, other tenants or closed visits.
- S30/S30i show live only when genuine location is fresh; ETA only from verified routing provider. Stale/lost/unavailable states S30a/b/d hide ETA, show last verified update; patient-offline S30e/f distinguished from collector GPS loss; collector delayed S30c avoids fabricated ETA; reassignment S30g/h immediately discards old collector's route/contact and only shows new identity/location after verification.
- S31/S31b contact options require approved masked/direct/support contact rules; do not invent phone number. S32/S32a only complete when authorized collection/scans actually confirm; partially collected, failed visit or recollection needs valid backend states and audit.
- Live location ends at defined collection/assignment termination per approved privacy policy; specimen movement uses **barcode/custody events, never GPS attached to the blood tube**.

### G. Specimen chain, lab status, approved reports — S33–S41b

- Reuse real `lab` specimen/result state machines and `reporting` release; inspect `homecollection` handover and `lab.specimen.status_changed`, lab result verification/approval and reporting release events as documented. Do not inject fake LIMS timestamps or claim 7 fixed stages map 1-to-1 to every lab test.
- Specimen timelines keyed to actual barcode/specimen identity; record collection, transit, receipt, testing, QC/review, rejection, recollection, release with verified timestamps and status owners. Not every analyzer flow generates each UI stage; map missing/late/partial states deliberately. S33a rejected/recollection and S33b transit delayed need meaningful safe actions; S34a partially completed panels are per-test not per-order.
- Reports: pending/delayed/ready/partially ready; H/M? reports are accessible by actual patient with consent/guardian/delegate, never public raw IDs alone. Result values and reference ranges from clinically approved release only. No preview of unapproved result, no fabricated “normal” classification.
- Released PDFs must come from existing immutable renderer/object store (signed, expiring access); enforce authorization before issuing download/view URL, PDF viewer timeout/retry/download-safe handling, revoke active capability for removed delegate, and audit access.
- S39a abnormal flags use server classifications with approved explanation; do not diagnose or automatically generate treatment advice. Missing report S41/S41a/b uses verified identity and ownership matching with anti-enumeration, OTP and audit; do NOT treat patient ID or UHID as sufficient authorization.
- Worker delivery/retry notifications must not leak test result values in push notifications or logs. Respect tenant data isolation and sensitive PHI handling.

### H. Notifications, contact, service/support/legal — H09, S47–S51a

- Real notification preferences per verified contract, opt-in permission, failed push/delivery, dedupe, device token registration/rotation, event-driven booking/collection/report alerts, user unsubscribe; no reward notifications unless reward program approved.
- Contact S48: official MetroLabs phone/WhatsApp/email/branch/address/hours/website only after verified configuration; tap call/WhatsApp/map must go somewhere real, not empty links.
- FAQ S49/S49a: curated content and search; correct escalation when nothing found. Do not invent clinical answers or support times.
- Report a problem S50/S50a/b: persisted ticket (authorized submit, typed category, attachments with virus scan, receipt ID, status tracking if supported), retry and offline/error; no fake “submitted” toast without backend acknowledgment.
- Terms, About, Privacy S51: use legally approved content; enforce consent/version where policy requires; logout clears session and sensitive local caches, handles unsynced data explicitly, routes correctly.

### I. Extra v1.1 H pages — explicit requirement and safety gates

- `H04 H05 H06` Community / Ask Expert / Discussion — **Phase 2 only** unless written sign-off and staffing. Would require moderation queue, report/abuse/block, consent/privacy, role verification for clinician replies, retention/deletion, audit, media upload sanitation, dangerous-medical-content escalation, user notifications, anti-spam. Do not simulate doctor responses or launch an unmoderated health forum.
- `H07` MyCare / health score / diet plan / consult / personal health tracker — **Phase 2 only**. Requires licensed clinical oversight, provenance for health measurements, approved risk model/clinical rules, appointment operations, consent, security, retention and human escalation. No automatic health score/diagnosis/diet plan from arbitrary inputs.
- `H09` reward/advisor categories are reference labels, not proof a rewards/advisor service exists.
- `H12` Wallet, `H13` Refer & Earn, `H14` Lucky Draw, `H15` Corporate Verification, `H16` Own Package are explicitly **placeholders in source B**, not fully designed user journeys. Keep `NOT_SPECIFIED` until requirements, legal/finance review (especially wallet, referral, lucky draw), anti-fraud/rate-limit schemes, and business ownership are approved. No fabricated award balances, draws, points or corporate eligibility.
- `H10` Empty Cart, `H11` Splash and `H11b` Loading should be integrated as lightweight UI states only; don't create duplicate domains.

## 6. Backend and contract implementation rules

The existing 17-module service is contract-first. Before a new operation:
1. Search current OpenAPI specs (`contracts/openapi/`), route manifest, generated TS/Dart clients, existing module routes/services/repositories, typed ports and event schemas. Trace a real request from Flutter to API handler to RLS table to event/worker and back. Record exact file paths/operationIds—**never synthesize them**.
2. Reuse existing contract if it meets the behavior and authorization. If not, prepare a **reviewable proposed contract diff** with request, response, tenant and actor scopes, pagination, idempotency, error cases, privacy, version compatibility and migration/backfill impact. Wait for policy approval on high-stakes semantics; then implement with existing code-generation pipeline.
3. Place business rule in owning backend module (not client), respect port/events boundary (no module reading another module's tables), enforce tenant RLS, permission/assertion, parameterized SQL, optimistic concurrency/version conflicts, idempotent state transition, legal/custody audit. DB changes require reversible migration plan and isolation tests. Do not invent indexes for speculative volume.
4. Every state-changing event must write outbox/event atomically with server state where existing platform expects it; worker consumers must be idempotent and retry-aware. Document duplicate/out-of-order delivery behavior; no clinical or billing side effects twice.
5. Use the existing storage/upload service for prescription and report documents; signed short-lived access, MIME/type/size limits, malware scan, audit, and no raw public object path.
6. Feature flags must be tenant scoped; disabled features remain inaccessible both in UI and backend. Source A reports `tenant_a` booking/payment features off; verify actual state. Do not turn on a gateway without merchant sandbox/test signoff.
7. Never promise production readiness because code unit tests pass; need actual end-to-end environment and authorized external systems.

## 7. Frontend fidelity rules and Flutter implementation

- Work in `apps/patient_app` and shared `packages/ui-flutter` **as already structured**, not a parallel Flutter project. Preserve Riverpod + go_router if actual code confirms them. Use generated API client and original transport/security conventions; avoid direct Supabase table calls or duplicate services.
- Feature-first data repositories: replace `MhnController` fake providers **one approved slice at a time** with typed real repository providers; preview/demo mode can remain explicit and compile-time gated, but production must not silently fall back to fixtures on network failure.
- Implement v1.1 design tokens from original MetroLabs theme; no raw hex colors or inline hardcoded typography where lint rules forbid. Match approved H*/S* layout intent without copying Healthians assets. Buttons should be accessible and states actionable.
- Preserve every relevant UI state: loading, initial, empty, no access, error, offline/retry, expired OTP, no slots, stale GPS, reassignment, payment pending, partial report, no pdf, guardian consent, failed upload and support failure.
- Accessibility: scalable type 100/130/200%, focus/semantics, contrast, no overlap, scroll/pinned bar layout, keyboard avoiding insets, no trapped focus or inaccessible tabs. Test on 360/390/430 logical widths plus real Android device with TalkBack; iOS only if actual build target/environment permits (doc reports Android only).
- Visual checks: golden/widget tests compare *actual Flutter renders* against source B for approved UI and source A's working flows; record intentional deviations due to accessibility / legal scope / missing assets. No screenshot-as-screen implementation.
- Performance: debounce search, cancel stale requests, pagination, cache TTL approved, dismiss stale location updates, efficient list renders, graceful reconnect. Do not hardcode timers, map refresh interval or retention durations lacking policy.
- Secure mobile: existing secure storage, log redaction, screenshot blocking on sensitive screens as existing pattern dictates; no PHI in crash analytics, local preferences, push notifications or URL query parameters. Use authenticated deep links with owner verification.

## 8. Test/QA matrix — minimum for every vertical slice

For each changed user action, add or execute **relevant** tests and retain evidence:

**Server:** success + invalid input + tenant mismatch + user without access + forged token + expired/changed session + duplicate/idempotent retry + concurrency conflict + rate-limit + event out-of-order + missing provider credential; currency math, settlement, reconciliation and rollback where payments involved.

**DB:** tenant A cannot read/write tenant B; guardian/delegate cannot access non-consented report; dropped consent invalidates future signed link issuance; correct event transition/append-only log/privileged writes.

**Flutter:** route presence, auth redirect, state loading/empty/error/online-offline, correct real data mapping, invalid form, double-tap avoidance, 100/130/200% text, 360/390/430 width, keyboard/safe area and assistive-tech semantics. Golden screen comparisons MUST specify whether pixel/visual or semantic.

**E2E paths:**
1. OTP sign-in → profile completion → Home.
2. Browse/search/filter → view price/package → cart → select one patient → server quote → slot → booking success.
3. Unsupported address and no slots → safe recovery.
4. Payment pending/failed/paid-but-booking-unknown → no double charge or duplicate booking.
5. Booking → assigned phlebotomist → collector en route → arrived → collected; different patient denied.
6. Offline/stale GPS and collector reassignment → no stale location/ETA displayed.
7. Phlebo offline scan → outbox retry → exactly-once logical event → lab handover and specimen timeline.
8. LIMS testing → partial result approved → signed report released → authorized PDF available; unapproved never visible.
9. Family adult consent/guardian access → delegate permission enforcement → revoked access -> denied report read.
10. Missing report lookup → proof of ownership → correct association; enumeration blocked.
11. Prescription upload/scan/review/retry safely handled.
12. Notifications and support tickets confirmed by persisted server state and background worker.
13. 155-ID screen inventory shows no untracked UI states; Phase-2/placeholder items explicitly held.

Tests on a stubbed gateway or a simulated GPS feed verify only integration contracts, NOT real external service availability. Label every scenario accordingly.

## 9. Reporting loop; exact output after EACH slice

Report in concise but auditable format:

```
SLICE ID / SCREEN IDs:
PONYTAIL STATUS: installed and activated / instruction-only / blocked; version or commit evidence:
BASELINE BRANCH / HEAD / working-tree safety:
REPO EVIDENCE: exact paths, contract operationIds, DB policies and generated client:
WHAT WAS ALREADY IMPLEMENTED:
CHANGES MADE: exact files / small rationale / migrations / flag changes:
SERVER RULES + AUTHZ / TENANT RLS:
EXTERNAL INTEGRATIONS: confirmed / simulated / missing:
TESTS RUN: exact commands, exit codes and totals; skipped checks explicitly:
VISUAL + ACCESSIBILITY: tested widths, text scales, device, screenshot paths:
SCREENS UPDATED: IDs and traceability CSV rows:
BLOCKERS / POLICY APPROVALS: owner and required decision, never guessed:
ROLLBACK/COMPATIBILITY NOTES:
NEXT UNBLOCKED SLICE:
```

Use a single working implementation ledger file in the repo under `docs/` (follow existing docs naming); update the supplied screen CSV or its copy with links to actual code/test evidence. When no service is available, include blockers rather than a fake success. Record all new changes in git without disturbing other people's work; **never push, deploy, enable tenant flags, migrate production DB, send real SMS, initiate real charge or publish notifications without explicit user authorization**.

### Definition of done: one screen

Every **approved** functional control has a real route/action; input validation; correct authenticated request; correct tenant/patient authorization; persisted server effect or verified read; loading/error/empty/offline handling; test evidence; screen-reader/text-scale coverage; no unverified statements. One static screenshot alone never counts.

### Definition of done: release candidate

All 155 source IDs are accounted for as verified, **explicitly** excluded/Phase-2, or blocked with an accountable decision; all **approved launch-scope** features have linked code/contracts/tests and working staged E2E results; no production mock fallback, no staging OTP override, no unlicensed visuals or fabricated clinical/financial data, no unapproved premium or gambling features; full product/legal/security QA passed; release plan and rollback documented. If any required gate cannot be proved, report `NOT RELEASE READY` and continue only with safe unblocked tasks.

## 10. First response and immediate execution instruction

**Do not respond with a giant speculative implementation or claim to have built the full app.** Begin by (1) verifying Ponytail loading, (2) finding the real repo and recording HEAD, (3) verifying the two PDFs + 155-ID CSV, (4) auditing the baseline Flutter + OpenAPI + LIMS backend with real paths, (5) producing the two navigation/scope ADRs and 155-row evidence matrix. Then pick the highest-priority *approved, unblocked* vertical slice—most likely replacing fake Reports or Bookings data, because source A explicitly identifies those as the initial wiring targets. Implement that small full-stack slice in the same session if the repo and environment permit, run tests, and report actual results. **Continue iterating automatically over approved unblocked slices when time and environment permit, but never simulate approval, deploy, or claim future asynchronous work.**

**STOP conditions:** source repo not accessible; skill not verifiable (unless instruction-only fallback explicitly accepted); permission/scope conflict affects a specific change; required production credentials or clinical/legal approval absent; destructive operation without user authorization; test failure cannot be safely diagnosed. Report blocker and other unblocked work, not conjecture.

---

### Reference artifacts accompanying this directive

- `MHN_Agent_Implementation_Loop.mmd`: Mermaid diagram with gates and rework loop.
- `MHN_Existing_LIMS_Architecture_Graph.mmd`: existing architecture and three distinct tracking sources.
- `MHN_v1.1_155_Screen_Traceability_Ledger.csv`: all exact H/S screen IDs, page references, preliminary *candidate* modules, no prefilled proof.
- `LIMS-features-and-architecture(1).pdf`: document-reported architecture, not proof of deployed availability.
- `MyHealthNow_v1.1_Healthians_layout_wireframes(1).pdf`: visual and scope references (including Phase-2 and placeholder warnings).

**Do not mark these artifacts as implemented code. They are the audited request and implementation plan.**
