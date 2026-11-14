Title: CR-C7-WEB-T03-a: SCR-05 page shortcut Alt+N ("New instrument") contradicts C0 global Alt+N
From chunk: C7            To owner: C0-0D (shell shortcuts) / spec owner of C7 04-UI-UX §4
Type: spec
Blocking? no — "New instrument" stays reachable by its button; only test web-t03.components.test.tsx:167-180 is held. Same root as CR-C7-WEB-T02-d (.orchestra/cr/WEB-T02.nonblocking.md:38).
Problem: spec/chunks/C7-instrument-integration/04-UI-UX.md:192 declares SCR-05 `Alt+N` New instrument; spec/chunks/C0-foundation-contracts/04-UI-UX.md:317 reserves global `Alt+N` (focus navigation), and C0 04-UI-UX.md:325 / 01-PRD.md:245 (AC-0D-7.5) require the registry to throw / the build to fail on a page key that conflicts with a global key. No implementation can satisfy both.
Proposed change (exact): spec owner assigns SCR-05 (and SCR-01, :190) a free `Alt+<letter>` page key in C7 04-UI-UX §4, or rules that page "New" actions reuse the global Alt+N handler.
Backward compatible? yes
Tenant/security impact: none
Tests that will prove it: web-t03.components.test.tsx "page-level ... New instrument is registered for manage only" updated to the ruled key.
