# T0B-ADMINFIX-1 impl (writer) — BLOCKED on CR, no code changed
- Files changed: none in services/; filed `.orchestra/cr/T0B-ADMINFIX-1.md` (to C0-0D, blocking), per ruling point 4.
- Cause 1 (view ops): core/ports/registry.ts:100-106 refuses module `identity` its own IdentityPort outside production -> _audit-view.bind.ts:20 read throws common.internal.
- Cause 2 (listAuditExports/getAuditExport/createAuditExport): _audit-export.bind.ts has no guard; audit-export.service.ts:121 (canReadAll, P-10) and :134 (getActor) read ctx.ports.IdentityPort -> same refusal.
- Fix needs core (owned by C0-0D, 01-CHUNK-MAP §3): proposed one-line `|| owners[port] === module` in portsFor; PORT_CONSUMERS untouched (test :45-48 stays).
- [CONV] no module-local IdentityPort: would bypass stage 9 and the observed port (AUTH-SENSITIVE).
- Open: once CR lands, re-run verify.cmd; identityIsConsumer control tests indicate handlers then pass without edits.
