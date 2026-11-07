APPROVE
Re-review after e1ce966. Prior item 1 (auto code colliding with an explicit code blocks quick-add forever) is handled as asked: `.orchestra/cr/T-15.md` follows the spec/program/04-CHANGE-REQUESTS.md §2 template (the IRD line is omitted, which is fine because this is not a billing change). It cites 02-TRD:172/173/641 and 05-SCHEMA, proposes skip-taken plus a 100-try cap, and covers T-16 `CP`. Collision test is deferred until the ruling. T-15-impl.md Open line updated. No code changed since the prior review, so all earlier "no defect" checks still hold.
Ran T-15-verify suite: 4 files, 267/267 pass.
Still open, outside T-15: CR ruling, then the collision test (T-15/T-16). Idempotency replay (T-36), getReferrer port (T-29), price-list reassignment at merge (T-17).
