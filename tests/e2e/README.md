# C6 nightly E2E journey (C6-T34)

`reporting-journey.e2e.ts` drives the 05-DoD §5 journey over the HTTP API of the compose stack (recording WhatsApp provider, no real sends):
register, approve, assemble, render, held (dues), pay, auto-release, WhatsApp, OTP, download, QR verify; plus amendment, outsourced merge, narrative sign, bulk release, rejection/recollection, cancel/credit note, cross-tenant attempts and a PHI scan.

```
docker compose up -d --wait
E2E_BASE_URL=<stack url> E2E_STAFF_TOKEN_A=<token> E2E_STAFF_TOKEN_B=<token> npx vitest run tests/e2e/reporting-journey.e2e.ts
```

Nightly (`.github/workflows/nightly.yml`, owned outside C6) runs this file and then `tests/load/reporting-load.js` against the compose stack. Routes are those of 02-TRD §6 (portal under `/v1/reporting/portal/` with `X-Lims-Portal-Credential`); register, approve, pay, recorded provider messages, QR-token read, logs and seed use the non-production test-support routes proposed in CR `.orchestra/cr/C6-T34`, which must be mounted in the compose stack before the journey can pass.
