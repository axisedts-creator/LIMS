# T0D-FIX-12 impl (writer)
- apps/web/src/core/session/c2.ts: 429 retried once after Retry-After (delta-seconds, capped 1 s; date/junk/missing = 1 s), same body/cookie/key; 2nd 429 relayed as typed problem (middleware already fails the request with 429 problem+json). Comment cites LD-455.
- apps/web/src/core/shell/Rail.tsx, GlobalSearch.tsx: prefetch={false} on every <Link>.
- [CONV] No request-scope memo added: middleware already resolves once per request (tester measured: page render = 1 resolve); idle touch logic untouched.
- Tests: after ruling (T0D-FIX-12-ruling.md) fix12 config 32/32 pass. Existing session/shell/api suites 409/409 green (22 files, temp JSX config). tsc: no errors in changed files.
- Open: limiter recommendation + per-lane prefetch follow-up (C2, C5, C13) in T0D-FIX-12-left.md.
