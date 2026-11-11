# FD-T01 tests
- services/api/src/modules/frontdesk/__tests__/unit/boot.test.ts (vitest): files exist, manifest vs real contracts, real-repo bootstrap boots, 29 ops mounted + unauthenticated 400/401, handlers throw LimsError common.service_unavailable (503, no payload echo), permissions (10 TRD §7 codes, in permissions.yaml), config keys/defaults, worker `manifest` + validateManifests, web `navManifest`.
- tests/frontdesk/FD-T01.paths.test.mjs (node:test): six files exist; tools/lint/check-paths.ts passes on `c04/*`, fails for other chunk / core path.
- Run all: `.orchestra\notes\FD-T01-verify.cmd` (needs `pnpm install`; this worktree has no node_modules, so vitest was NOT run here).
- Export names the writer must use: `manifest` (index.ts, worker index.ts), `handlers` (handlers/index.ts, same object as manifest.handlers), `navManifest` (nav.manifest.ts). permissions.ts/config.ts export shape is free; keys/codes must be spec-verbatim.
- Assumption: "nav entry hidden" = `navManifest.entries` is `[]` (NavEntry has no hidden flag). If a different mechanism is intended, file a CR.
- Expected now: all fail (files missing). Not testable here: tenant-flag config, live auth with claims.
- Revised per FD-T01-ruling.md: the 3 bootstrap tests now use `bootConfig()` = loadConfig with LIMS_CORE_JWT_ALG/ISSUER/AUDIENCE/KEY_FILE (ES256, synthetic key from core/auth/__tests__/helpers.ts). Assertions unchanged.
