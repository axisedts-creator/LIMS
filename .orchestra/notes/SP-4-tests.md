# SP-4 tests
- File: db/tests/spikes/SP-4.decision.test.mjs (node:test, no deps; same layout as SP-1/SP-2).
- Run: `node --test db/tests/spikes/SP-4.decision.test.mjs`
- Checks db/meta/decisions/SP-4.md: outcome storage-policies|api-proxied, evidence blocks, probe setup (bucket reports, tenants A/B, claims resolver), cross-tenant read+write denied, same-tenant read works, §8 template, Realtime probe/deferral, no secrets.
- Conditional: storage-policies needs T0B-12 + REQ-SEC-034 and no successful cross-tenant; api-proxied needs ctx.storage, server credentials, C6/C4 CR, T0B-12, no end-user policies.
- Expected now: all 10 fail with "db/meta/decisions/SP-4.md must exist" (see run below).
- Live Storage/Realtime probes not unit-testable; record evidence checked structurally only.
