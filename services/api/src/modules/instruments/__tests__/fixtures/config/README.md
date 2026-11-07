Shared C7 golden vector (02-TRD 5.10). SYNTHETIC test key `cfg-test-1`, used only by tests.
Go copy: apps/bridge-agent/testdata/config (byte-identical, checked by c7-fixture-copy-check).
- canonical.vector.json: input document (keys unsorted on purpose)
- canonical.expected.bin: exact canonical UTF-8 bytes (no trailing newline)
- canonical.sha256.txt: hex SHA-256 of those bytes
- signature.b64url.txt: base64url Ed25519 signature over canonical.expected.bin
- test-key.pkcs8.pem / test-key.spki.pem: test key pair
