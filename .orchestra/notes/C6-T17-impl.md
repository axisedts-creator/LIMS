# C6-T17 impl (writer) — post-ruling round (LD-62)
Files: no code change this round. LD-62 deps already in place (services/api/package.json dompurify 3.4.17 + jsdom 31.0.0 exact; pnpm-lock.yaml regenerated). narrative.service.ts stores sections as {key, heading, html} (key order per ruling); eager deps() in sanitise.ts kept.
[CONV] Tests revised by tester per arbiter ruling (TESTS_WRONG, heading); impl unchanged.
Checks: verify.cmd (narrative.handlers, narrative.static, manifest) 231/231 pass. Full reporting dir: 1045 pass / 1 fail = repository.static inline-SQL check on service/reports.service.ts (C6-T04 file, not C6-T17).
tsc: errors only outside chunk (contracts/ports/IdentityPort.ts TS2835, packages/shared-ts bsdate TS5097) — pre-existing, not touched.
Open: repository.static / reports.service.ts needs a C6-T04 owner; `pnpm install --frozen-lockfile` ERR_PNPM_IGNORED_BUILDS (@scarf/scarf) from last round still unapproved.
