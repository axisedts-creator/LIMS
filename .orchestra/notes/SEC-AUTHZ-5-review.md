APPROVE

Scope: git diff 6472637a9..HEAD = tests/security/authz-classification.json (tester regen, ab964cebc) + .orchestra/notes/SEC-AUTHZ-5-impl.md. Owned paths only; no code, contract, permissions.yaml, role pack, SQL, policy or migration change.
- Fresh `node tests/security/classify-authz.mjs` output is byte-identical (CRLF-normalised) to the committed snapshot (LD-420).
- Against 6472637a9: 87 operations change class, all into guarded-exact (46 unguarded, 29 guarded-other, 12 stub); 0 move to a weaker class. Counts: unguarded 176->130, guarded-other 70->41, stub 40->28, guarded-exact 751->838.
- Every operation with a `catalog.*` x-permission is guarded-exact; authz-exceptions.json stays `[]`; no CR needed.
- `node --test tests/security/authz-classification.test.mjs`: 19/19 pass.
- No log, secret or PHI content in the diff.
Not re-run here: vitest catalog suites (impl note reports 6027 pass, 0 fail) and DB-bound catalog suites (no database).
