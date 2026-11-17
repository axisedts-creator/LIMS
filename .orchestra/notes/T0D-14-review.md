APPROVE
- Scope: `git diff 8db0dbb..HEAD` = test-harness edits + notes only; implementation (25c422b, inside base) unchanged.
- playwright.config.ts: `import.meta.url` -> `__dirname`, unused imports dropped — exactly ruling item 1.
- T0D-14.shell.spec.ts:13 `useSid`: `url: WEB` -> `domain: 'localhost', path: '/'`; `__Host-lims_sid`, httpOnly, secure, sameSite 'Lax' kept — exactly ruling item 2. No other assertion changed; cookie-attribute test (AC-0D-7.3) still asserts HttpOnly/Secure/Lax/Path=/ no Domain on the server-set cookie.
- Re-run in tracked tree (2026-11-07): `node --test tests/web-e2e/T0D-14.static.test.mjs` 11/11 pass; `pnpm exec playwright test -c ../../tests/web-e2e/playwright.config.ts` (apps/web) 17/17 pass, AC-0D-7.1–7.6 all exercised.
- No secrets, no PHI, no new names; edited paths are tests/web-e2e + .orchestra/notes only.
- Carried open items (not blocking, per impl note / CR T0D-14.md): actions.ts idempotency keys, SSE relay, HelpPanel, module i18n loader, X-Request-Id uuid v4 vs v7, `next dev` middleware-to-proxy deprecation warning.
