# Agent orchestra — how it works
One run = one chunk. For every task in the chunk's 06-IMPLEMENTATION-PLAN:
1. TESTER writes failing tests (may touch test files only)
2. WRITER implements until tests pass (may NOT touch tests)
3. VERIFY runs `pnpm -s verify` (or the task's own command) — no AI tokens used
4. DEBUGGER fixes failures (max 3 rounds; may NOT touch tests)
5. REVIEWER checks the diff against the spec → APPROVE, or CHANGES → back to writer (max 2 rounds)
Each step is a separate Claude session. The script reverts any file a role is not allowed to touch, so roles never overlap.
Usage limit hit → waits 20 min and resumes the SAME session (no work lost, no tokens wasted re-reading).
Anything it cannot decide → task "blocked": read .orchestra/cr/, .orchestra/notes/*-dispute.md, .orchestra/logs/<chunk>.log
Progress: .orchestra/tasks/<chunk>.json (status: todo/tested/implemented/changes/done/blocked). To retry a blocked task, set its status back and re-run.
