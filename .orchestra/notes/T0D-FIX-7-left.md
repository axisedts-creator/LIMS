# T0D-FIX-7 left (not edited, outside payments)
Params declared array + form + explode:false outside payments: analytics (many), engagement status, inventory movement_kind + status.
- CONFIRMED same string-only fault: `services/api/src/modules/inventory/handlers/lots.schemas.ts:18` csvOf() requires typeof string; used for `movement_kind` (line 54 casts to string and splits). An array from the validator gives a 400. Likely cause of T0D-FIX-9 listStockMovements 400.
- Already accept arrays: inventory alerts.schemas.ts:11 (status), engagement booking.service.ts:106 (status), analytics export.service.ts:102 (status).
- Not traced: analytics MIS/report array filters (branch_id, centre_id, collector_id, department_id, item_status, party_id, payment_method_code, processing_branch_id, referrer_id, representative_id, segment, specimen_type_code). No string-only split found in analytics/ by grep, but the readers were not checked one by one.
