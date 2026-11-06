# C11 Specialty Pathology — 06 Implementation Plan

Status: DECISION, 2026-11-06. One task ≈ one PR (02-CV §12). Branch names `c11/<kebab-topic>`. Every task's tests are listed; "AC" = acceptance criteria in `01-PRD.md`. Prerequisite for T-01: C0 has frozen the `anatomic` DDL (05-SCHEMA), `contracts/openapi/anatomic.yaml` (02-TRD §5), permission/error/route additions (CR-C11-002/003/006) and the fakes for LabPort, FrontdeskPort, CatalogPort, IdentityPort, upload pipeline.

---

## 1. Tasks

| ID | Goal | Files / paths | Depends on | Done when | Tests | ACs |
|---|---|---|---|---|---|---|
| T-01 | Module and worker skeletons; manifest autoload; permissions file; config parsing | `services/api/src/modules/anatomic/{index,permissions,config}.ts` (`ModuleManifest.systemPermissions: ['anatomic.case.work','frontdesk.order.read','catalog.test.read']`), `handlers/index.ts` (stubs return `501` only in dev — boot check requires every operationId), `services/worker/src/jobs/anatomic/index.ts` (WorkerManifest without `permissions`; subscribes only `lab.specimen.status_changed.v1` — the `lab.result.*` subscriptions come with T-27) | C0 contracts | API and worker boot with fakes; every operationId of `anatomic.yaml` mapped | boot test; config test (`LIMS_ANATOMIC_IMAGE_MAX_BYTES` > 15 MB → boot fails); system actor holds exactly the three manifest permissions | — |
| T-02 | Pure domain: state table, labels, accession pattern, plaintext | `domain/case.ts`, `case.state.ts`, `labels.ts`, `accession-pattern.ts`, `plaintext.ts` | T-01 | 100 % of state rows + forbidden examples tested | unit: every transition C1–C7 + forbidden list; letters A…Z→AA…AZ→BA; block/slide label goldens; pattern tokens/overflow/invalid; tz year boundary 31 Dec 18:15 UTC = 1 Jan Asia/Kathmandu | AC-02.3, 02.4, 04.1, 04.3, 04.4 |
| T-03 | Synoptic definition + value validator + display renderer; molecular result validation | `domain/synoptic.ts`, `domain/molecular.ts` (moved here from T-16: sign-out completeness §4.5.3 in T-14 needs it) | T-02 | validator rejects all invalid fixtures with exact JSON Pointers | unit: duplicate keys, missing options, bad `show_if`, min>max, limits; value types; hidden-field rule; display golden; molecular result vs assay definition (code in set, quantitative only when allowed, decimals) | AC-08.2, 08.5, 11.2, 11.3 |
| T-04 | Repositories (all tables) + integration harness | `repository/*.repo.ts`, `__tests__/integration/setup.ts` | T-01, C0 migrations | CRUD against migrated PG17 with tenants A/B; explicit `tenant_id` filter in every query (REQ-SEC-024) | integration per repo; RLS centre scoping (A1 vs A2) | AC-13.2 |
| T-05 | Intake consumer | `service/intake.service.ts`, `services/worker/.../consumers/lab.specimen.status_changed.v1.ts` | T-04, T-06 (auto-accession calls `numbering.service`) | §4.1 behaviour incl. auto-accession, rejected, recollection, aliquot, add-on join; explicit `link_kind` on every upsert | consumer contract: 03-IC §3.7 example, unknown fields, duplicate `event_id`, stale seq, concurrent two-specimen race (two tx), no-anatomic items (`not_anatomic` link), `collected` event on an unknown specimen (`not_anatomic` link, no CHECK violation), `rejected` before `received` (stale `received` ignored), profile missing | AC-01.1–01.10 |
| T-06 | Numbering service + accession endpoint + case details/parts + assignees | `service/numbering.service.ts`, `service/case.service.ts`, handlers A4–A7, A12 | T-02, T-04 | numbers per series/year; concurrency safe; duplicate mapping; `{branch}` from `ctx.core.branch`; A12 via `ctx.core.memberships.list` (08 A17 D-47) | integration: 20 parallel accessions distinct+consecutive; year rollover; pattern overflow → 500 code; `{branch}` with no `branch_id` → 500 `accession_pattern_invalid`; duplicate → 409; A12 with/without `case_id` (centre filter), `q` prefix match, `limit` cap | AC-02.1–02.7 |
| T-07 | Case reads: list (queues, filters, sort, cursor), detail (incl. LabPort read-through, demographics), lookup | handlers A1–A3, `service/labstatus.service.ts`, `mappers/case.dto.ts` | T-06 | queue definitions per 03-APP-FLOW §4.1 (`awaiting_lab` reads `case_items.lab_approved_version_no`, which T-27's consumers maintain); field allowlist per permission; display names via `ctx.core` (08 A17 P-17); access log `anatomic_case.view`, `anatomic_object.lookup` | contract tests; mapper tests (patient omitted without `frontdesk.patient.read`; `lab_status` omitted on `auth.forbidden`); `awaiting_lab` with seeded `item_submissions`/`lab_approved_version_no` rows; `sort=accessioned_at` | AC-13.1, 13.2, 13.4 |
| T-08 | Gross + stage transitions + cancel | handlers A8–A11, `service/gross.service.ts` | T-06 | guards per §7 | integration: guard matrix per case kind; `signout_locked` after sign-out | AC-03.1–03.4, 15.1, 15.2 |
| T-09 | Material: blocks, slides, stain orders, movements, labels data | handlers M1–M15, `service/material.service.ts` | T-08 | labels unique; IHC block rule; routine stains not orderable; `block_not_available` only for discarded blocks at M5; movement guards and required reason for sent_out/discarded; per-id bulk outcomes; access log `anatomic_label.print` | integration + probes with mixed-tenant id arrays; movement history newest first; lookup of another tenant's label → 404 | AC-04.1–04.7, 05.1–05.7, 06.1–06.5 |
| T-10 | Images: upload, re-scan job, content stream, edit/deactivate | handlers I1–I4, `service/image.service.ts`, `tasks/anatomic.process_image.ts` | T-04; **CR-C11-008 / CR-C2-011 merged for real pipeline** (fake before) | state from `AcceptedUpload.scanState` (08 A17 P-19: clean → ready, infected → quarantined, pending/unavailable → processing + job that re-scans with `ctx.files.scan(ctx.storage.read(…))`, ≤ 5 attempts); `x-upload` list; path rule; no filename stored; inline headers per 08 A17 D-67; `422 common.upload_quarantined` until ready; access log `anatomic_image.view` on every content call; D-66 image rules on signed-out cases | integration with fake pipeline returning each `scanState` and a re-scan that turns `clean`/`infected`/stays `unavailable`; size/type; header assertions; log-scan test for planted filename | AC-12.1–12.8 |
| T-11 | Config: settings, stains, test profiles (CatalogPort check), assays, coded values (diagnoses, cytology adequacy, cancel reasons — no change reasons, 08 A17 D-62), text templates | handlers K1–K12, K20–K22, `service/config.service.ts` | T-04 | privileged checks; lazy defaults (§2.3 of 05-SCHEMA, 08 A17 P-22) | integration; aal1 → `auth.mfa_required`; technologist: K-writes 403, K-reads 200 | AC-14.1–14.4 |
| T-12 | Synoptic templates lifecycle | handlers K13–K19 | T-03, T-11 | draft/publish/retire/new-version; DB guard trigger honoured | integration: immutable after publish; one published per key | AC-08.1–08.4, 08.6 |
| T-13 | Report drafts | handlers R1, R2, `service/report.service.ts` (draft part) | T-09, T-10, T-12 | `If-Match` create/update; synoptic instance validation; image limits; diagnosis codes active | integration | AC-07.1, 07.3–07.6 |
| T-14 | Content snapshot + sign-out (A1) | `domain/report-content.ts`, handler R3, report.service sign-out | T-13 | §4.4 steps (port calls first, then `report_versions` with the decided `version_kind`, then `item_submissions`); atomic rollback on port failure; idempotent replay; access log `anatomic_report.sign_out` | unit snapshot goldens (full, addendum_only, summary truncation); integration with LabPort fake (D-7 versioning; `failNext`), FrontdeskPort item inactive; idempotency replay; view row equals snapshot | AC-09.1–09.10 |
| T-15 | Changes (revision/amendment) and addenda | handlers R4–R10 | T-14 | kind decision via LabPort; reason code format-only, from C5's set (08 A17 D-62), system codes rejected; `amendment` sent on every revision/amendment and `supplementary_report` on every addendum submission; addenda contents per 02-TRD §4.7; D-66 edit rules while a change draft is open; access log `anatomic_report.view` (R7) | integration: approved → amendment (08 R1); E10 race (revision draft, approved before sign → `amendment`, no `lab.amendment_reason_required`); two targets one approved → `amendment`; `lab.result_locked` propagation; add-on scope; second addendum on the same add-on item keeps the first; full-scope versions carry all non-add-on addenda | AC-10.1–10.8, 03.4, 03.5 |
| T-16 | Molecular results and batches | handlers Q1–Q7, `service/molecular.service.ts` (uses `domain/molecular.ts` from T-03) | T-11 | validation against assay definitions; batch positions | integration | AC-11.1, 11.4–11.6 |
| T-17 | Published view contract test + JSON Schemas of jsonb columns | `__tests__/contract/view.contract.ts` | T-14 | column list + types; JSON Schema validation of fixture rows | SQL contract test | AC-09.8 |
| T-18 | Probes | `__tests__/probes/*` | T-07…T-16 | every operationId covered by generator + hand-written cases (07-SECURITY §5) | probes | 07-SECURITY |
| T-19 | Web: worklist, lookup, case workspace shell + Overview/Parts tabs | `apps/web/src/app/(staff)/anatomic/{page,cases/[case_id]/page}.tsx`, `features/anatomic/{nav.manifest.ts,server,components,forms,help}` | T-07, T-08 (Prism mock before) | all page states; shortcuts; scanner behaviour | MSW/Prism component tests; axe; keyboard walk-through | AC-13.1, 13.4 |
| T-20 | Web: Blocks & slides, Stains, Images tabs, labels page, tracking | `features/anatomic/components/{material,images,tracking}`, `app/(staff)/anatomic/{tracking,cases/[case_id]/labels}` | T-09, T-10, T-19 | label print layout; basket mode | component tests; print CSS snapshot | AC-06.2, 13.3 |
| T-21 | Web: Report tab (draft editor, synoptic form, preview, sign-out dialog, changes, addenda) | `features/anatomic/components/report/*` | T-13–T-15, T-19 | error mapping per 04-UI-UX §8; step-up flow | component tests incl. `report_incomplete` error summary mapping | AC-07.2, 09.2 (UI), 10.x (UI) |
| T-22 | Web: Molecular tab, batches pages | `features/anatomic/components/molecular/*`, `app/(staff)/anatomic/batches/*` | T-16, T-19 | | component tests | AC-11.x (UI) |
| T-23 | Web: configuration (incl. template builder + live preview) | `app/(staff)/anatomic/config/*`, `features/anatomic/components/config/*` | T-11, T-12 | builder produces definitions accepted by T-03 validator | component + round-trip tests | AC-08.x, 14.x (UI) |
| T-24 | Observability + audit access events | metrics in services; `ctx.audit.access` calls (exactly the six 08 A17 D-53 codes in 02-TRD §12); alert rule definitions handed to C1 | T-07…T-16 | metrics exist; log-scan test finds no accession/labels/text; CI string-literal check passes (08 A13 P-3) | log-scan test with planted PHI; metric presence tests; access-log row per listed operation | 02-TRD §12 |
| T-25 | User manual + in-app help | `docs/manual/anatomic/*`, `features/anatomic/help/*` | T-19…T-23 | every `helpKey` has help; manual pages per 04-UI-UX §9 | build check | — |
| T-26 | E2E nightly scenario + performance check | `apps/web/src/features/anatomic/__tests__/e2e/anatomic.e2e.ts` (inside C11's owned feature path; run by the nightly e2e job) + seed at 1×/10× | all | 02-TRD §11 targets met on reference dataset | e2e; load script | DoD §3.5 |
| T-27 | CR-C11-011 consumers (accepted in 08) | `consumers/lab.result.approved.v1.ts`, `consumers/lab.result.amended.v1.ts`; adds the two subscriptions to the WorkerManifest and the `evt.anatomic.lab.result.*` tasks (02-TRD §9) | T-05, T-14 | `lab_approved_version_no` per 02-TRD §8.2 (`max(item_version_no)` where `lab_version_no` = `result_version_no` / `new_version_no`, then `greatest`) | consumer contract tests: revise twice before approval then approved → `awaiting_lab` empty; amended; duplicate/out-of-order; non-anatomic result → no-op | AC-13.x (awaiting lab) |

## 2. Milestones

| M | Contents | Exit criteria |
|---|---|---|
| M1 "Intake & accession" | T-01–T-08 | cases appear from synthetic C5 events; accession numbering correct; probes for these ops green |
| M2 "Bench" | T-09–T-12 | blocks/slides/stains/movements/images/config working against fakes |
| M3 "Report & hand-off" | T-13–T-17 | sign-out → LabPort fake shows submissions; view rows validated |
| M4 "UI" | T-19–T-23 | all screens with states; axe clean |
| M5 "Chunk gate" | T-18, T-24–T-26 (incl. T-27) | 05-DoD §3 items 1–8 green with real C5/C4/C3/C2 implementations |

## 3. Fake → real switch points

| Dependency | Fake until | Switch when | Integration check |
|---|---|---|---|
| `LabPort` (C5) | M3 | C5 passes its chunk gate incl. A1 contract tests (14)–(20) | sign-out e2e: C5 result `resulted` → verify → approve → `lab.order.ready_for_report.v1` |
| `lab.specimen.status_changed.v1` producer (C5) | M1 (event fixtures) | C5 merged | receive in C5 UI → case appears |
| `FrontdeskPort` (C4) incl. CR-C5-003 purpose/batch | M1 | C4 merged + CR-C5-003 merged | patient header; item inactive scenario |
| `CatalogPort` (C3) | M1 | C3 merged | workflowType routing with real catalog; `usesExistingMaterial` add-on tests (CR-C11-009, accepted) |
| `IdentityPort` (C2) incl. CR-C11-005 numbering | M1 | C2 merged | privileged/aal2 flows; accession pattern from settings |
| upload pipeline / storage (C0) | M2 | CR-C2-011 + CR-C11-008 merged; SP-4 outcome known | real scan/re-encode; EXIF strip test |
| C6 consumption of the view | — (C11 only publishes) | C6 IS-21 (Phase 2) | C6 renders a synthetic anatomic section from C11 rows |

## 4. CR candidates foreseen

Raised now (02-TRD §16): CR-C11-001 … CR-C11-011. Likely later:
- Molecular instrument interfacing (C11 as consumer of `instruments.result.received.v1` for molecular analysers) — only after B2 manuals exist.
- An `anatomic.v_pub_case_daily` view for C8 TAT/volume MIS (accession → sign-out) — when C8 asks.
- Rich-text narrative fields (would change 02-TRD §4.6 and the view text semantics).
- Preliminary anatomic reports (frozen section) — needs a change to 03-IC §4.5 ("anatomic always final").
- C5 option to accept a module result signed by an approver as verified (CR-C11-010 follow-up; client decision Q4).

## 5. Risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| R1 | Double sign-off (C11 sign-out + C5 verify/approve) feels redundant to pathologists | documented in UI copy ("Sent to lab verification"); A1 chain confirmed by 08 R2; client decision C-02 (08 §5.2, default: sign-out does not count as verification) |
| R2 | Amendment reason transport to C5 | closed by 08 R1: `SubmitModuleResultInput.amendment { reasonCode, reasonText? }` and seed `supplementary_report` (C5); no feature gate; C11 always captures a reason; C5 contract cases (22)(23) cover it |
| R3 | Image storage growth (≈91 GB/yr/lab estimate, 02-TRD §11) exceeds the 04 §14 storage line | flagged to C1 for the separately growable object volume (04 I1); `max_images_per_case` setting |
| R4 | Add-on (IHC) billed items and stray C5 specimens | closed by CR-C11-009 (C5 creates add-on results without a specimen); C11 links via `linkAnatomicAddonItem` |
| R5 | Centre-scoped hub staff without `all_centres` cannot see cases | binding provisioning rule 08 A13 D-13(2) applied to anatomic permissions (05-SCHEMA §1); C2 shows the warning; probe tests cover both modes |
| R6 | Labs paste copyrighted protocol text into templates | UI notice (04-UI-UX §4.7); tenant responsibility stated in manual; no protocol content shipped |
| R7 | Patient names typed into image captions or labels | captions are P3 and never logged; UI hint; labels contain only accession-derived text |
| R8 | `ctx.uploads` API shape differs from what C11 assumes | built on 08 §4.13 + A17 P-19 only (`accept`, `files.scan`, `storage.read`); adapter wrapper `image.service` isolates it; contract test with the C0 fake |
| R9 | Order changes not pushed to C11 (no `items_changed` consumer) | live check at detail and sign-out (`anatomic.order_item_inactive`) |
| R10 | Label printers cannot scan Code 128 with hyphens | validate per site (ASSUMPTION); text labels always printed |
