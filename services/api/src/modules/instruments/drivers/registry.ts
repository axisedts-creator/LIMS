// Driver registry — 02-TRD §6.1. Code status/capabilities must equal instruments.g_drivers (CI: __tests__/ci/driver-registry-check.ts).
import { LimsError } from '../../../core/errors.js';
import { astmGenericE1394 } from './astm_generic_e1394/index.js';
import { fileDropGeneric } from './file_drop_generic/index.js';
import { hl7v2GenericOru } from './hl7v2_generic_oru/index.js';
import { mindrayBc5380Sketch, mindrayBs200Sketch } from './mindray_sketches.js';
import { geteinMetis } from './getein_metis/index.js';
import { truthH80e } from './truth_h80e/index.js';
import type { DriverStatus, InstrumentDriver } from './types.js';

const DRIVERS: readonly InstrumentDriver[] = Object.freeze([astmGenericE1394, hl7v2GenericOru, fileDropGeneric, mindrayBc5380Sketch, mindrayBs200Sketch, truthH80e, geteinMetis]);
const BY_CODE = new Map(DRIVERS.map((d) => [d.code, d]));

export const listDrivers = (): readonly InstrumentDriver[] => DRIVERS;
export const getDriver = (code: string): InstrumentDriver | undefined => BY_CODE.get(code);

export type DriverPurpose = 'create' | 'commissioning' | 'live';

/**
 * AC-04.2 / AC-21.3: only `verified` goes live; `generic` is shadow/commissioning only; `sketch_blocked` is never live and is
 * selectable at all only when LIMS_INSTRUMENTS_ALLOW_SKETCH_DRIVERS is on and NODE_ENV is not production. Unknown values fail closed.
 */
export function assertDriverSelectable(
  driver: { readonly status: DriverStatus },
  opts: { readonly allowSketchDrivers: boolean; readonly nodeEnv?: string; readonly purpose: DriverPurpose },
): void {
  const { purpose } = opts;
  const known = purpose === 'create' || purpose === 'commissioning' || purpose === 'live';
  const ok = known && (
    driver.status === 'verified'
    || (driver.status === 'generic' && purpose !== 'live')
    || (driver.status === 'sketch_blocked' && purpose !== 'live' && opts.allowSketchDrivers === true && opts.nodeEnv !== 'production'));
  if (!ok) throw new LimsError('instruments.driver_not_available');
}
