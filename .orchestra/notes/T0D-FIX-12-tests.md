# T0D-FIX-12 tests (tester)
- apps/web/src/core/session/__tests__/fix12.c2-429.test.ts: c2Resolver retries 429 once (Retry-After honoured, capped 1 s, junk/missing ok), 2nd 429 relayed, other statuses/no-answer not retried, same touch/cookie/key on retry.
- apps/web/src/__tests__/fix12.burst.test.ts: middleware = 1 resolve per request (measured: page render = 1, serverFetch fan-out = 0, so bursts come from link prefetch), touch true/false kept, 429 twice -> 429 problem+json with no session headers, static check: every `<Link>` in Rail.tsx, GlobalSearch.tsx (and any next/link user under core/ only, per T0D-FIX-12-ruling.md) has prefetch={false}.
- apps/web/src/__tests__/vitest.fix12.config.ts: test-only config.
- Run: pnpm --dir apps/web exec vitest run --config src/__tests__/vitest.fix12.config.ts  (= T0D-FIX-12-verify.cmd)
- Now: 32 tests, 21 fail (no retry in c2.ts, no prefetch={false}), 11 pass (guards: no retry on 401/5xx/no-answer, 1 resolve per request, touch).
- Writer: retry goes in c2.ts only; middleware needs no change. Existing session/shell/server-fetch tests untouched.
