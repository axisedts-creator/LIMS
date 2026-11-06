APPROVE

Re-review of `git diff 950d663..HEAD` (T0C-06, AC-0C-2.2) after writer fixes in 8cc9a70.

Prior defects:
1. Script injection via inlined `${{ }}` in `run:` — fixed: tools/codegen/oasdiff.sh:8 passes labels through `env: PR_LABELS`, and the loop calls `bash tools/codegen/oasdiff.sh /tmp/base.yaml "$f"`.
2. Missing re-run trigger on label add/remove — fixed: tools/codegen/oasdiff.sh:7 `on: pull_request: types: [opened, synchronize, reopened, labeled, unlabeled]`.

Re-checked: names verbatim (`oasdiff breaking ... --fail-on ERR`, 1.35.x, `cr-approved-breaking`); only owned paths touched; no PHI or secrets; fails closed (exit >1, missing binary, unreadable file, bad arg count); label match is exact-token. RLS, permissions, idempotency, rate tier, error codes: N/A (CI script).
Ran `npx vitest run __tests__/oasdiff.test.ts`: 21 passed, 3 skipped (real oasdiff not installed).

Open item for 0A (not blocking, already in impl notes): 0A CI must install oasdiff 1.35.x so the `real oasdiff` block runs and proves `head-breaking.yaml` really fails.
