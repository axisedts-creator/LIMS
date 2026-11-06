# T-01 debug
- Cause: infra/tests/run.sh missing (writer could not create it); verify cmd `sh infra/tests/run.sh` also fails under `cmd /c` because `sh` is not on the Windows PATH ("sh is not recognized").
- Fix: added infra/tests/run.sh (gitleaks, yamllint, ansible-lint, static tests minus Lint class). Not fixed (outside my paths): run.ps1 Verify needs Git Bash on PATH or verify "bash infra/tests/run.sh".
- Round 2: run.sh was again absent on disk (prior write lost); recreated infra/tests/run.sh. Verify log still "'sh' is not recognized": run.ps1 `cmd /c` needs sh/bash on PATH (outside my paths, human/orchestrator).
- NOT RUN: bash -n / run.sh denied approval. yamllint, ansible-lint, gitleaks availability unknown; missing tool = FAIL by design.
