// LD-73 regenerator (also documented in fixtures/config/README.md). Synthetic key only.
const c = require('crypto'), fs = require('fs'), path = require('path');
const dir = process.argv[2];
const seed = c.createHash('sha256').update('cfg-test-1', 'ascii').digest();
const pre = Buffer.from('302e020100300506032b657004220420', 'hex');
const priv = c.createPrivateKey({ key: Buffer.concat([pre, seed]), format: 'der', type: 'pkcs8' });
const pub = c.createPublicKey(priv);
fs.writeFileSync(path.join(dir, 'test-key.pkcs8.pem'), priv.export({ type: 'pkcs8', format: 'pem' }));
fs.writeFileSync(path.join(dir, 'test-key.spki.pem'), pub.export({ type: 'spki', format: 'pem' }));
const msg = fs.readFileSync(path.join(dir, 'canonical.expected.bin'));
const sha = c.createHash('sha256').update(msg).digest('hex');
console.log('sha256 matches file:', sha === fs.readFileSync(path.join(dir, 'canonical.sha256.txt'), 'utf8').trim());
const sig = c.sign(null, msg, priv).toString('base64url');
fs.writeFileSync(path.join(dir, 'signature.b64url.txt'), sig + '\n');
console.log('verify:', c.verify(null, msg, pub, Buffer.from(sig, 'base64url')), sig);
