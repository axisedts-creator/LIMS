# T0B-12 impl (LD-54 + LD-55)
- `db/provisioning/create-storage-buckets.mjs`: HTTP transport wired per LD-55: `LIMS_CORE_STORAGE_URL` (no default, trailing slash trimmed), paged `GET /bucket?limit=100&offset=N`, `POST /bucket` for absent, `PUT /bucket/{id}` {public:false} for public, private untouched; Bearer + apikey headers; POST non-2xx re-lists and accepts only present+private.
- Output only `<bucket> created|ok|flipped`; errors name operation + HTTP status only (no URL, credential, body; fetch errors swallowed to "request failed").
- [CONV] exit via `process.exitCode`, not `process.exit()`: on Windows, exiting with fetch sockets closing crashes libuv (`UV_HANDLE_CLOSING` assertion), seen in the tests.
- `db/meta/decisions/SP-4.md`: appended "Provisioning contract (LD-55)" (items 1-4, existing text unchanged). `db/provisioning/README.md`: status updated.
- Tests: `.orchestra\notes\T0B-12-verify.cmd` (both node files) gives 105/105 pass, GATE tests included.
- Open: live run against real Storage = first-deploy smoke test (LD-54), not executed; routes come from storage-api v1.89.13 source and are unconfirmed live.
