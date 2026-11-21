// T0D-OFFLINE-4 (LD-322 decision 2 and 3; done_when 2 and 3): verification works offline and enforces the T0B-VERLEVEL-1 policy LOCALLY with the cached policy:
// levels, distinct people, the enterer cannot verify, only a pathologist gives the final signature, the same messages as online; the server checks again at sync.
// MFA step up: disabled offline with the reason unless the tenant allows offline approval AND the signer is a pathologist signed in on this device.
// Fails now because core/offline/labflows.ts does not exist.
import { describe, expect, it } from 'vitest';
import { DEPT, MSG, P_PATH, P_VERIFY, PATH, TEST, U, USER, USER2, createEnv, ops, policy, row, signoff } from './offline4.fixtures';

const R = (n: number, over: Record<string, unknown> = {}) => row(n, over);
const P_ENTER_V = ['sync.use', 'lab.result.enter'];

describe('a valid sign off is queued as one result.verify operation', () => {
  it('level 1 without a pathologist: any verifier may sign once; the op carries the result id, the version the user saw and nothing else', async () => {
    const r = R(1);
    const env = await createEnv({ results: [r], policies: [policy({ required_verifiers: 1, require_pathologist: false })] });
    const lab = env.lab(USER2, P_VERIFY);
    expect(await lab.checkVerify(r.id)).toMatchObject({ allowed: true, final: true });
    const out = await lab.verifyResult({ result_id: r.id });
    expect(out).toMatchObject({ ok: true, final: true });
    const [op] = await env.pendingOps();
    expect(op).toMatchObject({ op_type: 'result.verify', entity_id: r.id, base_version: 3 });
    expect(op!.payload).toEqual({}); // VerifyResultRequest: additionalProperties false
    expect(op!.op_id).toBe(out.op_id);
    await env.drain();
    expect(ops(env, 'result.verify')).toHaveLength(1);
  });

  it('level 2: the first sign off is not final and counts; a different person completes it (distinct people over the shared PC)', async () => {
    const r = R(2);
    const env = await createEnv({ results: [r], policies: [policy({ required_verifiers: 2, require_pathologist: false })] });
    const a = env.lab(USER2, P_VERIFY); const b = env.lab(PATH, P_VERIFY);
    expect(await a.verifyResult({ result_id: r.id })).toMatchObject({ ok: true, final: false });
    expect(await b.signoffState(r.id)).toMatchObject({ required: 2, count: 1, final: false, source: 'device', signers: [USER2] });
    expect(await b.verifyResult({ result_id: r.id })).toMatchObject({ ok: true, final: true });
    expect(await b.signoffState(r.id)).toMatchObject({ count: 2, final: true, source: 'device' });
    expect((await env.pendingOps()).map((o) => o.entity_id)).toEqual([r.id, r.id]);
  });
});

describe('the policy is resolved from the cache: test > department > lab, inactive ignored, none = level 2 + pathologist + enterer excluded', () => {
  it('the most specific active policy wins', async () => {
    const r = R(3);
    const env = await createEnv({ results: [r], policies: [
      policy({ id: U(701), scope: 'lab', required_verifiers: 3 }),
      policy({ id: U(702), scope: 'department', department_id: DEPT, required_verifiers: 2 }),
      policy({ id: U(703), scope: 'test', test_id: TEST, required_verifiers: 1, require_pathologist: false }),
    ] });
    expect(await env.lab(USER2, P_VERIFY).signoffState(r.id)).toMatchObject({ required: 1 });
    const env2 = await createEnv({ results: [r], policies: [
      policy({ id: U(701), scope: 'lab', required_verifiers: 3 }),
      policy({ id: U(702), scope: 'department', department_id: DEPT, required_verifiers: 2 }),
      policy({ id: U(703), scope: 'test', test_id: TEST, required_verifiers: 1, active: false }),
    ] });
    expect(await env2.lab(USER2, P_VERIFY).signoffState(r.id)).toMatchObject({ required: 2 }); // the inactive test policy is skipped
  });

  it('no policy cached at all: level 2, pathologist for the final sign off, the enterer may not sign', async () => {
    const r = R(4, { entered_by_user_id: USER });
    const env = await createEnv({ results: [r], policies: [] });
    const lab = env.lab(USER, P_VERIFY);
    expect(await lab.signoffState(r.id)).toMatchObject({ required: 2 });
    expect(await lab.checkVerify(r.id)).toMatchObject({ allowed: false, code: 'lab.enterer_cannot_verify' });
  });

  it('a level frozen on the result (signoff_required) wins over a policy changed later', async () => {
    const r = R(5, { signoff_required: 3, signoff_count: 1, signoffs: [signoff(USER2)] });
    const env = await createEnv({ results: [r], policies: [policy({ required_verifiers: 1, require_pathologist: false })] });
    expect(await env.lab(PATH, P_VERIFY).signoffState(r.id)).toMatchObject({ required: 3, count: 1, final: false });
  });
});

describe('refusals at once, with the same code and the same words as the online screen; nothing is queued', () => {
  it('the enterer cannot verify (cached entered_by_user_id); allowed when the policy lets the enterer sign', async () => {
    const r = R(6, { entered_by_user_id: USER });
    const env = await createEnv({ results: [r], policies: [policy({ require_pathologist: false })] });
    const out = await env.lab(USER, P_VERIFY).verifyResult({ result_id: r.id });
    expect(out).toEqual({ ok: false, code: 'lab.enterer_cannot_verify', message: MSG.enterer });
    expect(await env.pendingOps()).toHaveLength(0);
    const env2 = await createEnv({ results: [r], policies: [policy({ require_pathologist: false, allow_enterer_verify: true })] });
    expect(await env2.lab(USER, P_VERIFY).verifyResult({ result_id: r.id })).toMatchObject({ ok: true });
  });

  it('a result entered on THIS device by the same person is also refused (the local entry counts as the enterer)', async () => {
    const r = R(7);
    const env = await createEnv({ results: [r], policies: [policy({ require_pathologist: false })] });
    await env.lab(USER, P_ENTER_V).enterResults({ entries: [{ result_id: r.id, version: 3, value_numeric: '5.4' }] });
    expect(await env.lab(USER, P_VERIFY).verifyResult({ result_id: r.id })).toMatchObject({ ok: false, code: 'lab.enterer_cannot_verify', message: MSG.enterer });
    const other = await env.lab(USER2, P_VERIFY).verifyResult({ result_id: r.id });
    expect(other).toMatchObject({ ok: true });
    const verify = (await env.pendingOps()).find((o) => o.op_type === 'result.verify');
    expect(verify!.base_version).toBe(4); // entered here: the server moves 3 -> 4 when result.enter lands, and the ops are applied in order
  });

  it('one person signs one version once: queued here, or already in the server chain', async () => {
    const r = R(8, { signoff_count: 1, signoffs: [signoff(USER2)] });
    const env = await createEnv({ results: [r], policies: [policy({ required_verifiers: 3, require_pathologist: false })] });
    expect(await env.lab(USER2, P_VERIFY).verifyResult({ result_id: r.id })).toEqual({ ok: false, code: 'lab.verifier_not_distinct', message: MSG.distinct });
    expect(await env.lab(USER, P_VERIFY).verifyResult({ result_id: r.id })).toMatchObject({ ok: true, final: false });
    expect(await env.lab(USER, P_VERIFY).verifyResult({ result_id: r.id })).toEqual({ ok: false, code: 'lab.verifier_not_distinct', message: MSG.distinct });
    expect(await env.pendingOps()).toHaveLength(1);
  });

  it('sign offs of an older result version do not count and do not block', async () => {
    const r = R(9, { current_version_no: 2, signoff_count: 0, signoffs: [signoff(USER2, { result_version: 1 })] });
    const env = await createEnv({ results: [r], policies: [policy({ require_pathologist: false })] });
    expect(await env.lab(USER2, P_VERIFY).verifyResult({ result_id: r.id })).toMatchObject({ ok: true, final: false });
  });

  it('the final sign off of a policy with require_pathologist, by a person who is not a pathologist: lab.pathologist_required', async () => {
    const r = R(10, { signoff_count: 1, signoffs: [signoff(USER2)] });
    const env = await createEnv({ results: [r] });
    expect(await env.lab(USER, P_VERIFY).verifyResult({ result_id: r.id })).toEqual({ ok: false, code: 'lab.pathologist_required', message: MSG.pathologist });
    // also when the tenant would allow offline approval: that exception is for a pathologist only
    expect(await env.lab(USER, P_VERIFY, { offlineApproval: () => true }).checkVerify(r.id)).toMatchObject({ allowed: false, code: 'lab.pathologist_required' });
    expect(await env.pendingOps()).toHaveLength(0);
  });

  it('a result that already has all its sign offs, or is approved: lab.result_invalid_transition', async () => {
    const full = R(11, { signoff_count: 2, signoffs: [signoff(USER2), signoff(PATH, { seq: 2, signer_is_pathologist: true })] });
    const done = R(12, { status: 'approved', signoff_count: 2, signoffs: [signoff(USER2), signoff(PATH, { seq: 2 })] });
    const env = await createEnv({ results: [full, done] });
    for (const r of [full, done]) expect(await env.lab(USER, P_VERIFY).verifyResult({ result_id: r.id })).toEqual({ ok: false, code: 'lab.result_invalid_transition', message: MSG.transition });
    expect(await env.pendingOps()).toHaveLength(0);
  });

  it('a flagged result needs its flags acknowledged (lab.flag_ack_required); the acknowledged flags travel in the payload', async () => {
    const r = R(13, { critical: { is_critical: true }, delta: { status: 'fail' } });
    const env = await createEnv({ results: [r], policies: [policy({ required_verifiers: 1, require_pathologist: false })] });
    const lab = env.lab(USER2, P_VERIFY);
    expect(await lab.verifyResult({ result_id: r.id })).toEqual({ ok: false, code: 'lab.flag_ack_required', message: MSG.flags });
    expect(await lab.verifyResult({ result_id: r.id, acknowledged_flags: ['critical'] })).toMatchObject({ ok: false, code: 'lab.flag_ack_required' });
    expect(await lab.verifyResult({ result_id: r.id, acknowledged_flags: ['critical', 'delta'] })).toMatchObject({ ok: true });
    expect((await env.pendingOps())[0]!.payload).toEqual({ acknowledged_flags: ['critical', 'delta'] });
  });

  it('permission and input: no lab.result.verify = auth.forbidden; an unknown result = common.not_found; a locked store = offline.locked', async () => {
    const r = R(14);
    const env = await createEnv({ results: [r], policies: [policy({ require_pathologist: false })] });
    await expect(env.lab(USER2, ['sync.use']).verifyResult({ result_id: r.id })).rejects.toMatchObject({ code: 'auth.forbidden' });
    await expect(env.lab(USER2, P_VERIFY).verifyResult({ result_id: U(9999) })).rejects.toMatchObject({ code: 'common.not_found' });
    await expect(env.lab(USER2, P_VERIFY).verifyResult({ result_id: '' })).rejects.toMatchObject({ code: 'common.validation_failed' });
    await expect(env.lab(USER2, P_VERIFY).verifyResult({ result_id: r.id, acknowledged_flags: ['made_up'] })).rejects.toMatchObject({ code: 'common.validation_failed' });
    env.store.lock();
    await expect(env.lab(USER2, P_VERIFY).verifyResult({ result_id: r.id })).rejects.toMatchObject({ code: 'offline.locked' });
  });
});

describe('the final pathologist sign off needs MFA step up: disabled offline with the reason, unless the tenant allows it (done_when 3)', () => {
  const base = () => R(20, { signoff_count: 1, signoffs: [signoff(USER2)] });

  it('default (tenant policy off): a pathologist is told it needs an internet connection; code sync.offline_not_allowed; nothing queued', async () => {
    const r = base(); const env = await createEnv({ results: [r] });
    const lab = env.lab(PATH, P_PATH);
    const c = await lab.checkVerify(r.id);
    expect(c).toMatchObject({ allowed: false, code: 'sync.offline_not_allowed' });
    expect(c.message).toMatch(/online|internet|connection/i);
    expect(c.message).not.toMatch(/sync\.offline_not_allowed/); // words, not codes
    expect(await lab.verifyResult({ result_id: r.id })).toMatchObject({ ok: false, code: 'sync.offline_not_allowed' });
    expect(await env.pendingOps()).toHaveLength(0);
  });

  it('tenant policy allows offline approval and the signer is a pathologist signed in on this device: queued as result.verify', async () => {
    const r = base(); const env = await createEnv({ results: [r] });
    const lab = env.lab(PATH, P_PATH, { offlineApproval: () => true });
    expect(await lab.checkVerify(r.id)).toMatchObject({ allowed: true, final: true });
    expect(await lab.verifyResult({ result_id: r.id })).toMatchObject({ ok: true, final: true });
    expect(await env.pendingOps()).toMatchObject([{ op_type: 'result.verify', entity_id: r.id, base_version: 3 }]);
  });

  it('an async tenant setting is awaited; a setting that throws fails closed (not allowed)', async () => {
    const r = base(); const env = await createEnv({ results: [r] });
    expect(await env.lab(PATH, P_PATH, { offlineApproval: async () => true }).checkVerify(r.id)).toMatchObject({ allowed: true });
    expect(await env.lab(PATH, P_PATH, { offlineApproval: () => { throw new Error('boom'); } }).checkVerify(r.id)).toMatchObject({ allowed: false, code: 'sync.offline_not_allowed' });
  });

  it('a pathologist who is NOT the final signer (a middle sign off, or a policy without require_pathologist) needs no step up', async () => {
    const mid = R(21); // level 2, nobody signed yet: this is sign off 1 of 2
    const env = await createEnv({ results: [mid] });
    expect(await env.lab(PATH, P_PATH).checkVerify(mid.id)).toMatchObject({ allowed: true, final: false });
    const free = R(22, { signoff_count: 1, signoffs: [signoff(USER2)] });
    const env2 = await createEnv({ results: [free], policies: [policy({ require_pathologist: false })] });
    expect(await env2.lab(PATH, P_PATH).checkVerify(free.id)).toMatchObject({ allowed: true, final: true });
  });
});
