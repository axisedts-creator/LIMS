# infra/providers/ — provider abstraction (02-TRD §3.4, IS-01, B12)

The rest of `infra/` configures plain Linux VMs over SSH (Ansible, 02-TRD §4). It works the same on any provider. Everything that depends on a provider lives in an adapter: `infra/providers/<name>/`.

## Adapter contract

Every adapter under `providers/<name>/` must deliver these items. It can use an API (IaC tool chosen per provider) or documented manual steps in its `checklist.md`.

1. **VMs.** Default prod profile `lean` (LD-45, LD-48): two VMs, `prod-1` (site A, 16 vCPU / 32 GB / ~640 GB NVMe) and `backup-1` (site B, a different provider, 4 vCPU / 8 GB / ≥ 160 GB). Profile `full`: four VMs (`data-1`, `app-1`, `dr-1`, `ops-1`). Staging gets one VM (lean) or two VMs, one per site (full). Each VM has the 02-TRD §3.1 sizes, the **Ubuntu 24.04** image, and a **static public IPv4**. Private disks are separate **block devices**, and their `/dev/disk/by-id` names are recorded in `inventories/<env>/hosts.yml`.
2. **Provider firewall** (if any). It opens 80/443 to app-1 and **51820**/udp between the VM public IPs, and closes everything else. Host nftables still enforces 02-TRD §3.3.
3. **Out-of-band console** access for break-glass (LUKS unlock, lost WireGuard).
4. **Snapshot** capability is recorded. Backups never rely on it.
5. **DR site B** is in a different building and on a different power feed than site A, and both sites are inside **Nepal** (04 S1).

## Adapters

- `generic/` is the default adapter. It has no API: [`generic/checklist.md`](generic/checklist.md) gives the manual steps, and [`generic/hosts.example.yml`](generic/hosts.example.yml) is the template for `inventories/<env>/hosts.yml`.
- A provider-specific adapter is added once B12 names a provider. It goes in `providers/<name>/` and may hold its IaC.

## Boundary rule

No provider-specific value (vendor name, region, instance id, metadata endpoint, cloud disk name) may appear outside `infra/providers/<name>/` and `infra/ansible/inventories/*/hosts.yml`. The grep check in `infra/tests/static/test_t02_providers.py` enforces this rule. Roles and `group_vars` take only generic values: addresses, `/dev/disk/by-id` names and sizes, all read from `hosts.yml`.
