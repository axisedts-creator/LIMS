# T0C-SYNC-2 debug (2026-11-18)
Cause: 5 failing tests (sync2-openapi item 1) demand type: object on SyncUpsert.document, SyncConflict.local/server_payload, ResolveSyncConflictRequest.merged_payload.
Lint rule 3 (lint-openapi.ts:197) rejects open objects; OPEN_OBJECT_ALLOWLIST (:64, LD-119) is op+status keyed, cannot cover component schemas. Tests contradict lintfix1 (lintRepo empty).
No impl fix possible without lint policy change (lead-owned). Existing dispute stands: .orchestra/notes/T0C-SYNC-2-dispute.md (options a/b). Stopped.

## Round 3 (2026-11-18, LD-369)
Cause: sync2-openapi/codegen/pending tests now green (208/208) via regenerated clients + SyncErrorCode additions already in tree. Last red: registry-equality routes.yaml==IC §7: 3 extra ids (staff.billing.expenses/expense_types/cash_transfers) from T0D-ACCT-2 on main, absent in IC §7.
Fix: none possible in impl (spec/ read-only; same failure on main). CR filed: .orchestra/cr/T0C-SYNC-2.md. Not a SYNC-2 defect.
