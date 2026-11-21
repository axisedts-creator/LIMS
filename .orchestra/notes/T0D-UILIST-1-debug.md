# T0D-UILIST-1 debug
Cause: writer left anatomic (batches, landing), instruments (agents 500, instruments list, settings 500) and quality (runs, observations) unfinished: 16 uilist1 reds.
Fix: core/shell/LoadError.tsx + loadOr (NotAvailable.tsx, 5xx -> ErrorState with title); anatomic landing loadOr, batches pendingOr + one FilterBar + no second New batch; instruments agents/instruments pass loadError, list is a DataTable with column sort; settings loadOr; quality runs/observations pendingOr, Needs action moved into the FilterBar.
Result: uilist1 74/76, web-style-3 101/101; 2 reds are the outsourced fixture (dispute note). Old tests that pin old markup: see T0D-UILIST-1-dispute.md. Snapshots rs-c7 instruments not regenerated.
