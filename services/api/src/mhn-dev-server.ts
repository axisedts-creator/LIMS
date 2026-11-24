import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import './__tests__/setup-env.js';
import { bootstrap } from './core/bootstrap.js';
import { loadConfig } from './core/config.js';
import { getTextBeeConfig, sendTextBeeSms } from './modules/engagement/gateways/textbee.adapter.js';

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
process.env.LIMS_CORE_JWT_ISSUER = process.env.LIMS_CORE_JWT_ISSUER || 'https://api.metrolmis.com:8443/auth/v1';
process.env.LIMS_ORIGIN_STAFF_WEB = process.env.LIMS_ORIGIN_STAFF_WEB || 'https://app.metrolmis.com:8443';
process.env.LIMS_ORIGIN_PORTAL = process.env.LIMS_ORIGIN_PORTAL || 'https://portal.metrolmis.com:8443';
process.env.LIMS_ORIGIN_API = process.env.LIMS_ORIGIN_API || 'https://api.metrolmis.com:8443';
process.env.LIMS_CORE_JWT_AUDIENCE = 'authenticated';
process.env.LIMS_CORE_JWT_KEY_FILE = pubJwtPath;

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';

const app = await bootstrap({ config: loadConfig(process.env) });

// OAuth callback routes for Google Web Client redirects
app.get('/auth/callback', async (_req, reply) => {
  return reply.type('text/html').send('<h3>Google OAuth sign-in completed. You can return to the app.</h3><script>window.close();</script>');
});
app.get('/v1/auth/callback', async (_req, reply) => {
  return reply.type('text/html').send('<h3>Google OAuth sign-in completed. You can return to the app.</h3><script>window.close();</script>');
});

const textBeeCfg = getTextBeeConfig();
if (textBeeCfg) {
  console.log(`[MHN Dev] TextBee SMS gateway enabled (Device: ${textBeeCfg.deviceId})`);
}

// Dev hook: automatically dispatch SMS OTP via TextBee during development
app.addHook('onResponse', async (request, reply) => {
  if (request.url.includes('/otp-challenges') && !request.url.includes('/verify') && reply.statusCode === 202) {
    const phone = (request.body as Record<string, unknown> | undefined)?.['phone_e164'];
    if (typeof phone === 'string' && phone.startsWith('+')) {
      const code = process.env.LIMS_ENGAGEMENT_OTP_TEST_CODE || '123456';
      const msg = `Your My Health Now verification code is ${code}. Valid for 5 minutes.`;
      console.log(`[MHN Dev] Dispatching OTP SMS via TextBee to ${phone}...`);
      sendTextBeeSms(phone, msg)
        .then((res) => {
          if (res.success) console.log(`[MHN Dev] TextBee SMS sent successfully to ${phone}`);
          else console.warn(`[MHN Dev] TextBee SMS dispatch error:`, res.error);
        })
        .catch((err) => console.error('[MHN Dev] TextBee SMS dispatch failed:', err));
    }
  }
});

await app.listen({ host, port });
console.log(`MHN Fastify API listening on http://${host}:${port}`);
