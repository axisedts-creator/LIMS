# AG-T03 impl
- Added apps/bridge-agent/internal/astm/{checksum,frame,records,classify}.go (API per AG-T03-tests.md).
- Ran `go mod tidy` in apps/bridge-agent (go.mod/go.sum updated; C7 owns the app) — tests could not compile otherwise.
- `go vet` clean; `go test -count=1 ./internal/astm/` = ok.
- [CONV] checksum compared case-insensitively on receive, uppercase on send; Frame.Checksum stored uppercase.
- [CONV] Tokenize fails closed (empty Message) unless first record is `H` with >= 5 chars; unknown record types are skipped; LF around CR tolerated.
- [CONV] EncodeRecords rejects empty records; Receive rejects trailing bytes after CR LF.
- Open: TS side (drivers/astm/tokenizer.test.ts) must read __tests__/astm-vectors.json; not touched here.
