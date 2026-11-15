Title: CR-C1-010: OtpInput single-input mode (one real input for the 6-digit code) for web auth MFA screens
From chunk: C1            To owner: C0-0B (packages/ui kit owner)
Type: ui-kit
Blocking? yes — WEB-STYLE-4 (LD-213 item 4) acceptance "the 6-digit code field stays ONE real input (autocomplete one-time-code, inputmode numeric, maxlength, name and id unchanged)" cannot be met in this lane.

Problem (what you cannot do today, with the user story / acceptance criterion it serves):
LD-213 (4) asks for the MFA code to be one real input styled with wide letter-spacing, tabular figures, centred. `apps/web/src/features/admin/auth/MfaChallengeForm.tsx:56` and `MfaEnrolment.tsx:133` render the kit `OtpInput` (`packages/ui/src/components/OtpInput/OtpInput.tsx`), which renders SIX inputs (one per digit, autocomplete one-time-code only on cell 1), with no `name`, no `id` prop and no `maxLength`. LD-213 forbids this lane from editing `packages/ui` and from changing behaviour, so the C1 lane leaves OtpInput unchanged and the requirement stays open.

Proposed change (exact): add an optional prop to `OtpInputProps`:
  `mode?: 'cells' | 'single'` (default `'cells'`, current behaviour unchanged), plus optional `name?: string` and `id?: string`.
  When `mode === 'single'`: render ONE `<input className="lims-input lims-otp-single lims-mono" type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="one-time-code" maxLength={length} name={name} id={id ?? useId()} aria-describedby={error id}>` with the existing label as a real `<label htmlFor>`; digits-only filter, `onChange`, `onComplete` (on full length and on Enter) and `isDisabled` behave as today. Kit CSS gets `.lims-otp-single` (letter-spacing ~0.5em, `font-variant-numeric: tabular-nums`, text-align centre, larger size) from tokens only (LD-140).
  Alternative acceptable to C1: an LD amendment to LD-213 accepting the six cells for WEB-STYLE-4 (then no kit change).
Backward compatible? yes — default mode keeps six cells; C6 portal OTP and existing C2 callers unaffected.
Tenant/security impact: none — presentation only; no RLS, no PHI field, no new public surface. The code value path (onChange/onComplete to the existing server action) is unchanged.
IRD/regulatory impact: n/a.
Alternatives considered: (a) restyle six cells as one visual field in shell.css — does not give one real input, name or maxlength; (b) replace OtpInput with a raw input in the C1 auth forms — changes behaviour and form fields, forbidden by LD-213.
Tests that will prove it: kit unit test — `mode="single"` renders exactly one input with autocomplete one-time-code, inputmode numeric, maxlength 6, given name/id; paste of "12 34 56" yields "123456" and fires onComplete; default mode still renders six cells (phase1-fields test stays green). C1 follow-up: switch the two MFA forms to `mode="single"` and the web-style-4 one-input test passes.
