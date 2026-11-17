APPROVE

Scope: `git diff 14ed643..HEAD` (T-13, comment codes #57–#59).

Checked
- Names verbatim: operationIds listCommentCodes/createCommentCode/updateCommentCode, path param `comment_code_id`, tables `catalog.comment_codes` / `catalog.comment_code_texts`, index `comment_codes__tenant_id_code_dept__uq`, entity_type `comment_code`, error `catalog.code_duplicate` — match 02-TRD §5 rows 57–59, 05-SCHEMA, catalog.yaml.
- Contract: perms catalog.test.read / catalog.test.manage, idempotency none/required/none, rate tier general — enforced by router from catalog.yaml; If-Match on PATCH (428/409) via shared checkUpdate.
- Tenant isolation: every statement binds tenant_id explicitly; FK (tenant_id, department_id) -> foreign dept 404 (S-1). No RLS/policy changes in this diff (schema owned by T0B migrations).
- done_when: uniqueness relies on the expression index; 23505 -> 409 (incl. race tests, inactive slot kept).
- AC-09.3: text edit bumps version, closes old history row, inserts text_version = new version; old rows never rewritten. AC-09.1/09.2 data side covered here; port `resolveCommentCodes` is T-29 (plan row) — correctly not implemented.
- No PHI/secrets; error details never echo submitted values (AB-20); SQL fully parameterised.
- Owned paths only (catalog module + own notes).

Ran
- vitest src/modules/catalog: 16 files, 1790 tests passed.
- tsc --noEmit: 1 error, pre-existing in packages/shared-ts/src/bsdate/index.ts (TS5097), none in catalog.

Non-blocking notes (no change required for T-13)
- comments.service.ts:69 code_prefix range assumes byte-wise collation (writer flagged with ponytail). DB collation is the supabase/postgres default and the fake DB cannot prove it; under a glibc en_US collation a prefix ending in `Z`/`9`/`_` would return an empty page. `starts_with(code, $p)` is collation-independent if a real-DB test ever shows it.
- comments.service.ts:111 two text edits of one code at the same millisecond `now` would hit comment_code_texts__tenant_id_code_id_from__uq (unmapped 23505 -> 500). Serialised by the row lock + version check, so practically unreachable.
