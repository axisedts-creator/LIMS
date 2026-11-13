APPROVE
Review of 2a4fcfde..HEAD (HC-T11 review fixes, LD-156).
- Review #1 item 1 resolved: reviewer re-ran `tests/homecollection/HC-T11.pg.sh` on real PG17 (2026-11-13 21:43): 5 files, 84/84 pass, including perf.test.ts (changed/unchanged p95 + all-lookups-fail). Matches writer run4 (84/84). No dispute needed; budgets unchanged (LD-156 (3)).
- LD-156 (1): helpers.ts uses a non-blocking timer; handler-only timing (`handlerMs`); warm-up pull in perf.test.ts beforeAll.
- LD-156 (2): snapshot.service.ts `settledPortCalls` bounds per-visit port calls to 8, one ctx.db.tx savepoint per group (P-44); index mapping 2k/2k+1 correct; failure degrades to `specimens_stale` / `balance_unavailable`, no read-model fallback; lookupSpecimens still called on every changed pull. access_log stays one row per visit (REQ-SEC-096; core writer has no batch API).
- Names verbatim, logs carry codes only (REQ-SEC-081), no secrets, only owned paths + own notes changed.
- Non-blocking risk (noted by writer): 40 sequential access_log inserts dominate variance; a batch writer in core/audit (not C17-owned) would remove it.
