# HC-T19 impl (writer)
- New: `app/(staff)/homecollection/visits/[visit_id]/{page,loading,error}.tsx`, `components/VisitDetailView.tsx` (ReviewDialog inlined: source test wants RadioGroup in view/route files), `help/visit.md`.
- Edited: `server/{read,write,actions}.server|ts` (H2 getVisit, H7, H8, H9, H21 + 3 H20 sets), `types.ts`, `labels.ts`, `components/ReasonConfirm.tsx` (optional `onDone`, used by revisit -> router.push).
- [CONV] H2 rebuilt from an allow-list; address/note kept only with visit.assign; phone only via H21 action result, held in one component's state. Idempotency-Key via useSubmissionKey (same body = same key).
- [CONV] Tube chip = latest collection of that specimen (fixture has applied+discarded for one tube); in_progress shows no state buttons (H4/H6 would 409). Sequence shown as "Stop N on the route" (test regex `\b2\b` needs a word break after the number in textContent).
- Run: HC-T19 96/96 pass (after ruling); HC-T18 135/135, HC-T20 148/148 still pass; tsc clean for my files. E2E not run (needs compose).
- Review applied: reason field is `CodedSelect homecollection.review_reasons` (04-UI-UX §2.2); review primary button reads Apply/Discard/Confirm by decision (E2E `/^discard/i`). Re-run: 96/96, 135/135, 148/148; tsc clean in impl files.
- OPEN: E2E not run (needs compose); Tubes "Clock" column needs CR (`clock_suspect` not in VisitDetailDto).
