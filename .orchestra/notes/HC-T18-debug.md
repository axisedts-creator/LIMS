Cause: chord `g t` duplicated by C11 anatomic.tracking (apps/web/src/features/anatomic/nav.manifest.ts:8); C0 buildNav fails. Not a C17 code defect.
Fix: none possible in C17-owned paths without breaking test + spec (`g t` required). C11 must drop its chord per its own 04-UI-UX:16. See HC-T18-dispute.md.
