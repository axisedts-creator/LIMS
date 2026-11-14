# T-16 impl (writer) — credit parties #67–#70
- Files: service/creditParties.service.ts (new), handlers/creditParties.handlers.ts (new), handlers/index.ts (4 stubs -> spread), repo/masters.repo.ts (MasterTable += credit_parties), probes/pending.json (4 ids removed, 66 -> 62).
- Result after ruling (TESTS_WRONG, tests revised): T-16-verify 202/202 pass; full catalog suite 30 files / 2549 pass. No impl change needed. tsc: 2 errors, both outside owned paths (contracts/ports/IdentityPort.ts, packages/shared-ts bsdate), none in T-16 files. Lint not run.
- [CONV] auto code CP{seq:5} via code_counters key party_code (same as T-15 doctors); blank/whitespace party_code = absent; list order party_code,id (cursor on party_code); q = trimmed code prefix, ≤20, escaped LIKE.
- [CONV] allow-list (pan/phone/email/address) via IdentityPort.getActor ∋ catalog.price_list.manage on list, get, create AND update (fail closed); empty PATCH = 400; unknown keys reported at path "" (AB-20).
- Open: auto code vs existing explicit CP00001 -> 409 (no skip), same unruled CR as T-15 (.orchestra/cr/T-15.md). No price_list_id in DTO (T-17).
