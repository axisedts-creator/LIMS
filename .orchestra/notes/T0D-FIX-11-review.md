CHANGES
Scope reviewed: `git diff 2109ee577..HEAD`. Paths owned (apps/web staff routes/features, core i18n and packages/ui are C0-0D, same chunk C0). No quality/ files touched, no PHI and no secrets, synthetic data only. Names are verbatim (common.feature_disabled, auth.forbidden, billing.cash_report.read). No new permission, no migration, no contract change. Dues, status-board and analytics report-page are fine. Both defects below are on /billing/daily-cash, which is one of this task's screens. done_when 4 / LD-455 rule 3 says "a failed api call shows the kit inline error with the reference inside the section".

1. apps/web/src/app/(staff)/billing/daily-cash/page.tsx:30. The cash-sessions read `getDailyCash({ date: day, centreId }).then(..., () => null)` turns EVERY failure (400, 500) into `null`. DailyCollectionScreen.tsx:116 then shows `billing.daily_summary.sessions_unavailable` ("...you need the billing.cash_report.read permission"). For a 400 or 500 that message is false, and the reference is lost.
   Fix: in the rejection handler, return `null` only for `e instanceof ApiError && e.status === 403`. For any other ApiError, return `{ err: refOf(e) }`, and pass it as a new optional prop `sessionsError?: { requestId?: string }`. When that prop is set, DailyCollectionScreen renders `<ErrorState title={D('load_failed')} requestId=... />` in place of the sessions_unavailable line, and Previous Outstanding, Deposit and Carried Forward show "—". Add a test to fix11.billing.test.tsx with a mocked 400 and a mocked 500 on this read: one inline error with REF, and no "you need the billing.cash_report.read permission" text.

2. apps/web/src/app/(staff)/billing/daily-cash/page.tsx:23 and :40. Two reads on this screen are not handled:
   - `getMyCashSession()`: a non-404 ApiError still rethrows.
   - `collection()` → `listAccountParticulars()`: not wrapped in `soft`.
   Either failure rejects the page-level Promise.all and lands on error.tsx (full error page), not on the inline error with the reference.
   Fix:
   - (a) `getMyCashSession().catch((e) => ({ failed: refOf(e) }))`, and return `<LoadError title={t('nav.billing.daily_cash')} {...failed} />` like `report`. Alternatively, show the error in place of the MyShift section.
   - (b) In `collection()`, catch an ApiError from `Promise.all([listAccountParties(), listAccountParticulars()])` and return `{ summary: null, summaryError: refOf(e), centres: [], centreId: undefined, day, particulars: [], sessions: [] }`. The collection section then shows its ErrorState.
   - Add the mocked 400 and 500 tests for both reads to fix11.billing.test.tsx.

Notes (not defects of this diff, already recorded): rs-c8.static baseline for report-page.tsx needs a lead re-baseline (left.md). The verify run had a vitest worker start timeout on bl-t20 (infra, see debug.md). Re-run verify after the fixes.
