# C6-T35 impl (writer)
Files: docs/manual/reporting/{README,worklist,report,narrative,outsourced,deliveries,delivery,templates,template,messages,settings,portal,runbooks}.md (13 pages, docs only).
Tests: `node --test tests/docs/C6-T35.manual.test.mjs` → 27/27 pass (after review fixes).
Sources: help/*.md, 04-UI-UX §1.1/§2/§4/§6, contracts/routes.yaml; synthetic only, no URLs, no pending.json change (no stub ops).
[CONV] deliveries/templates list pages name no permission (no routes.yaml row, per T31); they point to delivery.read / template.manage.
Open: wording not in spec, needs doc review — "old callback URL stops working" on rotate, "version number goes up by one" on publish, sweep resumes renders after restart, "do not resend while circuit open".
Open: no screenshots (none required).
Review fixes: portal.md Dues section now covers dues page, report dues card, payment status and payment return pages (04-UI-UX §4); runbooks.md names `reporting.channel.manage` verbatim.
