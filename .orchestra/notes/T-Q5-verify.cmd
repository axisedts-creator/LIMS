cd /d "%~dp0..\.." && pnpm --dir apps/web exec vitest run src/features/engagement/__tests__/t-q5 && pnpm --dir packages/ui exec vitest run src/components/__tests__/queueboard
