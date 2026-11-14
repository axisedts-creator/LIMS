// #17 GET /v1/lab/status-board (02-TRD §5.2 row 17; permission lab.status_board.read; AC-18.1..18.4)
import type { Handler } from '../../../core/module.js';
import { getStatusBoard } from '../service/report.service.js';

export const handler: Handler = (req, ctx) => getStatusBoard(ctx, req.query);
