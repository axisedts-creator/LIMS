APPROVE
Scope: git diff ff8e4d1a4..HEAD = one code change: apps/web/src/features/admin/__tests__/__snapshots__/rs-c2.screens.test.tsx.snap loses exactly the export `snapshot: sign-in 1` (24 lines, nothing else); plus .orchestra notes (impl, ruling, dispute rename). Matches LD-283 verbatim: writer-owned snap per run.ps1 TestExempt, single export, no other snapshot or test line touched.
Checks: rs-c2.screens.test.tsx:369-370 now satisfied (users, roles-edit-privileged, centres drawer, settings kept; no `snapshot: sign-in `). Ran vitest.m5.config.ts --maxWorkers=1: 14 files / 382 tests passed, no obsolete snapshot.
No DB/RLS, permissions, routes, error codes, logs or secrets in this diff; no invented names; only owned paths.
Non-blocking notes (not defects of this diff): done_when (7) Playwright 1440/390 still not run (impl notes say so); CR T0D-MSERIES-5 nonblocking (footer links, portal button) open for the lead.
