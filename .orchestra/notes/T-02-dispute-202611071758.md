# T-02 dispute (debugger)
Failing: `test_t02_providers.ProviderValueGrep.test_no_provider_value_outside_allowed_paths` (PROVIDER_RX, test_t02_providers.py:38-45,51-69).
Spec rule: 02-TRD.md:225 "No provider-specific value may appear outside `infra/providers/<name>/` and `inventories/*/hosts.yml`" (hosting-provider values: 02-TRD §3.4 provider contract).
All hits are NOT hosting-provider values; no T-02 file is implicated:
- `googleapis` = Envoy protobuf type URLs `type.googleapis.com/envoy...` in `compose/supabase/envoy/{cds.yaml,lds.template.yaml}` and vendored `compose/supabase/upstream/volumes/api/envoy/*` (T-05; required by Envoy, upstream files vendored verbatim per LD-42).
- `AZURE`/`Google Cloud` = commented OAuth-login settings in vendored `compose/supabase/upstream/{.env.example,docker-compose.yml}` (T-05; not hosting).
- `aws` = `public.ecr.aws` in `tests/static/test_t23_registry.py:70`, `tests/internal/registry_egress.sh:12` (T-23; a foreign-registry deny list).
- `169.254.169.254` = metadata-endpoint DENY probes in `tests/internal/egress_probe.sh:29`, `tests/static/test_t05_supabase_compose.py:301` (hardening assertions).
Fixing in implementation would mean editing vendored upstream/Envoy files or other tasks' paths (not T-02's).
Requested test change (tester): narrow PROVIDER_RX (drop bare `googleapis`/`azure`/`google cloud`/`aws` word matches or require hosting contexts e.g. `\.amazonaws\.com`, `compute.googleapis.com`, `azure.com`), and exempt `compose/supabase/upstream/`, `tests/` deny-lists for `169.254.169.254`. Keep detection of the planted-value self-check.
