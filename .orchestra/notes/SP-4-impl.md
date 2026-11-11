# SP-4 impl
- Files: `db/meta/decisions/SP-4.md` (new). Tests: `node --test db/tests/spikes/SP-4.decision.test.mjs` → 10/10 pass.
- Outcome: **api-proxied**. Live probes ran on the local CLI stack (storage-api v1.89.13, realtime v2.103.2). Every cross-tenant read and write was denied. Same-tenant read worked with resolver-shaped claims and with the server credential.
- Deciding fact: under 08 R10 the GoTrue JWT has no `tenant_id` (no hook), so the §8 policy denies even the owning tenant. Storage-policies would need a new token issuer, which is out of C0's scope.
- [CONV] Resolver-shaped probe tokens were minted with the stack secret, because the C2 login flow and claims resolver are not built yet. The real GoTrue JWT was probed too.
- [CONV] The probe-only Realtime policy `sp4_probe__realtime_select` was temporary and dropped. The real Realtime policy names stay with T0B-14 / C16 / C17.
- Open: T0B-12 skips end-user storage policies. T0B-14 does not create Realtime policies. C4 07-SECURITY "storage policy" wording: CR filed `.orchestra/cr/SP-4.nonblocking.md` (review item 1). Not probed on the C1 compose stack.
