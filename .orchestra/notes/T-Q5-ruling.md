TESTS_WRONG — queueboard.test.tsx:78 assumes the stale time keeps UTC minutes (":05"); spec requires display in Asia/Kathmandu (UTC+05:45), so 09:05Z must render as 14:50 / 02:50 PM.
Reasons:
- spec/program/02-CONVENTIONS.md:438 — "Time zone for display | `Asia/Kathmandu` (UTC+05:45) unless a tenant setting says otherwise [CONV]"; v1 accepts only Asia/Kathmandu (03-INTERFACE-CATALOG.md:1602, 08-CR-REGISTER.md:2127).
- spec/program/02-CONVENTIONS.md:1164 — display formats `hh:mm A`, time zone `Asia/Kathmandu`.
- spec/chunks/C16-patient-engagement/04-UI-UX.md:264 (D1) and LD-145 only require the stale state to show the last-update time from staleSince; neither names UTC or machine-local time, so the convention above governs.
- Kit already follows it: packages/ui/src/components/_shared/dates.ts:20 `DEFAULT_TZ = 'Asia/Kathmandu'`; QueueBoard output "02:50 PM" is correct.
- `/\d{1,2}:05/` can only pass with UTC or a whole-hour-offset zone, i.e. it asserts something the spec forbids.
Change in the test (line 78 only; keep staleSince 2026-11-13T09:05:00Z): `expect(banner.textContent).toMatch(/\b(02:50\s?PM|14:50)\b/)`.
Implementation unchanged. Other 9 QueueBoard tests unaffected.
