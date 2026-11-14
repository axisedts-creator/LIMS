
## HC-T03 debugger
Cause: both failures are test faults (collections id-swap probe has no parent arg; listVisitsByRoute fixture seeds assigned visit with order_id null, violating visits__order_when_active__ck).
Fix: none to impl; see HC-T03-dispute.md. Tests untouched.
