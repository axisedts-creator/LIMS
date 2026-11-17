// The fake must pass the same contract suite (plan T1). Required fake API (beyond GoTrueGateway):
//   createFakeGoTrueGateway(): GoTrueGateway & {
//     mailbox: { latestTokenHash(email, type): string | undefined };   // hash of the newest invite/recovery mail
//     advanceTime(seconds: number): void;                             // drives link TTL (3600 s) and the refresh reuse interval (<= 10 s)
//     calls: ReadonlyArray<{ method: string }>;                        // every gateway call, for "GoTrue never called" assertions (AU-T2, AU-T4)
//     passwordHash(userId): string | undefined }                       // '$2a$10$…'
// Access tokens are unsigned JWT-shaped strings with claims sub, session_id, aal, role=authenticated, aud, iat, exp.
import { describe, it, expect } from 'vitest';
import { createFakeGoTrueGateway } from '../gateway.fake.js';
import { describeGatewayContract, type Harness } from './contract.suite.js';
import { goodPassword, uniqueEmail } from './helpers.js';

function makeHarness(): Harness {
  const fake = createFakeGoTrueGateway();
  return {
    gateway: fake,
    latestTokenHash: async (email, type) => fake.mailbox.latestTokenHash(email, type),
    ageEmailTokens: async (s) => fake.advanceTime(s),
    passReuseInterval: async () => fake.advanceTime(11),
    passwordHash: async (id) => fake.passwordHash(id),
  };
}
describeGatewayContract('fake', makeHarness);

describe('fake: call instrumentation', () => {
  it('records each gateway call by method name; reading state is not a call', async () => {
    const fake = createFakeGoTrueGateway();
    expect(fake.calls).toHaveLength(0);
    await fake.signInWithPassword(uniqueEmail('x'), goodPassword());
    await fake.adminFindUserByEmail(uniqueEmail('y'));
    expect(fake.calls.map((c) => c.method)).toEqual(['signInWithPassword', 'adminFindUserByEmail']);
  });
  it('two fakes do not share state', async () => {
    const a = createFakeGoTrueGateway(); const b = createFakeGoTrueGateway();
    const email = uniqueEmail('iso');
    await a.adminCreateUser({ email, emailConfirm: true });
    expect(await b.adminFindUserByEmail(email)).toBeNull();
  });
});
