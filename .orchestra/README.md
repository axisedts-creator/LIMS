# Agent orchestra
**Parallel (normal):** `powershell -ExecutionPolicy Bypass -File .orchestra\supervisor.ps1` from C:\LIMS. Opens one window per lane
(C0-0A, C0-0B, C0-0C, C0-0D, C1). Each lane works in its own git worktree under C:\LIMS-lanes\ and its own branch lane/<name>,
so lanes never edit the same files. Finished tasks are merged into C:\LIMS main and pushed; each lane then pulls the others' work.
**Every lane retries every 10 minutes forever:** after a failure, a block, a usage limit or "waiting on another lane". Fix the cause
(or the script in C:\LIMS\.orchestra) and the next try picks it up automatically. Close a lane's window to stop it.

Per task: TESTER writes failing tests -> WRITER implements -> VERIFY (`pnpm -s verify`, no AI tokens) -> DEBUGGER (max 3 rounds)
-> REVIEWER (APPROVE or CHANGES, max 2 rounds). Each step is a separate Claude session; the script reverts any file a role may not touch.
Usage limit -> waits 10 min and resumes the same session.

Shared state (all lanes): C:\LIMS-state\tasks\<chunk>.json (status per task), C:\LIMS-state\logs\<chunk>.log.
Per lane details: C:\LIMS-lanes\<lane>\.orchestra\logs\agents.log.
Blocked task: read the lane's .orchestra\cr\ and notes\*-dispute.md, fix, set its "status" back to "todo" in the task list.
