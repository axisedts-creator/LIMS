// hl7v2_generic_oru — ORU^R01 per HL7 v2 (04 N9), 02-TRD §6.2. Defaults are UNVERIFIED per vendor. No host query.
import { OPTIONS_SCHEMA, isDelim, parseDelimited, type Profile, type Ref } from '../delimited.js';
import type { InstrumentDriver } from '../types.js';

const ref = (seg: string, field: number, comp: number): Ref => ({ seg, field, comp });

export const HL7: Profile = {
  header: 'MSH',
  emit: 'OBX',
  resets: { PID: ['PV1', 'ORC', 'OBR', 'SPM', 'OBX'], OBR: ['SPM', 'OBX'] },
  // MSH|^~\&  -> field '|', component '^', repeat '~' (escape/subcomponent unused)
  delims: (h) => {
    const field = h[3];
    if (!isDelim(field)) return undefined;
    const end = h.indexOf(field, 4);
    const enc = h.slice(4, end === -1 ? undefined : end);
    if (enc.length < 2 || enc.length > 5 || ![...enc].every(isDelim) || new Set([field, ...enc]).size !== enc.length + 1) return undefined;
    return { field, component: enc[0]!, repeat: enc[1]! };
  },
  index: (seg, n) => (seg === 'MSH' ? n - 1 : n), // MSH-1 is the field separator itself
  kind: (get) => {
    // message code = leading 3 letters of MSH-9.1 (tolerates senders that keep '^' while declaring another component char)
    const type = /^[A-Z]{3}/.exec(get(ref('MSH', 9, 1)) ?? '')?.[0];
    return type === 'ORU' ? 'results' : type === 'ORM' || type === 'QRY' ? 'host_query' : 'other';
  },
  defaults: {
    sample: [ref('OBR', 3, 1), ref('OBR', 2, 1), ref('SPM', 2, 1)],
    testCode: ref('OBX', 3, 1),
    value: ref('OBX', 5, 0),
    unit: ref('OBX', 6, 1),
    flags: ref('OBX', 8, 0),
    status: ref('OBX', 11, 1),
    time: [ref('OBX', 14, 1), ref('OBR', 7, 1), ref('MSH', 7, 1)],
    messageTime: ref('MSH', 7, 1),
    messageControlId: ref('MSH', 10, 1),
  },
};

export const hl7v2GenericOru: InstrumentDriver = Object.freeze<InstrumentDriver>({
  code: 'hl7v2_generic_oru',
  version: '0.1.0',
  protocol: 'hl7v2',
  status: 'generic',
  capabilities: Object.freeze({ resultUpload: true, hostQuery: false, worklistDownload: false, qc: true, attachments: false, calibration: false }),
  optionsSchema: OPTIONS_SCHEMA,
  parse: (raw, ctx) => parseDelimited(HL7, raw, ctx),
});
