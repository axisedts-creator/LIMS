# T0D-11 dispute — accent.test.ts "subtle = accent mixed 8% with white"
- Test: `deriveAccent('#000000').subtle === '#141414'` (comment: round(255*0.08)=20). That is 8% white + 92% accent, i.e. subtle ≈ accent.
- Spec 04-UI-UX §1.6: "`accent.subtle` = accent mixed 8% with white"; §1.1 gives the role "selected row, active nav background" and the default `#EFF6FF` (a near-white tint of `#1D4ED8`). Standard reading = `color-mix(in srgb, accent 8%, white)` = 8% accent, 92% white; 8% of #1D4ED8 gives #EDF1FC ≈ #EFF6FF. The test's reading makes the selected-row bg nearly the accent, so primary text (#0F172A) on it would fail AA for dark tenants.
- Fix the test: expect `deriveAccent('#000000').subtle` = `#EBEBEB` (255 - round(255*0.08) = 235). The `#FFFFFF -> #FFFFFF` line is correct either way.
- Implementation uses the spec reading; that is the only failing test (29/30 pass).
