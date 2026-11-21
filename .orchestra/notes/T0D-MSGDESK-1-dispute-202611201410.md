# T0D-MSGDESK-1 dispute (writer) — three older tests pin the engagement / partners nav manifest entry counts
The brief (done_when, "the staff navigation entries (additive)") and msgdesk1.source.test.ts ("the engagement nav manifest gains two entries after the ten existing ones")
require two new engagement entries (engagement.msg_templates order 110, engagement.msg_broadcasts order 120). Two tester-owned suites in the verify chain pin the pre-task count:
1. src/features/engagement/__tests__/content1.source.test.ts:67 `expect(m.entries.length, 'the nine existing entries stay').toBe(10)` -> 12 now.
2. src/features/engagement/__tests__/nav-complete.engagement.test.ts (run by vitest.content1 AND vitest.nav-complete): the specSuite row list (9 spec rows + CONTENT) is exact,
   and `expect(m.entries).toHaveLength(9 + CONTENT.length)` -> 3 failures ("holds exactly the spec rows", "spec order", "settings entry present").
Ask (same pattern as the T0D-CONTENT-1 CONTENT rows / the T0D-SALES-1 partners rows): add the two MSGDESK rows to nav-complete.engagement as additive rows that join once their page exists
(name Message Templates / Messages, paths /engagement/messages/templates|broadcasts, permission engagement.broadcast.read, orderRange after 100), and narrow content1 line 67 to ">= 10".
3. src/features/partners/__tests__/nav.manifest.test.ts:39 (node --test) `entries.length <= EXPECTED.length + 4 + 3` -> 13 now: the one MSGDESK inbox entry (partners.tickets,
   order 130) that msgdesk1.source requires ("gains the ticket inbox entry after the twelve existing ones"). Ask: allow `+ 1` for T0D-MSGDESK-1.
The new labels already follow the suite's label rule (engagement.nav.<id suffix>). The implementation stays.

Not mine (failing on main state, unrelated to this task): nav-complete.admin-pack (3: corp_admin pack now holds lab.result.approve / hidden list) and nav-complete.build
"by('billing') toBe(9)" (22 billing entries). My entries are visible to corp_admin (the hidden list got shorter, not longer).
