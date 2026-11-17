import 'server-only';
// Field specs per master (04-UI-UX §4 SCR-02…05). `code` is create-only: the PATCH specs have no `code` key, so it is never sent.
import { VALUE_CODE_RE, VALUE_SET_CODE_RE, UNIT_CODE_RE } from './types';
import { bool, exactCode, int, list, pick, str, upperCode, uuid, type V } from './shared';

const dept = { name: str(1, 100), report_order: int(0, 9999), report_heading: str(0, 100), is_active: bool };
export const DEPARTMENT = { create: { code: upperCode(), ...dept }, required: ['code', 'name', 'report_order'], patch: dept } as const;

const spec = { name: str(1, 100), report_label: str(1, 100), is_active: bool };
export const SPECIMEN_TYPE = { create: { code: upperCode(), ...spec }, required: ['code', 'name', 'report_label'], patch: spec } as const;

const cont = { name: str(1, 100), additive: str(0, 60), cap_colour_display: str(0, 40), default_specimen_type_id: uuid, is_active: bool };
export const CONTAINER = { create: { code: upperCode(), ...cont }, required: ['code', 'name'], patch: cont } as const;

const meth = { name: str(1, 120), is_active: bool };
export const METHOD = { create: { code: upperCode(), ...meth }, required: ['code', 'name'], patch: meth } as const;

export const UNIT = { create: { code: exactCode(UNIT_CODE_RE), display: str(1, 32) }, required: ['code', 'display'], patch: { display: str(1, 32), is_active: bool } } as const;

const value: Record<string, V> = { code: upperCode(VALUE_CODE_RE), display: str(1, 40), sort_order: int(0, 9999), is_active: bool };
const values = list(50, (v) => pick(v, value, ['code', 'display']));
const vs = { display: str(1, 100), is_ordered: bool, values };
export const VALUE_SET = { create: { code: upperCode(VALUE_SET_CODE_RE), ...vs }, required: ['code', 'display', 'is_ordered'], patch: { ...vs, is_active: bool } } as const;
