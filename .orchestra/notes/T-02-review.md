CHANGES

Implementation files (providers/README.md, generic/checklist.md, generic/hosts.example.yml, inventories/{dev,staging,prod}/*) match 02-TRD §3.1, §3.4, §4, §12.1, §15: §15 key names are copied exactly, there are no secrets, host_key_checking stays on, the wg subnets are separate per env, and dev is one VM. No impl change needed. Ran `python -B -m unittest discover -s infra/tests/static -p "test_t02_*.py"`: 22 OK, 2 skipped. RLS, permissions, idempotency, rate tier, error codes and PHI do not apply here, because T-02 has no DB, API or logging surface.

Defects (both in tests; tester to fix):

1. infra/tests/static/test_t02_providers.py:58 — the grep check skips the whole `infra/tests/` tree. 02-TRD §3.4 allows provider values only in `infra/providers/<name>/` and `inventories/*/hosts.yml`, so any provider value in `infra/tests/**` (for example the later `tests/internal/*.py` or `tests/external/*`) would pass unseen. Fix: keep `providers/` as the only prefix exemption and exempt just this scanner file by exact path:
   `if rel.startswith("providers/") or rel == "tests/static/test_t02_providers.py": continue`
   Also add one planted case to `test_scanner_flags_planted_values_and_honours_allowed_paths`, e.g. `"tests/internal/x.py": "h = " + "hetz" + "ner"`, and expect `tests/internal/x.py` in the flagged list.

2. infra/tests/static/test_t02_providers.py:213 — `test_no_public_address_shared_between_envs` compares `ansible_host`, which is the wg IP. That is already covered by the subnet test, so `public_ip` is never checked across envs (REQ-SEC-136 / §12.1: no network path between envs). Fix: compare `v.get("public_ip")` instead, i.e. `a = v.get("public_ip")`, and assert that it is set (`self.assertTrue(a, f"{e}/{h}: public_ip")`) before the duplicate check.
