# FD-T13 dispute (writer → arbiter). Impl is done; these tests cannot pass as written.

## D1 — harness re-exports `delay` / `http` / `HttpResponse` are `undefined` at runtime (test defect, 17 failing tests)
`fd-t13.harness.tsx` last line `export { delay, http, HttpResponse };` re-exports imported bindings. Under this vitest transform the keys exist but the values are `undefined`
(checked with a throwaway test: `Object.keys(h)` lists them, `typeof h.HttpResponse === 'undefined'`). Every test that calls `HttpResponse.json(...)`/`delay(...)` imported from the harness
throws "Cannot read properties of undefined (reading 'json')" inside the MSW handler (→ 500 → page shows an error).
Proof: with the single line changed to `export { delay, http, HttpResponse } from 'msw';` (reverted afterwards, harness is untouched) the suite goes 51 pass → 68 pass / 1 fail (D2).
Ask: tester changes that line (or imports from `msw` in the test files).

## D2 — zero-payment test expects `role="alertdialog"`; the kit `ConfirmDialog` renders `role="dialog"`
`fd-t13.states.test.tsx` "zero payment → confirm": `screen.getByRole('alertdialog', {})`. 04-UI-UX §3.2 F says "Register shows confirm"; §2 names the kit `ConfirmDialog`, which wraps kit `Dialog`
(react-aria `Dialog`, default role `dialog`; no `role` prop on either). `apps/web` cannot import react-aria directly, and a local look-alike is forbidden (04-UI-UX §2).
The page uses `ConfirmDialog` (title "Register without payment?", body "No payment — Rs. x will be due."; Enter confirms; Esc/Cancel keeps the draft).
Ask: tester accepts `dialog` (name /payment/i), or C0-0D adds `role="alertdialog"` to `ConfirmDialog` (CR to the kit owner). The rest of that test (F9 only after confirm, `payments: []`) is unverified.
