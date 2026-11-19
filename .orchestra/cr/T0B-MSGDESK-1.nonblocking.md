Title: CR-C0-MSGDESK-1: outbox purpose, recipient kinds and opt out source for broadcasts; audience city / priority columns
From chunk: C0 (T0B-MSGDESK-1, engagement broadcast + partner tickets)            To owner: C0-0B (schema), C0-0C (contract), C6 (reporting outbox)
Type: schema | api | port
Blocking? no for the handlers, boot check and tests (all 21 operations are real and fail closed); YES for real broadcast sending and for done_when (3) "opted out recipients are skipped and counted".
Problem (what you cannot do today, with the user story / acceptance criterion it serves):
  1. Opt out: no table or column says a laboratory, franchise, client or lab_user opted out of a channel (only reporting.referrer_preferences for doctors).
     Interim: opted_out_count is always 0 and no recipient row is skipped as opted_out.
  2. Audience filter city and priority (BroadcastAudienceFilter): no column on partners.partners, catalog.credit_parties, core.collection_centres or core.users.
     Interim: a filter naming city or priority is refused 400 common.validation_failed (/audience_filter/city|priority), never ignored (ignoring would widen the audience).
  3. Outbox: reporting.deliveries__purpose__ck and g_message_templates__purpose__ck have no broadcast purpose; deliveries__recipient__ck has no client kind;
     NotificationPort needs a registered templateCode. Interim: approveBroadcast calls NotificationPort with recipient partner | centre | staff | client,
     the rendered closed placeholders and idempotencyKey broadcast:<broadcast id>:<recipient id>, but no templateCode / purpose (none is invented).
     The real port therefore refuses (reporting.notification_template_unknown) and the whole approval rolls back: nothing is queued or sent (fail closed).
  4. "Provider configured and approved": only reporting.channel_accounts exists (no approved flag). Interim: an active row of the channel whose provider_kind is not recording.
  5. Recipient without an address for the channel: interim = not a recipient (not counted, no row); skip_reason no_address is unused.
  6. Status sent: nothing moves a broadcast from sending to sent when the outbox drains (needs a reporting event or worker task).
Proposed change (exact):
  a. reporting migration: add 'broadcast' to deliveries__purpose__ck and g_message_templates__purpose__ck; add 'client' to deliveries__recipient__ck;
     seed template engagement.broadcast_message (channels sms, whatsapp, email; params party_name, lab_name, lab_phone, send_date; body = the tenant template body).
  b. NotificationPort (03-IC §4.8): accept recipient { kind: 'client', creditPartyId } and resolve its contact from catalog.credit_parties.
  c. opt out: a column broadcast_opt_out text[] (channels) on partners.partners, catalog.credit_parties, core.collection_centres and core.users, or one table
     engagement.broadcast_opt_out (tenant_id, party_kind, party_id, channel); the audience SQL then counts them in opted_out_count and writes skipped rows.
  d. city / priority: name the source columns (e.g. partners.partners.city, catalog.credit_parties.city, a priority on credit parties) or drop them from BroadcastAudienceFilter.
  e. worker task engagement.broadcast_settle: when no recipient of a sending broadcast is queued any more, move it to sent.
Backward compatible? yes (additive CHECK values, new optional columns / table, new template row).
Tenant/security impact: no RLS change; opt out rows are tenant rows under the existing __tenant policies. No PHI (party display names only).
Alternatives considered: invent a template code / purpose in code (forbidden: names are copied from the spec); skip city / priority silently (widens the audience).
Tests that will prove it: broadcast.test.ts gains an opted out party (skipped row, opted_out_count + 1, no NotificationPort call) and a city filter case;
  a reporting outbox test that a broadcast purpose row is written once per idempotency key.
