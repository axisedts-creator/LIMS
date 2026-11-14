# WIRE-ID impl (writer)
- Changed: `services/api/src/modules/identity/index.ts` only (ports line + 2 imports); no wire file needed.
- `ports: { IdentityPort }` = createIdentityPort({ repo: createCoreAdminRepo(), systemActorPermissions: () => [] }); metrics = default identity sink.
- [CONV] systemActorPermissions fail closed `() => []`: core gives module construction no CR-C2-013 source. Non-blocking CR: `.orchestra/cr/WIRE-ID.nonblocking.md`.
- LD-81: no mintPatientAccessToken, no patient writers; no env/file/connection at construction; claimsResolver placeholder untouched.
- Tests: manifest-ports 29/29; identity dir (excl. role-packs) 4206 passed, 72 skipped, 0 failed.
- tsc --noEmit has pre-existing errors elsewhere (quality/observation.service.ts); none in identity/index.ts.
- Open: real systemActorPermissions provider needs core change (CR above).
