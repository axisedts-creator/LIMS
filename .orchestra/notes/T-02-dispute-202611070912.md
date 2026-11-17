# T-02 dispute (writer)
- T-02 suite: 22 run, OK (2 skipped: ansible.cfg absent, ansible-inventory CI-only).
- Full gate `bash infra/tests/run.sh` FAILS at `static`: `test_t01_skeleton.Gitleaks.test_no_decrypted_or_private_material_under_infra` flags
  `infra/tests/static/test_t02_providers.py (private key material)`.
- Cause: test_t02_providers.py line 228 holds the literal `PRIVATE KEY-----` / `AGE-SECRET-KEY-` in its regex. The T-01 scan exempts only its own file.
- No implementation file is involved. Tests are not mine to edit.
- Proposed fix (tester): split the literals in test_t02, as its planted-value self-check already does (e.g. `"PRIVATE" + " KEY-----"`), or have T-01 exempt `infra/tests/static/test_*.py`.
