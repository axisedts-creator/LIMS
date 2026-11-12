# HC-T04 debug
- Cause: verify log's only line is the Docker daemon connection failure (npipe dockerDesktopLinuxEngine missing). Environmental, not an implementation defect; settings/reasons DB suites never ran.
- Fix: none in code (no change warranted). Start Docker Desktop, rerun `.orchestra/notes/HC-T04-verify.cmd`; only then can real failures be diagnosed.
