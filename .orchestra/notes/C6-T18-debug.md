# C6-T18 debug
Cause: verify fails at load, not on T18 logic: `Cannot find module 'dompurify'` from `domain/sanitise.ts:24` (module-level call at :27), pulled in via `index.ts` -> narrative/outsourced handlers. dompurify/jsdom absent from services/api deps and node_modules.
Impl notes confirm templates.handlers + templates.static + manifest = 136/136 pass with dompurify/jsdom stubbed; no T18 code defect.
Fix: none possible in C6 paths. services/api/package.json is C0-0D-owned; already requested in `.orchestra/cr/C6-T17.md` (accepted CR-C6-019: dompurify 3.4.17, jsdom 31.0.0 + lockfile).
Action: C6-T18 verify stays blocked until that CR lands; rerun verify after a clean install. No test or impl edits made.

## round 2
Cause unchanged: `Cannot find module 'dompurify'` (sanitise.ts:24), dompurify/jsdom still absent from services/api/package.json. Not a T18 defect (136/136 pass with stubs).
Fix: none in C6 paths; blocked on CR-C6-019 (.orchestra/cr/C6-T17.md). Rerun verify after C0-0D lands deps + lockfile. No test/impl edits.
