# T0B-ACCT-1 debug (verify round: 29 fail / 2007 pass)
- counter.unit static rule (1 fail): a COMMENT in invoice.service.ts (REGAPI-2 previewNo) named fiscal_counters. Fix: comment reworded, no code change; counter.unit 41/41 green.
- crossTenant.handlers (28 fail): the 12 ACCT-2 ops are still 503 stubs and the probe forbids service_unavailable. Not ACCT-1 code (its 12 ops pass). Test untouched: see T0B-ACCT-1-dispute-crosstenant.md.
- Not re-run: full billing suite, boot.test (60 s timeouts on loaded host).
