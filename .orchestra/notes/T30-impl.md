# T30 impl (manuals + in-app help, S24)
- Added docs/manual/admin/ (README + sign-in + 16 screen pages) and docs/manual/platform/ (README + 10 pages); apps/web/src/features/platform/help/ (10 files). Admin help (16, from T20) unchanged.
- Content from 04-UI-UX §3–§7; routes and permissions are copied as written in contracts/routes.yaml and permissions.yaml (roles/role-editor edits cite identity.role.manage; branch/centre edits cite identity.centre.manage).
- [CONV] LD-140: manual describes the right drawer and per-section/per-tab Save; role pack not mentioned (RM-T05).
- [CONV] Did not invent tenant status values or the permission for "Record review completed" (spec silent); left them generic.
- Verify: node --test tests/docs/C2-T30.manual.test.mjs gives 67/67 pass; all tests/docs/*.test.mjs give 94/94 pass.
- Open: nothing under infra/tests/ touched (LD-116).
