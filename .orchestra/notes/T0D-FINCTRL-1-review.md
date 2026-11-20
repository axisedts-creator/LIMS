CHANGES

Reviewed `git diff 4246a23a..HEAD` (28 product files plus notes). Ran finctrl1 390/390, fd-t13 70/70 and rs-c2 74/74, all green. The BFF paths, methods, bodies, Idempotency-Key and If-Match match contracts/openapi/billing.yaml (T0C-FINCTRL-1 operations). The routes, nav entries and permission codes match LD-321. Nothing is under admin, platform or (auth). No PHI and no secrets.

1. apps/web/src/app/(staff)/billing/discounts/limits/page.tsx:15 and authorities/page.tsx:15 (via accounts.server.ts:118 `listMembers`). Limits and authorities are keyed by the wrong id.
   - The API keys them on `user_id` = core.users.id: services/api/src/modules/billing/repository/discountPolicy.repo.ts:96, discountPolicy.service.ts:272 `userOrNotFound`, and frontdesk discountApprovals.repo.ts:58 `l.user_id = m.user_id`.
   - `listMembers` returns `membership_id` instead. The identity UserPage (contracts/openapi/identity.yaml:951) carries no user id at all.
   - Effect: PUT /v1/billing/discount-limits/{membership_id} and POST discount-authorities send a membership id. The server answers common.not_found, or the row never matches a requester. Every existing row also shows "—" in the User column.
   - The MSW tests pass only because the mocks use one id for both.
   - Fix: write `.orchestra/cr/T0D-FINCTRL-1.md` (template in spec/program/04-CHANGE-REQUESTS.md). It should ask for one of two things: either the identity UserPage exposes `user_id`, or the billing limit and authority operations take and return `membership_id`. Until the ruling, Add New and Edit on both screens must stay disabled, with a visible reason (a new catalogue key). Then add a test that the screens send the id the API is keyed on.

2. apps/web/src/app/(staff)/billing/daily-cash/page.tsx:20 together with DailyCollectionScreen.tsx:807-811. When `getDailyCash` fails (for example without billing.cash_report.read), the page passes `[]`. The screen then shows Previous Outstanding Cash 0.00, Deposit 0.00 and Carried forward = the cash total. Those are invented money figures.
   - Fix: on a refused read, pass `sessions={null}` (`.then((r) => r.sessions ?? [], () => null)`).
   - In the screen, when `sessions === null`, show "—" and a not available line (catalogue key) for the three figures instead of computing them.
   - Keep 0.00 for an undefined prop, as the existing test pins it, and add one test for the null case.

3. done_when (6), the fiscal year filter on the ledger STATEMENT, is not delivered. getAccountStatement has no `fiscal_year_label` parameter, and T0B-FINCTRL-1-impl.md:7 item 4 only notes "CR NEEDED". No CR file exists in .orchestra/cr.
   - Fix: add this as a second item in the same `.orchestra/cr/T0D-FINCTRL-1.md`: a `fiscal_year_label` query parameter on getAccountStatement. Then list it as open in T0D-FINCTRL-1-impl.md.
