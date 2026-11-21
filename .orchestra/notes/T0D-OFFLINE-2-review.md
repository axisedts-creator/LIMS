APPROVE

Scope reviewed: git diff 565bb96e2..HEAD. Changed: apps/web/src/core/shell/shell.css, apps/web/src/features/admin/auth/__tests__/m5.entry.test.tsx, and the OFFLINE-2 notes and verify.cmd.

- shell.css: every hero animation over 450 ms is gone: sway, wave and its delay, bob x2, ring, the chip 7.5s/5.4s durations and the -2s/-1s delays. The 4 unused @keyframes are deleted. The static transforms stay, including the plate's rotateX(56deg) rotateZ(-30deg). lims-rise and lims-fade stay, both on motion tokens. The reduced-motion block is intact, and no remaining rule points at a deleted keyframe. This is display only and matches ruling §5 (LD-384 widened, option B).
- m5.entry.test.tsx: changed exactly as ruling §4 asks. The loop check is now an assertion against `infinite` and against anything over 450 ms; it is not weakened, because it now tests what 13-M-SERIES §2.3 and r04 require. The reduced-motion test still checks that the plate stays tilted. The edit is in features/admin/auth/__tests__, which is outside the rs-c2 pin walk, and rs-c2 is still 74/74. The arbiter approved it with a TESTS_WRONG ruling.
- No names invented. No PHI, no secrets. No DB, RLS, permission or route changes in this pass.
- Re-run by reviewer: r04 76/76, rs-c2 74/74, offline2 140/140, offline1 82/82, density 350 (+2 skipped), m5.entry 66/66 (vitest.m5.config.ts). All green.
- Non-blocking: the comment at shell.css:159 ("the wave: delay = ...") and the --r/--c/--lit nth-child variables are now dead. Remove them in a later cleanup task, not here (LD-384 limits what this task may touch). The ruling §7 lead check on the features/admin test edit is recorded only in the tester's note.
