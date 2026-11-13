# T-L1 impl (writer) — round 3: API 41/41; web 35/35 after ruling (no impl change needed)
- API (round 1): service/link.service.ts, handlers/link.handlers.ts, repository/linkCodes.repo.ts (round 2: column list concatenated, no `${}` before WHERE), repository/consents.repo.ts.
- Web W8: app/(staff)/engagement/app-access/[patient_id]/{page,loading,error}.tsx; features/engagement/components/AppAccess.tsx (AppAccess, CodeSlip), AppAccessHost.tsx; server/link.server.ts, link-actions.ts, link-pages.tsx.
- [CONV] Slip = kit TokenSlip printed through PrintFrame (no patient name); code kept only in dialog state, gone on close; times in Asia/Kathmandu.
- [CONV] Phone radio option labels avoid the word "phone" ("On record +977•••••42" / "Another number"); relationship is a kit Select per 04-UI-UX W8.
- [CONV] Lab name on the slip = session tenantCode (same source as the W6 token slip). Consent text from T1 settings; none → Issue disabled with a notice.
- Open: AppLink has no `version`, so L4 If-Match sends `link.version ?? 1` (needs CR: version in AppLink or ETag on L3). Guardian-required-under-minor_age_years not enforced in UI (API side). tsc clean for these files; apps/web has no eslint binary.
