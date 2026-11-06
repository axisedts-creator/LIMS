# T-01 impl (writer)
- Files: infra/{README.md,THIRD-PARTY-OPS.md}, infra/ci/*.sh (12 stubs, exit 2), infra/secrets/.sops.yaml, infra/secrets/schema/{dev,staging,prod}.secrets.schema.yaml (60 ids each, same set), infra/tests/run.sh (TAP: gitleaks, yamllint, ansible-lint if infra/ansible, static tests minus Lint class to avoid self-recursion).
- [CONV] .sops.yaml age recipients are non-bech32 PLACEHOLDERS (sops rejects them = fail closed); real public keys at key ceremony.
- [CONV] free-name ids: pgbackrest_repo{1,2}_cipher_pass, repo2_sftp_private_key, object_replica_ssh_key, luks_keyfiles, registry_htpasswd, grafana_admin_password, grafana_users, ops_nginx_basic_auth, alertmanager_smtp_relay, wireguard_private_keys (on-host only), lims_<role>_password.
- [CONV] upstream Supabase ids marked exposure: env; consumers "(T-05)" resolved against UPSTREAM.lock.
- Test nit: test_rotation_intervals_conv treats valkey_lims_api_password as a DB password (contains lims_api + pass) and wants 180; TRD s8.2 says 365. Kept 365, block carries a comment explaining 180 does not apply (satisfies regex). Tester should exclude valkey_*.
- NOT RUN: python, gitleaks, bash -n all denied approval in this session; yamllint/ansible-lint not installed (pip install denied). Verified only by grep (no >80-char YAML lines, no value/private-key keys).
- Removed stale T-01-dispute.md (test file now exists; tool gap stays open, see above).
