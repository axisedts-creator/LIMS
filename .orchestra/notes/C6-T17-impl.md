# C6-T17 impl (writer) — review round
Files: service/narrative.service.ts (review #2: stored sections now {key, heading, html} per 05-SCHEMA §2.12; heading copied from template at draft creation and on N3, N5 copies prev; view uses stored heading, falls back to template/key for legacy rows; content_sha256 now covers headings). services/api/package.json + pnpm-lock.yaml reverted to 5ecae71 (review #1); `.orchestra/cr/C6-T17.md` asks C0-0D to add dompurify 3.4.17 + jsdom 31.0.0 per CR-C6-019.
[CONV] N3 with no template: heading = key.
Checks: tsc — only the 2 pre-existing errors (contracts/ports, shared-ts). vitest (handlers, static, manifest, narrative-image): FAIL — "Cannot find module 'dompurify'" + static "declared dependencies" assertion, because the deps were reverted. Expected until C0-0D lands the CR.
NOT verified: the new heading-freeze test and the rest of the suite with deps present (re-run with deps restored was blocked by approval prompts in this session).
Open: task stays pending-cr on CR-C6-019 / .orchestra/cr/C6-T17.md. Real DB/RLS not exercised.
