# T0D-UILIST-2 impl (writer)
Files: billing invoices/entries/ledger/pocket/summary/credit-parties/registers/audit-trail/cbms/worklist (components + page.tsx, billing.css, format.tsx, listRead.ts, accounts.server.ts); payments ReconciliationView, StaticQrView, labels.tsx (cellMoney), pages; frontdesk FrontdeskWorklist, DiscountApprovalsInbox, RegistrationForm, frontdesk.css (30 px controls), worklist + discount-approvals pages; rs-c15 + rs-c4 screen .snap regenerated (LD-362).
[CONV] money cells = bare "1,500.00" in .lims-money, "(NPR)" in the header; payments uses string slicing (pg-t18.source). [CONV] StaticQrView uses usePathname() (rs-c15.static route baseline).
[CONV] 501 operation_pending = NotAvailable with header columns; 500+ = DataTable error (message, reference, Retry), title + filters kept.
Round 3 (after ruling 10:39, tester helper fix c3f026498): no source change needed. uilist2 63/63, web-style-3 101/101, elabmenu 99/99. main already merged (HEAD..main = 0).
Shell reds, pre-existing, not this task: r04.source motion x1, m2.source drawer motion x1 (this branch has no commit under apps/web/src/core or packages/ui).
Open: account summary list handler T0B-ACCTLIST-1 (NotAvailable until then).
