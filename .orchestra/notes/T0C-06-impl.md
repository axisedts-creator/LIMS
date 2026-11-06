# T0C-06 impl (AC-0C-2.2)
- Files: `tools/codegen/oasdiff.sh` (new). Tests: 21 pass, 3 skipped (real-oasdiff block; oasdiff not installed). Full codegen suite 152 pass.
- Runs `oasdiff breaking <base> <head> --fail-on ERR` (02-TRD gate 6 row); exit 1 bypassed only when `PR_LABELS` has exact token `cr-approved-breaking`.
- [CONV] Fail closed: bad args / unreadable file -> 2, missing oasdiff -> 127, oasdiff exit >1 never bypassed.
- [CONV] Label delivery via env `PR_LABELS` (spec silent; tester assumption kept).
- Job definition for 0A: in script header comment (loop over changed `contracts/openapi/*.yaml`, base from `origin/main`, new files skipped, `PR_LABELS` from PR labels).
- Open: 0A must pin oasdiff 1.35.x in CI and run the real-fixture block; breaking fixture not verified against real oasdiff here.
