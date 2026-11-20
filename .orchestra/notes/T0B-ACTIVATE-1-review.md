APPROVE

Round 2 (after review fixes 6441ab42e, 79e00cb8b). All four prior items resolved:
1. mfa.repo.ts:79-81 INVITE_ACCEPT_SQL back to `status = 'sent'` (03-APP-FLOW §2.6 / M2), comment cites LD-299 + CR ACTIVATE-1c.
2. mfa.repo.accept-invitation.test.ts: `pending` is now the refused case (false, invitation/membership untouched, no membership UPDATE); statement asserted to list only `sent`; expiry, scoping, single-use, fail-closed kept.
3. activate.chain.test.ts: fake accept mirrors `sent` only; explicit worker-seam step pending -> sent before set password; new STAGING GAP test pins that without it the membership stays invited and activateTenant is refused (identity.tenant_not_ready).
4. CR file has BLOCKING ACTIVATE-1c (pending -> accepted; §2.6 line 120, M2 line 60, invitation.state.ts EDGES); §3.7 bullet removed; 1b mail/template CR with exact link shape kept.

Done_when: (1) chain/confirm tests cover provisioning invite link; (2) confirmEmailToken.ts:79-82 invite ok provisioning|active, recovery active only, count/locked/status guards and no-oracle error kept; (3) sent only + CR per brief clause; (4) login gate/resolver untouched, chain asserts identity.tenant_suspended before activate; (5) real chain provision -> link -> set password -> activate -> login; (6) no rate-limit/MFA/platform-path change; (7) mail CR present. No PHI, no secrets, owned paths only, names verbatim, no RLS change.

Note for lead (not a defect): blocking CR ACTIVATE-1c lives in T0B-ACTIVATE-1.nonblocking.md, so it may be batched rather than triaged in a day; lead should pick it up from there.

Ran: verify.cmd tests + confirm/setPassword: 4 files 46/46 pass. Full identity suite: 10 fail, all in ci-scripts.test.ts and role-packs/apply-role-pack.script.test.ts (untouched by this diff, pre-existing). Not verified: accept SQL against real Postgres.
