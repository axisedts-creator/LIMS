# IDGW-APIKEY-1 impl (writer)
- Changed: gotrue/gateway.http.ts (apikey header, `publishableKey` option, env read only in gotrueGatewayFromEnv), gotrue/mapping.md ("Hosted Supabase" note), render.yaml (new name, sync: false), .orchestra/cr/IDGW-APIKEY-1.nonblocking.md (non-blocking CR to C2). 4 files, under the 12 limit.
- [CONV] admin calls: apikey + authorization = service key; other calls: apikey = publishable key only when non-empty; unset = headers as before. LD-199 cited in code comments.
- OPEN: `.env.example` NOT edited. Read and Grep on that file were permission-denied in this session, so I did not work around it. Add this line (empty value): `LIMS_IDENTITY_GOTRUE_PUBLISHABLE_KEY=`. It is the only apikey test still failing.
- Tests: apikey.unit.test.ts 18/19 pass. `src/modules/identity` suite: 4694 pass, 2 fail. One is the `.env.example` test. The other is role-packs/route-guard.test.ts (AppShell.tsx nav hint). It touches none of my files; not confirmed pre-existing.
- Not run: ci-scripts, static security suite outside identity, infra/secrets schema parity. `tsc --noEmit` errors are in contracts/ports (TS2835), none in my files.
