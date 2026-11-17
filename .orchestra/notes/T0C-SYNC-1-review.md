APPROVE
Scope: git diff c9d9ff63b..HEAD = notes (impl, ruling, dispute rename) + contracts/__tests__/registry-equality.test.ts only. No contract, migration, service or web change in this range.
- Test change follows the arbiter ruling 442e0a7f5 (TESTS_WRONG) and LD-330 (keep both lanes' codes): MSGDESK_ERRORS / MSGDESK_CODES are added to the allow-lists, and every IC equality and order assertion stays in place. Every allow-listed MSGDESK code exists in contracts/permissions.yaml (lines 220-221, 258-260) and errors.yaml, so nothing is invented.
- fixed_actor_permissions filtering is limited to the MSGDESK codes. The IC deep equality still holds for everything else.
- Ran: contracts `npx vitest run __tests__/registry-equality.test.ts`: 14/14 pass (22:48).
- Non-blocking: the comment at registry-equality.test.ts:101 still says "exactly the five sync.* codes", and the one at :191 says "two MSGDESK codes" (the filter covers 5). Lead follow-up per ruling: add the MSGDESK codes to IC §8/§11, then drop the allow-lists.
- Not in this diff: the probe-rows fixtures (engagement.sql, partners.sql) are uncommitted in the worktree. They are not reviewed here.
