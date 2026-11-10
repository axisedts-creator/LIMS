# FD-T10 impl (writer)
- Files: service/trf.service.ts; handlers/{uploadTrf,getTrfAttachment,getTrfAttachmentContent}.ts + index.ts wiring; worker tasks/{trf_scan,trf_draft_purge}.ts + index.ts/cron.ts; pending.json minus the 3 operationIds (LD-70).
- [CONV] F20 quarantine key `{tenant}/q/{yyyy}/{mm}/{id}.{ext}` (server-generated), row `pending`, enqueue `frontdesk.trf_scan` (job_key = id); only the worker sets `clean` + moves to `{tenant}/{yyyy}/{mm}/{id}.{ext}`. created_by = membership id.
- [CONV] centre scope via IdentityPort.getActor().centreScope (as orders): out of scope = auth.forbidden on upload, 404 on read; order_id validated before any byte is stored.
- [CONV] purge uses the DB clock for the 24 h cut (as the DEFINER); objects deleted first, only ids whose delete succeeded reach `purge_trf_drafts`.
- Results: static 16/16, worker wiring+live 27/27, api upload+content 48/50 sequential; 2 failures are test defects -> FD-T10-dispute.md (bigint string in trfRow; sentinel asserted absent from the body that must carry original_filename).
- Open: JPEG re-encode is a core gap (accept() refuses JPEG with 422); TRF link at registration (`trf_attachment_ids`) still `service_unavailable`; orphan object if the request tx fails after the handler returns (no sweeper); no qpdf sanitise.
