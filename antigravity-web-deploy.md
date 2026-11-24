# Staff web UI deployment for Antigravity: deploy-only access

Written 2026-11-24 by the deploy orchestrator (Claude Code). No secret value in this file.

## What you have
- A dedicated ssh key, **only** for deploying the staff web UI: private key `C:\Users\rauna\.ssh\antigravity_web_deploy` (public key is authorised on the server with a forced command and the `restrict` option: no shell, no port forwarding, no other command).
- Server address: `metrolmis@100.82.8.12` (Tailscale address of the server; your PC is already on the tailnet).
- Whatever you send, the server runs exactly one program: it reads a **unified diff from standard input**, validates it, applies it to a copy of the live web source, builds a new image, pushes it, rolls ONLY the staff web service (`web-a`, about 15 to 40 seconds unavailable), checks health, and rolls back by itself if the check fails.

## What the server accepts (anything else is rejected before any change)
- A text unified diff made with `git diff` (paths `a/...` and `b/...` from the repo root), up to 2 MB.
- It may touch ONLY: `apps/web/src/**`, `apps/web/public/**`, `packages/ui/src/**`. No other folder, no `..`, no symlinks, no binary files, no file mode changes, no renames.
- It must apply cleanly to the **live web source** (see below), not to `main`. If it does not apply, the server says so and changes nothing.

## How to produce a patch that applies
The live web source is NOT the same as `origin/main`: it is an older base plus host fixes plus UI changes already deployed. Do not diff against `main`.
1. Unpack the baseline: `C:\LIMS\live-web-source.tgz` (a snapshot of the live `apps/web/src` and `packages/ui/src` taken 2026-11-24 05:00 UTC) into an empty folder, run `git init`, `git add -A`, `git commit -m baseline` there.
2. Make your UI changes in that folder (same file paths as in the repo: `apps/web/src/...`).
3. Create the patch: `git diff --no-color baseline > ui.patch`, after `git add -A` (new files included). Check the first line of each file header looks like `diff --git a/apps/web/src/... b/apps/web/src/...`.
4. If the live UI changes in the meantime (another deployment), ask the operator for a fresh snapshot.

## How to send it (Windows, no PowerShell piping: raw bytes)
```
cmd /c "ssh -i C:\Users\rauna\.ssh\antigravity_web_deploy -o IdentitiesOnly=yes -o BatchMode=yes metrolmis@100.82.8.12 < ui.patch"
```
You will see progress lines: patch applied, building (a few minutes), pushing, rolling, health check, `DONE: web rNN is live` or `ROLLING BACK`. Exit code 0 = deployed or dry run. Other exit codes: 3 another deploy is running, 5 rejected patch, 7 patch does not apply, 9 build failed (last build log lines are shown), 11 rolled back.

## Safety rules
- **Dry-run mode is ON at the moment**: the server applies the patch to a copy and stops before building (it says `DRY RUN`). The operator removes the file `/home/metrolmis/lims-deploy/web-ui-deploy.dry` to allow real deployments.
- Only one deployment runs at a time. Two sessions deploying the web UI in parallel can overwrite each other's work: agree with the operator who deploys.
- Your UI code runs in staff browsers and its server-side parts run inside the web container: write it as production code. No real patient data, no secrets in code, no new dependencies (package.json is outside the allowed folders).
- Every deployment is logged on the server and the previous lock files are saved, so the operator can roll back.

## Known limits of the checks
The server does not run the web test suite or the type checker before deploying (a broken build stops at the image build; a build that works but looks wrong is on you). Run `pnpm typecheck` and the web tests in your own checkout first.
