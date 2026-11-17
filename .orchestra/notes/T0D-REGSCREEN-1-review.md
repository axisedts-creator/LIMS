APPROVE

Scope: `git diff d1980ddf1..HEAD` (commit f2eba85ef): `apps/web/src/features/catalog/server/specs.ts` and `.orchestra/notes/T0D-REGSCREEN-1-debug.md`.

- Matches LD-329 exactly: one key, `quick_add: bool`, added to `DOCTOR.create` only (specs.ts:37). It is optional, because `required` stays `['display_name']`. The line 4 comment is corrected. Nothing else in specs.ts or any other C3 file changed.
- Name is verbatim from the contract: contracts/openapi/catalog.yaml DoctorCreate `quick_add: type: boolean` (line 10135). Nothing invented.
- PATCH spec does not get `quick_add`, which is correct because it is create-only. The other server-owned fields (is_verified, source, merged_into_id, tenant_id, version) are still in no spec.
- No contract, migration, route, permission or spec/* change. No PHI or secrets. regscreen1.quickadd.test.tsx is not edited.
- Notes say regscreen1 config 66/66 green.

Open item (not a defect of this diff; LD-329 tells the writer to report it, not edit it): catalog `web-t33.server.test.ts:166-168` pins the DOCTOR.create key list to `['display_name','phone_e164']` while sending `quick_add: true`. It is now red. A C3 test update or an arbiter ruling is needed before merge to main.
