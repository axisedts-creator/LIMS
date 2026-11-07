# T0D-14 dispute — two test-harness defects (implementation not at fault)

1. `tests/web-e2e/playwright.config.ts:5` uses `import.meta.url`, but no `"type":"module"` package.json is above tests/web-e2e (root has none), so Playwright 1.65 loads it as CJS: `SyntaxError: Cannot use 'import.meta' outside a module`. Adding a local `{"type":"module"}` then fails with `Cannot find package '@playwright/test'` (pnpm does not hoist it to the root). Fix: `const here = __dirname;` (Playwright compiles TS config to CJS) — not run by me in that exact form.
2. `T0D-14.shell.spec.ts:13` `useSid` adds the cookie with `url: WEB` → every test fails `browserContext.addCookies: Protocol error (Storage.setCookies): Invalid cookie fields`. Chromium rejects a `__Host-` cookie set via `url` on http://localhost (probe: `url` form FAIL; `domain:'localhost', path:'/'` form OK and stored host-only, secure, path=/). Fix: replace `url: WEB` with `domain: 'localhost', path: '/'` in `useSid` only.

Evidence: with both fixes applied in an untracked copy (config moved under apps/web, spec patched only at line 13) → **17/17 Playwright passed**; static suite 11/11 passes unmodified. Temp copies deleted.
