TESTS_WRONG — the three older tests pin pre-task nav entry counts; the spec and the binding brief require the new MSGDESK nav entries to be added
Reasons:
- Brief files list (.orchestra/inbox/T0D-MSGDESK-1-arbiter.md:18) says "the staff navigation entries (additive)", and done_when (:21) says new engagement and partners routes "are registered the way T0D-ACCT-1 registers its routes", which means a routes.yaml row plus a nav entry. LD-321 (:33) scopes MSGDESK as broadcasts and partner tickets. So adding the entries is required, not optional.
- contracts/routes.yaml:193,216,217 already hold staff.partners.tickets, staff.engagement.msg_templates and staff.engagement.msg_broadcasts (staff_web, non-parameterised), so they meet the nav entry rules in spec/chunks/C0-foundation-contracts/04-UI-UX.md:295-300. C16 04-UI-UX.md:35 §1.3 lists 9 spec rows. It does not forbid additive rows, and the CONTENT row (nav-complete.engagement.test.ts:11-14) already set that pattern.
- Fixes for the tester:
  1. engagement/__tests__/content1.source.test.ts:67: change `toBe(10)` to `toBeGreaterThanOrEqual(10)` (message: "the nine existing entries and CONTENT stay").
  2. engagement/__tests__/nav-complete.engagement.test.ts: add a MSGDESK array, built like CONTENT and filtered by pageExists. Rows: {name 'Message templates', path '/engagement/messages/templates', permission 'engagement.broadcast.read', group 'engagement', orderRange [100, 200], id 'engagement.msg_templates', routeId 'staff.engagement.msg_templates'} and {name 'Messages', path '/engagement/messages/broadcasts', the same permission, group and orderRange, id 'engagement.msg_broadcasts', routeId 'staff.engagement.msg_broadcasts'}. Spread `...MSGDESK` after `...CONTENT` in rows, and change line 39 to `toHaveLength(9 + CONTENT.length + MSGDESK.length)`. Keep the label rule test unchanged.
  3. partners/__tests__/nav.manifest.test.ts:39: change the bound to `EXPECTED.length + 4 + 3 + 1`, add a comment saying T0D-MSGDESK-1 (LD-321) adds partners.tickets (pinned by msgdesk1.source.test.ts), and update the assert message to match.
- The implementation stays. nav-complete.admin-pack and the nav-complete.build billing count fail on main and are not in this dispute. They need their own task.

=== LEAD ITEM, LD-435 (2026-11-20) ===
Round 4 pulled in four core/nav failures, none caused by MSGDESK-1
(confirmed: branch diff against main touches only engagement, partners
and core/i18n messages.ts). Same stale-frozen-pin family as LD-391
through LD-433, now in core/nav.

TESTER, two fixes:

1. nav-complete.build.test.ts: the by billing toBe nine line. Change it
to toBeGreaterThanOrEqual(9), matching the style the frontdesk, lab and
engagement lines just above it already use. Leave the payments line
alone.

2. nav-complete.admin-pack.test.ts: the HIDDEN_NON_PLATFORM array. The
generated report at notes/T0D-NAV-COMPLETE-1-admin-hidden.md now shows
zero non-platform entries hidden from corp_admin, so set
HIDDEN_NON_PLATFORM to an empty list. Leave the platform-group handling
in the same test exactly as it is.

WRITER: nothing to do here, same as the rest of this task.
