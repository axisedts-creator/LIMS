# SEC-AUTHZ-5 dispute (writer, round 2)
Rerun of SEC-AUTHZ-5-verify.cmd after the ruling fixes: vitest 4299 pass, 1 fail; node security tests fail only on the snapshot (not regenerated yet, tester step).
Fix 1 (imports.commit PRICE_ALL) now passes. Fix 2 is self-contradictory:
- `creditParties.handlers.test.ts` "PATCH by a manage caller still returns no sensitive field" grants MANAGE and expects no pan / phone / email / billing_address.
- AB-22 design (creditParties.service.ts:4, AC-12.4): those fields leave ONLY for holders of catalog.price_list.manage, so a manage caller does get them. The same file's test "PATCH with If-Match "1" -> 200" (READ+MANAGE) expects `billing_address: 'New Street 5'` back.
- Failing line: `expected '{"id":"0190c300-…' not to match /123456789|9779800000001|billing@examp…/`.
Passing it would need the service to mask fields from manage holders (breaks AB-22 and the sibling test). Implementation unchanged.
Suggested test fix: grant MANAGE and assert 200 with the sensitive fields present (or drop the test; read-only denial is covered by the authz5 matrix).
