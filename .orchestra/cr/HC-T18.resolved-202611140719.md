Title: CR-C17-HC-T18: duplicate nav chord `g t` — anatomic.tracking (C11) collides with homecollection.handovers (C17)
From chunk: C17            To owner: C11
Type: bug
Blocking? yes — HC-T18 (nav test "the C0 build check passes across ALL feature manifests") fails after merging main.
Problem (what you cannot do today, with the user story / acceptance criterion it serves):
  C0 build-nav reports `duplicate shortcut chord "g t": anatomic (anatomic.tracking) and homecollection (homecollection.handovers)`.
  C17 04-UI-UX §1 l.12/16 assigns `g t` to homecollection.handovers (review C17 #19). C11 04-UI-UX §1 l.16 already rules:
  "If a later collision appears, the build fails and C11 drops its chord (no CR needed)." C17 cannot edit apps/web/src/features/anatomic/** (not owned).
Proposed change (exact): apps/web/src/features/anatomic/nav.manifest.ts — remove `chord: 'g t'` from the `anatomic.tracking` entry (per C11 04-UI-UX §1 l.16).
Backward compatible? yes — only the keyboard chord for Block & slide tracking goes away; route, permission, id unchanged.
Tenant/security impact: none (no RLS, PHI or public surface change).
IRD/regulatory impact: n/a
Alternatives considered: change C17 chord — rejected, contradicts C17 spec §1 and C11's own collision rule; HC-T18 test asserts `g t`.
Tests that will prove it: apps/web/src/features/homecollection/__tests__/hc-t18.nav.test.ts (C0 build check across all manifests) via .orchestra/notes/HC-T18-verify.cmd.
