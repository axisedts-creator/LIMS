// A4–A7, A12 (02-TRD §5.1). Thin: the service does load -> assertRole -> validate -> write.
import type { Handler } from '../../../core/module.js';
import { accessionCase, addPart, listAssignees, updateCaseDetails, updateCasePart } from '../service/case.service.js';
import { getCaseDetail, listCases, lookupObject } from '../service/case.read.service.js';

// A1–A3 (C11 T-07)
export const listAnatomicCases: Handler = (req, ctx) => listCases(ctx, req.query);
export const lookupAnatomicObject: Handler = (req, ctx) => lookupObject(ctx, req.body);
export const getAnatomicCase: Handler = (req, ctx) => getCaseDetail(ctx, req.params);

export const accessionAnatomicCase: Handler = (req, ctx) => accessionCase(ctx, req.params, req.headers, req.body);
export const updateAnatomicCaseDetails: Handler = (req, ctx) => updateCaseDetails(ctx, req.params, req.headers, req.body);
export const addAnatomicPart: Handler = (req, ctx) => addPart(ctx, req.params, req.headers, req.body);
export const updateAnatomicPart: Handler = (req, ctx) => updateCasePart(ctx, req.params, req.headers, req.body);
export const listAnatomicAssignees: Handler = (req, ctx) => listAssignees(ctx, req.query);
