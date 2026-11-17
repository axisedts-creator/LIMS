# T0C-05 impl (round 8, 2026-11-07: codegen+mocks+c4 913/917, 4 red = CR-C0-0C-002 lint/E1-E2; `--check` exit 0). Round 8 review item (c4 drift guard) tester-only, done 07ac537; no impl change.
- Round 7 (review item 1): genMsw sorts by URL key with `:param`→U+FFFF, then operationId, so literal siblings (possible-duplicates) precede `:patient_id` (MSW first-match); handlers.generated.ts regenerated.
- Flake risk: CLI --check test spawnSync ~15 s idle / ~50 s under host load; one run hit vitest "Timeout calling onTaskUpdate" (60 s worker RPC) though all tests passed. Rerun clean. Not a generator defect.
- Round 5: billing.yaml B19 operationIds listCreditParties->listCreditAccounts, getCreditParty->getCreditAccount (CR-C0-0C-004 option 1); outputs regenerated. vitest testTimeout 120 s [CONV].
- Files (earlier rounds): tools/codegen/{codegen.ts,gen-permissions.ts (LD-01 patient exception),gen-access-actions.ts}, lint-openapi.ts; contracts/package.json exports + LimsError explicit fields (LD-03); ERROR_META emitted. LD-09 needs no generator change.
- [CONV] generateAll sync; in-house schema→TS, client.ts on openapi-fetch 0.17.0, Dart client over `LimsTransport`; C4 → frontdesk+billing consumers.
- Other suites red, not T0C-05: lint rule 4 / E1-E2 justification (CR-C0-0C-002 + T0C-10.C3/C4/C5 CRs).
- Open (0A): api-client-ts package.json + lock, root `pnpm codegen`, lims_shared.dart exports, pnpm-workspace `- contracts`; dart analyze not run.
