# T0D-UILIST-3 screens (LD-353)
| route | tpl | changed | left / why |
|---|---|---|---|
| /catalog/departments, /specimens, /methods, /comment-codes | 1 | shared MasterTable in `.lims-table-scroll`; Status radio -> kit Select (master-ui) | none |
| /catalog/units | 1 | search + status filter row on Units tab | Value sets tab: no filter (not tested) |
| /catalog/panels | 1 | Kind select merged into the one filter row | none |
| /catalog/doctors | 1 | Verified/Status/Source radios -> Selects | verify queue, detail (other tasks) |
| /catalog/credit-parties | 1 | filter row (search, status, kind) | none |
| /catalog/imports | 1 | one filter row for both history tables; file name link titled | import form radio stays (entry, not filter) |
| /catalog/price-lists | 1 | FilterBar (search, applies to, status), scroll box, name titled | PRICETOOLS-1 has no file list in repo; detail/editor untouched |
| /catalog/surcharges, /catalog/tax | 1 | FilterBar (applies to, status), scroll box, titles | tax types tab: no filter |
| /catalog/comment-codes, /catalog/tests (pages) | 1 | 500 -> PageError (title, reference, Retry) in page | tests list/details/categories: TESTMGMT-1 |
| /catalog/price-simulator | 6 | two `.lims-entry-col` + sticky `.lims-entry-footer` (catalog.css, tokens) | result table unchanged |
| /inventory (landing) | 1 | FilterBar (kind), titles | stat tiles, checklist |
| /inventory/alerts | 1 | 501 NotAvailable / 500 ErrorState with title, filters, header row | none |
| /inventory/settings | 4 | 501 NotAvailable keeps title | form: T0D-UISETTINGS-1 |
| /inventory/stock, /items | 1 | cell titles | filters already fine |
| /inventory/transfers, /counts, /suppliers, /stores, /rules | 1 | one FilterBar each (local filter [CONV]), titles | stores Analysers tab untouched |
| /inventory/purchase-orders, /receipts | 1 | none (already green) | - |
| /inventory/bench | 3 | no inventory.bench.record -> title + plain no access, no API call | ADMIN PACK GAP: tenant admin pack lacks inventory.bench.record |
| /partners/manifests | 1 | switches in the one filter row, titles, failed load keeps header row + Retry | row hand-built (FilterBar cannot hold switches) |
| /partners/pickups | 1 | status filter (?state), column chooser (9 cols), titles | closed-state list values not checked against real API |
| /partners/referrers | 1 | titles, failed load keeps header | partners list/detail/settings untouched |
| /engagement/queue | 2 | 500 -> ErrorState in page | console layout: UICONSOLE |
| /engagement/bookings | 1 | 500 -> ErrorState in page, titles | status checkbox group stays |
| /engagement/slots, /bookable-items | 1 | one FilterBar (local), titles; bookable 501 NotAvailable with header | - |
| /engagement/reminders, /enquiries, /memberships | 1 | kit filter-bar class, titles | memberships New plan stays in tab |
| /homecollection/dispatch, /handovers, /devices | 1 | filters moved into one FilterBar, Refresh in header, titles, error.tsx keeps title | dispatch Status single choice [CONV]; settings (UISETTINGS-1), visit detail untouched |
Later task: wastage, unresolved, reports (inventory); partners settings/detail; server-side filters where now local.
