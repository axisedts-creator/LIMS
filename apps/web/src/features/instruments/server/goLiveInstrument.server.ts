import 'server-only';
// E28 goLiveInstrument (POST …/{instrument_id}/go-live, If-Match): commissioning → live. All four checklist items must be true
// and the evidence note 10–2000 characters; the API additionally requires a verified driver (B2) and aal2 (auth.mfa_required).
import { isObj } from '../forms/transport';
import { badRequest, postTransition } from './shared.server';
import { GO_LIVE_CHECKLIST_KEYS, type GoLiveChecklist, type Instrument } from './types';

export async function goLiveInstrument(instrumentId: string, version: number, input: { checklist: GoLiveChecklist; evidence_note: string }): Promise<Instrument> {
  const c = input?.checklist;
  const note = typeof input?.evidence_note === 'string' ? input.evidence_note.trim() : '';
  const complete = isObj(c) && Object.keys(c).length === GO_LIVE_CHECKLIST_KEYS.length && GO_LIVE_CHECKLIST_KEYS.every((k) => c[k] === true);
  if (!complete || note.length < 10 || note.length > 2000) throw badRequest();
  const checklist = Object.fromEntries(GO_LIVE_CHECKLIST_KEYS.map((k) => [k, true]));
  return postTransition(instrumentId, version, 'go-live', { checklist, evidence_note: note });
}
