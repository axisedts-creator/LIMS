# Tabletop record: synthetic site failover

- Date: 2026-11-11
- Scenario: synthetic. The whole primary site (app host and data host) is lost to a power and network failure; the second site, the standby host and the ops host are intact. No real patient data, tenant or person is involved.
- Participants: C1 writer agent only (desk walk-through against `dr.md`). The founder and the on-call engineers have not yet taken part; see Actions.
- Incident commander: primary on-call (role played by the writer agent)
- RTO target: 4 h from the declaration; RPO 15 min or less (AC-22.2)
- Next tabletop: 2027-05-11 (at most 6 months after this one)
- Actions: (1) hold the walk-through with the founder and both on-call engineers; (2) time each step on the staging game day (`dr.md#game-day`); (3) confirm with the DNS provider (B12) that TTL 300 s is set in advance; (4) confirm the cold VM at site B is allowed (B12).

## Walk-through (times relative to the declaration)
1. T+0: alerts `TargetDown` for both site A hosts; the on-call confirms with the provider console that site A is unreachable and declares SEV1.
2. T+0 h 20 min: the old primary is fenced (provider console). The standby is promoted with `dr-promote.yml -e confirm_env=<env>`.
3. T+0 h 40 min: the app VM is provisioned at site B and `site.yml` runs with the site B inventory; images are pulled from the registry mirror.
4. T+1 h 30 min: Storage objects are restored from the replica volume; the API smoke passes.
5. T+2 h: the DNS records of the origins are moved to the site B address (TTL 300 s, so clients follow in about 5 min); certificates are issued with ACME at site B.
6. T+2 h 30 min: staff sign-in is checked; the status page is updated. Inside the 4 h RTO.
7. Afterwards: the incident record names the degraded mode (no second-site archive, audit store on the promoted host); `NoOffsiteArchive` pages until a repo on another site exists.

## Findings
- The steps work in order on paper; no step needed information outside `dr.md` and the secrets store.
- Gap: nothing here was timed; the RTO is an estimate until the staging game day measures it.
- Gap: the registry mirror location at site B and the DNS provider are B12 items; the walk-through assumes them.
