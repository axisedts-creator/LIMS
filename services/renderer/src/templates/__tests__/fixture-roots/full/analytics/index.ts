// C6-T36 fixture standing in for C8's services/renderer/templates/analytics/index.ts (analytics.report). Synthetic data only.
export const templates = [
  { templateKey: 'analytics.report' as const, render: ({ data }: any) =>
      `<!doctype html><html><head><meta charset="utf-8"></head><body><h1>FIXTURE-ANALYTICS ${String(data.reportTitle).replace(/</g, '&lt;')}</h1><p>${(data.rows ?? []).length} rows</p></body></html>` },
];
export default templates;
