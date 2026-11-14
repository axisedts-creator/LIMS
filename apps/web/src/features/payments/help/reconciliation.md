# Gateway reconciliation

## Purpose
Every night the system compares its payments with what eSewa and Khalti say, for one business date. Differences are listed here as findings so a person can look at them. A nightly run covers the business date it was started for, not the day it ran.

## Tiles
- **Last successful run**: when the last completed run finished. If it says Never, no run has completed yet; tell your administrator.
- **Open critical findings**: findings that need attention first.
- **Payments under review**: payments the provider answered in an unclear way; open them from the review queue.

## Runs
Each row is one run: its business date, whether it was Nightly or Manual, its status and the counts (Checked, OK, Findings, Critical). **Run now** starts a run for today when you have permission; only one run can be going at a time.

## Open findings
Each finding shows how serious it is (Critical, Warning or Info), what kind it is, the payment, what we say, what the provider says, and any automatic action the system took (for example "Marked paid", "Put under review" or "Ledger repaired"). "—" means the system changed nothing and a person must decide. Use the Intent link to see the payment.

## Resolve
When a finding is dealt with, press **Resolve** and choose a reason. If you choose Other, write a short note. A resolved finding cannot be changed again.
