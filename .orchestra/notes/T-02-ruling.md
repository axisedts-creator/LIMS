TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)

Reasons:
- spec/chunks/C1-infrastructure-ops/02-TRD.md:217-225: "provider-specific value" is scoped by §3.4 (B12) to the hosting-provider adapter contract (VMs, provider firewall, console, snapshots, DR site) — i.e. values that bind infra to one VM host. 01-PRD.md:61 (IS-01) says the same: "provider bits in `infra/providers/<name>/`".
- Verified by running provider_scan(INFRA): all 11 hits are non-hosting: Envoy protobuf type URLs `type.googleapis.com/...` (compose/supabase/envoy/*, compose/supabase/upstream/volumes/api/envoy/*), commented OAuth `AZURE` settings in vendored compose/supabase/upstream/{.env.example,docker-compose.yml}, `public.ecr.aws` in a foreign-registry deny list (tests/internal/registry_egress.sh, tests/static/test_t23_registry.py), and `169.254.169.254` in metadata-endpoint DENY probes (tests/internal/egress_probe.sh, tests/static/test_t05_supabase_compose.py). None configures a host on a provider; none is a T-02 file.
Required test change (infra/tests/static/test_t02_providers.py:34-69):
1. PROVIDER_RX: drop bare `googleapis` and bare `azure`/`google[ -]cloud`/`\baws\b`; match hosting contexts instead (`amazonaws\.com`, `compute\.googleapis\.com`, `\.azure\.com`, `cloud\.google\.com`). Keep vendor names (hetzner, digitalocean, ...), `\bec2\b`, region and instance-id patterns, `/dev/xvd`.
2. provider_scan: skip `compose/supabase/upstream/` (vendored verbatim upstream, not LIMS-authored config).
3. Allow `169.254.169.254` only under `tests/` (deny/probe assertions); still flag it everywhere else.
4. Keep test_scanner_flags_planted_values_and_honours_allowed_paths passing unchanged in intent; add one planted `type.googleapis.com/envoy` line (not flagged) and one `compute.googleapis.com` line (flagged).
