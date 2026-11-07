APPROVE

Scope: `git diff 3384f2a..HEAD` = `infra/tests/internal/container_hardening.py` (new) + debug note. Owned path (task brief files list).
- Checker keys/values verbatim from 02-TRD s5.7 (log-driver, log-opts max-size/max-file, live-restore, no-new-privileges, icc, userland-proxy, default-ulimits nofile 65536/65536); extra `hosts` guard (unix:// / fd:// only) supports REQ-SEC-130 "no TCP API", not an invented requirement.
- Stdlib only; exits 0/1/2; malformed / missing / non-object file fails closed (exit 2).
- Role call (`docker_engine/tasks/main.yml:73-78`, `ansible.builtin.script` + `role_path/../../../tests/internal/...`) resolves to this file and copies it to the host — correct.
- No PHI, no secrets, no DB/RLS/permissions surface in this diff (N/A).
- Ran `python -B -m unittest discover -s infra/tests/static -p "test_t03*.py"`: 51 OK, 1 skip (CI-only ansible syntax-check).
- Not verified here: ansible converge twice / idempotency, `nft -c`, LUKS unlock fallback (need real hosts; not part of this diff).
- Note (not a defect): T-03-debug.md round 4 says "left uncommitted"; file is in fact committed in 357159c.
- Later scope: Σ mem_limit ≤ 85 % (AC-30.1) and compose hardening checks belong to the compose tasks, not T-03.
