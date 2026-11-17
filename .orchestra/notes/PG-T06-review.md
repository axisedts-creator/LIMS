APPROVE
PG-T06 review (895b6ba7..HEAD).
- Fields per TRD §7.2.3 verbatim (amount/tax_amount/product_service_charge/product_delivery_charge/product_code/total_amount/transaction_uuid/success_url/failure_url/signed_field_names/signature); signing order per §7.2.2.
- Callback: ≤4 KB, required keys, REQ-SEC-049 names, length check then timingSafeEqual on decoded bytes, txn ref + product_code match.
- Status: raw-text regex + exact decimal parser (no floats); 5xx / code:0 / timeout -> transient; scd mismatch withholds amount; refId -> secondaryRef.
- No PHI in log (intent_id only), no secrets, owned paths only, no DB/RLS surface in this task.
- Tests: 102/102 pass (unit + ct + sim), reviewer re-ran the verify command.
- Non-blocking: initiate() deferred (noted Open by writer); async buildAction/verify deviate from the sync §7.1 signature (SecretHandle.use is async), [CONV] recorded.
