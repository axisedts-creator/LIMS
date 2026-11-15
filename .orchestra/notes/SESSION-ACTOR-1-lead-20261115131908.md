ESCALATE — needs the human lead
Reasons:
- The CR is about an auth-path SECURITY DEFINER function with an EXECUTE grant to lims_api (LD-208; the LD-189 AUTH-SENSITIVE rules apply). Gate rule 2 bars a lead approval of any auth or permission-grant change, even one the founder has already authorised.
- The ask is a spec edit: C0 should copy the body of db/migrations/20261115155000_identity__add_session_actor_definer.sql into spec/chunks/C2-identity-admin/05-SCHEMA.md s10.3. The lead may not edit spec/ ("No spec edits"), and LD-208 says the s5.4 and s6 rows stay uncommitted in main until the founder commits them.
- The s5.4 and s6 rows already exist at spec/chunks/C2-identity-admin/05-SCHEMA.md:469 and :488. s10.3 has no app.identity_session_actor body (a grep of spec/ finds only those two lines), so the gap is real and documentation only.
- The CR is non-blocking. Code and tests stand as written under LD-208. The withdrawal of item 2 is already recorded at .orchestra/cr/C2.T6.nonblocking.md:16.
- For the human lead: (1) commit the 05-SCHEMA s5.4/s6 rows; (2) have C0 transcribe the migration body into s10.3; (3) after merge, do the LD-208 steps: push-cloud.ps1, push a deploy snapshot, retry the login.
