Title: CR-C0-0D-UNSLOP1: lead ruling on the 45 file cap (review items 3 and 4)
From chunk: C0-foundation-contracts (lane C0-0D)   To owner: lead
Type: bug (task scope; no schema/api/event change)
Blocking? yes: T0D-UNSLOP-1 review items 3 and 4 cannot both be met by the writer.
Problem: brief caps the task at 45 files; diff is 69 files outside .orchestra (11 of them tests; 37 only for part (D) one-line crumb removals). Review item 4 asks (B) on ~20 more screens (inventory stock/purchase orders/receipts/items/rules/settings, engagement settings/reminders, homecollection dispatch/settings, instruments messages, partners manifests, billing settings, catalog panels/departments/specimens/methods/imports/price lists/tax/surcharges) "with a web test each" -> ~90+ files. Reverting (D) beyond the cap breaks the tester's updated single-trail pins (ruling item 5), which the writer may not edit; (B) tests are tester work.
Proposed change (pick one): (a) raise the cap for part (D) to the current 69 files and split (B) remaining screens into a follow-up task (e.g. under T0D-UILIST-1/2/3 of LD-353, which already own list/filter-bar alignment); or (b) raise the cap to ~95 and send (B) back to the tester for tests first.
Backward compatible? yes (display only).
Tenant/security impact: none (no route, permission, contract or API change).
Alternatives considered: revert (D) crumbs in 24 files (fails tester pins t19.case, cattests1, hc-t19, t20, rs-c4.static + snapshots); do (B) untested (violates tests-first).
Tests that will prove it: unslop1 verify.cmd 30/30 stays green; follow-up task adds one web test per (B) screen.
