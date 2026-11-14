HC-T18 dispute (debugger): only failing test = hc-t18.nav.test.ts:66 "C0 build check passes across ALL feature manifests". Error: `duplicate shortcut chord "g t": anatomic (anatomic.tracking) and homecollection (homecollection.handovers)`.
Not fixable in C17 code: the same test (l.18, l.47) and spec/chunks/C17-home-collection/04-UI-UX.md:12,16 + spec/review/C17-home-collection.md:19 require handovers chord `g t`; C17 may not edit apps/web/src/features/anatomic/nav.manifest.ts (C11-owned, T-19).
Spec resolves it on the C11 side: spec/chunks/C11-specialty-pathology/04-UI-UX.md:16 "If a later collision appears, the build fails and C11 drops its chord (no CR needed)." C17's `g t` came later (review #19, after C11's 2026-11-06 check).
Needed: C11/anatomic drops or changes `chord: 'g t'` on anatomic.tracking (nav.manifest.ts:8). Alternative: lead rules C17 handovers uses another free chord, then test l.18/l.47 must change (tester).
No implementation change made.
