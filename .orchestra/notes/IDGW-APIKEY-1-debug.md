# IDGW-APIKEY-1 debug
- Cause: .env.example lacks `LIMS_IDENTITY_GOTRUE_PUBLISHABLE_KEY=` (empty). Only failing test: apikey.unit.test.ts:229 (18/19 pass). render.yaml, gateway, mapping.md, CR are fine.
- Fix: add that one line (empty value) next to LIMS_IDENTITY_GOTRUE_SERVICE_KEY in .env.example, with a "# optional, all; hosted Supabase publishable key sent as apikey on non-admin gotrue calls" comment.
- NOT applied: Read/Grep/Edit on .env.example are permission-denied in this session; I did not work around it. Needs a human or a session with access to that file.
- Test is consistent with spec (LD-199 item 2); no dispute.
