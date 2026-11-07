CHANGES
Round 2. Scope: git diff dc4cf7b..HEAD = identity/index.ts (manifest, unchanged since round 1, OK) + new repository/__tests__/sessions.repo.live.test.ts + notes.
Manifest/resolver: names verbatim, fail-closed, no PHI/secrets, owned paths only — OK. Round-1 items addressed in form, but the live suite cannot pass against a real migrated DB (it skips here, so these were never exercised). Checked against db/migrations/20261105001300_identity__create_identity_schema.sql, 20261105000400_core__create_users_and_memberships.sql, core/db/tx.ts.

1. services/api/src/modules/identity/repository/__tests__/sessions.repo.live.test.ts:16,22 — `H(\`t${n}\`)` yields 2–3 byte tokens; `sessions__token_len__ck` requires `octet_length(token_sha256) = 32`, so every insertSession fails. Fix: `const H = (s: string) => \`\\x${createHash('sha256').update(s).digest('hex')}\`` (import `createHash` from `node:crypto`).
2. same file:53 — `createDb({ pool: apiPool })` omits `identitySystemActorId`; tx.ts:144 rejects identityAuthTx with common.internal when it is unset, so every resolve() fails. Fix: `createDb({ pool: apiPool, identitySystemActorId: SYS })`.
3. same file:86 — `lock_reason_code = 'admin_lock'` violates `memberships__lock_reason__ck` (allowed: left_organisation, security_concern, policy_violation, other). Fix: use `'security_concern'`.
4. notes/T4-tests.md — p95 <= 3 ms @500 rps still unmeasured (suite skipped). Not a code fix: after 1–3, run with LIMS_TEST_DATABASE_URL (+ LIMS_TEST_API_DATABASE_URL=lims_api) and record the printed `T4 bench:` line; until then done_when bench item stays open.
Not a C2 defect: runtime db wiring into module construction remains open with C0-0D (CR-C2-020).
