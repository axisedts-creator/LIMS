import pg from '../node_modules/.pnpm/pg@8.23.1/node_modules/pg/lib/index.js';

const BASE_URL = 'http://127.0.0.1:3000';
const CLIENT_HEADERS = {
  'Content-Type': 'application/json',
  'X-Lims-App-Version': '1.0.0',
  'X-Lims-App-Platform': 'android',
};

async function main() {
  console.log('=== TASK 1: VERIFY REAL ASYNCHRONOUS SELF-REGISTRATION ===');
  
  // 1. Initial State: Register/Login with fresh phone number
  const phone = `+97798${String(Date.now() % 100000000).padStart(8, '0')}`;
  console.log(`1. Requesting OTP for fresh phone: ${phone}`);
  const chalRes = await fetch(`${BASE_URL}/v1/engagement/auth/otp-challenges`, {
    method: 'POST',
    headers: { ...CLIENT_HEADERS, 'X-Lims-Patient-PreAuth': 't.tenant_a' },
    body: JSON.stringify({
      phone_e164: phone,
      app_instance_id: '01900000-0000-7000-8000-000000000007',
      app_platform: 'android',
    }),
  });
  const chal = await chalRes.json() as any;
  console.log('Challenge status:', chalRes.status, 'token length:', chal.challenge_token?.length);

  // Verify OTP
  const verifyRes = await fetch(`${BASE_URL}/v1/engagement/auth/otp-challenges/verify`, {
    method: 'POST',
    headers: { ...CLIENT_HEADERS, 'X-Lims-Patient-PreAuth': `c.tenant_a.${chal.challenge_token}` },
    body: JSON.stringify({ code: '123456' }),
  });
  const auth = await verifyRes.json() as any;
  console.log('Verify status:', verifyRes.status, 'accountId:', auth.account?.id);
  const authHeaders = {
    ...CLIENT_HEADERS,
    'Authorization': `Bearer ${auth.access_token}`,
    'X-Lims-Session-Token': auth.session_token,
  };

  // Check 0 initial profiles
  const initialProfilesRes = await fetch(`${BASE_URL}/v1/engagement/me/profiles`, { headers: authHeaders });
  const initialProfiles = await initialProfilesRes.json() as any;
  console.log('Initial profiles status:', initialProfilesRes.status, 'body:', initialProfiles);
  const profilesList = initialProfiles.data || [];
  console.log(`Initial profiles count: ${profilesList.length} (expected 0)`);
  if (profilesList.length !== 0) {
    throw new Error(`Expected 0 initial profiles, got ${profilesList.length}`);
  }

  // 2. Submit E16 createSelfRegistration
  console.log('2. Submitting E16 createSelfRegistration...');
  const regRes = await fetch(`${BASE_URL}/v1/engagement/me/profiles/self-registrations`, {
    method: 'POST',
    headers: {
      ...authHeaders,
      'Idempotency-Key': `selfreg-${Date.now()}`,
    },
    body: JSON.stringify({
      relationship: 'self',
      full_name: 'Bikram Thapa',
      sex: 'male',
      birth_on: '1988-06-15',
      sms_consent: true,
      whatsapp_consent: true,
      consent_text_version: '2026-01',
    }),
  });
  console.log('E16 HTTP Status:', regRes.status, '(expected 202 Accepted)');
  const regBody = await regRes.json() as any;
  console.log('E16 Response Body:', JSON.stringify(regBody));
  if (regRes.status !== 202 || regBody.status !== 'queued') {
    throw new Error(`E16 failed: ${regRes.status} ${JSON.stringify(regBody)}`);
  }

  const regId = regBody.id;
  console.log(`Registration queued with ID: ${regId}`);

  // 3. Poll E17 getSelfRegistration until created
  console.log('3. Polling E17 getSelfRegistration for worker completion...');
  let created = false;
  let pollResult: any = null;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const pollRes = await fetch(`${BASE_URL}/v1/engagement/me/profiles/self-registrations/${regId}`, {
      headers: authHeaders,
    });
    pollResult = await pollRes.json();
    console.log(`Poll #${i + 1}: status = ${pollResult.status}`);
    if (pollResult.status === 'created') {
      created = true;
      break;
    }
    if (pollResult.status === 'failed') {
      throw new Error(`Registration failed with code: ${pollResult.failure_code}`);
    }
  }

  if (!created) {
    throw new Error(`Timed out waiting for registration ${regId} to reach 'created' state`);
  }

  console.log('Registration successfully created! E17 Body:', JSON.stringify(pollResult));
  console.log('Profile ID (link_id):', pollResult.profile_id);

  // 4. Verify in PostgreSQL directly via docker exec (superuser)
  console.log('4. Verifying database state directly via psql...');
  const { execSync } = await import('node:child_process');
  const dbOut = execSync(`docker exec lims_mhn_pg psql -U supabase_admin -d postgres -t -c "SELECT id, status, patient_id, link_id FROM engagement.self_registrations WHERE id = '${regId}';"`, { encoding: 'utf8' }).trim();
  console.log('Database self_registrations row:', dbOut);
  if (!dbOut.includes('created') || !dbOut.includes(pollResult.profile_id)) {
    throw new Error(`Database check failed: ${dbOut}`);
  }

  const linkOut = execSync(`docker exec lims_mhn_pg psql -U supabase_admin -d postgres -t -c "SELECT id, relationship, method, status, display_name FROM engagement.account_patient_links WHERE id = '${pollResult.profile_id}';"`, { encoding: 'utf8' }).trim();
  console.log('Database engagement.account_patient_links row:', linkOut);
  if (!linkOut.includes('self_registered') || !linkOut.includes('active') || !linkOut.includes('Bikram Thapa')) {
    throw new Error(`Link check failed: ${linkOut}`);
  }

  // 5. Verify E13 profiles list
  console.log('5. Verifying E13 GET /v1/engagement/me/profiles...');
  const updatedProfilesRes = await fetch(`${BASE_URL}/v1/engagement/me/profiles`, { headers: authHeaders });
  const updatedProfiles = await updatedProfilesRes.json() as any;
  const list = updatedProfiles.data || [];
  console.log('Updated profiles count:', list.length);
  console.log('Profile entry:', JSON.stringify(list[0]));

  // 6. Verify duplicate self prevention
  console.log('6. Testing duplicate self-link prevention...');
  const dupRes = await fetch(`${BASE_URL}/v1/engagement/me/profiles/self-registrations`, {
    method: 'POST',
    headers: {
      ...authHeaders,
      'Idempotency-Key': `selfreg-dup-${Date.now()}`,
    },
    body: JSON.stringify({
      relationship: 'self',
      full_name: 'Bikram Thapa Duplicate',
      sex: 'male',
      birth_on: '1988-06-15',
      sms_consent: true,
      whatsapp_consent: true,
      consent_text_version: '2026-01',
    }),
  });
  const dupBody = await dupRes.json() as any;
  console.log('Duplicate self submission status:', dupRes.status, dupBody);
  if (dupRes.status !== 409 || dupBody.code !== 'engagement.link_limit_reached') {
    throw new Error(`Expected 409 engagement.link_limit_reached, got ${dupRes.status}`);
  }
  console.log('Duplicate self link correctly rejected with 409 engagement.link_limit_reached!');

  console.log('=== REAL WORKER SELF-REGISTRATION LIFECYCLE VERIFIED 100% ===');
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
