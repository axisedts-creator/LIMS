import { ConfirmDialog } from './ConfirmDialog';

const base = { title: 'Reject specimen', body: 'This cannot be undone.', confirmLabel: 'Reject', isOpen: true, onConfirm: () => {}, onCancel: () => {} };

export default { title: 'Overlays/ConfirmDialog', component: ConfirmDialog };

export const Plain = { args: base };
export const DangerWithReason = {
  args: {
    ...base,
    tone: 'danger',
    requireReason: {
      codedSet: 'reject_reason',
      options: [
        { code: 'wrong_tube', display: 'Wrong tube' },
        { code: 'hemolyzed', display: 'Hemolyzed' },
      ],
      freeText: { maxLength: 200, isRequired: false },
    },
  },
};
