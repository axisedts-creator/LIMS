# SEC-ENV-1 impl (writer)
Files: services/api/src/core/config.ts (new `isProductionEnv(env)`; responseValidation default uses it), reporting/delivery/callbacks.ts, payments/config.ts, services/worker/.../send_delivery.ts (worker imports the API helper, one source of truth, no copy).
- [CONV] production = LIMS_CORE_ENV==='production' || NODE_ENV==='production', exact string, reads only the env passed in. Staging (LIMS_CORE_ENV=staging, NODE_ENV unset) unchanged.
- [CONV] payments boot refuses unless GATEWAY_ENV=production exactly when isProductionEnv; error message now names both variables (still names LIMS_PAYMENTS_GATEWAY_ENV, no secrets).
- Ran: api (production-env, callbacks-prod-env, payments unit) + worker reporting tests green; api and worker `tsc --noEmit` clean. Not run: full `pnpm -s verify`.
- Open: payments/unit/manifest.test.ts "PHASE_STUBS ... still lists the other three" fails (expects 3 stubs, got []); file untouched by me, looks pre-existing, not checked on a clean tree.
- Open: `.env.example` comment NOT done, the file is unreadable to this session (permission denied). Someone with access should add: "production = LIMS_CORE_ENV or NODE_ENV is production; then LIMS_PAYMENTS_GATEWAY_ENV must be production".
- Open: LD-236 text said "LD-236" in the files list; no spec/decision file edited (not owned).
