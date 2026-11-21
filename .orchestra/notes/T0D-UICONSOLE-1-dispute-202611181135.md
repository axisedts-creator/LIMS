# T0D-UICONSOLE-1 dispute 2 (writer, 2026-11-18 11:30 NPT)

Ruling item 4 (T0D-UICONSOLE-1-ruling.md) says the tester updates the two old tests; commit 3b23237b3 changed only uiconsole1.lab.test.tsx. Both still fail and cannot pass together with the uiconsole1 contract:
1. adminpage-lab-1.critical-values.test.tsx:106 requires a "Detected at" list columnheader; uiconsole1.lab.test.tsx:4 requires list headers exactly Age since detected, Analyte, Direction, Status (Detected at in the detail). Fix: drop /detected at/i from the list-column loop and assert it in the detail (as uiconsole1 :82 already does).
2. c5-t23.exceptions.test.tsx "filters" requires role combobox named Reason; uiconsole1 (ruled) requires the kit Select (role button). Fix: query `within(filterBar).getByRole('button', { name: /reason/i })` / `/status/i`, keep the reason= / status= and no-barcode assertions.
3. Still missing (dispute item 3): uiconsole1.payments / uiconsole1.inventory tests, -tests.md, verify.cmd. Payments review, refunds, inventory unresolved stay unchanged until they exist.
Run (maxWorkers=1, machine load): uiconsole1.lab all green; config total 2 fail = items 1 and 2.
