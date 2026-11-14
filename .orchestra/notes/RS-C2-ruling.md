TESTS_WRONG — rs-c2.baseline.json holds a pre-T0D-DEP-02 sha256 for features/admin/auth/actions.ts; the spec forbids behaviour change by the restyle, not byte drift from another task.
- spec/program/10-DESIGN-SYSTEM.md:135 (s7.2) and LD-140 (inbox brief line 31): RS tasks change "appearance and arrangement only; no API, field, validation, permission or route change". The rule binds the RS-C2 diff, not commits from other tasks merged from main.
- spec/program/12-REFERENCE-SOFTWARE-GAP.md:138: restyle passes "never behaviour". Commit 62f59645 ([writer] T0D-DEP-02, LD-174, merged via 1cdbced0) is the only change to auth/actions.ts since the baseline (git log: 31eebaeb, b2a8dea7, 62f59645; no RS-C2 commit). It swaps the inline LIMS_WEB_BFF_KEY_FILE read for readBffKey(); same key, same X-Lims-Bff-Key header, same /v1/identity/auth/* calls.
- The byte-identical check is a test design choice, not a spec rule; it is stale against the new main.
Change to make (tester), apps/web/src/features/admin/__tests__/rs-c2.baseline.json only:
- Replace ONLY the value of data_files["features/admin/auth/actions.ts"] with the sha256 of the file as it is at 62f59645 (CRLF normalised to LF, as the test computes it).
- Do NOT run a full RS_C2_RECORD=1 re-record: that would also re-baseline routes, api_paths, permission_codes and field_names from the restyled tree and hide a real behaviour change.
- Keep auth/actions.ts in DATA_FILES; leave rs-c2.static.test.ts unchanged.
Not part of this ruling: the rs-c2.screens.test.tsx "Failed to start forks worker" error is the host (LD-177: no further reset, goes to the founder).
