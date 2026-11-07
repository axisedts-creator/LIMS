# T0A-05 debugger
- Cause: only 1 of 50 fails: SAFE_PHONE_PREFIX_SOURCE still `UNVERIFIED`, checkedOn `0000-00-00` (generators/index.ts:8). Test is correct (TRD §3.5: "T0A-05 verifies +999 unassigned in ITU E.164 list"). Not a code defect.
- Fix NOT applied: needs real ITU-T E.164 lookup; WebFetch denied here (permission not granted). Setting date/note from memory would fake evidence.
- Next: human/web-enabled session reads https://www.itu.int/pub/T-SP-E.164D, then sets checkedOn + note (cite ITU edition + wording for 999, must contain "ITU", no "UNVERIFIED"). If 999 is assigned, change SAFE_PHONE_PREFIX and re-run verify.

## round 2
- Same cause. /browse skill errored ("Execute skill: browse"), no ITU access. Fix still blocked on real E.164 lookup; no code changed, no fake evidence.
- Needs web-enabled session: set SAFE_PHONE_PREFIX_SOURCE.checkedOn + note (contains "ITU", cites edition, no "UNVERIFIED"). If +999 assigned, change prefix.

## round 3
- Same cause. WebFetch (via web-fetch agent) denied: permission not granted. No ITU access, no code changed, no fake evidence.
- Need: grant WebFetch (or run web-enabled session), then set SAFE_PHONE_PREFIX_SOURCE.checkedOn + note (contains "ITU", edition, no "UNVERIFIED"). If +999 assigned, change prefix.

## round 4 (LD-22: WebFetch allowed)
- Cause: SAFE_PHONE_PREFIX_SOURCE was UNVERIFIED placeholder. Fetched ITU PDF (OB 1114, position 15 Dec 2016, p.9): "999 Reserved for future global service" = no country/operator holds it. Prefix kept.
- Fix: generators/index.ts SAFE_PHONE_PREFIX_SOURCE checkedOn 2026-11-07 + note citing edition/wording. Verify cmd: 50/50 pass. Caveat: 2016 is the newest list found on the ITU page; newer bulletin amendments not checked.
