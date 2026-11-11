BL-T22 impl (writer, round 4, after main merged into lane: HEAD..main = 0). Owned paths only. No code change this round.
Files (earlier rounds, unchanged): worker billing/alerts/{integrity,cbms}.rules.yaml, frontdesk/alerts/frontdesk.rules.yaml; ledger.service.ts recordPayment (LD-75(b), in HEAD).
Probes run 2026-11-11 11:00: 28 fail / 332 pass / 7 skip. alerts.rules, securityContracts, phi.logscan pass; uploads 9/10 pass.
16 fails = probe.kit ctxFor too thin (own IdentityPort 404, no events/core/storage.delete/download) -> TESTS_WRONG, see BL-T22-dispute.md §1.
1 fail = PDF-JS sanitise is worker trf_scan's job (02-TRD:556), not the handler -> TESTS_WRONG, dispute §2.
11 fails = billing/handlers/index.ts:27 notYet stubs (BL-T15 handlers never wired; BL-T21 payment intents Phase 1.5). Not faked (LD-95); dispute §3.
[CONV] none new.
Open: lead/BL-T15 owner wires register/export/credit-note handlers; trf_scan.ts:4 lacks qpdf (FD-T10).
