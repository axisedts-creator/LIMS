APPROVE

WEB-CSS-RATCHET-1 review (LD-241), diff 25f758fd..HEAD.

- Scope: only tests/web/css-class-{ratchet.test.mjs,scan.mjs,baseline.json} + notes. No component, stylesheet, contract, migration or spec change (done_when "no other file changes" holds).
- done_when: scans className in apps/web, apps/portal, apps/partner, packages/ui; defined = .css/.module.css of same app or packages/ui (+ inline <style>); per-app baseline; fails on NEW and on STALE entry (fixture tests prove both); seven lims-platform-* asserted in apps/web baseline; notes give counts per app (web 79, portal 1, partner 5, ui 71 = 156).
- Ran `node --test tests/web/css-class-ratchet.test.mjs`: 13 pass, 0 fail; diagnostics match baseline counts.
- Checked: packages/ui/dist/tokens.css (skipped as dist) defines no .lims- class, so no false violations from the skip. __tests__ fixture CSS correctly excluded.
- RLS/permissions/error codes/PHI/secrets: not applicable (static test only); no secrets or patient data in files.
- Non-blocking: test is not wired into `pnpm -s verify` (root package.json not in brief's file list); `pnpm -s verify` is red on @lims/worker#typecheck, unrelated to this task (per impl notes) — lead to route. Regex-scan limits (className={var}, dynamic names) are documented with a ponytail comment.
