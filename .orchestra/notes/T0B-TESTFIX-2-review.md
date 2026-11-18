APPROVE
Scope d15ad8f03..HEAD: only product-tree change is services/api/src/modules/frontdesk/__tests__/probes/uploads.live.test.ts (afterAll(resetSettings), cites LD-314 + arbiter ruling); rest are notes/logs under .orchestra/notes. Owned paths only; no product code, no migration, no new names.
Ruling applied verbatim: resetSettings reused from admin/helpers.ts:102 (no second baseline); updateFrontdeskSettings stays in P-2 sweep with if-match "1" (no loosening); crossTenant.live:160-164 already restores in finally; privilege.live has failure paths only.
No assertion deleted/skipped/loosened, no timeout or retry change. No PHI, no secrets (logs are migration NOTICEs + vitest summary).
done_when (4): writer-green4/5/6.log each "Tests 1677 passed (1677)", consecutive; run3 had 2 boot.test.ts 60s timeouts under host load (no settings/stale failure), honestly recorded as open watch item, not hidden.
done_when (7): impl notes state REGAPI-1/REGAPI-2 can now be re-verified.
Non-blocking: boot.test.ts real-bootstrap 60s timeout under host load remains a residual flake risk for future whole-suite verifies (tester-side shared bootstrap, not a timeout bump).
