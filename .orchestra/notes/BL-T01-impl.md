Files: services/api/src/modules/billing/{index,permissions,config}.ts, handlers/index.ts (stubs -> common.service_unavailable, like FD-T01), services/worker/src/jobs/billing/index.ts, apps/web/src/features/billing/nav.manifest.ts.
[CONV] exports `manifest` (api, worker) / `navManifest` (web) per 02-CONV §2.2/2.3; config reads only LIMS_BILLING_* keys.
Review pass: only defect was boot.test.ts timeout (test file, fixed by tester in 32bc94e). No implementation change needed.
Run (vitest): api billing 9/9 pass (17.97 s); worker + web billing 7/7 pass. tsc --noEmit (services/api): no billing errors.
Open: pnpm-workspace.yaml '@scarf/scarf' line flagged by review is not present in this worktree (status clean); nothing to revert.
