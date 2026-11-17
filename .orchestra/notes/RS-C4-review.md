APPROVE

RS-C4 review (diff fa534ee1..HEAD; LD-140, LD-170).

Checked
- Paths: only features/frontdesk/**, features/billing/** and .orchestra notes/cr. No app/(staff) route, server, forms, hooks or api-client file is touched (the rs-c4.static baseline hashes them).
- Behaviour: Register still has the same fields, handlers, shortcuts (Ctrl+Enter, F6, Esc, Alt+G, Ctrl+Shift+N) and one primary action. "Use this new patient" changed to secondary. No draft feature added. There is no <form> wrapper, so moving the submit button into the aside changes nothing.
- Layout: Patient, Tests and Billing sit in one left column. The sticky aside "Registration summary" shows Tests, Total, Paid, Balance and Discount authority (from quote.discount_evaluation). Age and DOB keep both fields inside one fieldset, which is correct because validation is "either, not both".
- Statement: Opening = closing - invoiced + paid + credited. The arithmetic is right and it uses only served data.
- Daily cash: has no opening/closing columns because the API serves no such data. Non-blocking CR CR-C4-RS-001 is filed per LD-140, which is correct (nothing invented).
- Styling: no style={...}, hex colour or px radius remains under the 4 paths. All 23 --lims-* variables in frontdesk.css and billing.css resolve to tokens.json (cssName mapping from build-tokens.ts). Px values left are border widths and one media query only.
- Print: PrintFrame copies the host stylesheets into the iframe, so .lims-cancelled-banner still styles printed invoices.
- No PHI in logs, no secrets, no tenant/RLS/permission/error-code surface in this diff.

Ran (CI=true)
- rs-c4: 36/36 pass (4 files, snapshots present).
- fd-t13: 70/70. fd-t14: 98/98.
- bl-t20: 18/18 static and 36/36 screens pass with --maxWorkers=1 --testTimeout=90000. The default parallel run failed 13 tests on "Timeout waiting for worker to respond" and 15 s test timeouts, caused by machine load (other lanes running), not by assertions.

Not verified: real browser layout, sticky behaviour and contrast (jsdom only); Playwright; fd-t17 and bl-t23 not run.
