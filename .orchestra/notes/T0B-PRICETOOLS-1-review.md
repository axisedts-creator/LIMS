APPROVE

Scope note: the requested range 653faecc8..HEAD is EMPTY (HEAD == 653faecc8). The task's work landed before that base, so this review covers the
T0B-PRICETOOLS-1 commits themselves: 43cc41a24 (tests), 098f46a16 (impl), cdfa48c00 (tests per ruling), fbe15a121, and the debugger notes b27f5754c/6e2da0343/2c3dd3653.
Files reviewed: catalog/domain/priceTools.ts, service/priceTools.service.ts, handlers/priceTools.handlers.ts, handlers/index.ts, index.ts (pendingOperations),
service/pricing.service.ts (dated assignments), service/quote.service.ts (period resolution), import/xlsx.ts (types + '*' sheets), __tests__/pricetools/*, __tests__/probes/pricetools.*,
tests/catalog/T0B-PRICETOOLS-1.pg.sh. The orchestra file changes are owned notes and CR files.

Checked, no defect found:
- Names match contracts/openapi/catalog.yaml: the 7 operationIds, catalog.price_list.manage / .read (LD-321), catalog.import_not_committable, common.version_conflict,
  catalog.version_in_use, common.payload_too_large, common.unsupported_media_type, catalog.code_duplicate (assignment overlap). pendingOperations emptied (LD-325(b)).
- Tenant isolation: every SQL statement is filtered by tenant_id = $1, including both sides of the compare FULL JOIN and the orderables join. Foreign and unknown ids both
  return 404. Arrays are cast `::uuid[]` / `::bigint[]`. No new tables or RLS in this task (migration 20261117200000 belongs to T0C).
- Permissions: the service checks the permission before it reads anything. replacePriceListAssignments now asserts manage and fails closed without IdentityPort.
- Dry run writes only the batch row and the error rows. Size and ZIP magic bytes are checked before parsing. All sheets are read so a hidden-sheet formula is caught.
  Parser faults return 422, not 500.
- Commit: FOR UPDATE on the batch, then the list. A replay returns the first version. It creates a DRAFT only, re-checks the seal, and never publishes.
- Bulk update and copy use BigInt paisa, half up, and the rounding steps of the contract. Any result out of range refuses the whole request. Compare is one keyset-paged query.
- Logs: no logging at all, so no PHI. No secrets.

Non-blocking (for the lead and audit, not CHANGES):
1. service/priceTools.service.ts:169-173: catalog.import_invalid_file (registered, 422) is thrown by dryRunPriceListImport but is not in its x-error-codes
   (catalog.yaml:6654). Add it in a follow-up contract CR. It sits next to the formula_invalid CR in .orchestra/cr/T0B-PRICETOOLS-1.nonblocking.md.
2. The header comment at service/priceTools.service.ts:6 cites `.orchestra/cr/T0B-PRICETOOLS-1.md`, but the file is `T0B-PRICETOOLS-1.nonblocking.md`.
3. domain/priceTools.ts:104 validates the file's Effective From column, but commit (service:190,220) drops it. The contract gives the column no meaning, so this is not a
   defect. The template text should say it is informational, or a CR should define it.
4. The commit fills an existing EMPTY draft instead of returning 409 "list already has a draft" (catalog.yaml:6832). This is the documented [CONV] at service:76. A new list
   always starts with an empty draft v1, so a literal 409 would block every first import. It was accepted by the arbiter ruling and is flagged for audit.
5. done_when 6 (store the upload through the existing path) is open behind the same CR, because catalog owns no bucket.

Not verified by me: I did not run the suites or the boot test (reviewer is read-only). The 3-run green evidence must come from verify.
