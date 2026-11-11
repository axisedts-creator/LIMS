# FD-T16 impl (round 2)
- order.service.ts: F8b/F13 `add[].priority` optional per contract RegistrationItem; missing = stored order's priority [CONV, as F9 item default].
- patient.service.ts + orders.repo.ts: F6 listPatientOrders filters by actor centre scope (fail closed), as F10 (07-SECURITY §6.2).
- registration.service.ts: F8 tenant-bound centre lookup (core.centre; another tenant's centre = 404, §6.1); F9 a named discount_approval_id not visible in tenant = 404 even when no approval is needed (was silently ignored -> 201).
- [CONV] LD-70: probes/pending.json already `[]`; no edit.
- Ran FD-T16-verify: 218/225 pass; 7 remaining = harness defects, see FD-T16-dispute.md. Regression: change.test + registration.test 80/80; patients/quote pass except pre-existing quote.test:302 (currency in assertCreditAllowed, J-T01 code, not touched). tsc clean on edited files.
- Not verified: full frontdesk suite in one run (killed at 10 min on this machine; load timeouts / worker crashes 0xC0000142).
