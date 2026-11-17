Title: CR-C1-NEPAL-002: first Nepal server = ONE host, staging (synthetic data only); spec topology stays the prod path
From chunk: C1            To owner: C1 (lead) / founder
Type: bug (topology scope note; no schema/api/event/port change)
Blocking? no. The kit already has the profile (`infra/ansible/inventories/staging-lean/`, LD-45/LD-48, 08-CR-REGISTER addendum citing LD-45).

Problem:
The founder has one server in Nepal (32 GB RAM / 16 cores). 04 S1 requires, for PHI, ">=2 VMs + a third Nepal location for replica/backups". 04 I1 sizes VM-1 data plus VM-2 app. The `prod-lean` profile (08-CR-REGISTER, LD-45) still needs `backup-1` at a second site on a different provider (WAL archive repo2, RPO <= 15 min, object replica, audit digests, external uptime check). So one box cannot host PHI under the spec, lean or full.

Proposed change (exact):
1. The single server is built ONLY with `-i infra/ansible/inventories/staging-lean` (topology_profile `lean`, groups `dr: {}` and `backup: {}` empty). Environment = `staging`. Synthetic data only (CLAUDE.md, 00-README hard rules).
2. No real patient data, no real tenant onboarding, no live payment-gateway keys on this host. C18 (legacy/eLabs import) must not run against it.
3. Nothing in `prod-lean/` or `prod/` changes. Promotion to prod requires `backup-1` at site B (B12: DOIT-enrolled provider) and a restore drill under 35 days old (04 I3), exactly as the spec says.
4. Known reduced guarantees on this host, accepted for staging only: no off-site WAL (pgBackRest repo1 only, local disk), no external uptime vantage (alerts die with the host), restore drill runs on the same host from repo1.

Backward compatible? yes. Documentation and scope only; no code path changes.
Tenant/security impact: none added. RLS, FORCE RLS, cross-tenant probes, TLS, nft egress allowlist and SOPS secrets are unchanged. S1 is NOT relaxed: this host never holds PHI.
IRD/regulatory impact: none (no live invoicing to IRD/CBMS from staging).
Alternatives considered:
- Run `prod-lean` with `backup-1` omitted. Rejected: it breaks S1/LD-45 ("off-site WAL ... never cut").
- Split the 32 GB host into 2 VMs. Rejected: same physical location, so it fails the "third Nepal location" part of S1 and adds no real redundancy.
Tests that will prove it:
- `infra/cutover/server-smoke.sh` refuses to run unless the inventory is `staging-lean` and LIMS_ENV=staging.
- CUTOVER.md go/no-go has a named check "synthetic-only" (no tenant except the synthetic seed tenants).
