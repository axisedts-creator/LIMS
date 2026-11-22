# T0D-FIX-12 impl (writer)
- apps/web/src/core/session/c2.ts: 429 retried once after Retry-After (delta-seconds, capped 1 s; date/junk/missing = 1 s), same body/cookie/key; 2nd 429 relayed as typed problem (middleware already fails the request with 429 problem+json). Comment cites LD-455.
- apps/web/src/core/shell/Rail.tsx, GlobalSearch.tsx: prefetch={false} on every <Link>.
- [CONV] No request-scope memo added: middleware already resolves once per request (tester measured: page render = 1 resolve); idle touch logic untouched.
- Tests: fix12 config 31/32 pass; the 1 fail is disputed (T0D-FIX-12-dispute.md: other lanes' links, over file budget). Existing session/shell/api suites 415/415 green (temp JSX config). tsc: no errors in changed files.
- Open: dispute ruling; limiter recommendation in T0D-FIX-12-left.md.
