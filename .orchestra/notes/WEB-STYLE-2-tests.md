# WEB-STYLE-2 tests (tester)
Files: apps/web/src/__tests__/web-style-2.test.ts, vitest.web-style-2.config.ts, fixtures/shell.baseline-style-2.css (shell.css before the change; "new CSS" = lines not in it), fixtures/auth-fields.baseline.json (field/behaviour signature of the auth sources).
Run: .orchestra/notes/WEB-STYLE-2-verify.cmd (also runs web-style, build-config, build-boundaries; static, no build, no network).
Class contract for the implementer: lims-auth-page = split container (kept), lims-auth-main = form column holding {children}, lims-auth-panel = aria-hidden brand panel; all three need rules in shell.css.
Panel in layout.tsx: aria-hidden, one p/h2/h3 line, one ol/ul with the 7 words in order (Draft … Released), no digits/%, no h1, no img/src/url()/remote URL. CSS: display:none base + @media (min-width: 64rem) shows it and sets 2 columns on .lims-auth-page; single column stays centred below; accent bg + accent-fg text; lime tokens never as `color`.
Now: 8 fail for the right reasons (no panel/main in layout, no new CSS rules, no panel rule, no two-column rule, new classes unused); 74 pass (planted-failure fixtures, forbidden-words scan, fields baseline, WEB-STYLE-1 and WEB-BUILD suites).
Exception (1 of max 3): lims-btn-md (same as WEB-STYLE-1). MfaEnrolment's QR img (DataUriImage, REQ-SEC-088) is allowed; the no-img rule applies to the layout only.
Not tested: the real build and the built-CSS grep (LD-201 (d), impl note); real rendering; if the impl restyles .lims-auth-card, WEB-STYLE-1's centring check (card or page) must still hold.
