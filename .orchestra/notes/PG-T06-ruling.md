TESTS_WRONG — the test asserts something the spec does not require
Reasons:
- spec/chunks/C15-payment-gateways/02-TRD.md:421 (§7.2.3) mandates the form field `signed_field_names`; the same test file asserts it at esewa.adapter.test.ts:54-56 and :61. Its key contains "name", so the regex `/patient|name|phone|email|mobile/i` at :110 can never pass against a spec-conformant action.
- spec/chunks/C15-payment-gateways/07-SECURITY.md:38 (REQ-SEC-141) asks for: only order ref, amount and product label, and no PHI. A bare substring "name" in a protocol key name is not PHI.
Change in the test (esewa.adapter.test.ts:108-111), with its intent kept:
- Keep the exact key-set check from :54-57. It already enforces "no extra field".
- Replace :110 with a check on values that includes `name` as a word, e.g.
  `expect(Object.values(a.fields).join('|')).not.toMatch(/patient|\bname\b|phone|email|mobile/i);`
  plus `expect(JSON.stringify(a)).not.toMatch(/patient|phone|email|mobile/i);` (the full action, without `name`).
Do not change the implementation for this test.
