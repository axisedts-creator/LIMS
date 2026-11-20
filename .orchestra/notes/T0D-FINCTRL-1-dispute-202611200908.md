# T0D-FINCTRL-1 dispute (writer)
Test: finctrl1.source.test.ts > "no route is added, renamed or removed under admin or platform; only the four /billing/discounts rows are new".
Why it is wrong: it collects every staff_web route whose path matches /discount/i and expects exactly the four new /billing/discounts/* rows, but
contracts/routes.yaml already holds `staff.frontdesk.discount_approvals` (/frontdesk/discount-approvals, owner C4, existed before this task, untouched).
Received: the four new paths + "/frontdesk/discount-approvals". The implementation adds exactly the four rows the brief names; no other route changed.
Proposed fix (tester): match the new rows only, e.g. `/^\/billing\/discounts?\b/` (or `x.path.startsWith('/billing/')` with /discount/i), so the
pre-existing frontdesk route is not counted. Everything else in the T0D-FINCTRL-1 suite passes (389 of 390).
