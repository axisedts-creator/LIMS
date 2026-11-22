# T0D-FIX-12 left (for the lead; LD-455 (b), LD-237, SEC-ABUSE-1: limiter and pipeline NOT changed)
Numbers: resolveSession = public, tier general; one bucket per client IP (services/api/src/core/pipeline/index.ts:104), token bucket 10/s, burst 20 (services/api/src/core/ratelimit/index.ts:63).
Resolves per page render: before = 1 (middleware, once per request; serverFetch never resolves), after = 1. Bursts came from next/link prefetch: each viewport link in the rail (up to ~14 group/entry links + create links when expanded) and search results = one request through middleware = one resolve. After: rail and global search links prefetch={false} = 0 resolves from prefetch there.
Still open, per owning lane (T0D-FIX-12-ruling.md item 4; in-page/list next/link still prefetch, not edited here, lead to rule):
- C2 (admin/identity): features/admin/components/UsersTable.tsx, UserDetailView.tsx, MyAccount.tsx; app/(staff)/admin/users/page.tsx, roles/page.tsx, audit/page.tsx.
- C5 (lab): features/lab/components/worklists/WorklistPage.tsx, worklists/DepartmentIndex.tsx, consoleParts.tsx, IngestExceptionList.tsx, CriticalValueList.tsx.
- C13 (partners): features/partners/components/TicketThread.tsx, TicketInbox.tsx.
Retry: one retry on 429 after Retry-After (cap 1 s); a second 429 fails the request with 429 problem+json, no session headers.
Recommendation: key the BFF-authenticated (X-Lims-Bff-Key valid) resolveSession bucket per hash of the session cookie, not per IP, so one lab behind one address cannot drain a shared 20-token bucket; keep per-IP for calls without the BFF key. Also confirm the gateway sets x-real-ip (host).
