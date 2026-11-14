APPROVE

H80-T08 review (reviewer), diff 0a948063..37fb7c5e.
- Full C7 suite re-run by reviewer: 61 files, 2071 passed, 4 todo (known MET-T03 hostQuery.getein_metis), 0 fail, 290 s.
- done_when covered: truth_h80e from real g_drivers rows = generic, none verified; E22/E23/E25 driver_status generic; E28 go-live refused `instruments.driver_not_available` (server side of toggle-disabled; web toggle owned by H80-T06); static guard for skip/only/new todo.
- No existing test or TS fixture edited (diff = 1 new test file, notes, 1 new fixture file).
- apps/bridge-agent/testdata/config/README.md: byte-identical to __tests__/fixtures/config/README.md (cmp), C7-owned path (01-CHUNK-MAP), synthetic key text only, no secret.
- No migration/route/RLS/permission/log changes in this diff; names (truth_h80e, generic, instruments.driver_not_available, E22-E28) match spec; LD-139 cited.
- Non-blocking: CRLF checkout risk for fixture byte-identity on Windows (writer note); .gitattributes eol=lf would need a CR if not owned.
