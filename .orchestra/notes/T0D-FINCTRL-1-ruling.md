TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)

Reasons:
- Brief (.orchestra/inbox/T0D-FINCTRL-1-arbiter.md:21) requires new routes billing/discounts/reasons, slabs, limits, authorities and "do not add, rename or remove routes under admin or platform". It does not require that no other staff_web route anywhere contain "discount".
- contracts/routes.yaml:216 `staff.frontdesk.discount_approvals` (/frontdesk/discount-approvals, owner C4) already exists on main (`git show main:contracts/routes.yaml` line 216); `git diff main -- contracts/routes.yaml` shows only the four /billing/discounts/* rows added, nothing removed or renamed.
- finctrl1.source.test.ts:56 filters by `/discount/i` on all staff_web paths, so it counts that pre-existing frontdesk route and fails on correct code.

Change in the test (apps/web/src/features/billing/__tests__/finctrl1.source.test.ts:56): restrict the filter to the new billing area, e.g.
  `routes.filter((x) => x.origin === 'staff_web' && x.path.startsWith('/billing/') && /discount/i.test(x.path))`
and keep the `toEqual([...NEW].sort())` assertion. Optionally also assert `/frontdesk/discount-approvals` is still present (unchanged pre-existing route). Do not weaken the admin/platform guard.
