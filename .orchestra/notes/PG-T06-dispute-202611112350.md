# PG-T06 dispute (writer)
Test: unit/gateways/esewa.adapter.test.ts "only the order reference, amount and product code go out" (line ~108-111).
Assertion `expect(JSON.stringify(a)).not.toMatch(/patient|name|phone|email|mobile/i)` cannot pass: TRD §7.2.3 mandates the form field `signed_field_names` (also asserted by the same file at lines 54-55 and 61), and `name` matches it.
Fix suggestion: match on values / whole keys, e.g. `/patient|phone|email|mobile/i` on the JSON plus `/(^|[^_])\bname\b/` on keys, or `Object.values(a.fields).join()`.
Result without that test: 101/102 pass (adapter, ct and sim suites). Not editing tests (writer rule); stopping on this one.
