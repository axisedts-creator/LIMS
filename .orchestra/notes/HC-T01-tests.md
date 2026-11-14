# HC-T01 tests
- File: `services/api/src/modules/homecollection/__tests__/boot.test.ts` (vitest). Run: `.orchestra\notes\HC-T01-verify.cmd`.
- Covers: manifest (name/openapi/produces collection.synced.v1/no ports), 26 operationIds = handlers, 501 in dev / common.internal in staging+prod, no input echo, 6 homecollection.* permissions + per-op bearerJwt + privileged perms (handover/device/settings), config LIMS_HOMECOLLECTION_* defaults/overrides/fail-fast, real boot (26 routes mounted, 401 fail-closed).
- SEAMS the writer must follow (modelled on modules/analytics): `HOMECOLLECTION_PERMISSIONS` (frozen array), `loadHomecollectionConfig(env)` with fields pushMaxMutations/pushMaxBytes/snapshotMaxVisits/specimenRefreshSeconds (positive ints; snapshotMaxVisits <= 60; error names the env key), stubs 501 only when LIMS_CORE_ENV=dev.
- Fails now: ../index.js, ../config.js, ../permissions.js do not exist (import error). Not tested: A2 assertRole (handler-level, later task), real handlers.
