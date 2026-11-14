// R1–R3 — thin handlers over service/report.service.ts (T13).
import type { Handler } from '../../../core/module.js';
import { downloadReport, listReports, markSeen } from '../service/report.service.js';

export const listPartnerReports: Handler = (req, ctx) => listReports(req, ctx);
export const markPartnerReportsSeen: Handler = (req, ctx) => markSeen(req, ctx);
export const downloadPartnerReport: Handler = (req, ctx) => downloadReport(req, ctx);
