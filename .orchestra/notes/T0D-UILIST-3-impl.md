# T0D-UILIST-3 impl (writer)
Files: 50 web files (47 modified, 3 new: catalog PageError.tsx + page-failed.ts, engagement PageLoadError.tsx); rows in notes/T0D-UILIST-3-screens.md.
[CONV] catalog master-ui: MasterTable in `.lims-table-scroll`, status filter is a kit Select, `useListFilter(extra, code)` puts screen filters in the same row.
[CONV] new filters on screens whose API reads take no params filter the loaded rows only (display only, no API change).
[CONV] 500 on a list page -> ErrorState in page (title, request id, Retry=router.refresh); 501 -> NotAvailable; NEXT_* throws re-thrown.
uilist3: 166/173; the 7 reds are test defects -> notes/T0D-UILIST-3-dispute.md (with 5 older tests pinning old markup/throws).
Shell/kit: web-style-3 101/101, m4.source 6/6, elabmenu1.sidebar 23/23, m-series-kit 29/29; m2.source + r04.source 1 red each = pre-existing shell.css motion (file untouched).
Open: admin pack lacks inventory.bench.record; PRICETOOLS-1/SALES-1/PARTYSET-1 file lists not found; rs-c3.static 3 reds pre-existing (LD-362).
