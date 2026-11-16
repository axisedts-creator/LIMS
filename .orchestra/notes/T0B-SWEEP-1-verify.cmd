pnpm --dir services/api exec vitest run test-sweep/__tests__/prepare-mode && pnpm --filter @lims/api sweep && pnpm --dir services/api exec vitest run test-sweep/__tests__
