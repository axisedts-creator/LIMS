# HC-T01 impl
- Files: `services/api/src/modules/homecollection/{index,permissions,config}.ts` (new; no test files touched).
- index.ts: manifest (name/openapi/produces collection.synced.v1, no ports); 26 stub handlers inline (no handlers/ dir: not in task file list). Stub = 501 only if LIMS_CORE_ENV=dev and NODE_ENV!=production, else LimsError common.internal. [CONV] same as analytics.
- permissions.ts: HOMECOLLECTION_PERMISSIONS frozen, 6 codes. config.ts: loadHomecollectionConfig(env), 4 fields, defaults per TRD §11.1, [CONV] snapshotMaxVisits capped 1..60, digits-only ints.
- Run: vitest homecollection/__tests__ = 39/39 pass.
- Open: later tasks may want a handlers/ dir (move stubs then); no per-op permission enforcement yet (core bearerJwt + handler assertRole in later tasks).
