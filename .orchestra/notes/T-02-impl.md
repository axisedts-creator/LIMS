# T-02 impl (writer, C3)
- Files: `services/api/src/modules/catalog/domain/{codes,versioning.state,import.state}.ts` (pure, no DB).
- [CONV] Transition tables are `Map`/`Set` keyed `from>to` (no prototype-key hits); unknown status/kind fails closed.
- [CONV] codes: raw must be printable ASCII and ≤64 chars before trim+upper-case + §5.1 regex; errors = `common.validation_failed` / `common.field_invalid`.
- [CONV] Forbidden version pair -> `catalog.version_in_use`; forbidden import pair -> `catalog.import_not_committable` (tester assumptions adopted).
- Verify: T-02 suite 763/763 pass. Full api suite: 3 failures outside T-02 (lab boot x2, catalog skeleton autoload: `LIMS_CORE_ENV must be one of dev|ci|staging|production` — env, pre-existing).
- Typecheck: fails in `packages/shared-ts/src/bsdate/index.ts` (TS5097, not C3-owned); 0 errors in modules/catalog.
- Open: branch coverage argued by exhaustive matrices, not measured (no coverage plugin).
