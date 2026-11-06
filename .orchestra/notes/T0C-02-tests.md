# T0C-02 tests (AC-0C-1.2)
- File: `contracts/__tests__/ports.test.ts` (Vitest). Reads IC §4 ts blocks (keyed by `// contracts/ports/<Name>.ts` header) and compares to `contracts/ports/*.ts`.
- Run: `pnpm --filter @lims/contracts exec vitest run __tests__/ports.test.ts` (or `pnpm vitest run contracts/__tests__/ports.test.ts`). Needs `typescript` in `contracts/package.json` devDependencies.
- Fails now: `contracts/ports/` missing. Implementer: 14 files at top level (`common.ts` + 13 ports; only extra allowed is `generated/`), each = IC block verbatim (comments may differ; code compared whitespace-insensitively; `@throws` error codes must be kept).
- tsc check copies ports to a temp dir with tsconfig.base.json + `module ESNext/moduleResolution Bundler` (IC imports are extensionless, so NodeNext cannot be used); stubs `generated/error-codes.ts` (`ErrorCode = string`) if T0C-05 hasn't made it.
- Tests NOT run here: no node_modules (vitest/typescript/yaml) installed in this worktree; only IC extraction logic reasoned by hand (14 ts blocks in §4).
- Spec gap: IC `import('./generated/error-codes')` needs T0C-05 output; T0C-02 depends only on T0C-01.
