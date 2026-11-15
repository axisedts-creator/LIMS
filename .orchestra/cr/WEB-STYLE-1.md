Title: CR-C1-WEB-STYLE-1: 401 middleware sign-in stub stays unstyled (CSS would need CSP/nonce change)
From chunk: C1            To owner: C0-0D
Type: bug
Blocking? no  (WEB-STYLE-1 is complete without it; LD-198 rule (b))
Problem (what you cannot do today, with the user story / acceptance criterion it serves):
  The unauthenticated first screen is the middleware stub apps/web/src/core/shell/sign-in-page.ts (401, AC-0D-7.2). It renders with no CSS by design. WEB-STYLE-1 only fixed its link (href /auth/ -> /auth/login). Giving it the Metro Green look would need either an inline <style> (blocked by the current CSP) or a nonce/hash added to the CSP, both outside C1 and outside LD-198 scope.
Proposed change (exact): none from C1. Owner decides one of: (1) keep the stub CSS-free (current state, AC-0D-7.2 as written); (2) add a CSP hash/nonce for a minimal stub stylesheet; (3) redirect unauthenticated page loads straight to /auth/login instead of the 401 stub — this deviates from AC-0D-7.2 and is the founder's decision.
Backward compatible? yes (option 1 is no change; options 2/3 are owner/founder calls)
Tenant/security impact: option 2 touches CSP (new hash/nonce); option 3 changes the 401 behaviour. No RLS change, no PHI field, no new public surface.
IRD/regulatory impact (billing changes only): n/a
Alternatives considered: styling the stub inside WEB-STYLE-1 — rejected by LD-198 (b) (CSP/nonce change, middleware untouched).
Tests that will prove it: for option 2, a middleware test asserting the stub's CSP header carries the stylesheet hash; for option 3, a middleware test asserting a 307 to /auth/login replaces the 401.
