# SP-1 — GoTrue JWT claims (`session_id`, `aal`, `alg`)

- Date run: 2026-11-06 · Plan row: `spec/chunks/C0-foundation-contracts/06-IMPLEMENTATION-PLAN.md` SP-1 · REQ-SEC-065, REQ-SEC-067, 08 R10
- **Outcome: claims as expected.** `session_id` present (UUID), `aal` present (`aal1` after password, `aal2` after TOTP), `session_id` stable across refresh. C2 T1 proceeds; no blocker raised in 07-BLOCKERS.
- Fallback selected: none.

## Decision

| Item | Value |
|---|---|
| Pinned GoTrue | `supabase/gotrue:v2.197.0` = `public.ecr.aws/supabase/gotrue@sha256:1736a63078f5922b198c4cbe50f80ab9a2d3b54fe8b7b6cfb2e9dc5dbbc12c6b` (tag matches C1 02-TRD pin candidate) |
| `LIMS_CORE_JWT_ALG` | `ES256` (header `kid` present; key from `GOTRUE_JWT_KEYS`, EC P-256) |
| `LIMS_CORE_JWT_ISSUER` (local dev) | `iss` = `http://127.0.0.1:54321/auth/v1` (per env = GoTrue `API_EXTERNAL_URL`) |
| `LIMS_CORE_JWT_AUDIENCE` | `aud` = `authenticated` |
| `exp` lifetime | `exp - iat` = 3600 s (1 h; REQ-SEC-065 ≤ 1 h holds; `GOTRUE_JWT_EXP=3600`) |
| `session_id` | present, UUID string; stable across refresh (aal1 and aal2) and across MFA step-up |
| `aal` | `aal1` → `aal2` after TOTP verify; `amr` `["password"]` → `["totp","password"]` |

- The GoTrue custom access-token hook is not used (no `GOTRUE_HOOK_*` env on the container). Tenant/membership/actor claims come only from the identity `claimsResolver` (08 R10); of the JWT, core reads only `sub`, `session_id`, `aal`, `exp`, `iat` (REQ-SEC-067).
- `alg` is set by GoTrue key config, not by the image: with only `GOTRUE_JWT_SECRET` it issues HS256. Every env must set `GOTRUE_JWT_KEYS` with an EC P-256 signing key so `LIMS_CORE_JWT_ALG=ES256` holds (open point for C1 prod stack).

## Evidence

Stack: local Supabase CLI 2.105.0 dev stack (`supabase_auth_LIMS`). A temporary GoTrue container of the same image, same env except `GOTRUE_MFA_TOTP_ENROLL_ENABLED=true` / `GOTRUE_MFA_TOTP_VERIFY_ENABLED=true` (off in `supabase/config.toml`), was run on `supabase_network_LIMS`. Synthetic user `sp1-<random>@example.test`; deleted afterwards. Only decoded header/payload fields printed; no tokens or keys recorded.

Commands:

```sh
docker image inspect public.ecr.aws/supabase/gotrue:v2.197.0 --format '{{json .RepoDigests}}'
docker run -d --name sp1_gotrue_spike --network supabase_network_LIMS -p 127.0.0.1:59999:9999 -e ... <image> auth
# then against http://127.0.0.1:59999:
POST /signup                              {email, password}
POST /token?grant_type=password           -> decode access JWT
POST /token?grant_type=refresh_token      -> decode
POST /factors {factor_type: totp}; POST /factors/{id}/challenge; POST /factors/{id}/verify {code: RFC 6238 TOTP}
POST /token?grant_type=refresh_token      -> decode
psql: delete from auth.users where email='sp1-…@example.test'; docker rm -f sp1_gotrue_spike
```

Output:

```text
repo digests: ["public.ecr.aws/supabase/gotrue@sha256:1736a63078f5922b198c4cbe50f80ab9a2d3b54fe8b7b6cfb2e9dc5dbbc12c6b"]
hook env present: false
health: {"version":"v2.197.0","name":"GoTrue",...}
password login : {"alg":"ES256","typ":"JWT","kid":"<present>","iss":"http://127.0.0.1:54321/auth/v1","aud":"authenticated","exp_minus_iat":3600,"session_id":"84c548f3-cf48-47c8-a93b-2755dc277bff","aal":"aal1","amr":["password"],"role":"authenticated"}
refresh (aal1) : {"alg":"ES256",...,"exp_minus_iat":3600,"session_id":"84c548f3-cf48-47c8-a93b-2755dc277bff","aal":"aal1","amr":["password"]}
after TOTP     : {"alg":"ES256",...,"exp_minus_iat":3600,"session_id":"84c548f3-cf48-47c8-a93b-2755dc277bff","aal":"aal2","amr":["totp","password"]}
refresh (aal2) : {"alg":"ES256",...,"exp_minus_iat":3600,"session_id":"84c548f3-cf48-47c8-a93b-2755dc277bff","aal":"aal2","amr":["totp","password"]}
claim_keys: ["aal","amr","app_metadata","aud","email","exp","iat","is_anonymous","iss","phone","role","session_id","sub","user_metadata"]
session_id stable across refresh + MFA step-up: true
cleanup: synthetic user deleted, temp container removed
```

## Open points

- `infra/compose/supabase/upstream/UPSTREAM.lock` (C1, 08 A25 D-208) does not exist yet; this run used the CLI dev-stack image. Re-check digest equality once the lock lands (`supabase-pin` CI job).
- Claims verified on the CLI stack, not the self-hosted docker stack; prod must configure `GOTRUE_JWT_KEYS` (ES256) — see Decision.
