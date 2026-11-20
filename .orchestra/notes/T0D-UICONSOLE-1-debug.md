Debugger 2026-11-18: no implementation fix. verify = 57 failed / 202 passed.
Cause: all 57 are test-side. uiconsole1.payments:103 expects /123,456\.00/ but lakh grouping is pinned everywhere (1,23,456.00). 56 old tests (t24.unresolved, pg-t18.review, pg-t19.refunds) still pin role="grid" and the old columns; the console markup is a plain table per brief.
Fix: none by writer/debugger; tests may not be edited by me. Dispute written in T0D-UICONSOLE-1-dispute.md. Tester must update the 3 old files and :103, then re-verify.
