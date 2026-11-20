TESTS_WRONG — apps/web/src/__tests__/vg8.typecheck.test.ts:115 BASELINE_AS_ANY = 80 is mis-measured; tester sets it to 90 (and the it() title at line 80 "at most the 80 existing uses" to 90). Nothing else changes.
Reasons:
- Task brief done_when (inbox VERIFY-GREEN-8-arbiter.md:18) forbids `as any` "added to hide an error"; it does not fix a number. The gate's job is "not added".
- Arbiter re-measure (git grep -o -w "as any" -- apps/web/src, excluding *typecheck.test*): f944a2cb3 = 66, 818f6275c = 90, HEAD = 90. The line-115 comment claims 80 at 818f6275c; the real occurrence count there was already 90 (80 is the per-LINE count from `git grep -c`; the gate counts occurrences, vg8.typecheck.test.ts:81).
- Per-file counts at 818f6275c and HEAD are identical, so VG8 writer/debugger commits added 0 `as any`. The 24 over 66 come from other lanes' files (offline1, printcfg1, elabmenu1, webfix2, offline3.fixtures), which LD-425 / ruling 757347041 keep out of scope.
- Prior ruling item 2 ("find ~10 casts this task added", LD-427) is void: there are none to find. Item 1 (TS2883) is done per dispute line 2.
- Implementation needs no change; this is a stale constant in the gate only. Spec precedence (CLAUDE.md) gives no other number.

Reset: C1 VERIFY-GREEN-8 to changes (tester edits line 80 title + line 115 constant to 90, with comment "occurrences at 818f6275c = HEAD, arbiter 2026-11-19").
