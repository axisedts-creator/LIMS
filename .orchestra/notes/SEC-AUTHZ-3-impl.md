# SEC-AUTHZ-3 impl (writer)
- Changed: services/api/src/core/pipeline/authz-central.ts only (skipReason no longer skips platform.*; new platform branch calls PlatformAuthz.assertPlatform(ctx, x-permission); identity/platform/authz.ts read use only).
- [CONV] platform ops are marked asserted for stage 9 before the check (same as non-user actors in SEC-AUTHZ-2), so shadow does not 500 on staging.
- [CONV] ctx.platformRole/aal exist only for a verified platform session (buildCtx), so tenant/patient/partner/portal/system/device actors fail inside assertPlatform with auth.forbidden; aal1 on a privileged code gives auth.mfa_required. IdentityPort.assertRole is never asked for platform.*.
- Mode, deny log and metric unchanged from SEC-AUTHZ-2; no contract, permission, SQL or exception-file change; no handler-vs-x-permission mismatch found, so no CR.
- Run: 8 vitest files 754/754 pass; node --test authz-classification 19/19 pass; tsc shows no error in authz-central.ts.
- Open: snapshot tests/security/authz-classification.json regeneration is the tester's (no change expected); full api suite not run.
