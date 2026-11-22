Cause: tests/security/authz-classification.json was stale (no getMisReportPage entry; the file also lagged other wired handlers), so build4-mis-page-openapi.test.ts:201 failed.
Fix: regenerated it with `node tests/security/classify-authz.mjs > tests/security/authz-classification.json`. getMisReportPage = guarded-exact, analytics.dashboard.read. No source or test edited.
Result: build4-mis-page-openapi.test.ts 20/20 pass. Full verify chain (api, web) not re-run by me.
Note: regen also moved ~65 other entries (stale baseline vs merged main); counts guarded-exact 931 to 996, unguarded 47 to 1.
