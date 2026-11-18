TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)
- Disputed: apps/web/src/features/engagement/__tests__/adminpage-eng-1.static.test.ts:92-103 pins every `code: engagement.*` line in contracts/permissions.yaml, and the whole contracts/openapi/engagement.yaml, to BASE 052539369 (:14), the tree before ADMINPAGE-ENG-1.
- The five new codes (engagement.broadcast.read/manage/approve, engagement.content.read/manage) came from T0C-CONTENT-1 (9a920abce) and T0C-MSGDESK-1 on main, not from T0D-CONTENT-1 (`git diff 052539369 HEAD -- contracts/permissions.yaml`). engagement.yaml also changed on main (T0C-CONTENT-1, T0C-MSGDESK-1, T0C-SYNC-1), so :102 fails as soon as :97 passes.
- LD-313(a, c) in the brief puts portal content in the engagement module and engagement.yaml and allows NEW permission codes for it. LD-321 names engagement.broadcast.read/manage/approve as new codes. Lead decisions outrank the chunk docs (CLAUDE.md precedence). The test comment at :94 ("never engagement.*") is out of date.
- Same pattern as ruling T0D-ENGBOOK-1 (billing.*). No implementation change can pass the test without reverting contract work on main.
Change the test as follows (keep the ADMINPAGE-ENG-1 intent: its own codes are unchanged, and it adds no new code outside the allowed families):
1. :96-97 compare only the base engagement lines. Every `code: engagement.` line in basePerms must still appear unchanged in perms: `for (const l of engLines(basePerms)) expect(perms.split('\n')).toContain(l)`.
2. :100 also allow new codes that start with `engagement.content.` or `engagement.broadcast.` (cite LD-313, LD-321).
3. :102 replace the byte-identical engagement.yaml check with a scoped one: the settings operations that ADMINPAGE-ENG-1 relies on still exist (or compare against the current main tree, not BASE). Keep :101 as it is.
4. Update the :94 comment to cite this ruling and LD-313/LD-321.
