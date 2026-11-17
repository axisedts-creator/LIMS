# C6 reporting load test (C6-T34)

k6 script `reporting-load.js`. Synthetic data, non-production only (`TARGET_ENV` = `staging`, `compose` or `ci`; anything else is refused in `setup()` before any request).

```
k6 run -e TARGET_URL=<stack url> -e TARGET_ENV=staging -e STAFF_TOKEN=<token> tests/load/reporting-load.js
```

Env: `TARGET_URL`, `TARGET_ENV`, `STAFF_TOKEN`, optional `SEED_COUNT` (default 10000 = 10x seed, 10 labs x 1000 PDFs/day; lower values are refused). Routes are fixed to 02-TRD §6 (R3, R7 bulk-release, R9 regenerations, R17, D3 deliveries, Q1 verifications) plus the non-production seed route of CR `.orchestra/cr/C6-T34`; setup fails fast if the seed returns no QR tokens, fewer than 200 versions or no released reports.

| Scenario | Route | Measured as |
|---|---|---|
| renders | R9 then R3 polls | trigger to new version rendered (ready to rendered); first `rendering` poll to `rendered` (render) |
| bulk_release | R7 `{ids}` (200 distinct) | request duration |
| deliveries | D3 `{recipient_kind, channel}` | enqueue latency |
| qr_verify | Q1 `{qr_token}` | request duration |

| Scenario | Load | Threshold (02-TRD §11) |
|---|---|---|
| renders | 42/min for 15 min | render p95 < 5 s; ready to rendered p95 < 60 s; failures < 1 % |
| bulk_release | 200 ids per request | p95 < 8 s |
| deliveries | 1/s | send task p95 < 1 s |
| qr_verify | 5/s | p95 < 100 ms |

A failed threshold makes k6 exit non-zero. Not run in the unit gate (needs k6 + a stack); nightly runs it after the E2E journey (see `tests/e2e/README.md`).
