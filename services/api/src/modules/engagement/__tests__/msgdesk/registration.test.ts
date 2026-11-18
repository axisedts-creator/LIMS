// T0B-MSGDESK-1 done_when (1) FIRST PRIORITY: every new operation of T0C-MSGDESK-1 has a real handler, so the module boot check passes with NO pending ids (LD-325(b)).
// Static: no database. Fails now because engagement lists the 11 broadcast ids as pending and partners serves the 10 ticket ids with the T01 stub.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSpec, REPO_ROOT } from '../../../../core/module.js';
import { manifest as engagement } from '../../index.js';
import { manifest as partners } from '../../../partners/index.js';

const BROADCAST_OPS = ['listBroadcastTemplates', 'createBroadcastTemplate', 'updateBroadcastTemplate', 'deactivateBroadcastTemplate', 'createBroadcast', 'previewBroadcastAudience',
  'requestBroadcastApproval', 'approveBroadcast', 'cancelBroadcast', 'listBroadcasts', 'listBroadcastRecipients'];
const TICKET_OPS = ['createPartnerTicket', 'listPartnerTickets', 'getPartnerTicket', 'replyPartnerTicket', 'closePartnerTicket', 'reopenPartnerTicket',
  'listMyPartnerTickets', 'createMyPartnerTicket', 'getMyPartnerTicket', 'replyMyPartnerTicket'];
const pendingOf = (m: unknown): string[] => [...(((m as { pendingOperations?: readonly string[] }).pendingOperations) ?? [])];
const idsOf = (file: string): string[] => Object.values<any>(loadSpec(join(REPO_ROOT, file)).paths).flatMap((p) => Object.values<any>(p).map((m) => m?.operationId).filter(Boolean));

describe('T0B-MSGDESK-1 (1): handlers registered for every MSGDESK operation', () => {
  it('the 21 operations are in the specs', () => {
    expect(idsOf('contracts/openapi/engagement.yaml')).toEqual(expect.arrayContaining(BROADCAST_OPS));
    expect(idsOf('contracts/openapi/partners.yaml')).toEqual(expect.arrayContaining(TICKET_OPS));
  });
  it.each(BROADCAST_OPS)('engagement has a handler for %s and it is not pending', (id) => {
    expect(typeof (engagement.handlers as Record<string, unknown>)[id], `${id} handler`).toBe('function');
    expect(pendingOf(engagement), `${id} still pending`).not.toContain(id);
  });
  it('engagement pendingOperations is empty (LD-325(b): the handler task removes the ids it implements)', () => {
    expect(pendingOf(engagement)).toEqual([]);
  });
  it.each(TICKET_OPS)('partners has a REAL handler for %s (not the T01 stub)', (id) => {
    const h = (partners.handlers as Record<string, (...a: any[]) => unknown>)[id];
    expect(typeof h, `${id} handler`).toBe('function');
    expect(String(h), `${id} is still the T01 stub`).not.toContain('not implemented');
    expect(pendingOf(partners)).not.toContain(id);
  });
  it('no handler key outside the spec and every spec operation is handled (boot check, AC-0D-1.2)', () => {
    for (const [m, file] of [[engagement, 'contracts/openapi/engagement.yaml'], [partners, 'contracts/openapi/partners.yaml']] as const) {
      const spec = idsOf(file); const have = Object.keys(m.handlers);
      expect(have.filter((i) => !spec.includes(i))).toEqual([]);
      expect(spec.filter((i) => !have.includes(i) && !pendingOf(m).includes(i))).toEqual([]);
    }
  });
});
