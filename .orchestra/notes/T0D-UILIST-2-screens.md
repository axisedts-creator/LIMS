# T0D-UILIST-2 screens (template 1 LIST unless noted; writer fills "changed" as each lands)
| Route | Tpl | Changed | Left / why |
|---|---|---|---|
| /billing/invoices | 1 | one FilterBar (fiscal year, date range, centre, status, invoice no, credit party, Reset); money right, NPR in header; 500 ErrorState keeps filters; 501 NotAvailable | — |
| /billing/accounts/entries | 1 | one filter row, From/To same control + YYYY-MM-DD helper, 13+ cols in table box, Columns chooser, sticky first | — |
| /billing/accounts/ledger | 1 | one filter row (party, from, to, Show), Print + Export CSV in header | — |
| /billing/accounts/pocket | 1 | same as ledger; 404/501 = NotAvailable | — |
| /billing/accounts/summary | 1 | search + FilterBar, listAccountSummaries (LD-358), NotAvailable while 501 | handler: T0B-ACCTLIST-1 |
| /billing/credit-parties, /registers, /audit-trail, /cbms, /worklist | 1 | PageHeader, one FilterBar, header row always, money right + NPR header | other worklist / register tabs only share the kit table |
| /payments/reconciliation, /payments/static-qr | 1 | PageHeader, one FilterBar, header row always, money right + NPR header | — |
| /frontdesk/registrations/new | 6 | controls 1.875rem, one label class, equal column cards, sticky footer kept | — |
| /frontdesk/worklist, /frontdesk/discount-approvals | 1 | same empty-table look, ErrorState in table body, NotAvailable on 501 | discount approvals money (NPR to header, Discount split from percent) waits for dispute item 2 (fd-t14 pins "NPR 1,500.00" cells) |
| not touched | — | /billing/dues, /billing/daily-cash, /billing/settings (T0D-PRINTCFG-1), discounts (T0D-FINCTRL-1), price lists (T0D-PRICETOOLS-1) | other tasks / later |
