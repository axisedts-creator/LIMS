# Generic provider — manual checklist (02-TRD §3.4)

Use these steps for any provider without an adapter, or for any VM host. Do them once per environment, then fill `infra/ansible/inventories/<env>/hosts.yml` from `hosts.example.yml`.

1. [ ] **VMs.** Create the VMs for the env, with the sizes from 02-TRD §3.1: prod = 4 (`data-1`, `app-1`, `dr-1`, `ops-1`), staging = 2 (site A: data+app, site B: dr+ops), dev = 1 (all roles except dr).
2. [ ] **Image.** Use Ubuntu 24.04 LTS (server, minimal) on every VM.
3. [ ] **Static IPv4.** Give each VM a static public IPv4 and record it as `public_ip` in `hosts.yml`.
4. [ ] **Disks.** Attach the private disks as separate block devices. Run `ls -l /dev/disk/by-id/` on each VM and record the names in `hosts.yml` under `disks`. Never use `/dev/sdX` names, because they can change between boots.
5. [ ] **Provider firewall** (if there is one). Open 80/tcp and 443/tcp to app-1 only. Open 51820/udp between the VM public IPs only. Close everything else. Host nftables still enforces 02-TRD §3.3.
6. [ ] **Console.** Confirm out-of-band console access (web or serial console) for every VM. Break-glass needs it for LUKS unlock and lost WireGuard. Record how to reach it in the ops runbook, not here.
7. [ ] **Snapshots.** Record whether snapshots are available. Backups never rely on them (pgBackRest, 02-TRD §9).
8. [ ] **Sites.** Confirm that DR site B is in a different building and on a different power feed than site A, and that both sites are inside Nepal (04 S1).
9. [ ] **Host keys.** Fetch each VM's SSH host key over the console. Pin it in `inventories/<env>/known_hosts`. Host key checking stays on.
10. [ ] **Isolation.** Confirm that no network path exists between environments (02-TRD §12.1), and that each env uses its own WireGuard subnet.
