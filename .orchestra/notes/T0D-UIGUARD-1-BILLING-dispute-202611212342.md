# T0D-UIGUARD-1-BILLING dispute (writer): registry needs 14 stale PARTNERS rule 2 entries removed (TESTER, LD-441)
Done when (1) names PartysetCommon for FilterBar, and /billing/daily-cash fails rule 2 through it (no entry covers that route). Once SearchBar renders the kit FilterBar,
the PARTNERS rule 2 legacy block in apps/web/src/core/__tests__/uiguard1.exceptions.ts ('PartysetCommon.tsx, ManifestInbox.tsx, PenaltyEvents.tsx') goes stale for 14 routes,
because PartysetCommon was their only violation: /billing/audit-trail, /billing/cbms, /billing/credit-parties, /billing/credit-parties/[credit_party_id], /billing/dues,
/billing/invoices, /billing/invoices/[invoice_id], /billing/registers, /billing/settings, /billing/worklist, /catalog/icd, /partners/[partner_id], /partners/onboarding, /partners/penalties.
Guard now: rules 1 to 7 green; only "no stale entry" fails, on exactly those 14. Writer may not edit the registry (LD-441). ASK: the tester deletes those 14 routes from that legacy block
(the routes still broken through ManifestInbox/PenaltyEvents stay). The matching PARTNERS lines in notes/T0D-UIGUARD-1-exceptions.md are left for the PARTNERS lane (LD-441: no edit of another area's lines); extra mirror lines do not fail the mirror test.
