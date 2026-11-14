IMPLEMENTATION_WRONG — the test is right (say what the implementation must do)
1. hc-t18.nav.test.ts:18,47 (handovers chord `g t`) match spec/chunks/C17-home-collection/04-UI-UX.md:12 and :16 (`g o` dropped for C8, `g t` replaces it).
2. hc-t18.nav.test.ts:64 (C0 build check across ALL manifests, chords unique) matches 04-UI-UX.md:16 "Chords are checked unique by C0's build, which is authoritative" and spec/chunks/C11-specialty-pathology/04-UI-UX.md:16 "Chords must be unique across manifests".
3. Spec already resolves the collision without a CR: C11 04-UI-UX.md:16 "If a later collision appears, the build fails and C11 drops its chord (no CR needed)." So no contradiction; CR_NEEDED does not apply. Tests stand unchanged.
4. Required change (per binding lead decision AUTO 2026-11-14T07:19:48 in the HC-T18 brief): in apps/web/src/features/anatomic/nav.manifest.ts remove `chord: 'g t'` from the `anatomic.tracking` entry, all other fields unchanged. homecollection.handovers keeps `g t`; no change to C17 homecollection code.
5. Ownership: the anatomic file is C11-owned; this edit is authorised only by the lead decision above and must touch nothing else in that file.
