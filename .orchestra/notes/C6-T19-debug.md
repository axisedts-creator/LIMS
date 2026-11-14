# C6-T19 debugger
Cause: 3 seed tests need db/seeds/*.sql inserting reporting.g_message_templates; db/ is C0-0B-only (01-CHUNK-MAP §3), so no in-chunk code fix exists.
Fix: none made (tests untouched, no out-of-ownership edit). Dispute written to C6-T19-dispute.md; CR-C6-022 already carries exact seed SQL for C0-0B.
