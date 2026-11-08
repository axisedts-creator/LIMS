Shared C7 golden vector (02-TRD 5.10). SYNTHETIC test key `cfg-test-1`, used only by tests.
Go copy: apps/bridge-agent/testdata/config (byte-identical, checked by c7-fixture-copy-check).
- canonical.vector.json: input document (keys unsorted on purpose)
- canonical.expected.bin: exact canonical UTF-8 bytes (no trailing newline)
- canonical.sha256.txt: hex SHA-256 of those bytes
- signature.b64url.txt: base64url (no padding) Ed25519 signature over canonical.expected.bin
- test-key.pkcs8.pem / test-key.spki.pem: test key pair (tracked via the scoped negation in root .gitignore, LD-58)

Key rule (LD-73): Ed25519 seed = SHA-256 of the ASCII string `cfg-test-1`. Synthetic only, never a production key.
Regenerate the PEMs + signature (run in this directory; Ed25519 is deterministic, output is stable):

    node -e "const c=require('crypto'),f=require('fs');const s=c.createHash('sha256').update('cfg-test-1','ascii').digest();const k=c.createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),s]),format:'der',type:'pkcs8'});f.writeFileSync('test-key.pkcs8.pem',k.export({type:'pkcs8',format:'pem'}));f.writeFileSync('test-key.spki.pem',c.createPublicKey(k).export({type:'spki',format:'pem'}));f.writeFileSync('signature.b64url.txt',c.sign(null,f.readFileSync('canonical.expected.bin'),k).toString('base64url'))"
