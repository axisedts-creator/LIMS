APPROVE

Reviewer TESTFIX-1 (LD-268), diff 9eda17b19..HEAD.
- Scope: test files + rs-c2.baseline.json + .orchestra/notes only. No product, policy, grant, migration, seed or contract edit. No secrets, no PHI, no new names.
- route-guard: STALE confirmed (AppShell.tsx rewritten in 9f4e6a46a T0D-MSERIES-2, LD-251). New regexes still pin `hasPermission(perms, e.permission)` + `perms = session.actor.permissions`; it still fails if the filter is removed. Not weakened.
- static.security / platform-ddl-1: detector false positive on the test title only. The guard regex and the PLATFORM-DDL-1 `/disable\s+row/i` assertions are unchanged.
- rs-c2: STALE baseline. The auth/actions.ts hash changed through 5b78ce4c6 (AUTH-MFA-PERSIST-1, LD-248). The two route entries exist in the tree (9f4e6a46a). api_paths, permission_codes and field_names are unchanged.
- Run by reviewer 2026-11-16: api 3 files / 221 tests pass; web rs-c2.static 14/14 pass.
- Non-blocking note: TESTFIX-1.md says 5b78ce4c6 came "since" 59b20a582. git shows it is an ancestor of 59b20a582, so that baseline refresh was already stale for that key. This does not change the classification.
- The other-reds list is present (api 84 files, web 261 files), as done_when requires.
