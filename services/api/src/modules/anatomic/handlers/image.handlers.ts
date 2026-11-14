// I1–I4 (02-TRD §5). Thin: the service does load -> assertRole -> validate -> write.
import type { Handler } from '../../../core/module.js';
import * as s from '../service/image.service.js';

export const uploadAnatomicImage: Handler = (req, ctx) => s.uploadImage(ctx, req.params, req.body);
export const getAnatomicImageContent: Handler = (req, ctx) => s.getImageContent(ctx, req.params);
export const updateAnatomicImage: Handler = (req, ctx) => s.updateImageMeta(ctx, req.params, req.headers, req.body);
export const deactivateAnatomicImage: Handler = (req, ctx) => s.deactivateImage(ctx, req.params, req.headers);
