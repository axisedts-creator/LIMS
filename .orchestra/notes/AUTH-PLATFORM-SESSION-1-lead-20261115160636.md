ESCALATE — needs the human lead
Reasons:
- The CR asks for spec transcription of two new SECURITY DEFINER auth read functions (identity.sessions, mfa_factors, platform_staff through owner-only policies) into C2 05-SCHEMA s5.4 (spec/chunks/C2-identity-admin/05-SCHEMA.md:428), s6 (:481) and s10.3 (:1427); that is an auth / RLS-adjacent surface, so rule 2 fails and LD-189 (AUTH-SENSITIVE) applies; same ruling as the SESSION-ACTOR-1 spec transcription.
- It is a spec edit, not a test or implementation change, so neither APPROVED_RETEST nor APPROVED_REWRITE fits; the lead cannot edit spec/.
- Note for the human lead: 05-SCHEMA.md:481 says `GRANT EXECUTE TO lims_app` while LD-216 fixes EXECUTE to lims_api only; the transcription must settle that wording.
- Per LD-216 this CR is non-blocking: this escalation does NOT hold, block or reopen AUTH-PLATFORM-SESSION-1; the task proceeds under the LD-216 scope (migration is body of record until C0 transcribes).
- Migration and pgTAP were NOT run in the lane (CR line 6); first real run is the post-merge push-cloud.ps1 + sign-in retry per LD-216.
