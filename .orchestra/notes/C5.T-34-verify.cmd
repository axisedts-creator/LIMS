cd /d "%~dp0..\.." && pnpm --dir apps/web exec tsc --noEmit -p tests/e2e/lab/tsconfig.json && pnpm --dir apps/web exec playwright test --config tests/e2e/lab/playwright.config.ts --list C5.T-34
