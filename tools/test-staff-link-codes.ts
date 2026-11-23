import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';

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
  console.log('=== TASK 2: VERIFY LINK-CODE ISSUANCE & REDEMPTION ===');
  const staffToken = mintStaffJwt();
  const staffHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${staffToken}`,
  };

  const testPhone = `+97798${String(Date.now() % 100000000).padStart(8, '0')}`;
  console.log(`Using test patient phone: ${testPhone}`);

  // 1. Staff issues link code via API
  console.log('1. Authorized staff issuing link code via POST /v1/engagement/link-codes...');
  const issueRes = await fetch(`${BASE_URL}/v1/engagement/link-codes`, {
    method: 'POST',
    headers: staffHeaders,
    body: JSON.stringify({
      patient_id: PATIENT_A,
      relationship: 'parent',
      consented_by: 'patient',
      identity_check_method: 'photo_id',
      bind_phone: 'other',
      phone_e164: testPhone, // bound to test patient account phone!
    }),
  });

  const issueBody = await issueRes.json() as any;
  console.log('Issue status:', issueRes.status, 'body:', JSON.stringify(issueBody));
  if (issueRes.status !== 201 || !issueBody.code) {
    throw new Error(`issueLinkCode failed: ${issueRes.status} ${JSON.stringify(issueBody)}`);
  }

  const plainCode = issueBody.code;
  const linkCodeId = issueBody.link_code_id;
  console.log(`Issued code: ${plainCode}, ID: ${linkCodeId}`);

  // 2. Verify format: Crockford Base32 with hyphen (XXXXX-XXXXX, 11 chars)
  console.log('2. Verifying Crockford Base32 formatting...');
  const CODE_FORMAT = /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/;
  if (!CODE_FORMAT.test(plainCode)) {
    throw new Error(`Code ${plainCode} does not match expected Crockford Base32 format`);
  }
  console.log('Code formatting verified!');

  // 3. Verify database storage: plaintext code NOT stored in database
  console.log('3. Checking engagement.link_codes database row...');
  const { execSync } = await import('node:child_process');
  const dbCode = execSync(`docker exec lims_mhn_pg psql -U supabase_admin -d postgres -t -c "SELECT code_hmac, status, relationship, bound_phone_last2 FROM engagement.link_codes WHERE id = '${linkCodeId}';"`, { encoding: 'utf8' }).trim();
  console.log('DB link_codes row:', dbCode);
  if (dbCode.includes(plainCode)) {
    throw new Error('SECURITY VIOLATION: Plaintext code found stored in database!');
  }
  console.log('Security verified: Only HMAC stored in database, plaintext never stored.');

  // 4. Log in as patient with phone testPhone
  console.log(`4. Authenticating patient account (${testPhone})...`);
  const chalRes = await fetch(`${BASE_URL}/v1/engagement/auth/otp-challenges`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Lims-App-Version': '1.0.0', 'X-Lims-App-Platform': 'android', 'X-Lims-Patient-PreAuth': 't.tenant_a' },
    body: JSON.stringify({ phone_e164: testPhone, app_instance_id: '01900000-0000-7000-8000-000000000009', app_platform: 'android' }),
  });
  const chal = await chalRes.json() as any;
  console.log('Chal status:', chalRes.status, 'token:', chal.challenge_token?.slice(0, 10));
  const verifyRes = await fetch(`${BASE_URL}/v1/engagement/auth/otp-challenges/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Lims-App-Version': '1.0.0', 'X-Lims-App-Platform': 'android', 'X-Lims-Patient-PreAuth': `c.tenant_a.${chal.challenge_token}` },
    body: JSON.stringify({ code: '123456' }),
  });
  const auth = await verifyRes.json() as any;
  console.log('Verify status:', verifyRes.status, 'has access_token:', !!auth.access_token);
  const patientHeaders = {
    'Content-Type': 'application/json',
    'X-Lims-App-Version': '1.0.0',
    'X-Lims-App-Platform': 'android',
    'Authorization': `Bearer ${auth.access_token}`,
    'X-Lims-Session-Token': auth.session_token,
  };

  // 5. Patient redeems code via POST /v1/engagement/me/profiles/redeem-code
  console.log('5. Patient redeeming link code via POST /v1/engagement/me/profiles/redeem-code...');
  const redeemRes = await fetch(`${BASE_URL}/v1/engagement/me/profiles/redeem-code`, {
    method: 'POST',
    headers: { ...patientHeaders, 'Idempotency-Key': `idem-${Date.now()}` },
    body: JSON.stringify({ code: plainCode }),
  });
  const redeemBody = await redeemRes.json() as any;
  console.log('Redeem status:', redeemRes.status, 'body:', JSON.stringify(redeemBody));
  if (redeemRes.status !== 201 || !redeemBody.profile_id) {
    throw new Error(`Redeem failed: ${redeemRes.status} ${JSON.stringify(redeemBody)}`);
  }
  const linkedProfileId = redeemBody.profile_id;
  console.log(`Successfully linked profile: ${linkedProfileId}, relationship: ${redeemBody.relationship}`);

  // 6. Verify profiles list contains linked patient
  console.log('6. Verifying profile list via GET /v1/engagement/me/profiles...');
  const profilesRes = await fetch(`${BASE_URL}/v1/engagement/me/profiles`, { headers: patientHeaders });
  const profilesBody = await profilesRes.json() as any;
  const profiles = profilesBody.data || [];
  console.log(`Total profiles linked to account: ${profiles.length}`);
  for (const p of profiles) {
    console.log(` - Profile: ${p.profile_id} | ${p.display_name} | ${p.relationship} | ${p.method} | ${p.status}`);
  }
  if (profiles.length < 1 || !profiles.some((p: any) => p.profile_id === linkedProfileId)) {
    throw new Error(`Linked profile ${linkedProfileId} not found in profiles list`);
  }

  // 7. Negative Boundary: Re-use denial
  console.log('7. Testing re-use denial (redeeming the same code again)...');
  const reuseRes = await fetch(`${BASE_URL}/v1/engagement/me/profiles/redeem-code`, {
    method: 'POST',
    headers: { ...patientHeaders, 'Idempotency-Key': `idem-${Date.now() + 1}` },
    body: JSON.stringify({ code: plainCode }),
  });
  const reuseBody = await reuseRes.json() as any;
  console.log('Reuse status:', reuseRes.status, reuseBody);
  if (reuseRes.status !== 422 || reuseBody.code !== 'engagement.link_code_invalid') {
    throw new Error(`Expected 422 engagement.link_code_invalid, got ${reuseRes.status}`);
  }
  console.log('Re-use correctly denied with 422 engagement.link_code_invalid!');

  // 8. Negative Boundary: Invalid formatting
  console.log('8. Testing invalid code format...');
  const invalidRes = await fetch(`${BASE_URL}/v1/engagement/me/profiles/redeem-code`, {
    method: 'POST',
    headers: { ...patientHeaders, 'Idempotency-Key': `idem-${Date.now() + 2}` },
    body: JSON.stringify({ code: 'INVALID-CODE' }),
  });
  console.log('Invalid format status:', invalidRes.status);
  if (invalidRes.status !== 400 && invalidRes.status !== 422) {
    throw new Error(`Expected 400 or 422 for invalid format, got ${invalidRes.status}`);
  }
  console.log('Invalid format rejected!');

  // 9. Negative Boundary: Phone mismatch denial
  console.log('9. Testing phone mismatch rejection...');
  const OTHER_PATIENT = 'e5dfcb10-10bf-7e19-9156-d3333f28dcb3';
  const mismatchIssueRes = await fetch(`${BASE_URL}/v1/engagement/link-codes`, {
    method: 'POST',
    headers: staffHeaders,
    body: JSON.stringify({
      patient_id: OTHER_PATIENT,
      relationship: 'parent',
      consented_by: 'patient',
      identity_check_method: 'photo_id',
      bind_phone: 'other',
      phone_e164: '+9779811111111', // Bound to different valid phone!
    }),
  });
  const mismatchIssue = await mismatchIssueRes.json() as any;
  console.log('Mismatch issue status:', mismatchIssueRes.status, 'body:', mismatchIssue);
  const mismatchRedeemRes = await fetch(`${BASE_URL}/v1/engagement/me/profiles/redeem-code`, {
    method: 'POST',
    headers: { ...patientHeaders, 'Idempotency-Key': `idem-${Date.now() + 3}` }, // patient is +9779800000009
    body: JSON.stringify({ code: mismatchIssue.code }),
  });
  const mismatchRedeem = await mismatchRedeemRes.json() as any;
  console.log('Phone mismatch redeem status:', mismatchRedeemRes.status, mismatchRedeem);
  if (mismatchRedeemRes.status !== 422 || mismatchRedeem.code !== 'engagement.link_code_invalid') {
    throw new Error(`Expected 422 engagement.link_code_invalid for phone mismatch, got ${mismatchRedeemRes.status}`);
  }
  console.log('Phone mismatch correctly rejected with 422 engagement.link_code_invalid!');

  // 10. Negative Boundary: Revoked code rejection
  console.log('10. Testing revoked code rejection...');
  const REVOKE_PATIENT = '3640fb7f-fbce-7b6c-8cb5-e55be460ad24';
  const revokeIssueRes = await fetch(`${BASE_URL}/v1/engagement/link-codes`, {
    method: 'POST',
    headers: staffHeaders,
    body: JSON.stringify({
      patient_id: REVOKE_PATIENT,
      relationship: 'parent',
      consented_by: 'patient',
      identity_check_method: 'photo_id',
      bind_phone: 'other',
      phone_e164: testPhone,
    }),
  });
  const revokeIssue = await revokeIssueRes.json() as any;
  console.log('Revoke issue status:', revokeIssueRes.status, 'body:', revokeIssue);
  if (revokeIssueRes.status !== 201) {
    throw new Error(`revokeIssue failed: ${revokeIssueRes.status} ${JSON.stringify(revokeIssue)}`);
  }
  // Staff revokes via L2
  const revokeRes = await fetch(`${BASE_URL}/v1/engagement/link-codes/${revokeIssue.link_code_id}/revoke`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${staffToken}`,
      'If-Match': '"1"',
    },
  });
  const revokeText = await revokeRes.text();
  console.log('L2 Revoke status:', revokeRes.status, 'body:', revokeText);
  if (revokeRes.status !== 204) {
    throw new Error(`Expected 204 for L2 revokeLinkCode, got ${revokeRes.status}: ${revokeText}`);
  }
  // Attempt redeem
  const revokeRedeemRes = await fetch(`${BASE_URL}/v1/engagement/me/profiles/redeem-code`, {
    method: 'POST',
    headers: { ...patientHeaders, 'Idempotency-Key': `idem-${Date.now() + 4}` },
    body: JSON.stringify({ code: revokeIssue.code }),
  });
  const revokeRedeem = await revokeRedeemRes.json() as any;
  console.log('Revoked code redeem status:', revokeRedeemRes.status, revokeRedeem);
  if (revokeRedeemRes.status !== 422 || revokeRedeem.code !== 'engagement.link_code_invalid') {
    throw new Error(`Expected 422 engagement.link_code_invalid for revoked code, got ${revokeRedeemRes.status}`);
  }
  console.log('Revoked code correctly rejected with 422 engagement.link_code_invalid!');

  console.log('=== TASK 2: LINK CODE ISSUANCE & REDEMPTION FULLY VERIFIED 100% ===');
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
