APPROVE

Re-review of `645b440..HEAD` (writer commit 84515c8 "T-01 review fixes"), checked against the 3 CHANGES items from 389d38b.

1. Fixed. `infra/tests/static/__pycache__/test_t01_skeleton.cpython-314.pyc` removed from the index; `infra/.gitignore` = `__pycache__/`; `git ls-files infra | grep pycache` is empty.
2. Fixed. `infra/.gitleaks.toml:8` narrowed to `infra/tests/static/__pycache__/`. Checked with a stale .pyc recompiled into that dir: `gitleaks detect --no-git --source infra` gives "no leaks found", so the path form matches. Stale file deleted afterwards.
3. Fixed. `infra/tests/run.sh:3` and `infra/README.md:20` now state the LD-17 ansible-lint exception, matching run.sh:14-16.

Earlier checks still hold (THIRD-PARTY-OPS covers 02-TRD s2 GPL/AGPL/MPL tools; schema covers s8.2 ids; placeholder recipients only; no secrets; only `infra/` paths plus own notes; LD-06/LD-17 cited). RLS/permissions/error codes/rate tier: not applicable.

Ran `bash infra/tests/run.sh` locally 2026-11-07: ok gitleaks, ok yamllint, SKIP ansible-lint (CI only), 24 static tests OK, exit 0.
Not verified by reviewer: ops runner / CI=true run with ansible-lint.
