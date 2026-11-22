# T0D-FIX-10 dispute (writer)
Test: t20.fix10-resend-invitation.test.tsx:138 — `expect(pageText()).not.toMatch(/Error:|at \w+ \(|stack/)` in "failure shows the error with its reference inside the dialog".
Why it is wrong: the inline error is the kit `Banner tone="danger"` (via admin `Alert`, the same one the detail-page dialog and every admin screen use). The kit Banner renders a VisuallyHidden tone label `Error: ` for screen readers (packages/ui/src/components/_shared/messages.ts `toneText.danger = 'Error'`, Banner.tsx:23). `pageText()` reads textContent, so the regex `/Error:/` matches that accessible label, not a stack trace. Received text: "...Resend invitation?Error: Something went wrong. Try again; ... Reference: 01a1a98a-...f10a ...".
Satisfying it would mean dropping the kit Banner (or its a11y label) for this one dialog — against "kit components only" and the detail-page parity the task asks for.
Proposed fix (tester): match stack-trace shapes only, e.g. `/\bat \w+ \(|\.tsx?:\d+|stack/i` or `/(Type|Reference|Syntax)Error:/`; keep the REF and "never Invitation sent." assertions.
Status: all other 18 tests pass with the implementation as is.
