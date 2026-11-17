# T0C-08 impl (AC-0C-4.1, 4.2)
- Files: root `package.json` (`mock:core` port 4100, `mock:list`, devDep `@stoplight/prism-cli` 5.16.0); `packages/fakes/{package.json, src/msw/server.ts, src/msw/handlers.generated.ts}`; `tools/codegen/codegen.ts` (+`genMsw`, wired into `generateAll`).
- [CONV] port = 4100 + index of module in `MODULE_OWNERS` order (core=0); `mock:list` prints `<m> http://127.0.0.1:<port>` from root scripts.
- [CONV] handlers: `*`-origin, `{p}`→`:p`, sorted by operationId, lowest 2xx + first `examples` value (else `example`), no body if none; `trace` ops skipped (no MSW helper).
- [CONV] `@lims/fakes` exports `./msw` → `server.ts` (re-exports `handlers`); no `setupWorker` (02-TRD §5.5).
- Tests: mocks.test.ts 14/14; full tools/codegen vitest 190 pass/3 skip (one cold first run had 1 failure, not reproduced in 3 reruns); `codegen --check` clean.
- Open: Prism not installed/run here (not smoke-tested); `mock:<m>` scripts are hand-added — each new contracts/openapi/<m>.yaml needs one (test enforces). Literal `:` in a path segment would be read as an MSW param.
- Note: `pnpm codegen` rewrites `db/seeds/003_*.sql` with LF (CRLF-only diff in worktree, no content change).
