BL-T22 impl (writer, round 3 after LD-95). Owned paths only. No code change this round.
Files (earlier rounds, unchanged): worker billing/alerts/integrity.rules.yaml, frontdesk/alerts/frontdesk.rules.yaml; billing/service/ledger.service.ts recordPayment (LD-75(b) ruling, in HEAD).
Probes run (2026-11-11 10:43): 38 fail / 322 pass / 7 skip. alerts.rules now passes (CR resolved as BL-T22.nonblocking.md per LD-95).
38 fails = handlers still stubbed in this lane (common.service_unavailable / common.internal for uploadTrf): FD-T05..T15 + BL-T13..T19 ops in crossTenant + uploads probes.
Cause: lane NOT merged with main at start: `git log HEAD..main` = 161 commits (incl. FD-T13, FD-T15 merges). My `git merge main` was refused (needs approval). Per LD-95 nothing stubbed/faked.
[CONV] none new.
Open: orchestra must merge main into lane/C4b, then rerun `.orchestra/notes/BL-T22-verify.cmd`; if a handler is still a stub after that, debugger names file:line.
Open (carried): assertRole(billing.payment.record, {centreId}) not in service; core pipeline gates permission.
