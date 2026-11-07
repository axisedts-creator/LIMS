# T-11 impl (writer)
- Files: roles/object_replica/{defaults,tasks,handlers}/main.yml, files/lims-object-replica.sh, templates/lims-object-replica{,-verify}.{service,timer}.j2; roles/luks_volumes/files/lims-lv-grow.sh + install task (0700) in tasks/main.yml; playbooks/site.yml play `Object replica` on `app:dr`.
- [CONV] REPLICA_DEST has no script default (LD-45: no host name); units set it to replica@<hostvars[groups['dr'][0]].wg_ip>:/replica/storage/. Empty `dr` (dev) = no timers.
- [CONV] new inventory var `object_replica_host_key` ("<type> <base64>" of dr sshd :2222), pinned in /etc/lims/object_replica_known_hosts; key on tmpfs /run/lims/secrets/object_replica/ssh_key 0600 (as pgbackrest).
- [CONV] lag sampled AFTER the transfer (dry-run, `>f` lines only); if the dry-run also fails, lag = now - last_success. verify flags corruption only on `%i` 3rd char `c` of file lines. Verify timer 03:30 UTC.
- [CONV] lvextend called as `lvextend -L|-l <size> --resizefs /dev/vg/lv`; shrink/odd input refused.
- Tests: T-11 36/36 OK; yamllint + gitleaks clean on touched paths. Full static: 577 run, 7 fail/2 err, none in T-11 files (missing T-20/T-21 promtool test files, yamllint on compose/supabase + rules/tests, envoy provider grep, 4 gitleaks hits elsewhere).
- OPEN: dr side only creates /srv/lims/replica/storage; the `replica` user, sshd :2222 chroot (/replica -> /srv/lims/replica) and authorized_keys are unowned by any task (same gap as pgBackRest repo2 SFTP) -> needs a lead decision/CR. `object_replica_host_key` not yet in staging/prod group_vars (assert fails closed until set).
