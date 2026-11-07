# C6-T18 debug
Cause: verify fails at load, not on T18 logic: `Cannot find module 'dompurify'` from `domain/sanitise.ts:24` (module-level call at :27), pulled in via `index.ts` -> narrative/outsourced handlers. dompurify/jsdom absent from services/api deps and node_modules.
Impl notes confirm templates.handlers + templates.static + manifest = 136/136 pass with dompurify/jsdom stubbed; no T18 code defect.
Fix: none possible in C6 paths. services/api/package.json is C0-0D-owned; already requested in `.orchestra/cr/C6-T17.md` (accepted CR-C6-019: dompurify 3.4.17, jsdom 31.0.0 + lockfile).
Action: C6-T18 verify stays blocked until that CR lands; rerun verify after a clean install. No test or impl edits made.
