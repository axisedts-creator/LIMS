# T0B-SYNC-5 dispute (writer)
1. static.test.ts line 116-122 ("every sync.* error code the runbook mentions is a registered code") contradicts lines 82 and 87 of the same file.
   Lines 82/87 require the runbook to contain `sync.conflict.resolve` and `sync.device.manage`; the regex `/\bsync\.[a-z_]+\b/g` matches only
   `sync.conflict` / `sync.device` inside them, and the exclusion list compares against the full codes, so the test can never pass.
   Observed: `AssertionError: sync.device: expected false to be true`. Proposed fix (tester): match `/\bsync\.[a-z_]+(?:\.[a-z_]+)*\b/g`,
   or exclude any match followed by `.`. No change made by the writer.
2. retention.live.test.ts needs a DELETE policy on core.sync_operation / core.sync_conflict, which the existing pgTAP
   db/tests/core/T0C-SYNC-2_sync_operations_conflicts.test.sql (lines 87, 91) forbids: see .orchestra/cr/T0B-SYNC-5.md (lead/arbiter ruling).
