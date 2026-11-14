Title: CR-C4-RS-001: daily cash report has no opening/closing balance (10-DESIGN-SYSTEM s4 "Accounts")
From chunk: C4            To owner: C0-0C
Type: api
Blocking? no (RS-C4 keeps the existing daily-cash columns; credit-party statement now has Opening/Closing from existing data)
Problem: s4 Accounts asks for a ledger table with opening/closing balance columns. The daily cash report returns only expected/counted/variance per session (and gross/reversed/net per staff and method). No opening or closing balance is served, and RS-C4 may not invent one (LD-140).
Proposed change (exact): add optional `opening` and `closing` Money to each row of `sessions[].rows[]` (or per session) in the daily cash report response, with the definition (e.g. opening = counted cash of the previous closed session for the same centre and method; closing = counted cash). C0-0C to confirm the definition with Accounts.
Backward compatible? yes (optional fields)
Tenant/security impact: none (same permission billing.cash_report.read, same RLS)
IRD/regulatory impact: none expected; Accounts to confirm
Alternatives considered: derive opening in the UI from the previous session (not possible, only one day is served); show an em dash column (adds a column with no data).
Tests that will prove it: rs-c4.ledger daily-cash test already allows an Opening/Closing column whose cells are money or an em dash.
