APPROVE
# T5 re-review (reviewer) — diff 545ef77..HEAD, fixes 8b6da95..43ecc0b
Ran: `vitest run src/modules/identity/ports/__tests__/` → 78 pass / 5 skipped (live, no DB).

Prior items resolved:
1. core-admin.repo.ts SUPPORT_SQL now LEFT JOIN platform_staff + coalesce(display_name,''); validity depends only on identity.support_sessions. Display-name read path filed as non-blocking CR `.orchestra/cr/T5.md` (CR-C2-021). Live support-actor test added (skips without DB).
2. IdentityPort.impl.ts revokePatientSessions: reason must be in REVOKE_REASONS, verbatim with sessions__revoke_reason__ck (db/migrations/20261105001300 :172-174). Unit test covers bad + all 13 allowed.
3. IdentityPort.impl.ts updatePartnerMembership deactivate: reasonCode must be in DEACTIVATION_REASONS, verbatim with memberships__deactivation_reason__ck (20261105000400 :64-65); absent still maps to 'other'. Unit test covers bad (no write) + all 4 allowed.

Still not verified: live DB run (support-actor RLS test, privileged re-validation), `T5 bench:` p95, partner-actor writes under P-16 RLS. Open items from T5-impl.md (provision/openPatientSession fail closed BLOCKED T1/D-218; A28.2 scope; C0 tsc `./common` error) are unchanged and already recorded.
