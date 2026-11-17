# T15 impl (writer)
Files: identity/service/org.service.ts (service + default SQL repo), handlers/{list,create,update,deactivate,reactivate}{Branch,Centre}.ts, handlers/branchCentre.http.ts (glue, reuses role.http ifMatch/obj), handlers/index.ts (wiring).
[CONV] findBranch locks FOR UPDATE: centre create/move and deactivateBranch serialise on the branch row (no active centre under inactive branch).
[CONV] unknown / other-tenant / inactive branch on createCentre/updateCentre all -> 409 identity.centre_inactive, no detail (P-2); version checked after load, before business rule, lost race -> 409 version_conflict.
[CONV] reactivateCentre under an inactive branch -> 409 identity.centre_inactive (spec silent; CR .orchestra/cr/T15.md).
[CONV] no access-log entry on writes (master data; row audit trigger covers it), unlike role.service.
Tests: 174/175 pass; 1 disputed (.orchestra/notes/T15-dispute.md: test code contains `_`). tsc: only 2 pre-existing errors outside the lane.
Open: CR T15 (centre_inactive missing from updateCentre/reactivateCentre x-error-codes; list maxItems vs AC-C1.3). Default SQL repo never run against a live DB.
