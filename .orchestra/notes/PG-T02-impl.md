# PG-T02 impl (writer)
Files (services/api/src/modules/payments/domain/): intent.state.ts, refund.state.ts, outcome.ts (shared GatewayOutcome/columns, extra file), mapping.esewa.ts, mapping.khalti.ts, amount.ts, returnurl.ts.
Run: vitest domain dir = 6 files / 419 tests pass; `tsc --noEmit` clean for payments. eslint not installed in services/api (not run).
[CONV] State tables + mapping rows are data (Record of cells); errors are LimsError codes from contracts/errors.yaml (status via registry, no detail so URLs never echoed).
[CONV] Amounts via BigInt on decimal text, no floats; returnurl matches origin + path prefix on a segment boundary, rejects any `#`, userinfo, non-printable/non-ASCII, >2000 chars.
Open: `created` intent status treated as an open column in mapping tables (not polled in practice); assertAmountSupported gateway type is 'esewa'|'khalti' only (Fonepay slot = PG-T07).
