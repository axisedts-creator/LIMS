cd /d "%~dp0..\.." && node node_modules\vitest\vitest.mjs run --config apps/web/src/features/billing/__tests__/vitest.bl-t20.config.ts && node apps/web/src/features/billing/__tests__/copy-scan.mjs
