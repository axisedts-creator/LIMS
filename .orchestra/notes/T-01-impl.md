# T-01 impl (writer)
- Files: infra/{README.md,THIRD-PARTY-OPS.md}, infra/ci/*.sh (12 stubs), infra/secrets/.sops.yaml, infra/secrets/schema/{dev,staging,prod}.secrets.schema.yaml, infra/tests/run.sh (LD-06).
- This round: run.sh applies LD-17 (missing ansible-lint = `SKIP ansible-lint (CI only)` unless CI=true, then FAIL); yamllint falls back to `python -m yamllint` when script not on PATH (still FAIL if absent); wrapped 2 over-80 comment lines in dev/staging schema.
- [CONV] .sops.yaml age recipients are placeholders (sops rejects = fail closed); real keys at key ceremony. Free-name ids as before (pgbackrest_repo{1,2}_cipher_pass, lims_<role>_password, ...).
- Ran: `bash infra/tests/run.sh` = all ok (gitleaks ok, yamllint ok, ansible-lint SKIP, static 24 OK). Full unittest: 27 run, 1 skip, 1 FAIL test_yamllint_clean.
- Open (env, not code): yamllint 1.38.0 pip-installed --user to %APPDATA%\Python\Python314\Scripts, not on PATH; shutil.which fails. Fix: add that dir to PATH. ansible-lint not verified (CI only).
