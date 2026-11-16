# TESTFIX-1 (LD-268): three known red unit tests + list of other reds

All three were STALE expectations or a detector false positive. No REAL defect, so no CR. No policy, grant, migration or contract edit.

| test | class | evidence | fix (test files only) |
|---|---|---|---|
| identity `role-packs/route-guard.test.ts` "the shell filters nav by the actor permissions (AppShell.tsx)" | STALE | T0D-MSERIES-2 impl 9f4e6a46a (LD-251) rewrote `AppShell.tsx`: nav comes from the generated manifest, filtered per rail group with `perms = session.actor.permissions`. The permission filter is still there, only its text changed. | regex now checks the `navEntries` import from `../nav/generated`, the `perms` binding and the `hasPermission(perms, e.permission)` filter. Still fails if the filter is removed. |
| identity `security/static.security.test.ts` "no identity test disables RLS or stands in an RLS-less table" | STALE (detector false positive) | the guard regex `ALTER TABLE[^;`'"]*DISABLE ROW LEVEL` matched the TITLE of a test in `platform-ddl-1.static.test.ts` (PLATFORM-DDL-1, 81cd1199a), which lists the banned words ("ALTER TABLE / GRANT / ... / DISABLE ROW LEVEL SECURITY"). It is not a statement. | title reworded to "turning row level security off". The guard in static.security is untouched; the PLATFORM-DDL-1 assertions (`/disable\s+row/i` etc.) are untouched. |
| web `features/admin/__tests__/rs-c2.static.test.ts` "data ... files are untouched" + "same route files" | STALE baseline | baseline `rs-c2.baseline.json` last refreshed in 59b20a582 (T0D-MSERIES-2 tests, 2026-11-16 07:51). Since then: `features/admin/auth/actions.ts` gained `refreshSessionStateAction` (AUTH-MFA-PERSIST-1 impl 5b78ce4c6, LD-248); route files `app/(auth)/auth/page.tsx` (WEB-STYLE-1 3e620e182) and `app/(auth)/layout.tsx` (T0D-MSERIES-2 9f4e6a46a) were never recorded. api_paths, permission_codes, field_names unchanged (those tests were already green). | baseline hash for `auth/actions.ts` and the two route entries updated by hand (equal to what `RS_C2_RECORD=1` would write for these keys). |

Result after fix: route-guard + static.security + platform-ddl-1.static: 3 files, 221 tests pass (api). rs-c2.static: 14 tests pass (web).

## Other tests that fail (names only; one full run each, 2026-11-16)
Not fixed here (VERIFY-GREEN-5..9 and T0B-GREEN own them). Many api entries are DB-backed (frontdesk, homecollection, `*.live`): not classified here.

### api (services/api): 43463 tests, 42 failed, 84 failed files. Run takes > 25 min on this machine.
See list below.

### web (apps/web): 8397 tests, 5002 failed, 1103 failed suites; 261 failed files.
Causes by file count: assertion failures 183; unresolved import 36 (`@/core/shortcuts/registry`, `@/core/api/server-fetch`, `@/core/session/bff-key`, `@/app/(auth)/layout`, `@/app/(staff)/catalog/departments/page`, `@/features/billing/components/DailyCashView`, `@/features/portal/actions`); Playwright specs collected by vitest 32; `React is not defined` 4; no test suite found 5; hook timeout 1 (`web-auth-redirect-server.test.ts`).
Also red (not in the three named): `build-boundaries`, `build-config`, `web-style-2`, `web-style-4`, `m2.sidebar`, `r04.*`, `nav-complete.admin-pack`, `bff-key`, `root-page.audit-small-1`.
Full names are in the two sections below.

---

# api failing files
## assertion failures (84 files)
- src/core/pipeline/__tests__/bff-session.test.ts
- src/modules/analytics/__tests__/boot.test.ts
- src/modules/anatomic/__tests__/boot.test.ts
- src/modules/engagement/__tests__/boot.test.ts
- src/modules/homecollection/__tests__/boot.test.ts
- src/modules/inventory/__tests__/boot.test.ts
- src/modules/smartreport/__tests__/SmartReportPort.phase1stub.contract.test.ts
- src/modules/reporting/__tests__/repository.static.test.ts
- src/modules/reporting/__tests__/settings.handlers.test.ts
- src/modules/frontdesk/__tests__/admin/anonymise.test.ts
- src/modules/frontdesk/__tests__/admin/codes.test.ts
- src/modules/frontdesk/__tests__/admin/duplicates.test.ts
- src/modules/frontdesk/__tests__/admin/settings.test.ts
- src/modules/frontdesk/__tests__/approvals/consume.test.ts
- src/modules/frontdesk/__tests__/approvals/decide.test.ts
- src/modules/frontdesk/__tests__/approvals/inbox.test.ts
- src/modules/frontdesk/__tests__/approvals/request.test.ts
- src/modules/frontdesk/__tests__/consumers/booking.test.ts
- src/modules/frontdesk/__tests__/consumers/catalog.test.ts
- src/modules/frontdesk/__tests__/consumers/confirm.test.ts
- src/modules/frontdesk/__tests__/consumers/flags.test.ts
- src/modules/frontdesk/__tests__/consumers/recollection.test.ts
- src/modules/frontdesk/__tests__/orderchange/cancel.test.ts
- src/modules/frontdesk/__tests__/orderchange/change.test.ts
- src/modules/frontdesk/__tests__/integration/registration.billing-real.test.ts
- src/modules/frontdesk/__tests__/integration/repositories.test.ts
- src/modules/frontdesk/__tests__/contract/FrontdeskPort.booking.contract.test.ts
- src/modules/frontdesk/__tests__/contract/FrontdeskPort.contract.test.ts
- src/modules/frontdesk/__tests__/patients/create.test.ts
- src/modules/frontdesk/__tests__/patients/read-update.test.ts
- src/modules/frontdesk/__tests__/patients/search.test.ts
- src/modules/frontdesk/__tests__/orders/derived.test.ts
- src/modules/frontdesk/__tests__/orders/read.test.ts
- src/modules/frontdesk/__tests__/probes/crossCentre.live.test.ts
- src/modules/frontdesk/__tests__/probes/crossTenant.live.test.ts
- src/modules/frontdesk/__tests__/probes/phi.logscan.live.test.ts
- src/modules/frontdesk/__tests__/probes/privilege.live.test.ts
- src/modules/frontdesk/__tests__/probes/tables.live.test.ts
- src/modules/frontdesk/__tests__/probes/uploads.live.test.ts
- src/modules/frontdesk/__tests__/registration/downtime.test.ts
- src/modules/frontdesk/__tests__/registration/registration.test.ts
- src/modules/frontdesk/__tests__/registration/rollback.test.ts
- src/modules/frontdesk/__tests__/unit/boot.test.ts
- src/modules/frontdesk/__tests__/trf/content.test.ts
- src/modules/frontdesk/__tests__/trf/upload.test.ts
- src/modules/frontdesk/__tests__/quote/quote.test.ts
- src/modules/homecollection/repository/__tests__/repositories.test.ts
- src/modules/homecollection/repository/__tests__/static.test.ts
- src/modules/homecollection/__tests__/devices/register.test.ts
- src/modules/homecollection/__tests__/devices/signoff.test.ts
- src/modules/homecollection/__tests__/dispatch/assign.test.ts
- src/modules/homecollection/__tests__/dispatch/revisit.test.ts
- src/modules/homecollection/__tests__/dispatch/route.test.ts
- src/modules/homecollection/__tests__/dispatch/schedule.test.ts
- src/modules/homecollection/__tests__/observability/logscan.live.test.ts
- src/modules/homecollection/__tests__/devadmin/list.test.ts
- src/modules/homecollection/__tests__/devadmin/wipe.test.ts
- src/modules/homecollection/__tests__/handovers/confirm.test.ts
- src/modules/homecollection/__tests__/handovers/read.test.ts
- src/modules/homecollection/__tests__/settings/reasons.test.ts
- src/modules/homecollection/__tests__/settings/settings.test.ts
- src/modules/homecollection/__tests__/review/review.test.ts
- src/modules/homecollection/__tests__/visits/phone.test.ts
- src/modules/homecollection/__tests__/visits/routes.test.ts
- src/modules/homecollection/__tests__/visits/visit.detail.test.ts
- src/modules/homecollection/__tests__/visits/visits.list.test.ts
- src/modules/homecollection/__tests__/snapshot/ack.test.ts
- src/modules/homecollection/__tests__/snapshot/perf.test.ts
- src/modules/homecollection/__tests__/snapshot/settings.test.ts
- src/modules/homecollection/__tests__/snapshot/snapshot.test.ts
- src/modules/homecollection/__tests__/sync/dedupe.test.ts
- src/modules/homecollection/__tests__/sync/effects.test.ts
- src/modules/homecollection/__tests__/sync/guards.test.ts
- src/modules/identity/__tests__/role-packs/apply-role-pack.script.test.ts
- src/modules/micro/__tests__/probes/ci-grep.probes.test.ts
- src/modules/micro/__tests__/probes/spec.probes.test.ts
- src/modules/lab/handlers/__tests__/approve.handlers.test.ts
- src/modules/lab/handlers/__tests__/critical.handlers.test.ts
- src/modules/lab/handlers/__tests__/history.handlers.test.ts
- src/modules/lab/handlers/__tests__/ingestException.handlers.test.ts
- src/modules/lab/handlers/__tests__/resultEntry.handlers.test.ts
- src/modules/lab/handlers/__tests__/verify.handlers.test.ts
- src/modules/lab/service/__tests__/critical.service.test.ts
- src/modules/payments/__tests__/unit/manifest.test.ts


# web failing files
## assertion failures (183 files)
- src/__tests__/build-boundaries.test.ts
- src/__tests__/build-config.test.ts
- src/__tests__/web-style-2.test.ts
- src/__tests__/web-style-4.test.ts
- src/app/__tests__/root-page.audit-small-1.test.ts
- src/core/nav/__tests__/nav-complete.admin-pack.test.ts
- src/core/session/__tests__/bff-key.test.ts
- src/core/shell/__tests__/m2.sidebar.test.tsx
- src/core/shell/__tests__/r04.keys.test.tsx
- src/core/shell/__tests__/r04.search.test.tsx
- src/core/shell/__tests__/r04.shell.test.tsx
- src/features/analytics/__tests__/an-t17.export.test.tsx
- src/features/analytics/__tests__/an-t17.scope.test.tsx
- src/features/analytics/__tests__/an-t18.states.test.tsx
- src/features/analytics/__tests__/an-t20.exports.test.tsx
- src/features/analytics/__tests__/an-t20.referral.test.tsx
- src/features/analytics/__tests__/an-t20.schedules.test.tsx
- src/features/analytics/__tests__/rs-c8.screens.admin.test.tsx
- src/features/billing/__tests__/bl-t20.screens.test.tsx
- src/features/anatomic/__tests__/t19.nav.test.ts
- src/features/anatomic/__tests__/t19.pages.test.tsx
- src/features/anatomic/__tests__/t20.images.test.tsx
- src/features/anatomic/__tests__/t20.labels.test.tsx
- src/features/anatomic/__tests__/t21.changes.test.tsx
- src/features/anatomic/__tests__/t21.editor.test.tsx
- src/features/anatomic/__tests__/t21.signout.test.tsx
- src/features/anatomic/__tests__/t21.synoptic.test.tsx
- src/features/anatomic/__tests__/t22.batches.test.tsx
- src/features/anatomic/__tests__/t23.builder.test.tsx
- src/features/anatomic/__tests__/t23.config.test.tsx
- src/features/admin/__tests__/t20.audit-sessions.test.tsx
- src/features/admin/__tests__/t20.roles-org.test.tsx
- src/features/admin/__tests__/t20.settings.test.tsx
- src/features/admin/__tests__/t20.users.test.tsx
- src/features/catalog/__tests__/rs-c3.screens.test.tsx
- src/features/catalog/__tests__/web-t31.server.test.ts
- src/features/catalog/__tests__/web-t32.components.test.tsx
- src/features/catalog/__tests__/web-t32.server.test.ts
- src/features/catalog/__tests__/web-t33.components.test.tsx
- src/features/catalog/__tests__/web-t33.server.test.ts
- src/features/catalog/__tests__/web-t34.components.test.tsx
- src/features/catalog/__tests__/web-t34.server.test.ts
- src/features/catalog/__tests__/web-t35.components.test.tsx
- src/features/catalog/__tests__/web-t35.flow.test.tsx
- src/features/catalog/__tests__/web-t35.polling.test.tsx
- src/features/catalog/__tests__/web-t35.server.test.ts
- src/features/engagement/__tests__/adminpage-eng-1.baseline.test.ts
- src/features/engagement/__tests__/adminpage-eng-1.settings.test.tsx
- src/features/engagement/__tests__/t-l1.app-access.test.tsx
- src/features/frontdesk/__tests__/adminpage-fd-1.settings.test.tsx
- src/features/frontdesk/__tests__/fd-t13.keyboard.test.tsx
- src/features/frontdesk/__tests__/fd-t13.states.test.tsx
- src/features/frontdesk/__tests__/fd-t14.order.test.tsx
- src/features/frontdesk/__tests__/fd-t14.pages.test.tsx
- src/features/frontdesk/__tests__/fd-t14.screens.test.tsx
- src/features/frontdesk/__tests__/rs-c4.ledger.test.tsx
- src/features/frontdesk/__tests__/rs-c4.register.test.tsx
- src/features/instruments/__tests__/h80-t06.components.test.tsx
- src/features/instruments/__tests__/met-t05.components.test.tsx
- src/features/instruments/__tests__/rs-c7.screens.test.tsx
- src/features/instruments/__tests__/web-t02.server.test.ts
- src/features/instruments/__tests__/web-t03.server.test.ts
- src/features/instruments/__tests__/web-t04.components.test.tsx
- src/features/instruments/__tests__/web-t04.server.test.ts
- src/features/instruments/__tests__/web-t05.server.test.ts
- src/features/instruments/__tests__/web-t06.components.test.tsx
- src/features/instruments/__tests__/web-t06.server.test.ts
- src/features/inventory/__tests__/t20.alerts.test.tsx
- src/features/inventory/__tests__/t20.home.test.tsx
- src/features/inventory/__tests__/t20.settings.test.tsx
- src/features/inventory/__tests__/t21.items.test.tsx
- src/features/inventory/__tests__/t21.stores.test.tsx
- src/features/inventory/__tests__/t21.suppliers.test.tsx
- src/features/inventory/__tests__/t22.purchasing.test.tsx
- src/features/inventory/__tests__/t22.receipts.test.tsx
- src/features/inventory/__tests__/t23.bench.test.tsx
- src/features/inventory/__tests__/t23.counts.test.tsx
- src/features/inventory/__tests__/t23.stock.test.tsx
- src/features/inventory/__tests__/t23.transfers.test.tsx
- src/features/inventory/__tests__/t24.export.test.ts
- src/features/inventory/__tests__/t24.reports.test.tsx
- src/features/inventory/__tests__/t24.rules.test.tsx
- src/features/inventory/__tests__/t24.unresolved.test.tsx
- src/features/homecollection/__tests__/hc-t18.dialogs.test.tsx
- src/features/homecollection/__tests__/hc-t18.page.test.tsx
- src/features/homecollection/__tests__/hc-t18.source.test.ts
- src/features/homecollection/__tests__/hc-t19.detail.test.tsx
- src/features/homecollection/__tests__/hc-t19.page.test.tsx
- src/features/homecollection/__tests__/hc-t19.review.test.tsx
- src/features/homecollection/__tests__/hc-t20.devices.test.tsx
- src/features/homecollection/__tests__/hc-t20.handover.test.tsx
- src/features/homecollection/__tests__/hc-t20.pages.test.tsx
- src/features/homecollection/__tests__/hc-t20.settings.test.tsx
- src/features/lab/__tests__/adminpage-lab-1.critical-values.test.tsx
- src/features/lab/__tests__/adminpage-lab-1.worklists.test.tsx
- src/features/lab/__tests__/c5-t18.comment-cell.test.tsx
- src/features/lab/__tests__/c5-t20.pages.test.tsx
- src/features/lab/__tests__/c5-t21.pages.test.tsx
- src/features/lab/__tests__/c5-t23.pages.test.tsx
- src/features/lab/__tests__/lab-t10.label-page.test.tsx
- src/features/lab/__tests__/lab-t11.collect.test.tsx
- src/features/lab/__tests__/lab-t11.pages.test.tsx
- src/features/lab/__tests__/lab-t11.receive.test.tsx
- src/features/lab/__tests__/lab-t11.static.test.ts
- src/features/lab/__tests__/lab-t25.holds.test.tsx
- src/features/lab/__tests__/lab-t25.page.test.tsx
- src/features/lab/__tests__/lab-t25.qc.test.tsx
- src/features/lab/__tests__/lab-t26.worklists.test.tsx
- src/features/lab/__tests__/lab-t27.board.test.tsx
- src/features/lab/__tests__/lab-t27.page.test.tsx
- src/features/lab/__tests__/lab-t29.page.test.tsx
- src/features/lab/__tests__/lab-t29.settings.test.tsx
- src/features/lab/__tests__/lab-t30.detail.test.tsx
- src/features/lab/__tests__/lab-t30.page.test.tsx
- src/features/lab/__tests__/rs-c5.behaviour.test.tsx
- src/features/lab/__tests__/rs-c5.screens.test.tsx
- src/features/lab/__tests__/rs-c5.static.test.ts
- src/features/micro/__tests__/t19.pages.test.tsx
- src/features/micro/__tests__/t20.isolates.test.tsx
- src/features/micro/__tests__/t20.page.test.tsx
- src/features/micro/__tests__/t20.reads.test.tsx
- src/features/micro/__tests__/t20.setup.test.tsx
- src/features/micro/__tests__/t21.grid.test.tsx
- src/features/micro/__tests__/t21.keyboard.test.tsx
- src/features/micro/__tests__/t21.preview.test.tsx
- src/features/micro/__tests__/t21.save.test.tsx
- src/features/micro/__tests__/t22.bff.test.ts
- src/features/micro/__tests__/t22.reopen.test.tsx
- src/features/micro/__tests__/t22.reports.test.tsx
- src/features/micro/__tests__/t23.assign.test.tsx
- src/features/micro/__tests__/t23.page.test.tsx
- src/features/micro/__tests__/t23.resolve.test.tsx
- src/features/micro/__tests__/t23.tab.test.tsx
- src/features/micro/__tests__/t24.breakpoint-detail.test.tsx
- src/features/micro/__tests__/t24.breakpoint-list.test.tsx
- src/features/micro/__tests__/t24.breakpoint-polling.test.tsx
- src/features/micro/__tests__/t24.settings.test.tsx
- src/features/platform/__tests__/t26.ops.test.tsx
- src/features/platform/__tests__/t26.tenants.test.tsx
- src/features/partners/__tests__/t16.partners.test.tsx
- src/features/partners/__tests__/t16.queues.test.tsx
- src/features/partners/__tests__/t16.receive.test.tsx
- src/features/reporting/__tests__/c6-t31.pages.test.tsx
- src/features/reporting/__tests__/rs-c6.screens.test.tsx
- src/features/payments/__tests__/pg-t18.detail.test.tsx
- src/features/payments/__tests__/pg-t18.review.test.tsx
- src/features/payments/__tests__/pg-t19.recon.test.tsx
- src/features/payments/__tests__/pg-t19.refunds.test.tsx
- src/features/payments/__tests__/pg-t19.settings.test.tsx
- src/features/payments/__tests__/pg-t19.staticqr.test.tsx
- src/features/payments/__tests__/rs-c15.behaviour.test.tsx
- src/features/payments/__tests__/rs-c15.screens.test.tsx
- src/features/quality/__tests__/quality-t21.board.test.tsx
- src/features/quality/__tests__/quality-t21.lj.test.tsx
- src/features/quality/__tests__/quality-t21.polling.test.tsx
- src/features/quality/__tests__/quality-t21.rundetail.test.tsx
- src/features/quality/__tests__/quality-t22.maps.test.tsx
- src/features/quality/__tests__/quality-t22.materials.test.tsx
- src/features/quality/__tests__/quality-t22.plans.test.tsx
- src/features/quality/__tests__/quality-t22.targets.test.tsx
- src/features/quality/__tests__/quality-t24.polling.test.tsx
- src/features/quality/__tests__/quality-t24.settings.test.tsx
- src/features/quality/__tests__/quality-t24.tat.test.tsx
- src/features/smartreport/__tests__/sr-t18.chrome.test.tsx
- src/features/smartreport/__tests__/sr-t18.keyboard.test.tsx
- src/features/smartreport/__tests__/sr-t18.queue.test.tsx
- src/features/smartreport/__tests__/sr-t19.review.test.tsx
- src/features/smartreport/__tests__/sr-t20.editor.test.tsx
- src/features/smartreport/__tests__/sr-t20.library.test.tsx
- src/features/smartreport/__tests__/sr-t20.mapping-rules.test.tsx
- src/features/smartreport/__tests__/sr-t20.texts.test.tsx
- src/features/smartreport/__tests__/sr-t21.preview.test.tsx
- src/features/smartreport/__tests__/sr-t21.review.test.tsx
- src/features/smartreport/__tests__/sr-t21.wording.test.tsx
- src/features/smartreport/__tests__/sr-t29.llm-panel.test.tsx
- src/features/admin/roles/__tests__/rm-t05.screen.test.tsx
- src/app/(staff)/engagement/enquiries/__tests__/t-n1.enquiries.test.tsx
- src/app/(staff)/engagement/reminders/__tests__/t-r2.reminders.test.tsx
- src/app/(staff)/engagement/memberships/__tests__/t-m1.memberships.test.tsx
- src/app/(staff)/quality/autoverify/__tests__/av-t23.decisions.test.tsx
- src/app/(staff)/quality/autoverify/__tests__/av-t23.editor.test.tsx
- src/app/(staff)/quality/autoverify/__tests__/av-t23.overview.test.tsx
- src/app/(staff)/quality/autoverify/__tests__/av-t23.simulation.test.tsx

## hook timeout (1 files)
- src/__tests__/web-auth-redirect-server.test.ts

## playwright spec collected by vitest (harness) (32 files)
- tests/e2e/analytics/AN-T20.analytics.spec.ts
- tests/e2e/engagement/T-Q5.queue-display.spec.ts
- tests/e2e/catalog/C3.T-32.catalog.spec.ts
- tests/e2e/catalog/C3.T-34.catalog.spec.ts
- tests/e2e/catalog/C3.T-35.imports.spec.ts
- tests/e2e/homecollection/HC-T18.dispatch.spec.ts
- tests/e2e/homecollection/HC-T19.visit.spec.ts
- tests/e2e/identity/C2.T12.auth.spec.ts
- tests/e2e/identity/C2.T20.admin.spec.ts
- tests/e2e/identity/C2.T26.platform.spec.ts
- tests/e2e/identity/RM-T05.role-packs.spec.ts
- tests/e2e/instruments/H80-T06.preset.spec.ts
- tests/e2e/instruments/MET-T05.preset.spec.ts
- tests/e2e/inventory/C12.T-21.master-data.spec.ts
- tests/e2e/inventory/C12.T-22.purchasing-receiving.spec.ts
- tests/e2e/inventory/C12.T-23.stock-operations.spec.ts
- tests/e2e/inventory/C12.T-24.rules-unresolved-reports.spec.ts
- tests/e2e/lab/C5.T-10.labels.spec.ts
- tests/e2e/lab/C5.T-11.collect-receive.spec.ts
- tests/e2e/lab/C5.T-20.result-grid.spec.ts
- tests/e2e/lab/C5.T-21.verification-approval.spec.ts
- tests/e2e/lab/C5.T-34.journeys.spec.ts
- tests/e2e/micro/C10.T-19.worklist.spec.ts
- tests/e2e/partners/C13-T16.receive.spec.ts
- tests/e2e/reporting/C6.T-31.reporting.spec.ts
- tests/e2e/quality/C9.T-27.quality.spec.ts
- tests/e2e/smartreport/SR-T19.review.spec.ts
- tests/e2e/smartreport/SR-T24.journey.spec.ts
- tests/e2e/shell/T0D-MSERIES-2.shell.spec.ts
- tests/e2e/shell/T0D-MSERIES-4.shell.spec.ts
- tests/e2e/shell/T0D-UI-R04.shell.spec.ts
- src/features/homecollection/tests/e2e/HC-T30.nightly.spec.ts

## missing module (import unresolved) (36 files)
- src/features/analytics/__tests__/an-t18.page.test.tsx
- src/features/analytics/__tests__/an-t19.hub.test.tsx
- src/features/analytics/__tests__/an-t19.reports.test.tsx
- src/features/analytics/__tests__/an-t19.specifics.test.tsx
- src/features/analytics/__tests__/an-t20.runs.test.tsx
- src/features/analytics/__tests__/rs-c8.dashboard.test.tsx
- src/features/analytics/__tests__/rs-c8.screens.test.tsx
- src/features/anatomic/__tests__/t19.case.test.tsx
- src/features/anatomic/__tests__/t19.worklist.test.tsx
- src/features/anatomic/__tests__/t20.material.test.tsx
- src/features/anatomic/__tests__/t20.tracking.test.tsx
- src/features/anatomic/__tests__/t22.molecular.test.tsx
- src/features/catalog/__tests__/web-t31.components.test.tsx
- src/features/engagement/__tests__/t-b6.bookable.test.tsx
- src/features/engagement/__tests__/t-b6.bookings.test.tsx
- src/features/engagement/__tests__/t-b6.slots.test.tsx
- src/features/engagement/__tests__/t-q4.console.test.tsx
- src/features/engagement/__tests__/t-q4.setup.test.tsx
- src/features/frontdesk/__tests__/rs-c4.screens.test.tsx
- src/features/instruments/__tests__/rs-c7.behaviour.test.tsx
- src/features/instruments/__tests__/web-t02.components.test.tsx
- src/features/instruments/__tests__/web-t03.components.test.tsx
- src/features/instruments/__tests__/web-t05.components.test.tsx
- src/features/homecollection/__tests__/hc-t18.board.test.tsx
- src/features/lab/__tests__/c5-t20.grid.test.tsx
- src/features/lab/__tests__/c5-t21.queues.test.tsx
- src/features/lab/__tests__/c5-t23.exceptions.test.tsx
- src/features/micro/__tests__/t19.worklist.test.tsx
- src/features/micro/__tests__/t20.keyboard.test.tsx
- src/features/micro/__tests__/t21.screen.test.tsx
- src/features/micro/__tests__/t22.compose.test.tsx
- src/features/reporting/__tests__/c6-t31.screens.test.tsx
- src/features/reporting/__tests__/rs-c6.portal.test.tsx
- src/features/admin/auth/__tests__/m2.entry.test.tsx
- src/features/admin/auth/__tests__/t12.actions.test.ts
- src/features/admin/auth/__tests__/t12.mfa-409.actions.test.ts

## no test suite found (5 files)
- src/features/analytics/__tests__/nav.manifest.test.ts
- src/features/instruments/__tests__/web-t01.test.ts
- src/features/micro/__tests__/nav.manifest.test.ts
- src/features/partners/__tests__/nav.manifest.test.ts
- src/features/quality/__tests__/nav.manifest.test.ts

## React is not defined (harness) (4 files)
- src/features/admin/__tests__/rs-c2.screens.test.tsx
- src/features/admin/auth/__tests__/t12.forms.test.tsx
- src/features/admin/auth/__tests__/t12.mfa-409.test.tsx
- src/features/admin/auth/__tests__/t12.mfa-qr.test.tsx

