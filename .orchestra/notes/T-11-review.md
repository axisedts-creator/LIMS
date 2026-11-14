APPROVE
Re-review after fixes (diff 28c0fd9..HEAD). All three items from round 1 are resolved:
1. lims-object-replica.sh:32 FLAGS now use `--partial-dir=.rsync-partial`, not a bare `--partial`. The comment cites 02-TRD s9.5, 03-APP-FLOW and the CR.
2. test_t11_object_replica.py:460-468 has the regression tests `test_flags_use_partial_dir_not_bare_partial` and `test_interrupted_transfer_is_completed_by_next_run_or_shown_as_lag`.
3. .orchestra/cr/T-11.md is filed: (a) the flag change is non-blocking; (b) the dr `replica` chroot, sshd :2222 and authorized_keys (plus pgBackRest repo2) have no owner, and `object_replica_host_key` must be set per environment. It blocks only the end-to-end run.
Checked again, OK: no `--delete`; names are verbatim; LD-45 is followed (groups['dr'][0], no host literals, an empty dr gets no timers); the key is on tmpfs with mode 0600 and no_log; the host key is pinned; only owned paths are touched. T-11 static tests: 38/38 OK (run here).
Not run: the live `lvextend -r` test (gated by LIMS_T11_LIVE) and real rsync over ssh. The alert for a failed nightly verify depends on T-19.
