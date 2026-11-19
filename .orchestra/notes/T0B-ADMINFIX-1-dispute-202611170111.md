# T0B-ADMINFIX-1 dispute (writer): the chain test cannot be satisfied by any fix in owned paths; no code changed
Baseline: audit.chain.test.ts 47 fail / 34 pass (cause confirmed: registry.ts:106 refuses module identity reading its own IdentityPort).

Conflict inside audit.chain.test.ts, both "shadow" and "enforce" use the SAME handlers and the SAME HandlerContext:
1. enforce, "asserts its x-permission exactly once" (line 68): stage 8a (authz-central.ts:84-85) already calls the observed IdentityPort.assertRole once via the `frontdesk` view. So the handler must NOT call the observed port again.
2. shadow, "nobody gets in without the permission" (lines 100-129): stage 8a only logs, so the handler MUST assert (e.g. reader on listAuditExports: canReadAll is true, nothing else denies -> 200, test wants 403).
The handler cannot tell the two modes apart: authzMode is a createPipeline option (index.ts:56/195) and is not on ctx; the central result / RequestAuthz state is not on ctx either (authz-guard.ts keeps it private by design). The only port a handler can reach is ctx.ports.IdentityPort = the observed one.
Workaround checked and rejected: a module-local createIdentityPort over createCoreAdminRepo() would bypass the counter, but the fake pool (audit-view.helpers.ts:86) does not answer the core-admin membership/permission SQL, so admin would fail too; and it would be a second, unmonitored permission path (bad for AUTH-SENSITIVE code).
Even a core fix (owner may read its own port in registry.portsFor, which is a CR anyway) makes view ops assert twice in enforce (central + _audit-view.bind.ts) -> line 68 still fails.

Proposed test change (pick one, lead/arbiter):
 a) enforce: assert 1..2 like shadow (accept handler defence in depth); or
 b) count only stage 8a + extra permissions, i.e. expect `n >= 1` and that no *other* permission is asked (line 72 already covers no widening).
Proposed fix once (a)/(b) is ruled: identity reads IdentityPort through a view that allows the owner. Narrowest is core (registry.portsFor: `owners[port] === module` passes) = CR; alternative inside identity needs PORT_CONSUMERS to list identity (generated from contracts, not owned, and the test pins that it does not).
Second cause for listAuditExports (asked by the brief): _audit-export.bind.ts has no guard, but audit-export.service.ts:121 (canReadAll, P-10) and :134 (getActor, centre scope) read ctx.ports.IdentityPort -> same registry refusal -> common.internal.
