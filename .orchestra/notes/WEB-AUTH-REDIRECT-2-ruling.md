TESTS_WRONG — the real-server test requires an absolute Location on the wire and the unit test requires a loopback host to survive NextURL; LD-203 requires neither.
Reasons:
1. spec/ has no WEB-AUTH-REDIRECT-2 row (grep: 0 hits); binding source is LD-203 + task brief in .orchestra/inbox/WEB-AUTH-REDIRECT-2-arbiter.md (lines 19-20, 30).
2. LD-203 (inbox:30) real-server test: "307 and a Location ending in /auth/login". The absolute-URL requirement is for unit tests only (brief inbox:20 "unit tests assert an absolute Location"). Next's server relativizes same-origin redirects on the wire; not middleware-controlled.
3. Fix web-auth-redirect-server.test.ts:70-75: `const u = new URL(loc, base)`; keep `u.pathname === '/auth/login'`, `u.search === ''`, `u.origin === base` (still catches a foreign origin/open redirect). Drop the `new URL(loc)` must-not-throw assertion (line 71).
4. Fix line 92 the same way: `new URL(loc, base).pathname`; keep the /evil/i check on the raw header (line 91), and also assert `new URL(loc, base).origin === base`.
5. web-auth-redirect.test.ts:120-122: NextURL normalizes 127.0.0.1/::1 to localhost, so a loopback host cannot prove "origin follows the request". Use a non-loopback synthetic host, e.g. `http://lab.example.test:4567/no-such-page`, expecting `http://lab.example.test:4567/auth/login`. Intent (origin from request, not constant; inbox:30 "origin equals the request origin") unchanged.
6. Implementation (NextResponse.redirect(new URL(literal, req.nextUrl.origin), 307)) matches LD-203 scope; no implementation change required by this ruling.
