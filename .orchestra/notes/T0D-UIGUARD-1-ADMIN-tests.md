# T0D-UIGUARD-1-ADMIN tests (tester)
- Edited: apps/web/src/core/__tests__/uiguard1.exceptions.ts. Deleted all ADMIN entries (LD-441): 18 rule 7 legacy routes + the 2 pinned `/admin/*` entries (rule 1, rule 2; the rs-c2 display pin is withdrawn by LD-439 d). Nothing added.
- No new test file: the guard (uiguard1.guard.test.ts) proves done_when 4, 5, 6. Existing rs-c2.static and t20 tests prove 2 and 8 and are chained in verify.
- Red now, for the right reason: rule 1 (18 pages, no PageHeader), rule 2 (4 pages: access-log, audit, sessions, users hand built filter row), rule 7 (18 pages, raw h1 in page-kit.tsx, raw h/ul in ui.tsx and components).
- Writer: rebuild screens, delete the ADMIN lines in notes/T0D-UIGUARD-1-exceptions.md, re-record rs-c2.screens snapshots last (LD-440). Never touch the registry.
- Watch: rs-c2.screens.test.tsx:216 expects a level 3 heading in each drawer section; t20 tests use getByRole('heading'): a Card title row must keep those working or the writer disputes it.
- Run: .orchestra/notes/T0D-UIGUARD-1-ADMIN-verify.cmd (rs-c2.screens fails on stale snapshots until the writer re-records).
