# T-02 tests (tester)
- File: `infra/tests/static/test_t02_providers.py` (stdlib + PyYAML). Classes: ProviderDocs, InventoryLayout, MemoryBudget, ProfileDocs, EnvSeparation, InventorySecurity, ProviderValueGrep, Tooling.
- Run: `.orchestra\notes\T-02-verify.cmd` (= `python -B -m unittest discover -s infra/tests/static -p "test_t02_*.py"` from repo root). No `-I`: PyYAML is in user site, which -I hides.
- Covers IS-01, TRD s3.4/s3.1/s4/s12.1, grep check for provider values (ruling-scoped), planted-value self-check.
- LD-45/LD-48 (review round): all 5 inventories (dev, staging, prod, staging-lean, prod-lean) get layout/parse/subnet/known_hosts/public_ip checks; lean roles map (prod-1 in data+app+ops, backup-1 in `backup` only, dr empty, staging-lean = 1 VM); sum(mem_limit) <= 85 % RAM per host (+ gate self-check); prod-lean named default in infra/README.md + DECISION.md with scale triggers; `topology_profile` var.
- Result: 33 run, OK, 1 skip (ansible-inventory off CI, LD-17; on CI it now loops all 5 inventories).
- Assumption: backup-1 has no mem_limit_gib (LD-45 gives none); only prod-1 is pinned (32 GiB, Σ <= 27.2).
