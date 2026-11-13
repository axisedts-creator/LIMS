// Permission codes used by 02-TRD §5; all defined in contracts/permissions.yaml (CR-C12-001).
export const PERMISSIONS = {
  itemRead: 'inventory.item.read',
  masterManage: 'inventory.master.manage',
  stockManage: 'inventory.stock.manage',
  stockAdjust: 'inventory.stock.adjust',
  benchRecord: 'inventory.bench.record',
  poManage: 'inventory.po.manage',
  poApprove: 'inventory.po.approve',
  costRead: 'inventory.cost.read',
  reportExport: 'inventory.report.export',
} as const;
