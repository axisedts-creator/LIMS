# T0D-ELABMENU-3 dispute (writer, LD-359 snapshot round) 2026-11-18 04:12 NPT

Ran the 3 `-u` commands from LD-359. All pass (rs-c4 5/5, rs-c5 4/4, rs-c8 5/5).

- rs-c5.snap: ONLY headings change (Collect & dispatch -> Accession / Dispatch, Receive specimens -> Receive). Clean.
- rs-c8.snap: ONLY heading change (Income -> MIS Report). Clean.
- rs-c4.snap: NOT clean. +622/-25 lines. Besides New registration -> Patient Registration and Daily cash -> Daily Payment Collection it also adds the whole T0D-REGSCREEN-1/2 registration form (next_lab_number, next_receipt_number, clinical_history, patient_history, mr_number, external_reference, insurance_code, insurance_claim_amount, All tests/Favourites tabs, collection_at, collected_by_name, coupon_code, visiting_charge, payment_remark_0, Save as draft, Drafts) and React useId churn (_r_ii_ -> _r_sb_ etc.).
  Cause: REGSCREEN-1/2 commits (a223d732b, 35ca99fa4, cc707c13b) landed on this lane after LD-359 was written; the rs-c4 snapshot was never regenerated for them.

Per LD-359 ("if a diff changes anything else, stop"), nothing committed. The 3 regenerated .snap files are left modified in the working tree (revert was not permitted by the session).

ASK (lead): allow committing rs-c4.snap with the REGSCREEN form content (it is the true current render; no assertion changes), or name who regenerates it. rs-c5 and rs-c8 can be committed as-is.
