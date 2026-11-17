# C6-T05 debug (debugger)
Cause: verify 3 fails (47/50) are NOT impl bugs. (1) watermark: test HTML uses opacity:.08 -> Skia Form XObject; helpers/pdf-text.ts never follows `Do` (watermark IS on every page). (2) Devanagari "embeds Noto": host has no Noto Sans Devanagari; impl correctly uses fontconfig only (02-TRD:175). (3) saturation 503: test races, job hold (timeoutMs+setup/close) vs waiter bound (50ms later, same timeoutMs) ~0-30ms margin.
Fix: none in impl; changing impl to dodge would be wrong. No test edited. Dispute appended to C6-T05-dispute.md; arbiter/tester must act.
