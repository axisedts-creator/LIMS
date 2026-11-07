# C3 T-04 impl (writer)
- Files: service/masters.service.ts (defs + self-validation + flows), repo/masters.repo.ts (bound SQL), mappers/masters.mapper.ts (DTO, cursor), handlers/masters.handlers.ts + handlers/index.ts (12 ids wired), probes/pending.json (12 ids removed, 107 -> 95).
- [CONV] Update: SELECT … FOR UPDATE (masters row) -> 404 / 409, then UPDATE with `version = $3` predicate, then bumpRevision (state lock) — same lock order on create (INSERT then bump).
- [CONV] Code regex checked on the trimmed raw value BEFORE upper-casing (blocks `ı` -> `I` forgery); 23505 -> catalog.code_duplicate, 23503 (FK) -> common.not_found.
- [CONV] Cursor = base64url(JSON [sort, last value, last id]); sort mismatch / undecodable -> common.invalid_cursor. `?id=` without is_active returns inactive rows.
- Open: catalog.yaml lets `sort=report_order` on specimen types/containers/methods (copy of the departments enum) but those tables have no such column -> service returns 400; CR filed `.orchestra/cr/T-04.md` (non-blocking), code comment marked [CR-pending]; code unchanged until ruled.
- Checks: T-04-verify set 405/405 pass. Catalog suite 1270/1271: skeleton autoload test fails on reporting config (`LIMS_CORE_ENV` unset), not T-04. tsc: only pre-existing shared-ts bsdate TS5097.
