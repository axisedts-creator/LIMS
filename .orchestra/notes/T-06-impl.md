# T-06 impl (writer)
- Files: `infra/ansible/roles/secrets_render/{defaults/main.yml,tasks/main.yml,templates/service.env.j2}`. Tools `secrets_not_default.py`/`docker_inspect_secrets.py` already by tester, unchanged. T-06 static: 47/47 OK; yamllint role clean.
- Flow: assert enc file = `<env>.enc.yaml` -> dirs + findmnt tmpfs -> `sops -d` (localhost, run_once, no_log, stdout) -> ops_audit via `infra/ci/ops-note.sh` -> per-host placement by group -> asserts (non-empty, env values no `'`/newline, UID per service) -> files 0400 owner=UID, env files root 0400.
- [CONV] upstream Supabase env ids -> one `/run/lims/env/supabase.env` per host (compose `--env-file`, single-quoted literal); data gets POSTGRES_PASSWORD only; fixed_env (AC-05.3) goes there too.
- [CONV] `valkey_lims_api_password` -> `LIMS_CORE_REDIS_URL` in api-a/b, worker-a/b `.env` (value must be `[A-Za-z0-9._~-]`, no URL-encoding). `secrets_render_uids` and `secrets_render_enc_file` have no defaults: role fails closed until set (no UIDs in spec).
- Open: valkey `users.acl` not rendered; `reporting_channel_<secret_ref>` not placed (dynamic ids); value generation (generate-keys.sh -> sops) not scripted; role not wired into site.yml; stale files stay until reboot when a placement is removed.
- Not verified: no ansible/sops/jinja2 here, so the Jinja (set_fact dict build, template) never ran; live test_t06_live.py not run.
- Full static suite: 9 F / 2 E elsewhere (t01 gitleaks = upstream .env.example + tester's t06 test literals, t01 yamllint = T-05 compose, t02, t09, t20, t21); none in secrets_render.
