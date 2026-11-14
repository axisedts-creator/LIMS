# T2 tests (tester)
Files (all in services/api/src/modules/identity/domain/__tests__/): password-policy.test.ts, numbering-pattern.test.ts, settings.ranges.test.ts, permission-set.test.ts.
Run: `.orchestra\notes\T2-verify.cmd` (vitest, only these four files). Expected now: all fail on missing `../<module>.js` imports (impl absent).
Covers AC-A6.1/A6.2 (+A6.3 lookup order), AC-C3.1/C3.2, US-C2 ranges ±1 + timezone, AC-B2.1/B2.2, support allowlist (TRD §7.4), fixed actor sets.
Each file's header comment lists the ASSUMED exported API (spec fixes no signatures): implementer must match it or raise a CR/dispute.
Registry source: tests parse contracts/permissions.yaml via `yaml` and pass its `permissions:` array into the pure functions (implementation may default the param to the C0 constant).
Not covered here: breached-list DB (T4/T5), HTTP error mapping, pending-numbering/billing_live_on (T16).
Update (review item 2): settings.ranges.test.ts now also covers all 05-SCHEMA §4.6 regex/length/count/nullable rules (code common.field_invalid; abbreviated_invoice_limit_paisa -> identity.setting_out_of_range). Fails now on missing impl rules (27 fail / 84 pass).
