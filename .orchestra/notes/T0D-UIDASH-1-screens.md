# T0D-UIDASH-1 screens (writer)
| Route | Template | Changed | Left, and why |
|---|---|---|---|
| /analytics | 5 | h1 = menu label; one StatTileRow of 4 tiles (Patient visits, Reports pending, Net sales, Cash collected); ChartCard row (Net sales per day 2/3, Top departments 1/3) always drawn, "No data yet" when empty or no money tile (no money data passed then) | Needs you, stepper, Show yesterday, sub-values line kept; Results approved / Pending tests now only in the stepper |
| /lab/status-board | 5 | 5 status tiles are toggle buttons (filter, aria-pressed), chips gone; ChartCard Samples by status (aria-hidden: tiles carry the counts); Updated + Pause in header; table in .lims-table-scroll | date / centre filter row unchanged |
| /lab/pending | 5 | one FilterBar with Over target only switch (button role=switch); tiles Pending, Overdue; table in scroll box; 501 = NotAvailable with columns | Pending by department = NotAvailable (no department on PendingItem; summary op not read) |
| /billing/daily-cash | 5 | B.S. date once in header slot; Business date picker in one FilterBar; tiles Gross, Reversed, Net, Variance; bar Net by payment method | My shift, both tables unchanged |
| /billing/dues | 5 | FilterBar Centre + Party (centre filters rows on screen); tiles Total due, Oldest; bar Dues by age 0-30/31-60/61-90/90+; NotAvailable when a row lacks oldest_invoice_at; centre id never shown | Party has no options (DueRow has no party); page.tsx passes no centres (route file not edited) |
| /quality | 5 | tiles In control, Warning, Out of control, QC overdue; bar Pairs by status | Overdue only checkbox stays outside FilterBar (kit FilterBar has no toggle kind) |
| /quality/runs | 5 | tiles Runs, Needs action; bar Runs by outcome | Needs action checkbox, same reason |
| /quality/tat-alerts | 5 | tiles Warning, Breached, Escalated; bar Alerts by level | title stays the literal "TAT alerts" (quality-t24.static rejects the nav key as a permission name) |
| /quality/lj | 5 | development banner removed | no chart drawn yet (CR-C9-007 ControlChart); table kept |
