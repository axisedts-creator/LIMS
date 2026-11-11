# PG-T18 impl
- Files: app/(staff)/payments/{review,intents/[intent_id]}/{page,loading,error}.tsx; features/payments/{types,labels,query}.ts(x), components/{ReviewQueue,IntentDetailView}.tsx, server/{read.server,write.server,actions}.ts, help/{review,intent}.md.
- Run (after ruling TESTS_WRONG + revised tests 17fc6214): 88/88 pass, no impl change needed. tsc: no errors in my files.
- [CONV] money shown as "NPR …" by own string maths (kit MoneyText prints "Rs."; used only in Refunds tab); `centres=[]` in the review page (no centre-list API yet, same as billing); created range = A.D. days → Asia/Kathmandu instants, end exclusive, max 31 d.
- [CONV] resolve/cancel/recheck via server actions (token stays server-side); If-Match `"<version>"`, one Idempotency-Key per opened dialog; "other"-style reasons (requires_text) need a note before sending.
- Open: Request refund opens a stub dialog linking to /payments/refunds (real dialog = PG-T19); cancel dialog has no note field (P5 body is only reason_code); auth.mfa_required shows a banner, no shell step-up; nav.manifest + AC-PG-07.8 not in scope.
