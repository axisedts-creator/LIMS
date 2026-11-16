# T0B-ADMINFIX-1 impl (writer, reset 1 of 2, after T0D-PORTOWN-1 on main)
- Files changed: `services/api/src/modules/identity/handlers/_audit-export.bind.ts` only (asserts audit.log.export via IdentityPort.assertRole, fail closed common.internal when port absent; same shape as _audit-view.bind.ts). No file under services/api/src/core.
- Cause 1 (view ops): core/ports/registry.ts portsFor refused module identity its own IdentityPort outside production; fixed by T0D-PORTOWN-1 (LD-305).
- Cause 2 (listAuditExports/getAuditExport/createAuditExport): audit-export.service.ts canReadAll (P-10) and getActor read ctx.ports.IdentityPort -> same refusal; plus the bind asserted no permission, so in shadow mode (LD-261) a non-holder got 200/202 instead of 403.
- [CONV] guard fails closed (AUTH-SENSITIVE); no audit row / retention change. assertRole count 1..2 in shadow per arbiter ruling 202611170111.
- Verify (verify.cmd): 4 files, 171/171 pass; `tsc --noEmit` clean. eslint not installed in services/api (not run).
- Open: unrelated identity failures seen earlier (ci/ci-scripts, role-packs/apply-role-pack.script) not touched.
