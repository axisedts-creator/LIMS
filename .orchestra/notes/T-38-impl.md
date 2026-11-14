# T-38 impl (writer)
- Added `apps/web/src/features/catalog/help/<slug>.md` for all 19 slugs (home … imports), named after the last helpKey segment; SCR-07/08 use analyte.md / ranges.md (as the test header assumes).
- Added `docs/manual/catalog/`: README.md (index + onboarding checklist: lab-default tax rule before go-live), integration.md (04-UI-UX §7), runbook.md (Import stuck / Import quarantined / No price spike), and one page per screen.
- [CONV] Each manual screen page is the in-app help text plus a back-link to README, so the two cannot drift apart. Regenerate by copying help/ when help changes.
- [CONV] Copy is taken word for word from 04-UI-UX §3/§4/§7; no new names.
- Tests: `web-t38.docs.test.ts` 216/216 pass (vitest, web-t38 config, TZ=Asia/Kathmandu).
- Open: no screenshots (none required); the manual-from-help copy is a manual step, not a build step.
