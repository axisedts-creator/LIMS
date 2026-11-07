# T-03 tests (tester)
- File: `infra/tests/static/test_t03_host_baseline.py` (stdlib + PyYAML). Classes: Roles, Idempotence, Ssh, UsersAndPackages, Sysctl, Chrony, WireGuard, Nftables, LuksVolumes, DockerEngine, ContainerHardeningScript.
- Run: `.orchestra\notes\T-03-verify.cmd` (= `python -B -m unittest discover -s infra/tests/static -p "test_t03_*.py"`). Now: 62 failures, all "role/file missing"; 1 skip (ansible-playbook --syntax-check, CI only, LD-17).
- File lookup is by glob inside the role (`lims.conf*`, `90-lims.conf*`, `chrony.conf*`, `wg0.conf*`, `daemon.json*`, `lims-luks-unlock.service*`; nft rules = all files of role nftables). Networks = YAML mappings with `name`, subnet (literal or `docker_subnets.<key>`), `internal`.
- ASSUMPTION (contract for container_hardening.py): `--daemon-json PATH` checks only that file, exit 0 if TRD s5.7 holds, else non-zero and output names the key; stdlib only.
- Covers AC-01.4 (input drop, DOCKER-USER order), AC-29.1 (LUKS2, key in tmpfs, guarded format), AC-29.2 (chrony + node_timex_offset_seconds in role), AC-29.3 (sshd wg-only), REQ-SEC-125/130/132/137.
- NOT provable here: converge-twice = 0 changes, real unlock/fallback, live `nft list ruleset`, live networks (need VM; Idempotence class is a static proxy).
