APPROVE
# T0D-CATTESTS-1 review (reviewer) — diff 628535496..0618bfba3

Verified
- Names verbatim: catalog.test.read / catalog.test.manage (03-IC:3068); POST /v1/catalog/tests body {code, name, department_id, workflow_type, specimen_requirements[]} and 201 Test / 409 catalog.code_duplicate (C3 02-TRD:226); workflow_type enum matches 02-TRD:162; is_active=all per 02-TRD:146; detail route /catalog/tests/{test_id}.
- Idempotency: createOf sends an Idempotency-Key (validated IDEMPOTENCY_KEY_RE); EditorDialog supplies one key per form; double-click test passes.
- Input at the trust boundary: page.tsx drops non-UUID ids, odd status, q > 100, bad page, new != 1 before any API call; createTest forwards only TestCreate fields via pick() (no mass assignment); q never sent to the API (unknown key = 422).
- Permissions: read gate before any fetch; manage gates the button (disabled + visible reason) and ?new=1; API still enforces. 403 -> CatalogForbidden.
- No PHI, no logging, no secrets. No route, contract or permission change; nothing under features/admin, features/platform, app/(auth), app/(platform).
- Text from catalogue (31 catalog.tests.* keys); LD-310 cited in code comments.
- Tests: ran `.orchestra/notes/T0D-CATTESTS-1-verify.cmd` myself: 40/40 pass. They cover done_when (5): button shown/disabled by permission, headers with zero rows, filter change changes request (status, department, specimen, q), new=1 opens the same form, 25-row paging keeps filters, no raw keys.

Notes (not blocking)
- done_when (1) "short name" search is not possible: OrderableSummary has no short name and the list API takes no q. Documented by writer and tester; lead should raise a CR for server-side q + specimen_type_id (also removes the N+1 getTest specimen filter and the 2000-test MAX_PAGES ceiling, both marked ponytail in code).
- rs-c3.static fails 3 (server hashes / server-import sets): expected drift from new createTest.server.ts + listTests loaders; tester/lead must re-record rs-c3.baseline.json.
- 6 writer files + 2 tester files; reads "at most 6 files" as writer scope.
