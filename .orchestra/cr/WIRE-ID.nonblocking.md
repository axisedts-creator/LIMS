Title: CR-C1-WIRE-ID: core gives module construction no systemActorPermissions source
From chunk: C1            To owner: C0-0C
Type: port
Blocking? no (staging boot works; system actors hold no identity permission until fixed)
Problem: CR-C2-013 names ctx.core.systemActorPermissions, but core hands module construction no such provider. identity/index.ts uses `() => []` (fail closed, the documented unknown-id result), so IdentityPort denies every system actor every permission.
Proposed change: core passes a systemActorPermissions(actorId) provider (from worker manifests) to module construction; identity then replaces `() => []` with it.
Backward compatible? yes. Tenant/security impact: none now (narrowest result); widening only via the core provider.
Alternatives considered: hard-coded ids (rejected: invents permissions).
Tests that will prove it: manifest-ports.test.ts (unknown id gives none) plus a core provider test.
