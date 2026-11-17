APPROVE

Scope note: `git diff ccf3b04c..HEAD` is empty (HEAD == ccf3b04c). The T1 work landed earlier (f4439479, 839e4005, 3cadf74c, d43bbd11, 23c50291), so I reviewed the T1 files as they stand at HEAD: gateway.ts, gateway.http.ts, gateway.fake.ts, mapping.md and __tests__/*. I checked them against the done_when, the T1-ruling and LD-80.

Checked, no defects:
- done_when: mapping.md gives every one of the 14 gateway methods with path, headers, request and response fields, env and a source link. It has a verdict for each required claim: aal, session_id, refresh rotation and reuse, token_hash verify, admin create/find/sign-out/factor delete, password min-length, link TTL ≤ 60 min, D-218 a and b. The refuted items point to CR `.orchestra/cr/T1.nonblocking.md` and the 02-TRD s8 redesign notes.
- Tests: contract.suite.ts runs the same happy and failure cases per method against the fake (always) and the real container (env-gated). The live run passed 39/39 on 2026-11-11 (notes/T1-live-run-20261111.md). The ruling's fixes are in place: reuse is asserted against the verdict, the parent-leniency case is pinned, and ageEmailTokens ages the users.* timestamps.
- Fake: it matches the real container's leniency toward reuse of the immediate parent. Its stricter family kill is allowed by T1-ruling item 6.
- Secrets/PHI: the service key is sent only on /admin/* and /invite. GoTrueError carries only method, status and error_code. The network-error cause is dropped. No secrets are in files.
- Owned paths only. Nothing in the code is invented beyond the mapping verified live. Tenant/RLS, permissions, idempotency keys and rate tier do not apply to T1, which has no table, route or DB code.

Non-blocking notes (no change required for T1):
1. mapping.md:153 still says the CR to 08 R10 is "for lead and founder", but LD-80 (2026-11-09) has since decided CR-C2-T1-a (patient sessions use a LIMS-issued EdDSA JWT, not GoTrue). Suggest appending "decided by LD-80; patient JWT design pending the 08 addendum" to that line. The mapping.test.ts:59 regex still matches.
2. The working tree has an uncommitted, non-owned change to pnpm-workspace.yaml (`'@scarf/scarf': set this to true or false`). That is a pnpm placeholder and is not valid as a boolean. Do not commit it with T1.
3. The 3 s timeout on sendInvite/sendRecovery with a real SMTP relay is already logged by the lead as a follow-up for C2 after T1.
