TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)
- The guard assertions themselves are spec-backed and stay: `server/<operationId>.server.ts` must start with the "server-only" import guard (spec/program/02-CONVENTIONS.md:222-223).
- The defect is the harness, not the spec: web-t02.components.test.tsx:382, :394, :404 build paths from `process.cwd()`, which assumes cwd = apps/web. .orchestra/notes/WEB-T02-verify.cmd:1 runs from repo root (`cd /d "%~dp0..\.."`), and vitest `root` does not chdir, so the test gets ENOENT. No spec line requires a particular cwd.
- Change in test: resolve the three dirs from the test file, the same way web-t01.test.ts:12 and vitest.web-t02.config.ts:8 already do, e.g.
  `const WEB = join(import.meta.dirname, '..', '..', '..', '..');` then `join(WEB, 'src/features/instruments/components')`, `join(WEB, 'src/features/instruments/server')`, `join(WEB, 'src/app/(staff)/instruments', p)`.
- Keep every regex and assertion unchanged. Leave verify.cmd as it is.
- Point 2 (msw `onUnhandledRequest` TS2353) does not block and needs no spec ruling. The tester may fix the typing if `tsc` is a gate.
