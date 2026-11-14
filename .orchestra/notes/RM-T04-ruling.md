TESTS_WRONG — in escalation.test.ts, OVERLAY['frontdesk.discount.approve'] must be ACCOUNTS plus `corp_admin` and `std_admin`; the per-role "R2 ... held only by overlay roles" and "API refuses a decision authority to every role outside the overlay" checks then pass unchanged. Keep billing.refund.approve / billing.payment.reverse / billing.invoice.cancel as Accounts-only.

Reasons:
- spec/program/11-ROLE-MATRIX.md:224 (D3 default): "`corp_accounts` plus Admin (discount approve only)". LD-141 (task brief): D1-D12 defaults stand until a lead decision changes them. So the overlay's discount-approve holders include both Admin templates.
- 11-ROLE-MATRIX.md:18 (R5): Admin = `tenant_admin` ∪ ticked screens; contracts/permissions.yaml:74 grants `frontdesk.discount.approve` to `tenant_admin`. Admin therefore holds it through its base role, not through a menu tick, so R2 (11-ROLE-MATRIX.md:15) is not breached.
- R5 forbids only clinical sign-off for Admin (11-ROLE-MATRIX.md:18, :29). Discount approve is financial, not clinical.
- §9 appendix (source of truth per CR-C2-RM-002, :49) lists `frontdesk.discount.approve`* for `corp_admin` (:248) and `std_admin` (:458). The data file is copied unchanged (LD-141) and agrees.
- The §3 overlay prose (:49) names only Accounts for discount approve. D3 explicitly adds Admin for discount approve only, so these do not conflict and no CR is needed.
- No implementation or data change. Admin must still not hold refund approve, payment reverse or invoice cancel (D3 "discount approve only"). The test already asserts that.
