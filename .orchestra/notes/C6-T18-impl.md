# C6-T18 impl (writer)
Files: `service/templates.service.ts` (createTemplatesService: T1-T4, T6 + getVersionById / resolvePublishedVersion), `repository/templates.repo.ts`, `handlers/templates.handlers.ts`, `index.ts` (wired; T5 stays 501).
- [CONV] If-Match = report_templates.version; T4/T6 win the version-guarded header UPDATE first, then write version rows; 23505 on draft/published index -> common.version_conflict.
- [CONV] T6 with no draft -> reporting.template_invalid; stored draft re-validated at publish (422, no write). Retire old published, then promote draft, then current_version_id = new row (set in header bump).
- [CONV] Version row lookups for renders: draft -> common.not_found; no published version -> common.not_found. Config returned as stored (frozen), not re-validated.
- Config stored = validated copy (defaults filled); config_sha256 = sha256(JSON of that copy).
Verified: templates.handlers + templates.static + manifest = 136/136 pass, BUT only with dompurify/jsdom stubbed via a throwaway vitest config outside the repo. Plain `C6-T18-verify.cmd` still fails to load handlers+manifest: `Cannot find module 'dompurify'` (CR-C6-019, not mine to fix).
Open: tsc errors pre-exist outside my files (contracts/ports/IdentityPort.ts, shared-ts bsdate). repository.static.test fails on service/reports.service.ts (not my file).
