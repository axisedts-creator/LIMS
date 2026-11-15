APPROVE

# IDGW-APIKEY-1 review (reviewer)
- Range note: `3b4d8efa..HEAD` is empty (HEAD = 3b4d8efa); the task's commits are already ancestors of it. Reviewed 16c7d5c9, 0224d142, 760316b4, 3b1b4828 instead.
- gateway.http.ts: admin path sends `authorization: Bearer <serviceKey>` + `apikey: <serviceKey>`; non-admin sends `apikey` only when `publishableKey` is non-empty, never the service key; unset = headers unchanged. Env read only in `gotrueGatewayFromEnv`. LD-199 cited. No logging, error, mapping, breaker or timeout change.
- .env.example / render.yaml: name only, empty / `sync: false`. Not added to infra/secrets/schema (publishable key is not a secret; no parity test forces it).
- mapping.md "Hosted Supabase" note matches LD-199 evidence. Non-blocking CR to C2 exists (.orchestra/cr/IDGW-APIKEY-1.nonblocking.md). 6 non-note files, under the 12 limit; cross-lane edit authorised by LD-199.
- Tests cover every done_when item (admin/non-admin headers, set/empty/unset, planted failure, key leak in GoTrueError/LimsError/metrics, env reader scope, env/render/mapping/CR). Synthetic keys only.
- Ran: vitest gotrue/* + manifest-ports + static.security: 141 pass, 38 skipped (live suite), 0 fail. staging-boot.test.ts 11/11. service-key-grep.mjs exit 0. infra test_t0d_dep01_images (unittest) 115 OK.
- Not run: full ci-scripts suite; pytest-only infra suites (no pytest installed). Not verified live against hosted Supabase (LD-199 NOT COVERED list applies).
