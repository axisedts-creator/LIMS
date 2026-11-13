# T30 dispute (WRITER) — tests/docs/C2-T30.manual.test.mjs

**Defect: the route and permission checks can never pass when the routes.yaml value contains `_`.**

- `norm()` (line ~21) runs `s.replace(/[`*_]/g, '')`, which removes every underscore from the page text `t`.
- The test 'every screen has a manual page' then checks `t.includes(path)` and `t.includes(perm)` against the raw routes.yaml values, and those values keep their underscores.
- Proof: `norm('/admin/users/{membership_id} platform.dead_letter.manage')` gives `/admin/users/{membershipid} platform.deadletter.manage`.
- No page text can satisfy these checks:
  - user-detail: `/admin/users/{membership_id}`
  - audit-entry: `/admin/audit/{audit_id}`
  - tenant-detail: `/platform/tenants/{tenant_id}`
  - dead-letters: permission `platform.dead_letter.manage`
  - dead-letter-detail: `/platform/dead-letters/{dead_letter_id}` and permission `platform.dead_letter.manage`

**Suggested fix (tester):** apply the same normalisation to both sides, e.g. `t.includes(norm(path))` and `t.includes(norm(perm))`. Another option is to check the route and permission against the raw text `r` instead of `t`.

Writer stopped here as the inbox instructs. No manual or help files were written.
