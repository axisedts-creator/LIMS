# T-05 debug
- Cause: no impl exists. infra/compose/supabase/ absent; writer blocked (no network to fetch upstream bytes/digests). 26 of 41 tests fail with "missing file". Tests are not wrong.
- Fix: none possible without inventing data. Retried network (git ls-remote) - refused. Filed .orchestra/cr/T-05.md. No code or test changed.
- Next: orchestrator vendors upstream/ + digests (or allows network), then re-run writer.
- Round 2: same state. infra/compose/supabase/ still absent, 26/41 fail "missing file". Network (git ls-remote) still needs approval, not granted. CR .orchestra/cr/T-05.md already filed.
- Fix: none. Vendoring upstream bytes/digests from memory = inventing data (CLAUDE.md). No code or test changed.
- Next: orchestrator vendors upstream/ + UPSTREAM.lock digests or approves network, then re-run writer.
