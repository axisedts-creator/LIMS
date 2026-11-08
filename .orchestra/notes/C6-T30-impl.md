C6-T30 impl: new apps/portal (package, next config, middleware, server/{api,session,origin}.ts, features/portal/*, pages r/[token]{,/code,/report}, download/reissue/signout routes, v/[token], app fallbacks, .well-known stubs).
Checks: static 12/12; tsc clean; Playwright 47/48 (fails: AC-10.2 identical-response, see C6-T30-dispute.md).
[CONV] challenge id in 2nd cookie `__Host-lims_portal_ch`; `Origin: null` accepted only with Sec-Fetch-Site same-origin (no-referrer makes browsers send null).
[CONV] /v/<tok> middleware-rewritten to /v/_ with token in header x-qr-token (payload independent of token). Sign-out = POST route /r/[token]/signout.
[CONV] CSP enforced in production, report-only under next dev. Banner/Button of @lims/ui are client-only (react-aria) -> server-safe Notice with kit CSS classes.
Open: assetlinks/AASA are empty stubs (ids from C16/C17); dues pages (PP1/PP2, /dues) ship with C15; footer lab phone not available from API; "{n} tries left" omitted (API gives no count).
Side effects: building tokens modified tracked packages/ui/src/tokens.ts + packages/ui-flutter/.../tokens.g.dart (not mine; `git checkout` them); test-results/ is generated; pnpm-lock.yaml updated for new workspace member.
