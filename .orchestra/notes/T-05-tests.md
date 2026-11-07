# T-05 tests (tester)
- Static: `infra/tests/static/test_t05_supabase_compose.py` (stdlib + PyYAML + docker CLI for `compose config`, no daemon). Run: `.orchestra\notes\T-05-verify.cmd`. Now: 26 fail ("missing file" upstream/, UPSTREAM.lock, DECISION.md, overrides), 15 pass (the tools below).
- I wrote the test tools: `infra/tests/internal/published_ports.py` (AC-01.3, `--wg-ip/--public-ip/--only`) and `egress_probe.sh auth` (AC-09.3, TAP; driven by a fake `docker` in the tests). Both unit-tested; real run of the probe = deploy/CI.
- Live (CI/dev VM, `LIMS_T05_LIVE=1`): `infra/tests/integration/test_t05_live.py` GoTrue healthy, probe, no gateway port, Storage upload/download from an `app_net` container. NOT run here.
- CONTRACTS (see test docstring): project dir infra/compose/supabase, `-p supabase`, files per TRD s7.2; `up` set + depends_on closure exactly db,pgbouncer / api-gw,auth,rest,storage,imgproxy; DECISION.md line `Decision: split|fallback` (+ mentions `!reset`, `depends_on`, `functions`, Compose version).
- UPSTREAM.lock = YAML `repo, commit(40hex), fetched, files{rel-path: sha256}, images{svc:{image,tag,digest}}`; needs `-text` in .gitattributes for upstream/**; rendered image of api-gw/auth/rest/storage/imgproxy/pgbouncer = `<image>@<lock digest>`; trimmed lds mounted from outside upstream/.
- Assumes upstream service name `api-gw` and an `lds` mount target (TRD wording); if upstream differs, file a CR.
- Not provable here: real image pulls, healthy GoTrue, nftables rules, Envoy 404s (live test).
