// PHLEBO-UI-FULL-1: phlebotomist applications. Anonymous: create, upload piece, submit. Staff: list, get, download, decide.
import type { Handler } from '../../../core/module.js';
import * as s from '../application.service.js';

export const createPhleboApplication: Handler = (req, ctx) => s.createPhleboApplication(ctx, req.body);
export const uploadPhleboApplicationDocumentChunk: Handler = (req, ctx) => s.uploadPhleboApplicationDocumentChunk(ctx, req.params, req.headers, req.body);
export const submitPhleboApplication: Handler = (req, ctx) => s.submitPhleboApplication(ctx, req.params, req.headers);
export const listPhleboApplications: Handler = (req, ctx) => s.listPhleboApplications(ctx, req.query);
export const getPhleboApplication: Handler = (req, ctx) => s.getPhleboApplication(ctx, req.params);
export const downloadPhleboApplicationDocument: Handler = (req, ctx) => s.downloadPhleboApplicationDocument(ctx, req.params);
export const decidePhleboApplication: Handler = (req, ctx) => s.decidePhleboApplication(ctx, req.params, req.headers, req.body);
