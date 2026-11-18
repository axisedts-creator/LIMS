APPROVE
# T0D-UILIST-3 review (reviewer, 2026-11-18)
Scope note: the brief's range c82fbae94..HEAD is empty (HEAD = c82fbae94, the main merge). Reviewed the task commits c948a7286..b89c761b3 (bba1bcedb tester, 1093e651c writer, 7f771a28f arbiter, b89c761b3 tester revision).

Tests run here (build:nav first, --maxWorkers=1):
- uilist3 (11 files): 173/173 green.
- web-t31 125/125; t-b6 104/104; web-t33 102/103 (red = web-t33.server createDoctor, server file not touched by this task: pre-existing, listed in the dispute).
- web-style-3 101/101; r04 config 75/76, m2 config 322/324, m4 config 328/330: the only reds are the shell.css motion checks of m2.source / r04.source; shell.css and packages/ui are untouched by this task (last change 2b17ae5ae, LD-344) so pre-existing (LD-362).
- rs-c3 22/25: the 3 reds are rs-c3.static baselines, pre-existing per LD-362. No rs-cN config exists for inventory, partners, engagement or homecollection.

Checks: display only, no route/permission/contract/API change (pickups `state` reuses listPickups and is shape-checked in read.server qs/SHAPES; alerts params stay enum/UUID-checked). Error paths re-throw Next control flow (NEXT_* digest; non-ApiError in alerts; no-status errors in pageOr) and show only the request id, never the problem text. No PHI in logs, no secrets, no admin/platform/(auth)/(platform) files, tokens.json and shell values untouched. Permission names used verbatim (inventory.bench.record, partners.pickup.manage, homecollection.device.manage, inventory.stock.manage). Tests cover done_when (1)-(5) per screen group with empty and one-row renders.

Observations for the lead (not blocking under LD-362):
1. File count: 67 files under apps/ (writer 50, tester 17) against "at most 50 files in all"; if the cap counts tests (as LD-360 did), a cap ruling is needed.
2. Writer commit 1093e651c deletes 4 tracked scratch files under .tmp/ (fd04.log, fd04b.log, t24-body.txt, t24-files.txt) outside the task's paths.
3. PageError (catalog) and PageLoadError (engagement) are the same component twice; a later kit task can fold them into one.
4. Bench no-access state is hand-built markup (lims-state classes) rather than a kit component; admin pack gap for inventory.bench.record is in the screens notes.
