# T-01 debug
- Cause: infra/tests/run.sh missing (writer could not create it); verify cmd `sh infra/tests/run.sh` also fails under `cmd /c` because `sh` is not on the Windows PATH ("sh is not recognized").
- Fix: added infra/tests/run.sh (gitleaks, yamllint, ansible-lint, static tests minus Lint class). Not fixed (outside my paths): run.ps1 Verify needs Git Bash on PATH or verify "bash infra/tests/run.sh".
- NOT RUN: bash -n / run.sh denied approval. yamllint, ansible-lint, gitleaks availability unknown; missing tool = FAIL by design.
