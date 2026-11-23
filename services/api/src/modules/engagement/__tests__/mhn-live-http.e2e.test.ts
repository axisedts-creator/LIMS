// Milestone T13: Real local end-to-end patient journey integration test over HTTP.
// Running Flutter Patient App -> Real HTTP Request -> Running Fastify API -> Business Logic -> PostgreSQL 17 -> Row Level Security -> Actual HTTP Response -> Updated Flutter UI.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { exec } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap } from '../../../core/bootstrap.js';
import { loadConfig } from '../../../core/config.js';

const PORT = 8088;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TENANT_A = '01a1a98a-ac40-7000-8000-00000000a001';
const PATIENT_A = '01a1a98a-ac40-7000-8000-00000000a801';
const LINK_A = '01a1a98a-ac40-7000-8000-00000000a811';
const SYS_ACTOR = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';

const CLIENT_HEADERS = {
  'X-Lims-App-Version': '1.0.0',
  'X-Lims-App-Platform': 'android',
};

describe('T13 Live Fastify & PostgreSQL 17 HTTP Patient Journey E2E', () => {
  let app: FastifyInstance | undefined;
  let superPool: pg.Pool | undefined;
  let challengeToken = '';
  let accessToken = '';
  let sessionToken = '';
  let accountId = '';
  let centreId = '';
  let slotStart = '2026-11-23T08:00:00.000Z';
  let bookingId = '';
  let bookingVersion = 1;

  beforeAll(async () => {
    const appDbUrl = process.env.LIMS_TEST_APP_URL;
    const superDbUrl = process.env.LIMS_TEST_SUPER_URL;
    expect(appDbUrl, 'LIMS_TEST_APP_URL must be defined for live E2E').toBeTruthy();
    expect(superDbUrl, 'LIMS_TEST_SUPER_URL must be defined for live E2E').toBeTruthy();

    superPool = new pg.Pool({ connectionString: superDbUrl });

    // Generate ephemeral Ed25519 patient JWT keypair for token minting and verifying
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const scratch = mkdtempSync(join(tmpdir(), 'lims-t13-e2e-'));
    const privPath = join(scratch, 'patient-jwt-ed25519-priv.pem');
    const pubPath = join(scratch, 'patient-jwt-ed25519-pub.pem');
    writeFileSync(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });

    const rlPath = join(scratch, 'ratelimit.key');
    writeFileSync(rlPath, randomBytes(32).toString('hex'), { mode: 0o600 });

    // Configure process.env for Fastify bootstrap
    process.env.LIMS_CORE_DATABASE_URL = appDbUrl;
    process.env.LIMS_CORE_RATELIMIT_KEY_FILE = rlPath;
    process.env.LIMS_ENGAGEMENT_OTP_TEST_CODE = '123456';
    process.env.LIMS_IDENTITY_PATIENT_JWT_KEY_FILE = privPath;
    process.env.LIMS_IDENTITY_PATIENT_JWT_KID = 'pat-2026-11';
    process.env.LIMS_CORE_PATIENT_JWT_PUBLIC_KEY_FILE = pubPath;

    // Boot real Fastify instance
    app = await bootstrap({ config: loadConfig(process.env) });
    await app.listen({ host: '127.0.0.1', port: PORT });
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close().catch(() => undefined);
    if (superPool) await superPool.end().catch(() => undefined);
  });

  it('1. GET /v1/core/health/live responds 200 OK over real HTTP port', async () => {
    const res = await fetch(`${BASE_URL}/v1/core/health/live`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: 'ok' });
  });

  it('2. E1: GET /v1/engagement/app/config with X-Lims-Patient-PreAuth responds 200 with enabled features', async () => {
    const res = await fetch(`${BASE_URL}/v1/engagement/app/config`, {
      headers: {
        ...CLIENT_HEADERS,
        'X-Lims-Patient-PreAuth': 't.tenant_a',
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, any>;
    expect(body.features).toMatchObject({
      app: true,
      bookings: true,
      home_collection: true,
    });
    expect(body.allowed_phone_prefixes).toContain('+977');
  });

  it('3. E2: POST /v1/engagement/auth/otp-challenges creates challenge and returns 202 Accepted', async () => {
    const res = await fetch(`${BASE_URL}/v1/engagement/auth/otp-challenges`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...CLIENT_HEADERS,
        'X-Lims-Patient-PreAuth': 't.tenant_a',
      },
      body: JSON.stringify({
        phone_e164: '+9779800000001',
        app_instance_id: '01a1b34e-1000-7eee-9d29-d7ca59a102b5',
        app_platform: 'android',
      }),
    });
    expect(res.status).toBe(202);
    const body = await res.json() as Record<string, any>;
    expect(typeof body.challenge_token).toBe('string');
    expect(body.challenge_token.length).toBeGreaterThanOrEqual(32);
    challengeToken = body.challenge_token;
  });

  it('4. E3: POST /v1/engagement/auth/otp-challenges/verify verifies OTP, provisions membership and mints Ed25519 JWT', async () => {
    const res = await fetch(`${BASE_URL}/v1/engagement/auth/otp-challenges/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...CLIENT_HEADERS,
        'X-Lims-Patient-PreAuth': `c.tenant_a.${challengeToken}`,
      },
      body: JSON.stringify({ code: '123456' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, any>;
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.session_token).toBe('string');
    expect(body.account).toBeDefined();
    expect(typeof body.account.id).toBe('string');
    accessToken = body.access_token;
    sessionToken = body.session_token;
    accountId = body.account.id;

    // Link patient account to Asha Sharma in PostgreSQL under system actor RLS
    const client = await superPool!.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ tenant_id: TENANT_A, sub: SYS_ACTOR, actor_type: 'system' }),
      ]);
      await client.query('SET LOCAL ROLE lims_app');
      await client.query(`
        INSERT INTO engagement.account_patient_links (
          id, tenant_id, account_id, patient_id, relationship, method, display_name, status, created_by, updated_by
        ) VALUES (
          $1, $2, $3, $4, 'self', 'self_registered', 'Asha Sharma', 'active', $5, $5
        ) ON CONFLICT (tenant_id, id) DO NOTHING
      `, [LINK_A, TENANT_A, accountId, PATIENT_A, SYS_ACTOR]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });

  it('5. E30: GET /v1/engagement/me/bookable-items returns real catalog items with indicative prices', async () => {
    const res = await fetch(`${BASE_URL}/v1/engagement/me/bookable-items?booking_kind=centre_visit`, {
      headers: {
        ...CLIENT_HEADERS,
        Authorization: `Bearer ${accessToken}`,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, any>;
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(2);
    const cbc = body.data.find((i: any) => i.code === 'CBC');
    expect(cbc).toBeDefined();
    expect(cbc.display_name).toBe('Complete Blood Count (CBC)');
    expect(cbc.indicative_price?.amount_paisa).toBe(50000);
  });

  it('6. E31: GET /v1/engagement/me/booking-centres returns available collection centre', async () => {
    const res = await fetch(`${BASE_URL}/v1/engagement/me/booking-centres?booking_kind=centre_visit`, {
      headers: {
        ...CLIENT_HEADERS,
        Authorization: `Bearer ${accessToken}`,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, any>;
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    const centre = body.data[0];
    expect(centre.display_name).toBe('Alpha Main Diagnostic Centre');
    centreId = centre.centre_id;
  });

  it('7. E32: GET /v1/engagement/me/slots returns real database slot occupancy', async () => {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const res = await fetch(
      `${BASE_URL}/v1/engagement/me/slots?booking_kind=centre_visit&centre_id=${centreId}&date_from=${tomorrow}&date_to=${tomorrow}`,
      {
        headers: {
          ...CLIENT_HEADERS,
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, any>;
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.data[0].slot_start).toBeDefined();
    expect(body.data[0].remaining).toBeGreaterThanOrEqual(1);
    slotStart = body.data[0].slot_start;
  });

  it('8. E33: POST /v1/engagement/me/bookings creates confirmed booking with Idempotency-Key', async () => {
    const idemKey = `t13-booking-${Date.now()}`;
    const payload = {
      profile_id: LINK_A,
      booking_kind: 'centre_visit',
      centre_id: centreId,
      slot_start: slotStart,
      orderable_ids: ['01a1a98a-ac40-7000-8000-00000000a931'],
    };

    const res = await fetch(`${BASE_URL}/v1/engagement/me/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...CLIENT_HEADERS,
        Authorization: `Bearer ${accessToken}`,
        'Idempotency-Key': idemKey,
      },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, any>;
    expect(body.id).toBeDefined();
    expect(body.status).toBe('confirmed');
    expect(body.booking_no).toMatch(/^[A-Z0-9]{4,20}$/);
    bookingId = body.id;
    bookingVersion = body.version ?? 1;

    // Idempotent replay returns same booking
    const replay = await fetch(`${BASE_URL}/v1/engagement/me/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...CLIENT_HEADERS,
        Authorization: `Bearer ${accessToken}`,
        'Idempotency-Key': idemKey,
      },
      body: JSON.stringify(payload),
    });
    expect(replay.status).toBeLessThan(300);
    const replayBody = await replay.json() as Record<string, any>;
    expect(replayBody.id).toBe(bookingId);
  });

  it('9. E34: GET /v1/engagement/me/bookings lists confirmed booking under account RLS', async () => {
    const res = await fetch(`${BASE_URL}/v1/engagement/me/bookings`, {
      headers: {
        ...CLIENT_HEADERS,
        Authorization: `Bearer ${accessToken}`,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, any>;
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.some((b: any) => b.id === bookingId)).toBe(true);
  });

  it('10. E35: GET /v1/engagement/me/bookings/:id retrieves the exact selected booking', async () => {
    const res = await fetch(`${BASE_URL}/v1/engagement/me/bookings/${bookingId}`, {
      headers: {
        ...CLIENT_HEADERS,
        Authorization: `Bearer ${accessToken}`,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, any>;
    expect(body.id).toBe(bookingId);
    expect(body.status).toBe('confirmed');
    bookingVersion = body.version ?? bookingVersion;
  });

  it('11. E36: POST /v1/engagement/me/bookings/:id/cancel cancels the booking with If-Match', async () => {
    const res = await fetch(`${BASE_URL}/v1/engagement/me/bookings/${bookingId}/cancel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...CLIENT_HEADERS,
        Authorization: `Bearer ${accessToken}`,
        'If-Match': `"${bookingVersion}"`,
        'Idempotency-Key': `t13-cancel-${Date.now()}`,
      },
      body: JSON.stringify({ reason_code: 'patient_request' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, any>;
    expect(body.status).toBe('cancelled');
  });

  it('12. E13: GET /v1/engagement/me/profiles returns Asha Sharma patient profile under RLS', async () => {
    const res = await fetch(`${BASE_URL}/v1/engagement/me/profiles`, {
      headers: {
        ...CLIENT_HEADERS,
        Authorization: `Bearer ${accessToken}`,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, any>;
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.data[0].profile_id).toBe(LINK_A);
    expect(body.data[0].display_name).toBe('Asha Sharma');
    expect(body.data[0].relationship).toBe('self');
  });

  it('13. E37 / E38 / E39 / E40: Real Address Lifecycle (Create, Idempotency, Update, Version Conflict, Deactivate) under RLS', async () => {
    const addrIdemKey = `t15-addr-${Date.now()}`;
    const addrPayload = {
      profile_id: LINK_A,
      label: 'home',
      address_text: 'Ward 4, Baneshwor, Kathmandu',
      landmark: 'Near Alpha Diagnostic Centre',
      municipality: 'Kathmandu Metropolitan City',
      ward_no: 4,
      district: 'Kathmandu',
      contact_phone_e164: '+9779800000001',
    };

    // 1. E38: Create saved address
    const createRes = await fetch(`${BASE_URL}/v1/engagement/me/addresses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...CLIENT_HEADERS,
        Authorization: `Bearer ${accessToken}`,
        'Idempotency-Key': addrIdemKey,
      },
      body: JSON.stringify(addrPayload),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as Record<string, any>;
    expect(created.id).toBeDefined();
    expect(created.label).toBe('home');
    expect(created.address_text).toBe('Ward 4, Baneshwor, Kathmandu');
    const addressId = created.id;
    let addressVersion = created.version ?? 1;

    // 2. E38 Idempotency Replay: repeating same Idempotency-Key returns the exact same address
    const replayRes = await fetch(`${BASE_URL}/v1/engagement/me/addresses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...CLIENT_HEADERS,
        Authorization: `Bearer ${accessToken}`,
        'Idempotency-Key': addrIdemKey,
      },
      body: JSON.stringify(addrPayload),
    });
    expect([200, 201]).toContain(replayRes.status);
    const replayed = await replayRes.json() as Record<string, any>;
    expect(replayed.id).toBe(addressId);

    // 3. E37: List saved addresses
    const listRes = await fetch(`${BASE_URL}/v1/engagement/me/addresses`, {
      headers: {
        ...CLIENT_HEADERS,
        Authorization: `Bearer ${accessToken}`,
      },
    });
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json() as Record<string, any>;
    expect(Array.isArray(listBody.data)).toBe(true);
    expect(listBody.data.some((a: any) => a.id === addressId)).toBe(true);

    // 4. E39 Version Conflict: Update address with stale If-Match returns 409
    const staleUpdateRes = await fetch(`${BASE_URL}/v1/engagement/me/addresses/${addressId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...CLIENT_HEADERS,
        Authorization: `Bearer ${accessToken}`,
        'If-Match': '"999"',
      },
      body: JSON.stringify({
        ...addrPayload,
        address_text: 'Stale update attempt',
      }),
    });
    expect(staleUpdateRes.status).toBe(409);

    // 5. E39: Update saved address with correct If-Match
    const updateRes = await fetch(`${BASE_URL}/v1/engagement/me/addresses/${addressId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...CLIENT_HEADERS,
        Authorization: `Bearer ${accessToken}`,
        'If-Match': `"${addressVersion}"`,
      },
      body: JSON.stringify({
        ...addrPayload,
        landmark: 'Opposite Alpha Diagnostic Centre',
      }),
    });
    expect(updateRes.status).toBe(200);
    const updated = await updateRes.json() as Record<string, any>;
    expect(updated.landmark).toBe('Opposite Alpha Diagnostic Centre');
    addressVersion = updated.version ?? (addressVersion + 1);

    // 6. E40 Version Conflict: Deactivate address with stale If-Match returns 409
    const staleDeactRes = await fetch(`${BASE_URL}/v1/engagement/me/addresses/${addressId}/deactivate`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        Authorization: `Bearer ${accessToken}`,
        'If-Match': '"999"',
      },
    });
    expect(staleDeactRes.status).toBe(409);

    // 7. E40: Deactivate saved address with valid If-Match
    const deactRes = await fetch(`${BASE_URL}/v1/engagement/me/addresses/${addressId}/deactivate`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        Authorization: `Bearer ${accessToken}`,
        'If-Match': `"${addressVersion}"`,
      },
    });
    expect(deactRes.status).toBe(204);
  });

  it('14. E22: GET /v1/engagement/me/reports returns released laboratory reports for Asha Sharma', async () => {
    const res = await fetch(`${BASE_URL}/v1/engagement/me/reports`, {
      headers: {
        ...CLIENT_HEADERS,
        Authorization: `Bearer ${accessToken}`,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, any>;
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.data[0].report_id).toBe('01a1a98a-ac40-7000-8000-00000000a981');
    expect(body.data[0].status).toBe('valid');
  });

  it('15. Database Security, Report Access & RLS Policy Enforcement over real HTTP port', async () => {
    // A. Unauthenticated request rejected with 401
    const unauth = await fetch(`${BASE_URL}/v1/engagement/me/bookings`, {
      headers: CLIENT_HEADERS,
    });
    expect(unauth.status).toBe(401);

    // B. Forged bearer token rejected with 401
    const forged = await fetch(`${BASE_URL}/v1/engagement/me/bookings`, {
      headers: {
        ...CLIENT_HEADERS,
        Authorization: 'Bearer eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.bad.signature',
      },
    });
    expect(forged.status).toBe(401);

    // C. Non-existent booking yields 404 common.not_found
    const nonExistent = await fetch(`${BASE_URL}/v1/engagement/me/bookings/01a1a98a-ac40-7000-8000-999999999999`, {
      headers: {
        ...CLIENT_HEADERS,
        Authorization: `Bearer ${accessToken}`,
      },
    });
    expect(nonExistent.status).toBe(404);

    // D. Unreleased report download fails closed with 404 common.not_found
    const unreleasedReport = await fetch(`${BASE_URL}/v1/engagement/me/reports/01a1a98a-ac40-7000-8000-999999999999/versions/1/file`, {
      headers: {
        ...CLIENT_HEADERS,
        Authorization: `Bearer ${accessToken}`,
      },
    });
    expect(unreleasedReport.status).toBe(404);

    // E. Non-existent / foreign address deactivation yields 404
    const foreignAddrDeact = await fetch(`${BASE_URL}/v1/engagement/me/addresses/01a1a98a-ac40-7000-8000-999999999999/deactivate`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        Authorization: `Bearer ${accessToken}`,
        'If-Match': '"1"',
      },
    });
    expect(foreignAddrDeact.status).toBe(404);

    // F. Cancelling an already cancelled booking yields 409 common.version_conflict or 404
    const repeatCancel = await fetch(`${BASE_URL}/v1/engagement/me/bookings/${bookingId}/cancel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...CLIENT_HEADERS,
        Authorization: `Bearer ${accessToken}`,
        'If-Match': `"${bookingVersion}"`,
        'Idempotency-Key': `t15-cancel-conflict-${Date.now()}`,
      },
      body: JSON.stringify({ reason_code: 'patient_request' }),
    });
    expect([409, 400, 422]).toContain(repeatCancel.status);
  });

  it('16. Flutter Patient App Integration: Runs mhn_real_http_e2e_test.dart against running Fastify port', async () => {
    // Flutter test runs against http://127.0.0.1:8088 and updates UI widgets without blocking Node.js event loop
    const output = await new Promise<string>((resolve, reject) => {
      exec(
        'cd ../../apps/patient_app && flutter test test/features/mhn/mhn_real_http_e2e_test.dart',
        { encoding: 'utf8' },
        (err, stdout, stderr) => {
          if (err) reject(new Error(`Flutter test failed: ${stderr || stdout || err.message}`));
          else resolve(stdout);
        },
      );
    });
    expect(output).toContain('All tests passed!');
  }, 120_000);

  it('17. Database SECURITY DEFINER verification: app.core_lookup_event_id owner, search_path, grants, and tenant/actor RLS isolation', async () => {
    expect(superPool).toBeDefined();

    // 1. Owner & Definer Property Verification from pg_proc
    const procRes = await superPool!.query(`
      SELECT p.proname, p.prosecdef, r.rolname as owner, p.proconfig, p.prosrc
      FROM pg_proc p
      JOIN pg_roles r ON r.oid = p.proowner
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'app' AND p.proname = 'core_lookup_event_id'
    `);
    expect(procRes.rows).toHaveLength(1);
    const proc = procRes.rows[0];
    expect(proc.proname).toBe('core_lookup_event_id');
    expect(proc.prosecdef).toBe(true); // Must be SECURITY DEFINER
    expect(proc.owner).toBe('lims_owner'); // Must be owned by lims_owner
    expect(proc.proconfig).toEqual(['search_path=""']); // Must have safe empty search_path
    expect(proc.prosrc).toContain('core.event_log'); // Must qualify schema

    // 2. Privilege Grant Verification: lims_app has EXECUTE, PUBLIC is REVOKED
    const privRes = await superPool!.query(`
      SELECT
        has_function_privilege('lims_app', 'app.core_lookup_event_id(text, text)', 'EXECUTE') as app_execute,
        has_function_privilege('public', 'app.core_lookup_event_id(text, text)', 'EXECUTE') as public_execute
    `);
    expect(privRes.rows[0].app_execute).toBe(true);
    expect(privRes.rows[0].public_execute).toBe(false);

    // 3. Functional authorization tests using lims_app connection
    const appPool = new pg.Pool({ connectionString: process.env.LIMS_TEST_APP_URL });
    try {
      const client = await appPool.connect();
      try {
        const testEventId = '01a1a98a-ac40-7000-8000-00000000e111';
        const testEventType = 'engagement.booking.confirmed.v1';
        const testIdemKey = `db-test-key-${Date.now()}`;
        const patientActor = '01a1a98a-ac40-7000-8000-00000000a801';
        const otherPatientActor = '01a1a98a-ac40-7000-8000-00000000a802';

        // Insert synthetic event row as patient
        await client.query('BEGIN');
        await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
          JSON.stringify({ tenant_id: TENANT_A, sub: patientActor, actor_type: 'patient' }),
        ]);

        await client.query(`
          INSERT INTO core.event_log
            (tenant_id, event_id, event_type, producer, idempotency_key, aggregate_type, aggregate_id, aggregate_seq, occurred_at, envelope, created_by)
          VALUES
            ($1, $2, $3, 'engagement', $4, 'booking', '01a1a98a-ac40-7000-8000-00000000a991', 1, now(), '{"test":true}', $5)
        `, [TENANT_A, testEventId, testEventType, testIdemKey, patientActor]);

        // A. Authorized replay: Same patient looking up own event returns the exact persisted eventId
        const ownLookup = await client.query(`SELECT app.core_lookup_event_id($1, $2) as id`, [testEventType, testIdemKey]);
        expect(ownLookup.rows[0].id).toBe(testEventId);

        // B. Cross-actor duplicate denial: Different patient looking up the same key gets NULL
        await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
          JSON.stringify({ tenant_id: TENANT_A, sub: otherPatientActor, actor_type: 'patient' }),
        ]);
        const otherLookup = await client.query(`SELECT app.core_lookup_event_id($1, $2) as id`, [testEventType, testIdemKey]);
        expect(otherLookup.rows[0].id).toBeNull();

        // C. Cross-tenant denial: Same key looked up from Tenant B gets NULL
        await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
          JSON.stringify({ tenant_id: '01a1a98a-ac40-7000-8000-00000000b001', sub: patientActor, actor_type: 'patient' }),
        ]);
        const crossTenantLookup = await client.query(`SELECT app.core_lookup_event_id($1, $2) as id`, [testEventType, testIdemKey]);
        expect(crossTenantLookup.rows[0].id).toBeNull();

        // D. Staff actor: Staff in Tenant A can see the persisted event
        await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
          JSON.stringify({ tenant_id: TENANT_A, sub: SYS_ACTOR, actor_type: 'user' }),
        ]);
        const staffLookup = await client.query(`SELECT app.core_lookup_event_id($1, $2) as id`, [testEventType, testIdemKey]);
        expect(staffLookup.rows[0].id).toBe(testEventId);

        // E. Direct SELECT on core.event_log under patient role is denied / filtered by RLS
        await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
          JSON.stringify({ tenant_id: TENANT_A, sub: patientActor, actor_type: 'patient' }),
        ]);
        const directSelect = await client.query(`SELECT event_id FROM core.event_log WHERE tenant_id = $1 AND event_id = $2`, [TENANT_A, testEventId]);
        expect(directSelect.rows).toHaveLength(0); // RLS hides core.event_log from non-staff SELECT

        // F. Negative Test: Forged app.maintenance setting does not grant lims_app SELECT on core.event_log
        await client.query(`SELECT set_config('app.maintenance', 'core_lookup_event_id', true)`);
        const forgedMaintSelect = await client.query(`SELECT event_id FROM core.event_log WHERE tenant_id = $1 AND event_id = $2`, [TENANT_A, testEventId]);
        expect(forgedMaintSelect.rows).toHaveLength(0); // event_log__select__owner_lookup is strictly TO lims_owner

        // G. Negative Test: app.maintenance is cleanly restored after function execution (no state leakage)
        await client.query(`SELECT set_config('app.maintenance', 'pre_existing_value', true)`);
        await client.query(`SELECT app.core_lookup_event_id($1, $2)`, [testEventType, testIdemKey]);
        const restoredMaint = await client.query(`SELECT current_setting('app.maintenance', true) as maint`);
        expect(restoredMaint.rows[0].maint).toBe('pre_existing_value');

        // H. Negative Test: Unauthenticated caller (empty claims) cannot look up any events
        await client.query(`SELECT set_config('request.jwt.claims', '{}', true)`);
        const unauthLookup = await client.query(`SELECT app.core_lookup_event_id($1, $2) as id`, [testEventType, testIdemKey]);
        expect(unauthLookup.rows[0].id).toBeNull();

        // I. Negative Test: Missing tenant_id in claims cannot look up events
        await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
          JSON.stringify({ sub: patientActor, actor_type: 'patient' }),
        ]);
        const noTenantLookup = await client.query(`SELECT app.core_lookup_event_id($1, $2) as id`, [testEventType, testIdemKey]);
        expect(noTenantLookup.rows[0].id).toBeNull();

        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    } finally {
      await appPool.end();
    }
  });
});
