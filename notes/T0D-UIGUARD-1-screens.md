# T0D-UIGUARD-1 screens

T0D-UIGUARD-1 adds a guard test only (LD-353, LD-434 option A). It changes no page markup or CSS.

| route | template | changed | left and why |
|---|---|---|---|
| all app/(staff) pages | 1-6 | none: the guard in apps/web/src/core/__tests__/uiguard1.guard.test.ts walks them all | Each offender is listed in notes/T0D-UIGUARD-1-exceptions.md under its follow-up task id |
| /catalog/* (catalog.css) | 1 | none | R3 bold weights in catalog.css are left for T0D-UIGUARD-1-CATALOG. They are shared by 20+ catalog screens and their rs-cN snapshots. A fix here makes the tester-owned legacy entries stale, and the guard stays red until those entries are deleted in the same change. |
| /analytics/*, /inventory/reports, /lab/orders/[order_id]/results, /quality/autoverify/[version_id], /smartreport/summaries/[summary_id] | 5 / 2 | none | R6 charts without ChartCard are left for the ANALYTICS, INVENTORY, LAB, QUALITY and SMARTREPORT follow-ups, for the same stale-entry reason |
| /engagement/enquiries*, /engagement/memberships, reminders, /frontdesk/orders/[order_id], /frontdesk/patients/[patient_id], /offline | 1 / 2 | none | R4 (no ErrorState or NotAvailable) is left for the ENGAGEMENT, FRONTDESK and OFFLINE follow-ups |

Remaining work: one follow-up task per area heading in notes/T0D-UIGUARD-1-exceptions.md. Each follow-up fixes its files and deletes its legacy entries in the same change.
