TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)

Reasons:
- LD-213 (binding for this task; brief `.orchestra/inbox/WEB-STYLE-4-arbiter.md:33`) authorises "one new component for the inline art and mark (for example features/admin/auth/AuthArt.tsx)" and requires NO change to "form fields, names, ids, labels, copy, actions ... or behaviour". The intent of web-style-2 (g) (`apps/web/src/__tests__/web-style-2.test.ts:11`) is "form fields and behaviour unchanged".
- web-style-4 fixes the path: `apps/web/src/__tests__/web-style-4.test.ts:500` (`features/admin/auth/AuthArt.tsx`), so the file cannot move out of the walked tree (`web-style-2.test.ts:190`).
- `AuthArt.tsx` contains zero SIG_ATTR tokens (grep of name|id|htmlFor|type|href|action|autoComplete|inputMode|maxLength|method|data-testid = no match), so its only effect is the extra key `"features/admin/auth/AuthArt.tsx": []` from `signature()` (`web-style-2.test.ts:175-182`). No existing file's field signature changed.
- The failure is therefore a fixture that predates an LD-authorised file, not a field/behaviour change.

Change to make (tester): in `apps/web/src/__tests__/fixtures/auth-fields.baseline.json` add exactly `"features/admin/auth/AuthArt.tsx": []`. Do NOT make the test skip empty-signature files — keeping the explicit empty entry means the test still fails if AuthArt.tsx ever gains a form field, id or href. No implementation change required.
