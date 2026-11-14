APPROVE

Reviewed `git diff 93e8764f..HEAD` (boot.ts, identity/index.ts, claims/dbBinding.ts, 2 new tests) against LD-189, AC-0D-2.6, C0 02-TRD s6.4, 08 A25 D-212/R10, CR-C2-020.

Checked:
- Least privilege: only identity's createServices deps get `identityDb.register`; other modules keep { env, log, metrics } (tested by walking deps). Resolver sees a frozen facade with only identityAuthTx; `open()` returns only `d.identityAuthTx`. No pool, requestTx, withTenantScope or anonymousTx leaks.
- Late bind: same resolver object (core/bootstrap.ts reads it before bootPipeline); unbound rejects common.internal with the old text; no DB / unreachable DB boot reads nothing.
- Actor id: `SELECT actor_id FROM core.g_system_actors WHERE module = $1 AND is_active` ($1 bound 'identity'), lazy at first call, memoised on success only, in-flight shared, UUID-checked, exactly one row required. Never from env/JWT/request (tested with env decoys).
- Grant/RLS: migration 20261105000900 creates core.g_system_actors (global, no RLS, PK module) and GRANTs SELECT to lims_app, so rule 6 CR not triggered. Live-DB read still unverified (no real DB in tests).
- Fail closed: query error, empty, NULL, non-UUID all give common.internal with no id or driver text; next call retries.
- Claims stay `{ sub, actor_type: 'system' }`, no tenant_id (tx.ts unchanged). Allowlists, core/db, bootstrap.ts, spec, contracts untouched. No secrets, synthetic ids only. Paths are within the LD-189 cross-lane grant.
- Tests run: verify set (new 2 files + identity-auth, tx, pipeline/__tests__, identity claims, staging-boot): 15 files, 300 passed, 24 skipped, 0 failed.

Non-blocking note (no change required): on the very first call the g_system_actors SELECT runs before tx.ts refuses an operation outside LIMS_CORE_IDENTITY_AUTH_OPS, so "refused before any SQL" holds for transaction SQL (BEGIN/set_config/DEFINER) but not for that one read-only lookup. The authorization outcome is unchanged (rule 4), and the handoff test asserts exactly that. If the lead wants the literal reading, the lookup would have to know the allowlist, which LD-189 keeps out of the binding.
