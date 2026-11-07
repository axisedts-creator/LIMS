# T0C-05 impl (round 5, 2026-11-07: codegen.test.ts 23/24; 1 fail disputed, see T0C-05-dispute.md)
- Round 5: contracts/openapi/billing.yaml B19 operationIds listCreditParties->listCreditAccounts, getCreditParty->getCreditAccount (CR-C0-0C-004 option 1, lead AUTO 08:30:15); reran `npx tsx tools/codegen/codegen.ts` (now also emits billing/frontdesk/lab TS+Dart clients, refreshed operations.ts, client.ts, MSW handlers, 003 seed). `--check` exits 0.
- Round 5: tools/codegen/vitest.config.ts testTimeout 120 s [CONV] (generateAll ~2.5 s; double-run + CLI spawn exceeded 5 s default).
- Files (earlier rounds): tools/codegen/{codegen.ts,gen-permissions.ts (LD-01 patient exception),gen-access-actions.ts}, lint-openapi.ts; contracts/package.json exports + LimsError explicit fields (LD-03); ERROR_META emitted.
- [CONV] generateAll sync; in-house schema→TS, client.ts on openapi-fetch 0.17.0, Dart client over `LimsTransport`; C4 → frontdesk+billing consumers; g_permissions.module = first code segment, phase '1'.
- LD-09 needs no generator change.
- Other suites still red, not T0C-05: lint rule 4 / E1-E2 justification (CR-C0-0C-002 + T0C-10.C3/C4/C5 CRs), mocks.test.ts:99 (same timestamp dispute).
- Open (0A): api-client-ts package.json + lock, root `pnpm codegen`, lims_shared.dart exports, pnpm-workspace `- contracts`; dart analyze not run.
