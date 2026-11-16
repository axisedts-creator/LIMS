# T0B-PROVFIX-1 impl (writer, per LD-295 / arbiter ruling)
- services/api/src/modules/identity/service/tenant.service.ts: provisionTenant no longer calls seedIrdAnnexes (one comment line, LD-295, T0B-PROVFIX-3); seedIrdAnnexes + TENANT_ANNEXES kept; interface comment updated. Rest of provisionTenant unchanged.
- Tests: tenant.service + tenant.handlers 176/176 pass (.orchestra/notes/T0B-PROVFIX-1-verify.cmd); tsc --noEmit (services/api) clean.
- Review note completed (.orchestra/notes/T0B-PROVFIX-1-review.md): no FKs on created_by/updated_by/recorded_by; all 160 role permission codes seeded; feature flag insert admitted in scope.
- Nonblocking CR .orchestra/cr/T0B-PROVFIX-1.md: audit_log clause for the 3 annex tables (T0B-PROVFIX-3) + support_sessions writes (openSupportSession etc.) failing the same way.
- [CONV] none. Open: invite TypeError (T0B-PROVFIX-2) still blocks the founder retry; no DB run in lane, static review only.
