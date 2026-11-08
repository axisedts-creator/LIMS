APPROVE

Range 6f077eda..HEAD (cddf5740 tester, cc91d896 writer). Checked against LD-58 / LD-73:
- Both PEMs tracked (`git ls-files` lists test-key.pkcs8.pem + test-key.spki.pem); added via the scoped `.gitignore` negation `!services/api/src/modules/instruments/__tests__/fixtures/config/*.pem` directly after `*.pem` (already on base; no further .gitignore change in range).
- Key = deterministic Ed25519 from seed SHA-256("cfg-test-1"): re-derived independently; PKCS8 and SPKI PEMs match byte-for-byte. Synthetic test key only.
- signature.b64url.txt = Ed25519(base64url, no padding) over canonical.expected.bin: recomputed, matches. canonical.sha256.txt still matches canonical.expected.bin; vector/bin/sha unchanged.
- README documents seed rule + node regeneration one-liner (LD-73 step 3).
- No implementation change (service/signing.ts untouched in range); only owned test paths + .orchestra/notes touched. No PHI, no real secrets.
- `npx vitest run src/modules/instruments/__tests__/unit/signing.test.ts`: 54/54 pass.
- Go interop (done_when) remains for AG-T11 to copy fixtures byte-identically, per LD-73.
