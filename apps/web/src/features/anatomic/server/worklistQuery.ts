// Worklist URL → API query (04-UI-UX §4.1, AC-13.1). Only whitelisted, well-formed values survive; everything else is dropped so
// nothing user-controlled reaches the API (REQ-SEC-026/027). Centre scoping is the server's job (AC-13.2): `centre_id` only narrows.
import { QUEUES, UUID_RE, type Queue } from './types';

type Raw = Record<string, string | string[] | undefined>;
export interface WorklistQuery { queue: Queue; params: Record<string, string> }

const KINDS = /^(histology|cytology|ihc|molecular)(,(histology|cytology|ihc|molecular))*$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const SORTS = ['received_at', '-received_at', 'accessioned_at', '-accessioned_at', 'priority_received_at'];
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;

const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);
const iso = (v: string | undefined) => (v && ISO_UTC.test(v) && !Number.isNaN(Date.parse(v)) ? v : undefined);

export function parseWorklistQuery(sp: Raw): WorklistQuery {
  const q = one(sp['queue']);
  const queue = (QUEUES as readonly string[]).includes(q ?? '') ? (q as Queue) : 'to_accession';
  const centres = one(sp['centre_id']);
  const centreOk = centres !== undefined && centres.split(',').length <= 20 && centres.split(',').every((c) => UUID_RE.test(c));
  const who = one(sp['assigned_pathologist']);
  const priority = one(sp['priority']);
  const sort = one(sp['sort']);
  const cursor = one(sp['cursor']);
  const kinds = one(sp['case_kind']);
  const candidates: Record<string, string | undefined> = {
    case_kind: kinds && KINDS.test(kinds) ? kinds : undefined,
    centre_id: centreOk ? centres : undefined,
    priority: priority === 'routine' || priority === 'urgent' ? priority : undefined,
    assigned_pathologist: who === 'me' || (who !== undefined && UUID_RE.test(who)) ? who : undefined,
    received_at_from: iso(one(sp['received_at_from'])),
    received_at_to: iso(one(sp['received_at_to'])),
    sort: sort !== undefined && SORTS.includes(sort) ? sort : undefined,
    cursor: cursor !== undefined && CURSOR.test(cursor) ? cursor : undefined,
  };
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(candidates)) if (v !== undefined) params[k] = v;
  return { queue, params };
}
