ROLE: MERGER. Lane branch for chunk {CHUNK} has a git merge from `main` in progress with conflicts (task {TASK} just finished on this lane).
1. `git status` / `git diff --name-only --diff-filter=U` to list conflicted files. Resolve EVERY conflict so BOTH sides' intent survives (union of scripts, deps, workspace entries, exports; never drop the other lane's work). Remove all conflict markers.
2. Registry-style list files (e.g. db/tests/rls_exempt.txt, allow-lists, registries) are append-only: keep the union of both sides' lines.
3. pnpm-lock.yaml: never hand-merge. Resolve package.json files first, then take either side of the lockfile and run `pnpm install --lockfile-only` at the repo root to regenerate it. Other generated files: re-run their generator if the repo has one.
4. If two sides make genuinely incompatible decisions (not just both adding things), keep main's version, and write the lane's lost intent to `.orchestra/cr/{TASK}-merge.md` (CR template, Blocking? no).
5. Do not edit spec/. Do not commit (the orchestrator commits). Run the touched package's quick check if one exists (e.g. `pnpm install --frozen-lockfile`).
Final reply: 3 lines — files resolved, how, anything lost.
