# T0D-WAKE-1 writer dispute (2026-11-16 23:45 NPT, after LD-298)

Tester stage did NOT run: last rs-c2.baseline.json commit is still ec073f164 (TESTFIX-1); no "[tester] T0D-WAKE-1 tests revised per ruling" commit on lane/C0-0D (HEAD 199707574).

Verify run now: wake1 config 53/53 passed; ui no-raw-style-literals 41 passed 1 skipped; rs-c2.static 3 failed / 11 passed.

The 3 rs-c2 reds:
1. data files untouched: auth/actions.ts and auth/messages.ts hashes (expected, LD-298).
2. same route files: new app/(auth)/auth/waking/page.tsx (expected, LD-298).
3. NEW, not in LD-298's list: `same form field names` — baseline has `x-forwarded-for` and `x-real-ip`, tree does not.
   Cause: T0A-CLIENTIP-1 (c069f7ecd writer, 6c8aa5881 tester; lane C0-0A, merged via main into this lane at 2d6aeb827) moved `h.get('x-forwarded-for')` / `h.get('x-real-ip')` out of features/admin/auth/actions.ts:37 into core/api/client-context.ts, which is outside the rs-c2 ROOTS. Not a WAKE-1 change; not a behaviour change of the form fields.

Writer cannot fix: test and baseline are tester-owned; re-adding the header reads to actions.ts would undo T0A-CLIENTIP-1.
Per LD-298 the tester must stop with a blocking CR because the diff holds an entry beyond the 3 listed. Ask for lead to extend LD-298's allowed diff with field_names minus x-forwarded-for, x-real-ip (cause T0A-CLIENTIP-1), then tester re-records once.
Implementation files unchanged in this round.
