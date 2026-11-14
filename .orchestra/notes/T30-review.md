APPROVE

T30 review (diff 77070cfa..HEAD), reviewer.
- Tests: `node --test tests/docs/C2-T30.manual.test.mjs` gives 67/67 pass. They cover done_when "page per screen" (each page.tsx under the admin and platform app folders must have a SCREENS entry, a manual page and a help file), the "doc lint" checks and AC S24.
- Names: all 15 permissions cited in the manual pages exist verbatim in contracts/permissions.yaml. The route for each page is checked against contracts/routes.yaml by the test.
- Spot-checked these facts against 04-UI-UX §4–§7 and found them correct: 60 min reset, 12 chars, 31 days, 90 days, notes ≤2000, 15 MB, Tracking only, 1–500, support session fields (reason 10–500, ticket 1–60, duration 5–60, default 30).
- LD-140: covers the drawer, per-section Save and MFA badge, and has no role pack text (test enforced). LD-116: nothing under infra/tests/ in the writer's diff.
- Not applicable to a docs-only task: RLS, idempotency, rate tier and error codes. No PHI, no secrets, emails only on example.* (test enforced). The writer edited only owned paths. The .orchestra/cr rename came from the tester/orchestrator commit.
- Non-blocking: access-review.md cites `identity.user.read` for the page. The spec gives no permission for "Record review completed", so the writer left that action generic, which is correct (nothing was invented).
