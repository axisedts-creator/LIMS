# T-02 impl (writer)
- Files: infra/providers/{README.md,generic/checklist.md,generic/hosts.example.yml}; infra/ansible/inventories/{dev,staging,prod}/{hosts.yml,known_hosts,group_vars/{all,data,app,dr,ops}.yml}.
- Layout per 02-TRD s3.1: dev = `dev-1` (data, app, ops; dr empty); staging = `staging-a` (data+app), `staging-b` (dr+ops); prod = data-1/app-1/dr-1/ops-1.
- [CONV] `ansible_host` = wg IP (s4 "Ansible connects over WireGuard only"). Separate host vars: `public_ip`, `wg_ip`, `disks` (by-id). wg subnets per s12.1: 10.79 dev, 10.78 staging, 10.77 prod (.11/.21/.31/.41).
- [CONV] Public IPs use the RFC 5737 documentation ranges. Disk ids and known_hosts are placeholders until the VMs exist (checklist steps 4, 9).
- group_vars/all.yml holds only the s15 keys that have spec defaults. Keys with no default (origins, smtp_relay_fqdn, ntp_upstreams, …) are left out, so no value is invented.
- Open: (1) the first converge before WireGuard is up needs the public IP; that is T-03's bootstrap. (2) ansible-inventory is not run on Windows (LD-17). (3) Ruling + review (T-02-ruling.md, T-02-review.md): both defects were in tests; no impl change needed. After tester fixes (d3cd3ea; public_ip cross-env check, narrowed scanner exemption): T-02 22 OK (2 skip), all static 49 OK (3 skip). run.sh not re-run.
