# T0D-UICONSOLE-1 screens (writer, 2026-11-18)

| Route | Template | Changed | Left / why |
|---|---|---|---|
| /lab/critical-values | 2 CONSOLE | PageHeader (t lab.nav.critical_values), kit FilterBar (Status, same URL filter), StatTiles Open / Acknowledged (status notified) / Oldest age (oldest open, hh:mm), SplitConsole: queue Age since detected, Analyte (link kept), Direction, Status; detail Direction, Status, Detected at, Time to acknowledge (first_confirmed_notification_at when sent), History; bar = link "Open critical value (O)", key O opens. NotAvailable columns and error.tsx title updated. | No acknowledge / close action (none existed). Result value not shown. Reg no, patient, notifications count: not in CriticalValueDto (contract gap, unchanged). |
| /lab/ingest-exceptions | 2 CONSOLE | PageHeader, kit FilterBar (Reason, Status, same reason= / status= URL), StatTiles Open / Resolved / Oldest age, SplitConsole: queue Age, Barcode (link kept), Reason, Instrument code, Status; detail Status, Barcode, Instrument code, Instrument, Received, History (Received, Resolved or Discarded); bar = link "Open exception (O)". NotAvailable columns and error.tsx title updated. | Re-apply / Assign / Discard stay on /lab/ingest-exceptions/{id}. Raw value, flags, unit never shown (P3). |
| /payments/review | 2 CONSOLE | NOT CHANGED | Tester tests (uiconsole1.payments.test.tsx) not written yet; no -tests.md. Waits for tester. |
| /payments/refunds | 2 CONSOLE | NOT CHANGED | Same as above. |
| /inventory/unresolved | 2 CONSOLE | NOT CHANGED | Tester tests (uiconsole1.inventory.test.tsx) not written yet. |
