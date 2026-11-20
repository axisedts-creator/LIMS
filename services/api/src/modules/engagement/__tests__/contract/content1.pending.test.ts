// T0C-CONTENT-1 (LD-313, LD-325(b)) — the 9 portal content operations must not break module boot:
// every operationId of engagement.yaml has a handler OR is listed in the manifest's pendingOperations (core/module.ts checkHandlers, AC-0D-1.2 with BOOTGATE-1);
// every pending id is a real operationId. The T0B-CONTENT-1 handler task moves the ids from pending to handlers; this test stays green on both sides of that move.
// Operation names are pinned in tools/codegen/__tests__/content1-openapi.test.ts (header); a different choice needs a ruling, not a silent test edit.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSpec, REPO_ROOT } from '../../../../core/module.js';
import { manifest } from '../../index.js';

const NEW_OPS = ['listPortalContent', 'createPortalContent', 'updatePortalContent', 'deactivatePortalContent', 'reorderPortalContent', 'listMyPortalContent', 'listProfileImages', 'setProfileImage', 'clearProfileImage'];
const MSGDESK_OPS = ['listBroadcastTemplates', 'createBroadcastTemplate', 'updateBroadcastTemplate', 'deactivateBroadcastTemplate', 'createBroadcast', 'previewBroadcastAudience',
  'requestBroadcastApproval', 'approveBroadcast', 'cancelBroadcast', 'listBroadcasts', 'listBroadcastRecipients'];
const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/engagement.yaml'));
const specIds: string[] = Object.values<any>(spec.paths).flatMap((p) => Object.values<any>(p).map((m) => m?.operationId).filter(Boolean));
const handlerIds = Object.keys(manifest.handlers);
const pending: string[] = [...(((manifest as { pendingOperations?: readonly string[] }).pendingOperations) ?? [])];

describe('T0C-CONTENT-1: engagement manifest covers the portal content operations (handler or pending)', () => {
  it('the 9 new operations are in the spec', () => {
    for (const id of NEW_OPS) expect(specIds, id).toContain(id);
  });
  it('every spec operation has a handler or is listed pending (boot check would pass)', () => {
    const uncovered = specIds.filter((id) => !handlerIds.includes(id) && !pending.includes(id));
    expect(uncovered, `no handler and not pending: ${uncovered.join(', ')}`).toEqual([]);
  });
  it('every pending id is a spec operationId and appears once; only the MSGDESK and CONTENT operations may be pending', () => {
    expect(pending.filter((id) => !specIds.includes(id))).toEqual([]);
    expect(new Set(pending).size).toBe(pending.length);
    expect(pending.filter((id) => !NEW_OPS.includes(id) && !MSGDESK_OPS.includes(id)), 'only T0C-MSGDESK-1 and T0C-CONTENT-1 operations may be pending in engagement').toEqual([]);
  });
  it('a handler key that is not a spec operation does not exist (nothing was invented)', () => {
    expect(handlerIds.filter((id) => !specIds.includes(id))).toEqual([]);
  });
  it('each new id is handled or pending (LD-325(b): the contract task adds them to pendingOperations)', () => {
    for (const id of NEW_OPS) expect(handlerIds.includes(id) || pending.includes(id), `${id} neither handled nor pending`).toBe(true);
  });
});
