# T0D-BUILD-4 left (writer, 2026-11-22)
- Payment mode totals of Bill of the Day: the bill_of_the_day definition (contracts/openapi/analytics.yaml x-report-definitions) has NO payment mode column, so getMisReportPage cannot return amounts per payment mode. The block "Amount by payment mode" stays "Not available yet" with no number (LD-436: no invented values). Needs a CR: a payment mode column (or a separate per-mode definition) on the payments/billing side.
- Previous page on the MIS screens returns to the first page: the contract cursor is forward only.
