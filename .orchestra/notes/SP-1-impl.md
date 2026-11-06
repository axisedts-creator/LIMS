# SP-1 impl
- File: `db/meta/decisions/SP-1.md` (live spike run 2026-11-06 vs gotrue v2.197.0 @sha256:1736a630…; synthetic user, cleaned up).
- Outcome: claims as expected — `session_id` UUID, `aal1`→`aal2` after TOTP, stable across refresh; `LIMS_CORE_JWT_ALG=ES256`, `aud=authenticated`, exp 3600 s.
- [CONV] TOTP enabled only on a temporary same-image GoTrue container (config.toml has it off; supabase/ not edited).
- [CONV] ES256 depends on `GOTRUE_JWT_KEYS` (EC key); HS256-only secret would change alg — every env must set it.
- Open: C1 `UPSTREAM.lock` missing; re-check digest once it lands. Run was on CLI dev stack, not self-hosted docker stack.
- Tests: `node --test tests/spikes/SP-1.decision.test.mjs` → 8/8 pass.
