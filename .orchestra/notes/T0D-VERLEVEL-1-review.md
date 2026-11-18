APPROVE
Re-review after fixes (37a739ce4..HEAD). Names still verbatim vs contracts/openapi/lab.yaml; no PHI in logs, no secrets, only lab-owned web paths plus orchestra notes/cr.
Item 1 fixed: QueueScreen.tsx:211 dimmed row now carries inline `opacity: 0.55`; verlevel1.queues.test.tsx asserts computed opacity < 1 on the dimmed row and not on the other row.
Item 2 resolved per review: .orchestra/cr/T0D-VERLEVEL-1.md filed (user_id on SessionState.actor, ShellSession.actor.userId, c2/store mapping, then pages pass currentUserId); impl note states the pages wait on the CR and lab.verifier_not_distinct is the only guard until then.
Reviewer re-ran: verlevel1 67/67 pass; rs-c2 74/74 pass (baseline unchanged).
Residual (not blocking, tracked): dimming in the running app waits on the CR; "Updated by" shows a dash (no field in VerificationPolicy); 1366x768 fit and focus visuals not verifiable in jsdom.
