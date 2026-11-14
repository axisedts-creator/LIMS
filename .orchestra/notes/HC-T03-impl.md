# HC-T03 impl (repositories)
- Files: services/api/src/modules/homecollection/repository/{shared,bookingRefs,routes,visits,visitTransitions,visitAssignments,visitSpecimens,devices,syncBatches,mutations,collections,handovers,visitFlags,visitLocations,settings,reasons}.repo.ts (16 new).
- [CONV] fn(tx, tenantId, ...args), raw snake_case rows, null/[] on miss; every statement binds `tenant_id = $1`; static SQL, values only as $n; tables schema-qualified (search_path '').
- [CONV] insert*: column allow-list, tenant_id taken only from arg, created_by/updated_by default to app.current_actor_id(); append-only tables (transitions, assignments, sync_batches, mutations, locations) export no update/set; jsonb cols JSON.stringify'd.
- [CONV] update*(tx,t,id,expectedVersion,patch): patch keys allow-listed (= DB mutable-column trigger lists where one exists), unknown/tenant_id/id keys throw HC_PATCH_COLUMN before SQL; bumps version/updated_at; null on stale version or other tenant.
- shared.repo.ts is a helper (insertRow/getRowById/updateRow) named *.repo.ts like frontdesk's, so it also passes the static check; devices/syncBatches get-by-id are written out explicitly because static.test requires a literal `tenant_id = $1` in every repo file.
- getVisitByOrderId returns the oldest visit of the order (revisit/recollection visits share order_id).
- Ran (after ruling + revised tests, no impl change): tests/homecollection/HC-T03.pg.sh on PG17 -> 2 files, 186/186 pass. Open: P-1 stand-in DDL lacks C0 transition_guard triggers; cross-centre scoping untested (handler layer).
