# T0B-ADMINFIX-1 debug (debugger) — no code changed, still BLOCKED on core CR
- Cause (47 fails, all at core/ports/registry.ts:106): portsFor('identity') refuses IdentityPort outside production because generated PORT_CONSUMERS.IdentityPort omits owner `identity`; pipeline/index.ts:111 getter then throws common.internal on any `ctx.ports.IdentityPort` read.
- Cause 1: _audit-view.bind.ts:20. Cause 2 (listAuditExports/getAuditExport/createAuditExport): audit-export.service.ts:121 (canReadAll) and :134 (getActor) read the same port.
- Fix = core/ports/registry.ts:100 `|| owners[port] === module` (C0-0D owner, brief: core fault is a CR). Filed: .orchestra/cr/T0B-ADMINFIX-1.md. Every module-local workaround would bypass stage 9 (AUTH-SENSITIVE), so none applied.
- Tests are consistent with the spec (no dispute). Re-run verify.cmd once the CR lands; no handler edit expected.
