# Lab E2E (C5)

## T-34 nightly journeys (`C5.T-34.journeys.spec.ts`)

LD-134: no harness service and no seeded privileged sessions live in the repo or a compose profile. The journeys drive the public `/v1` API and the web app through a base URL and per-role session tokens that the nightly pipeline supplies by environment. Never commit a token or session id.

| Variable | Kind | Used for |
|---|---|---|
| `E2E_BASE_URL` | URL | stack under test (required by every journey) |
| `E2E_LAB_COLLECT_TOKEN` | secret | register, collect |
| `E2E_LAB_TECH_TOKEN` | secret | receive, reject, verify |
| `E2E_PATHOLOGIST_TOKEN` | secret | approve, release, amend |
| `E2E_LAB_STATUS_TOKEN` | secret | order/specimen status reads |
| `E2E_DEVICE_TOKEN` | secret | instrument result (`submitMessageBatch`) |
| `E2E_CENTRE_ID` | id | synthetic centre of the seeded stack |
| `E2E_HB_ORDERABLE_ID` | id | synthetic Hb orderable |
| `E2E_INSTRUMENT_ID` | id | synthetic instrument (instrument step) |
| `E2E_PAYMENT_METHOD` | optional | defaults to `cash` |

A journey skips, naming the missing variables, when any it needs is unset.

Check without a stack (type-check + list): `C5.T-34-verify.cmd`, i.e. `tsc --noEmit -p tests/e2e/lab/tsconfig.json` then `playwright test --config tests/e2e/lab/playwright.config.ts --list C5.T-34`.

The green run is a nightly/release gate once the pipeline supplies the variables.
