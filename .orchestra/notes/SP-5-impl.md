# SP-5 impl
- Files: db/meta/decisions/SP-5.md (record: Decision atlas 1.3.1 community, digest pinned), .orchestra/cr/SP-5.md (runner contract CR).
- Live run: supabase/postgres:17.6.1.136 on a `--internal` docker network, tcpdump in the shared netns; containers removed afterwards.
- Atlas: (a)–(g) pass. Update check DNS `vercheck.ariga.io` seen; `ATLAS_NO_UPDATE_NOTIFIER=1` → 0 lookups. sqitch 1.6.1 fails (c) (SET LOCAL ROLE ignored).
- [CONV] lock_timeout/statement_timeout passed as URL run-time params; password via PGPASSWORD; `--allow-dirty` on image init DB.
- Findings (CR): lims_owner needs USAGE + SELECT/INSERT/UPDATE on migrations_meta (verified via default privileges); txmode directive + blank line; applied-file edit undetected after re-hash → append-only check.
- Open: Atlas licence (Apache-2.0) not re-fetched (web blocked); only 2 synthetic files applied; lint not assessed (SP-6).
- Tests: node --test SP-5 25/25; SP-1/2/3 regression pass (63/63 total).
