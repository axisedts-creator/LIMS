# T0A-CLIENTIP-1 tests (tester)
- API: services/api/src/core/auth/__tests__/client-ip.test.ts (new describe "LD-296": list+key leftmost, no key/peer, junk leftmost, IPv6, mapped peer, trusted-CIDR single-literal rule).
- Web: apps/web/src/core/api/__tests__/client-context.test.ts, server-fetch.test.ts; core/session/__tests__/c2.client-context.test.ts; features/admin/auth/__tests__/t12.client-context.test.ts (uses t12.harness).
- Config: apps/web/src/core/api/__tests__/vitest.clientip1.config.ts. Run: `.orchestra\notes\T0A-CLIENTIP-1-verify.cmd`.
- Assumed helper API: `readClientContext(): Promise<{ ip?: string; userAgent?: string }>` in apps/web/src/core/api/client-context.ts (fail-soft: headers() throws -> {}).
- "KEY ON READS" describe in server-fetch.test.ts assumes the key IS sent; if the writer's openapi.ts/claims-resolver.ts reading says otherwise, stop and ask the lead (CR), do not weaken it.
- Not covered: live Render/Vercel header shape (needs the post-deploy auth_events check); spec/CR text; runbook note.
