APPROVE

Re-review (round 2) of 49912c2..HEAD (writer 038659a, tester 2702bea).

Prior items:
1. Fixed. Success report.sh now sits outside `block`, after `always` (restore-drill.yml:538). The rescue ends in `fail` and any_errors_fatal is set, so the success timestamp is written only after blkdiscard/lvremove succeeds (03-APP-FLOW s4.1). Covered by test_success_report_runs_after_scratch_lv_removed.
2. Fixed. drill-pg runs on `--network=drill-net`. DOCKER-USER is ACCEPT to dr wg_ip tcp/2222 via wg0, then DROP everything else from the subnet (insert order is correct). The rules and the network are deleted in `always`, and a missing rule is tolerated. repo2-sftp-host is the dr wg_ip:2222 (no DNS dependency). Covered by test_scratch_container_egress_limited_to_dr_sftp.
3. Fixed. .orchestra/cr/T-10.md is filed (non-blocking) and covers the repo2_sftp_private_key consumer and the C0 export-tenant-billing CLI.

Run: `python -B -m unittest discover -s infra/tests/static -p "test_t10_*.py"` gave 56 run, OK, 2 skipped (no promtool locally).
Still unverified (process gate AC-13.3): staging drill, promtool, real pgbackrest/LUKS/iptables behaviour.
