CHANGES

Reviewed `git diff 950d663..HEAD` (T0C-06, AC-0C-2.2). Names verbatim vs 02-TRD:1073 / 02-CV:1142 / PRD AC-0C-2.2 (`oasdiff breaking ... --fail-on ERR`, 1.35.x, `cr-approved-breaking`): OK. Only owned paths (`tools/codegen/**`, own notes): OK. No PHI/secrets. RLS/permissions/idempotency/rate tier/error codes: N/A (CI script). Script logic is fail-closed and quotes args correctly. Ran `npx vitest run __tests__/oasdiff.test.ts`: 21 pass, 3 skipped (real oasdiff not installed).

Defects (both in the job definition that is handed to 0A, which 0A will copy verbatim):

1. tools/codegen/oasdiff.sh:9 — `PR_LABELS="${{ join(github.event.pull_request.labels.*.name, ',') }}"` inlines label text into the `run:` script. That is GitHub Actions script injection: a label name containing `"` or `$(...)` runs as shell. Fix: change the comment so the label list is passed through the step's `env:` block, e.g.
   `#   env: PR_LABELS: ${{ join(github.event.pull_request.labels.*.name, ',') }}   # never inline ${{ }} in run:`
   and the loop line becomes `#     bash tools/codegen/oasdiff.sh /tmp/base.yaml "$f"`.

2. tools/codegen/oasdiff.sh:5 — the job definition leaves out the trigger. With the default `pull_request` types, adding `cr-approved-breaking` does not re-run the gate, so the red check stays and the bypass cannot work. Fix: add a comment line after line 5:
   `#   on: pull_request: types: [opened, synchronize, reopened, labeled, unlabeled]`

Not blocking (keep as an open item for 0A, already in the impl notes): the breaking fixture is checked only against the stubbed oasdiff. 0A CI must install oasdiff 1.35.x so the `real oasdiff` describe block runs and proves `head-breaking.yaml` actually fails.
