APPROVE
Re-review of 7333a39e..HEAD (review fixes ce6f27f6, 139c2b5b):
1. Prior #1 fixed — instruments.service.ts:288-289: non-blank `evidence_note` < 10 chars -> 400 `/evidence_note`; blank still -> 422 `instruments.go_live_checklist_incomplete` (AC-04.3). Test added (9 chars -> 400, nothing written, no publish).
2. Prior #2 fixed — instruments.service.ts:61-64,83-85: each `qc_sample_id_patterns` item must compile and reject lookaround/backreference; error path `/qc_sample_id_patterns/<i>`. Shared CHECK covers E24 and E26. Tests added for `(`, `(?=a)`, `(a)\1`.
Prior "Checked OK" items unchanged by the fixes (names, tenant predicates, BOLA, If-Match, version bumps I1–I6, E41 fan-out, no PHI/secrets, owned paths only).
Ran: verify.cmd vitest set — 4 files, 271/271 pass. `tsc --noEmit` — no errors in modules/instruments (existing errors elsewhere in contracts/ports and packages/shared-ts, not from this diff).
Not verified: SQL repo against real Postgres (RLS/FK/CHECK); handlers/ETag/Idempotency (out of scope). RE2 check only screens syntax (ponytail note); it is not a full RE2 parser.
