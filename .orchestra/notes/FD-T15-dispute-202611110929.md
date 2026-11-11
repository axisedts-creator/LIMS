# FD-T15 dispute (writer, 2026-11-11 09:26)
Run: `bash tests/frontdesk/FD-T15.pg.sh` -> 77/78 pass; 1 fail: admin/duplicates.test.ts:96 `expect(idsOf(dflt.body)).not.toContain(previous.x.id)`.

Test is wrong: duplicates.test.ts:93 `mkPair('2026-11-09T18:29:00Z')` is commented "2026-11-09 23:59" but 18:29Z + 05:45 = **2026-11-10 00:14** Asia/Kathmandu
(`node -e "new Date('2026-11-09T18:29:00Z').toLocaleString('en-CA',{timeZone:'Asia/Kathmandu'})"` -> `2026-11-10, 00:14:00`).
Kathmandu midnight of 2026-11-10 is 2026-11-09T18:15Z, so this patient IS created on tenant-local 2026-11-10 and correctly appears in the default (today) list.
The test's own other stamps agree with this: lastMinute 18:14Z = 23:59, nextDay 18:15Z = 00:00. Fix: line 93 stamp -> `'2026-11-09T18:14:00Z'` (23:59 on 11-09). Line 99 (`d9` contains previous) then also holds.
Impl (patients.repo.ts:69 `created_at >= ($3::date)::timestamp AT TIME ZONE tz AND < ($3::date+1)::timestamp AT TIME ZONE tz`) unchanged.
