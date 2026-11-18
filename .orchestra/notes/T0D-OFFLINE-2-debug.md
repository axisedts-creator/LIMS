Cause: sole failure r04.source.test.ts motion (14000 > 450) comes from shell.css .lims-auth-plate 'animation: lims-sway 14s' added by T0D-UIDASH-1 (6c1b8b4c1, ancestor of this lane base 532ab4115). OFFLINE-2 does not touch shell.css (git diff base..HEAD empty).
Fix: none made. shell.css is not an OFFLINE-2 file; test is not wrong (13-M-SERIES s2.3 cap 450 ms), so no dispute either. Needs a UIDASH-1 follow-up (shorten loop or exempt ambient auth art by lead ruling) or lead waiver.
All OFFLINE-2 suites pass per verify log (offline2 140, offline1 82, density 350, rs-c2 74).

Round 2: re-confirmed. Same single failure (r04.source.test.ts motion, lims-sway 14s in shell.css from UIDASH-1). No OFFLINE-2 code involved; no edit made. Lead must route to UIDASH-1 follow-up or waive.
