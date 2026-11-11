# AG-T18 impl
Files: apps/bridge-agent/build/release/main.go (package main; `release` + `release verify` CLI per test header contract). No other files changed.
Status: after the arbiter's ruling (test package -> main_test), `.orchestra\notes\AG-T18-verify.cmd` passes: `ok lims/apps/bridge-agent/build/release 227.8s`; `go vet` is clean.
[CONV] Seed SQL is one INSERT with ON CONFLICT (version) DO NOTHING, so re-running it is safe. Strings are SQL-escaped. Bounds come from the 05-SCHEMA CHECKs, and nothing is written to --out if a check fails.
[CONV] Signing accepts only an Ed25519 PKCS#8 key file. The key never appears in stdout, stderr or any artefact. Authenticode runs as an external hook; production refuses to run without a hook and refuses --nonprod.
Open: gofmt not run (needs approval); real Authenticode cert signing and ci.sh/ci-windows.ps1 wiring not done; --dry-run no-network not tested.
