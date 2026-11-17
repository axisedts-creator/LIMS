# T0C-SYNC-2 debug (2026-11-18)
Cause: 5 failing tests (sync2-openapi item 1) demand type: object on SyncUpsert.document, SyncConflict.local/server_payload, ResolveSyncConflictRequest.merged_payload.
Lint rule 3 (lint-openapi.ts:197) rejects open objects; OPEN_OBJECT_ALLOWLIST (:64, LD-119) is op+status keyed, cannot cover component schemas. Tests contradict lintfix1 (lintRepo empty).
No impl fix possible without lint policy change (lead-owned). Existing dispute stands: .orchestra/notes/T0C-SYNC-2-dispute.md (options a/b). Stopped.
