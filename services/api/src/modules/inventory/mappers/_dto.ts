// Shared mapper helpers (02-TRD §3.1 mappers/, §6.3; 07-SECURITY REQ-SEC-081, PE-3). Mappers are pure: (row, permissions) => Dto.
// Each mapper lists the DTO's keys explicitly (allowlist, so DB columns like tenant_id / basis_key never leak) and drops the cost keys
// unless `permissions` holds exactly inventory.cost.read. Missing permissions => no cost (fails closed).
import { LimsError } from '../../../core/errors.js';

export type Row = Record<string, any>;
export const COST_READ = 'inventory.cost.read';

export const isCostKey = (k: string): boolean => k.endsWith('_paisa') || k.endsWith('_paisa_x1e6') || k === 'value_basis';
export const canReadCost = (permissions: readonly string[] | undefined): boolean => Array.isArray(permissions) && permissions.includes(COST_READ);

/** Copy only `keys` that the row carries; cost keys are skipped unless `cost`. */
export function pick(row: Row, keys: readonly string[], cost: boolean): Row {
  const out: Row = {};
  for (const k of keys) if (row[k] !== undefined && (cost || !isCostKey(k))) out[k] = row[k];
  return out;
}

/** Live lines only (02-TRD §6.2: soft-removed lines are never returned). */
export const live = (lines: readonly Row[] | undefined): Row[] => (lines ?? []).filter((l) => l.removed_at == null);

/** D-70: an exempt line carries no tax_code at all (not null). */
export function taxLine(l: Row, keys: readonly string[], cost: boolean): Row {
  const o = pick(l, keys, cost);
  if (l.is_exempt === true) delete o['tax_code'];
  return o;
}

export const forbidden = (): never => { throw new LimsError('auth.forbidden'); };
