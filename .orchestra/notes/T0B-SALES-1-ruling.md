TESTS_WRONG — effects.test.ts:308/315 setup depends on cross-file state of the shared tenant B settings row; fix setup only, no assertion change.
1. Already decided by binding lead decision LD-376 (inbox T0B-SALES-1-arbiter.md:42), which outranks chunk text for this task; this ruling applies it.
2. services/api/src/modules/homecollection/__tests__/sync/effects.test.ts:308 calls setSettings(TENANT_B, ...false) BEFORE pushWorld (line 310); pushWorld runs ensureSettings (sync/helpers.ts:134) which seeds defaults, so the false value is lost when the row was absent/replaced by an earlier file.
3. Assertion line 314 (confirmed, null, received_at = handed_over_at) is the spec'd behaviour (03-APP-FLOW §1.3, cited in the test title) and stays untouched.
4. TESTER: in that test either (a) move line 308 setSettings to after `const w = await pushWorld(...)` (line 310), or (b) replace it with an upsert INSERT ... ON CONFLICT (tenant_id) DO UPDATE SET handover_confirmation_required = false; restore at line 315 the same way (upsert true).
5. TESTER, same pass (LD-376): grep every file under services/api/src/modules/homecollection/__tests__ for setSettings calls that run before pushWorld/seedWorld and apply the same fix.
6. Never DELETE homecollection.settings or any audited row (LD-356). No assertion deleted/skipped/loosened (LD-347).
7. WRITER/DEBUGGER: no implementation change; do not dispute this again; verify once after tester pass (main + timing command, three runs green).
