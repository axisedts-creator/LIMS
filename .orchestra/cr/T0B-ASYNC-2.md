Title: CR-C0-T0B-ASYNC-2-001: homecollection.refresh_visit_specimens needs ctx.ports.LabPort, which the worker JobContext does not provide
From chunk: C0 (C0-0B, task T0B-ASYNC-2)            To owner: C0-0B lead (worker core / port registry, IC X7); C5 (LabPort owner) for info
Type: port
Blocking? no for T0B-ASYNC-2 (task left undeclared, stays on the async-manifests KNOWN_GAP list per LD-279 shrink-only rule); yes for queuing homecollection.refresh_visit_specimens.
Problem: services/worker/src/jobs/homecollection/tasks/refresh_visit_specimens.ts (ctx typed `any`) calls api modules/homecollection/specimen.service.ts:29 `c.ports.LabPort.lookupSpecimens(...)`. JobContext (services/worker/src/core/manifest.ts:21-34) has no `ports` member and core/bootstrap.ts:73-78 wires none (not even a notWired proxy). Declared as-is, every run throws `TypeError: Cannot read properties of undefined (reading 'LabPort')`, retries 10 times (02-TRD §10) and dead-letters. Brief done_when (1): "if a task file does not fit the manifest type, write a change request and stop".
Proposed change (exact): add `readonly ports: PortRegistry` (contracts/ports, 03-INTERFACE-CATALOG §4 PortContext) to JobContext and wire it in bootstrap.ts from the port registry (IC X7), at minimum LabPort; then add 'homecollection.refresh_visit_specimens': refreshVisitSpecimens to jobs/homecollection/index.ts and drop it from KNOWN_GAP. Alternative: lead rules in writing that a dead-lettering task is acceptable until X7.
Backward compatible? yes (adds a context member).
Tenant/security impact: none on RLS/grants; LabPort.lookupSpecimens runs inside the existing withTenantScope tx.
IRD/regulatory impact: none.
Alternatives considered: declaring the task now (rejected: guaranteed dead-letter, hidden from tsc by `ctx: any`); rewriting the task file (rejected: brief forbids).
Tests that will prove it: async-manifests.test.ts with refresh_visit_specimens removed from KNOWN_GAP; homecollection manifest.test.ts listing it; a bootstrap test that ctx.ports.LabPort is defined.
