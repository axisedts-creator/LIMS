cd /d "%~dp0..\.." && node node_modules\vitest\vitest.mjs run --config apps/web/src/features/frontdesk/__tests__/vitest.fd-t17.config.ts && node apps/web/src/features/billing/__tests__/copy-scan.mjs
