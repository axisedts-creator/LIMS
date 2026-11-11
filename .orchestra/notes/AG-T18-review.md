APPROVE

Scope: `git diff 513490c5..HEAD` — apps/bridge-agent/build/release/{main.go,release_test.go} + AG-T18 notes only (owned paths).

Checked against spec:
- Names verbatim: artefact `bridge-agent-<version>-windows-amd64.zip` holding `agent.exe` + `manifest.json` (02-TRD §5.11); `instruments.g_agent_releases` columns and CHECK bounds (version regex, channel stable|beta, package_file_name ≤120, key_id ≤32, authenticode_publisher ≤200, notes ≤2000, sha hex64, size >0) match 05-SCHEMA DDL.
- Signature: Ed25519 over the raw SHA-256 bytes of the package, base64url (§5.11); proven by the test calling the agent's own `update.Stage` (AG-T16), and by a rejection under another key.
- Production gate (06 R3): production refuses `--nonprod` and refuses to run without an Authenticode hook. The hook runs with no shell, on a copy of the exe.
- Seed: one `INSERT ... ON CONFLICT (version) DO NOTHING`, every text value quote-escaped; a hostile-text test covers it. No RLS needed: G table, global, seed-only (05-SCHEMA G2).
- No secrets/PHI: only Ed25519 PKCS#8 keys are accepted, and key errors are never wrapped. A test asserts the key is not in stdout, stderr or any artefact. Synthetic data only.
- done_when: the staging dry-run yields a package plus seed that the agent verifier accepts. Covered.

Ran: `go -C apps/bridge-agent test -count=1 ./build/release/...` → `ok lims/apps/bridge-agent/build/release 116.148s`.
Not run: gofmt (approval denied); seed SQL not executed against real Postgres (checked as text only).
Non-blocking notes: build.ps1/build.sh wiring (02-TRD §6 tree) and C1 `infra/ci/agent-release.sh` integration are left to C1 T-34. The hook's output (≤512 bytes) is echoed to stderr on failure; the hook must not print secrets.
