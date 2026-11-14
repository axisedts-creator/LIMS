# HC-T04 debug
- Cause: verify log's only line is the Docker daemon connection failure (npipe dockerDesktopLinuxEngine missing). Environmental, not an implementation defect; settings/reasons DB suites never ran.
- Fix: none in code (no change warranted). Start Docker Desktop, rerun `.orchestra/notes/HC-T04-verify.cmd`; only then can real failures be diagnosed.

## Round 2
- Cause: unchanged. Verify log is still only the Docker npipe failure, and `docker info` still cannot reach the daemon. Environmental; the DB suites (settings/reasons) have never run.
- Fix: none in code (no change warranted, no dispute: tests do not contradict spec). Start Docker Desktop, then rerun `.orchestra/notes/HC-T04-verify.cmd`.

## Round 3
- Cause: unchanged. Verify log is still only the Docker npipe failure; `docker info` still cannot reach the daemon. Environmental; DB suites never ran.
- Fix: none in code, no dispute. Start Docker Desktop, rerun `.orchestra/notes/HC-T04-verify.cmd`.
