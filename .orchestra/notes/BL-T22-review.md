APPROVE

BL-T22 review (diff bbadee1d..HEAD, 2026-11-11)
- Code change: only services/api/src/modules/billing/__tests__/probes/probe.kit.ts (owned path). No implementation file was touched, as LD-105 requires.
- All four LD-105 items are in place: (1) IdentityPort.readBrandingAsset, which still refuses tenant B asset ids with common.not_found; (2) ctxFor.uploads.accept; (3) anonymisePatient runs with tenant A's actor and centreScope.all === true, and the allowed codes were not widened to auth.forbidden; (4) BODY_FOR gives updatePatient a one-field valid body (full_name, per the PatientUpdate schema) and searchPatients a valid query of at least 3 characters (POST body, E3/LD-10).
- crossTenant assertions and both own-tenant control cases are unchanged; crossTenant.handlers.test.ts is not in the diff.
- No PHI: data is synthetic ('Synthetic Patient', 'Demo'). No secrets. No invented names.
- Verified: `vitest run src/modules/billing/__tests__/probes` gives 359 passed, 7 skipped, 1 todo, 0 failed.
- Not re-checked here: alert YAML files and the CR (unchanged in this diff, already in HEAD). tables.live is skipped because it needs a live DB.
