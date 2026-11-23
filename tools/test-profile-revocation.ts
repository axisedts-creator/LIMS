import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { execSync } from 'node:child_process';

const BASE_URL = 'http://127.0.0.1:3000';
const TENANT_A = '01a1a98a-ac40-7000-8000-00000000a001';
const PATIENT_A = '25dba5ff-9e30-77da-889d-2b301ddea2cd'; // Bikram Thapa

function mintStaffJwt(): string {
  const privKey = readFileSync('/tmp/lims-mhn-jwt-key/priv.pem', 'utf8');
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', typ: 'JWT' };
  const payload = {
    sub: '01a1a98a-ac40-7000-8000-00000000a301',
    session_id: '01a1a98a-ac40-7000-8000-00000000a999',
    iss: 'https://gotrue.lims.test/auth/v1',
    aud: 'authenticated',
    role: 'authenticated',
    aal: 'aal1',
    iat: now,
    exp: now + 3600,
  };
  const b64u = (obj: any) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${b64u(header)}.${b64u(payload)}`;
  const sign = createSign('sha256');
  sign.update(unsigned);
  const signature = sign.sign({ key: privKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${unsigned}.${signature}`;
}

async function main() {
  console.log('=== TASK 3: VERIFY FAMILY CONSENT & PROFILE REVOCATION ===');
  const staffToken = mintStaffJwt();
  const staffHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${staffToken}`,
  };

  const testPhone = `+97798${String(Date.now() % 100000000).padStart(8, '0')}`;
  console.log(`Using test patient phone: ${testPhone}`);

  // 1. Staff issues link code for PATIENT_A
  console.log('1. Staff issuing link code...');
  const issueRes = await fetch(`${BASE_URL}/v1/engagement/link-codes`, {
    method: 'POST',
    headers: staffHeaders,
    body: JSON.stringify({
      patient_id: PATIENT_A,
      relationship: 'parent',
      consented_by: 'patient',
      identity_check_method: 'photo_id',
      bind_phone: 'other',
      phone_e164: testPhone,
    }),
  });
  const issueBody = await issueRes.json() as any;
  if (issueRes.status !== 201) throw new Error(`Issue failed: ${issueRes.status} ${JSON.stringify(issueBody)}`);
  const plainCode = issueBody.code;
  console.log(`Issued code: ${plainCode}`);

  // 2. Authenticate patient account
  console.log('2. Authenticating patient account...');
  const chalRes = await fetch(`${BASE_URL}/v1/engagement/auth/otp-challenges`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Lims-App-Version': '1.0.0', 'X-Lims-App-Platform': 'android', 'X-Lims-Patient-PreAuth': 't.tenant_a' },
    body: JSON.stringify({ phone_e164: testPhone, app_instance_id: '01900000-0000-7000-8000-000000000099', app_platform: 'android' }),
  });
  const chal = await chalRes.json() as any;
  const verifyRes = await fetch(`${BASE_URL}/v1/engagement/auth/otp-challenges/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Lims-App-Version': '1.0.0', 'X-Lims-App-Platform': 'android', 'X-Lims-Patient-PreAuth': `c.tenant_a.${chal.challenge_token}` },
    body: JSON.stringify({ code: '123456' }),
  });
  const auth = await verifyRes.json() as any;
  const patientHeaders = {
    'Content-Type': 'application/json',
    'X-Lims-App-Version': '1.0.0',
    'X-Lims-App-Platform': 'android',
    'Authorization': `Bearer ${auth.access_token}`,
    'X-Lims-Session-Token': auth.session_token,
  };

  // 3. Redeem code to create active link
  console.log('3. Redeeming link code...');
  const redeemRes = await fetch(`${BASE_URL}/v1/engagement/me/profiles/redeem-code`, {
    method: 'POST',
    headers: { ...patientHeaders, 'Idempotency-Key': `idem-${Date.now()}` },
    body: JSON.stringify({ code: plainCode }),
  });
  const redeemBody = await redeemRes.json() as any;
  if (redeemRes.status !== 201) throw new Error(`Redeem failed: ${redeemRes.status} ${JSON.stringify(redeemBody)}`);
  const profileId = redeemBody.profile_id;
  const initialVersion = redeemBody.version;
  console.log(`Linked profile ID: ${profileId}, version: ${initialVersion}`);

  // 4. Verify profile exists in GET /v1/engagement/me/profiles
  console.log('4. Checking GET /v1/engagement/me/profiles...');
  const list1Res = await fetch(`${BASE_URL}/v1/engagement/me/profiles`, { headers: patientHeaders });
  const list1 = await list1Res.json() as any;
  const found = list1.data?.find((p: any) => p.profile_id === profileId);
  if (!found || found.status !== 'active') throw new Error(`Profile not found or not active: ${JSON.stringify(list1)}`);
  console.log(`Verified active profile: ${found.display_name} (version ${found.version})`);

  // 5. Patient revokes profile via E19 (POST /v1/engagement/me/profiles/:id/remove)
  console.log('5. Revoking profile via E19 removeMyProfile...');
  const removeRes = await fetch(`${BASE_URL}/v1/engagement/me/profiles/${profileId}/remove`, {
    method: 'POST',
    headers: {
      'X-Lims-App-Version': '1.0.0',
      'X-Lims-App-Platform': 'android',
      'Authorization': `Bearer ${auth.access_token}`,
      'X-Lims-Session-Token': auth.session_token,
      'If-Match': `"${found.version}"`,
    },
  });
  console.log('Remove status:', removeRes.status);
  if (removeRes.status !== 204) {
    const text = await removeRes.text();
    throw new Error(`Expected 204 for E19 removeMyProfile, got ${removeRes.status}: ${text}`);
  }
  console.log('E19 removeMyProfile returned 204 No Content!');

  // 6. Verify DB row status has transitioned to 'revoked'
  console.log('6. Checking DB state for revoked link...');
  const dbRow = execSync(`docker exec lims_mhn_pg psql -U supabase_admin -d postgres -t -c "SELECT status, revoked_by_kind, is_active, version FROM engagement.account_patient_links WHERE id = '${profileId}';"`, { encoding: 'utf8' }).trim();
  console.log('DB account_patient_links row:', dbRow);
  const [dbStatus, dbRevokedBy, dbIsActive, dbVersion] = dbRow.split('|').map((s) => s.trim());
  if (dbStatus !== 'revoked' || dbRevokedBy !== 'account' || dbIsActive !== 'f') {
    throw new Error(`Unexpected DB row values: status=${dbStatus}, revoked_by=${dbRevokedBy}, is_active=${dbIsActive}`);
  }
  console.log(`DB state verified: status='revoked', revoked_by_kind='account', is_active=false, version=${dbVersion}`);

  // 7. Verify GET /v1/engagement/me/profiles NO LONGER contains the profile
  console.log('7. Verifying GET /v1/engagement/me/profiles omits revoked profile...');
  const list2Res = await fetch(`${BASE_URL}/v1/engagement/me/profiles`, { headers: patientHeaders });
  const list2 = await list2Res.json() as any;
  const stillPresent = list2.data?.find((p: any) => p.profile_id === profileId);
  if (stillPresent) throw new Error(`Revoked profile still returned in profiles list: ${JSON.stringify(stillPresent)}`);
  console.log('Confirmed: Revoked profile is completely omitted from patient profile list!');

  // 8. Negative Boundary: Attempting to remove already revoked profile returns 404
  console.log('8. Testing removal of already revoked profile...');
  const removeAgainRes = await fetch(`${BASE_URL}/v1/engagement/me/profiles/${profileId}/remove`, {
    method: 'POST',
    headers: {
      'X-Lims-App-Version': '1.0.0',
      'X-Lims-App-Platform': 'android',
      'Authorization': `Bearer ${auth.access_token}`,
      'X-Lims-Session-Token': auth.session_token,
      'If-Match': `"${dbVersion}"`,
    },
  });
  console.log('Second remove status:', removeAgainRes.status);
  if (removeAgainRes.status !== 404) {
    throw new Error(`Expected 404 for removing non-active profile, got ${removeAgainRes.status}`);
  }
  console.log('Correctly rejected with 404 common.not_found!');

  // 9. Negative Boundary: Booking attempt with revoked profile is rejected
  console.log('9. Testing booking attempt for revoked profile...');
  const bookingAttemptRes = await fetch(`${BASE_URL}/v1/engagement/me/bookings`, {
    method: 'POST',
    headers: { ...patientHeaders, 'Idempotency-Key': `idem-${Date.now()}` },
    body: JSON.stringify({
      profile_id: profileId,
      booking_kind: 'centre_visit',
      centre_id: '01a1a98a-ac40-7000-8000-00000000a002',
      slot_start: '2026-11-25T04:15:00.000Z',
      orderable_ids: ['01a1a98a-ac40-7000-8000-00000000b001'],
    }),
  });
  console.log('Booking attempt status:', bookingAttemptRes.status);
  const bookingBody = await bookingAttemptRes.json() as any;
  console.log('Booking attempt error body:', bookingBody);
  if (bookingAttemptRes.status !== 404 || bookingBody.code !== 'common.not_found') {
    throw new Error(`Expected 404 common.not_found for booking with revoked profile, got ${bookingAttemptRes.status}: ${JSON.stringify(bookingBody)}`);
  }
  console.log('Booking attempt correctly rejected with 404 common.not_found for revoked profile!');

  console.log('=== TASK 3: FAMILY CONSENT & REVOCATION FULLY VERIFIED 100% ===');
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
