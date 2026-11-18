APPROVE
Previous review items 1-5 are fixed in test files only (commit 1dfb41bcc), with no implementation change: kit.ts:24-25 UNOWNED_STUBS back to the 2 settings ids; st4-actor-type.test.ts:16 floor 68, :26 shared set is a subset of the ticket pair, :28 excludes partners.ticket.*; sales1.pending.test.ts:34-37 other pending ids must be ticket operations, read from the spec x-permission; boot.test.ts:31-35 MSGDESK1 is excluded alongside SALES1 at OPS, allOps and the handler keys.
partners/index.ts:76-83 pending = 15 sales + 10 ticket ids (LD-325(b)); :89-91 builds no stub for pending ids, so core serves 501 operation_pending. msgdesk1.pending.test.ts:28-32 matches LD-349 exactly.
Ran `npx vitest run src/modules/partners src/core/__tests__/pending-operations.test.ts`: 34 files, 1927 passed, 1 skipped, 0 failed.
Diff 79a9f587..HEAD: names verbatim, no PHI, no secrets, owned paths only. The uncommitted probe-row fixtures (engagement.sql, partners.sql) are not committed (LD-348).
