APPROVE

Re-review after fixes (3c7213e2, cd2e6a0b). Scope: `git diff 4b62cb22..HEAD`. `node --test tests/docs/C6-T35.manual.test.mjs` → 27/27 pass.

1. Prior item 1 (portal payment pages) fixed: docs/manual/reporting/portal.md:13-35 now covers the dues page (incl. balance 0), the report-page dues card, Payment status `/r/{token}/payments/{id}` and Payment return `/r/payments/{id}/done`, with wording verbatim from 04-UI-UX §4 rows 287-290 and the shipped pages (C6-T42). "after a minute" matches "up to 60 s". The gateway outcome never-shown/trusted note is present.
2. Prior item 2 fixed: runbooks.md:47 now says "Rotation needs `reporting.channel.manage`." (verbatim).
3. New tests (C6-T35.manual.test.mjs:101-109, 136-138) assert both fixes. Only owned paths and notes were touched. No PHI, secrets or invented names.
