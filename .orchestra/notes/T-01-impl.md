# T-01 impl (writer)
- Files: infra/{README.md,THIRD-PARTY-OPS.md,.gitleaks.toml,.gitignore}, infra/ci/*.sh (12 stubs), infra/secrets/.sops.yaml, infra/secrets/schema/{dev,staging,prod}.secrets.schema.yaml, infra/tests/run.sh (LD-06).
- This round (review items 1-3): untracked committed .pyc (`git rm --cached`) + new infra/.gitignore `__pycache__/`; gitleaks allowlist narrowed to `infra/tests/static/__pycache__/` (checked: without allowlist a stale .pyc gives 2 leaks, with it 0); run.sh:3 and README:20 now state the LD-17 ansible-lint exception.
- [CONV] .sops.yaml age recipients are placeholders (sops rejects = fail closed); real keys at key ceremony. Free-name ids as before.
- Ran: `bash infra/tests/run.sh` = gitleaks ok, yamllint ok, ansible-lint SKIP (LD-17), static 24 OK. `python -m unittest discover -s infra/tests/static` = 27 run, OK (1 skip).
- Open: ansible-lint / CI=true run on ops runner not verified locally.
