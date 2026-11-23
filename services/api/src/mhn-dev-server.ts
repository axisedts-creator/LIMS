import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import './__tests__/setup-env.js';
import { bootstrap } from './core/bootstrap.js';
import { loadConfig } from './core/config.js';

const scratch = mkdtempSync(join(tmpdir(), 'lims-mhn-dev-'));

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privPath = join(scratch, 'patient-jwt-ed25519-priv.pem');
const pubPath = join(scratch, 'patient-jwt-ed25519-pub.pem');
writeFileSync(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });

const jwtKeyDir = '/tmp/lims-mhn-jwt-key';
mkdirSync(jwtKeyDir, { recursive: true });
const privJwtPath = join(jwtKeyDir, 'priv.pem');
const pubJwtPath = join(jwtKeyDir, 'pub.pem');
if (!existsSync(privJwtPath) || !existsSync(pubJwtPath)) {
  const { privateKey: staffPriv, publicKey: staffPub } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  writeFileSync(privJwtPath, staffPriv.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(pubJwtPath, staffPub.export({ type: 'spki', format: 'pem' }), { mode: 0o644 });
}

const rlPath = join(scratch, 'ratelimit.key');
writeFileSync(rlPath, randomBytes(32).toString('hex'), { mode: 0o600 });

process.env.LIMS_CORE_ENV = 'dev';
process.env.LIMS_CORE_RATELIMIT_KEY_FILE = rlPath;
process.env.LIMS_ENGAGEMENT_OTP_TEST_CODE = process.env.LIMS_ENGAGEMENT_OTP_TEST_CODE || '123456';
process.env.LIMS_IDENTITY_PATIENT_JWT_KEY_FILE = privPath;
process.env.LIMS_IDENTITY_PATIENT_JWT_KID = 'pat-2026-11';
process.env.LIMS_CORE_PATIENT_JWT_PUBLIC_KEY_FILE = pubPath;
process.env.LIMS_CORE_JWT_ALG = 'ES256';
process.env.LIMS_CORE_JWT_ISSUER = 'https://gotrue.lims.test/auth/v1';
process.env.LIMS_CORE_JWT_AUDIENCE = 'authenticated';
process.env.LIMS_CORE_JWT_KEY_FILE = pubJwtPath;

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';

const app = await bootstrap({ config: loadConfig(process.env) });
await app.listen({ host, port });
console.log(`MHN Fastify API listening on http://${host}:${port}`);
