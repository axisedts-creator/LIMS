Title: CR-C15-011: C2 settings read port exposes no `trainingMode` flag (LD-26 sandbox-only gateway credentials)
From chunk: C15            To owner: C2 (settings read port) / C0-0C (contracts/ports)
Type: port
Blocking? no for PG-T01 (skeleton, no merchant accounts yet); yes for the merchant-account task (putMerchantAccount / testMerchantAccount must reject live credentials for a training tenant).
Problem: LD-26 (A33-3): `tenant.training_mode = true` => C15 accepts only sandbox gateway credentials. No existing C2 port method exposes the flag, and C15 must not read C2 tables. Serves LD-26, REQ-SEC-136.
Proposed change (exact): expose `trainingMode: boolean` through the existing C2 settings read port (same change already pending as CR-C2-T16 / CR-C6-023; confirm one shared signature). C15 reads it at putMerchantAccount and refuses `environment = production` credentials when true.
Backward compatible? yes (additive field).
Tenant/security impact: no RLS change, no PHI, no new public surface.
IRD/regulatory impact: none.
Alternatives considered: reading `tenant.training_mode` directly (forbidden: foreign table); a C15 own setting (violates "set only at provisioning, immutable").
Tests that will prove it: merchant-account unit test: training tenant + production credentials => rejected; non-training tenant unaffected.
