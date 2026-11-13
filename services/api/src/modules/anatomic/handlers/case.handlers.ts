// A4–A7, A12 (02-TRD §5.1). Thin: the service does load -> assertRole -> validate -> write.
import type { Handler } from '../../../core/module.js';
import { accessionCase, addPart, listAssignees, updateCaseDetails, updateCasePart } from '../service/case.service.js';

export const accessionAnatomicCase: Handler = (req, ctx) => accessionCase(ctx, req.params, req.headers, req.body);
export const updateAnatomicCaseDetails: Handler = (req, ctx) => updateCaseDetails(ctx, req.params, req.headers, req.body);
export const addAnatomicPart: Handler = (req, ctx) => addPart(ctx, req.params, req.headers, req.body);
export const updateAnatomicPart: Handler = (req, ctx) => updateCasePart(ctx, req.params, req.headers, req.body);
export const listAnatomicAssignees: Handler = (req, ctx) => listAssignees(ctx, req.query);
