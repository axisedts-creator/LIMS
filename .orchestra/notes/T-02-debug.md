## T-02 debug round 1
- Cause: `test_no_provider_value_outside_allowed_paths` regex over-broad; hits are Envoy protobuf URLs (`type.googleapis.com`), vendored Supabase OAuth comments (AZURE), `public.ecr.aws` deny list, and 169.254.169.254 deny probes — none are hosting-provider values.
- Fix: none in implementation (hits sit in T-05/T-23 vendored/test paths, not T-02's). Test contradicts 02-TRD.md:225 intent; see `.orchestra/notes/T-02-dispute.md`. Stopped.
