APPROVE

SEC-HDR-1 review (diff 950e5290..d537ac9c8).
- LD-238 met: X-Frame-Options DENY + Permissions-Policy on web (`secure()` covers next, redirect, rewrite, problem+json), portal (single exit) and partner middleware; partner gains Referrer-Policy no-referrer; web keeps `same-origin`, portal keeps `no-referrer` (added only where missing). camera=(self) on web only, cited to NewPatientForm.tsx getUserMedia; all other features `()`.
- API: one onSend hook (observability/security-headers.ts, wired in bootstrap) adds nosniff + no-referrer on every response, no-store only on 2xx JSON of a non-x-public operation when Cache-Control is absent. Handler Cache-Control is kept.
- CSP: no value or header name changed; golden-string tests per app (nonce stripped) and the PARTNER_CSP_ENFORCE / portal production switches are unchanged. HSTS left at the edge.
- No contract/spec/migration/policy edits, no secrets, no PHI, synthetic fixtures only. 5 implementation files (limit 8).
- Ran the four sec-hdr1 suites myself: api 13/13, web 12/12, portal 11/11, partner 18/18 green.
- Note (not a defect): operations with `security: []` but no `x-public` (session flow, callbacks) also get no-store. That is the safe direction.
- Open, not caused by this task: `pnpm -s verify` fails at `@lims/web#typecheck` on test-file errors that were already there (writer note). Not re-run by me.
