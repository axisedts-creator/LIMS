// T0B-PARTYSET-1 (LD-321, LD-325 b): the 5 ICD master operations of catalog.yaml (/v1/catalog/icd-master). Logic in service/icd.service.ts.
import type { Handler } from '../../../core/module.js';
import { createIcd, deactivateIcd, listIcd, searchIcd, updateIcd } from '../service/icd.service.js';

export const icdHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  listIcdMasterCodes: (req, ctx) => listIcd(req, ctx),
  searchIcdMasterCodes: (req, ctx) => searchIcd(req, ctx),
  createIcdMasterCode: (req, ctx) => createIcd(req, ctx),
  updateIcdMasterCode: (req, ctx) => updateIcd(req, ctx),
  deactivateIcdMasterCode: (req, ctx) => deactivateIcd(req, ctx),
});
