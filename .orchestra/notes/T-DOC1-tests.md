# T-DOC1 tests (tester)
- `tests/c16-t-doc1/help-manual.test.ts` + `tests/c16-t-doc1/vitest.config.ts` (vitest, repo root; pattern as C13.T25).
- Run: `.orchestra\notes\T-DOC1-verify.cmd`
- Help check (C0-UI §7): `apps/web/src/features/engagement/help/<helpKey>.ts` default-exports `{title, sections[>=2], shortcuts?, links?}` for all 12 keys of 04-UI-UX §8; no orphans; LD-140 clean; app_access explains identity check, phone binding, full history.
- Manual `docs/manual/engagement/`: README + pages naming every helpKey and every `/engagement/...` route in routes.yaml; staff pages name `legal.privacy_url`, `legal.terms_url` (LD-28), `engagement.link.issue`, aal2, consent text.
- Link checker: relative links + #anchors resolve, README links all pages, PNG-only local images with alt, no external URLs, synthetic data only.
- Patient page: H1 "How the app protects your reports" (file name free), in README; secure storage, screenshot/PDF trade-off, code once/phone only, remove profile, system browser, "Privacy policy"/"Terms of use" (LD-28), no URLs, no over-promises (pinning/push/guarantees).
- Assumptions: help file name = full helpKey; link from A6 (Flutter) not tested here. Fails now: no help dir, no manual dir.
