# T0A-05 debugger
- Cause: only 1 of 50 fails: SAFE_PHONE_PREFIX_SOURCE still `UNVERIFIED`, checkedOn `0000-00-00` (generators/index.ts:8). Test is correct (TRD §3.5: "T0A-05 verifies +999 unassigned in ITU E.164 list"). Not a code defect.
- Fix NOT applied: needs real ITU-T E.164 lookup; WebFetch denied here (permission not granted). Setting date/note from memory would fake evidence.
- Next: human/web-enabled session reads https://www.itu.int/pub/T-SP-E.164D, then sets checkedOn + note (cite ITU edition + wording for 999, must contain "ITU", no "UNVERIFIED"). If 999 is assigned, change SAFE_PHONE_PREFIX and re-run verify.
