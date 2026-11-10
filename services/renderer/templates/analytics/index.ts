// C8 data templates for the C6 renderer registry (loadRegistry finds templates/analytics/index.ts; keys must start with "analytics.").
import type { DataTemplateModule } from '../../src/templates/contract.js';
import { analyticsReportTemplate } from './report/report.js';

export const templates: DataTemplateModule[] = [analyticsReportTemplate];
