// #26 getSmartCodedSet (summary_reject_reasons, smartreport.summary.read) and #35 getSmartLibraryCodedSet (organ_groups, smartreport.template.manage).
// 08 A19 P-43: one permission floor per operation, so each operation serves ONLY its own set; any other set_code is common.not_found with no read.
import { LimsError } from '../../../core/errors.js';
import type { Handler } from '../../../core/module.js';
import { listOrganGroups, listRejectReasons } from '../repository/codedSets.repo.js';
import type { Row } from '../repository/common.repo.js';
import { authorise, isObj, type SrCtx } from './shared.js';

const codedSet = (permission: string, setCode: string, read: typeof listOrganGroups): Handler => async (req, ctx) => {
  const rc = await authorise(ctx as SrCtx, permission);
  const p = isObj(req.params) ? req.params.set_code : undefined;
  if (p !== setCode) throw new LimsError('common.not_found');
  const items = (await read(rc)).map((r: Row) => ({ code: r.code, display: r.display, sort_order: r.sort_order, is_active: r.is_active }));
  return { status: 200, body: { set_code: setCode, items } };
};

export const getSmartCodedSet = codedSet('smartreport.summary.read', 'summary_reject_reasons', listRejectReasons);
export const getSmartLibraryCodedSet = codedSet('smartreport.template.manage', 'organ_groups', listOrganGroups);
