# T-02 tests (tester)
- File: `infra/tests/static/test_t02_providers.py` (stdlib + PyYAML). Classes: ProviderDocs, InventoryLayout, EnvSeparation, InventorySecurity, ProviderValueGrep, Tooling.
- Run: `.orchestra\notes\T-02-verify.cmd` (= `python -B -m unittest discover -s infra/tests/static -p "test_t02_*.py"` from repo root). No `-I`: PyYAML is in user site, which -I hides.
- Covers IS-01, TRD s3.4 contract, s3.1 layout (dev 1 VM / staging 2 / prod 4: data-1 app-1 dr-1 ops-1), s4 (host_key_checking on, no secrets in inventories), s12.1 wg subnets 10.77/10.78/10.79, grep check for provider values outside providers/ and inventories/*/hosts.yml (+ planted-value self-check).
- Expects: infra/providers/{README.md,generic/checklist.md,generic/hosts.example.yml}; infra/ansible/inventories/{dev,staging,prod}/{hosts.yml,known_hosts,group_vars/{all,data,app,dr,ops}.yml}.
- ansible-inventory test skips off CI (LD-17); fails if CI=true and tool missing. ansible.cfg checked only if present (not a T-02 file).
- Assumptions: hosts carry `ansible_host`; disks appear as `/dev/disk/by-id/...` in hosts.yml; prod host names per TRD s3.1.
