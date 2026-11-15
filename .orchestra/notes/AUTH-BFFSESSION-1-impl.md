# AUTH-BFFSESSION-1 impl (writer)
- Changed: `services/api/src/core/openapi.ts` only (SID_COOKIE const + `out.bffSession` in securityHandlers(), always registered). bearerJwt untouched. No test/contract/spec edits.
- [CONV] LD-212/LD-189/LD-206: passes only if requestAuth bffKind set, route url starts `/v1/identity/auth/`, Cookie has `__Host-lims_sid=` value 1..4096 chars; else AuthError auth.unauthenticated. No DB call, no key/cookie read into logs, no claims, no kind check.
- Tests: bff-session.test.ts 158/158 pass. `src/core` + `src/modules/identity`: 6416 pass, 1 fail = known pre-existing identity role-packs/route-guard.test.ts.
- REPORT: schemes used in contracts/openapi/*.yaml with NO handler: deviceToken (8 ops), portalSession (9), patientPreAuth (3), paymentCallbackToken (4), queueDisplayToken (1). Only bearerJwt (and now bffSession) have handlers. These ops fail the same way (401 before handler) -> separate tasks.
- createAuthResolverRegistry: defined in core/auth/resolvers.ts; production code outside its own file does NOT call it (only tests under engagement, instruments, reporting, core/auth). Nobody wires it into securityHandlers.
- Open: GoTrue TOTP enrolment, session tables under RLS and resolveSession never run live.
