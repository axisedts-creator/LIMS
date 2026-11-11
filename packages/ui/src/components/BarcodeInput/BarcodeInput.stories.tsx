import { BarcodeInput } from './BarcodeInput';

export default {
  title: 'Fields/BarcodeInput',
  component: BarcodeInput,
  args: { label: 'Specimen barcode', name: 'barcode', onScan: () => {}, autoFocus: false, feedback: 'visual' },
};

export const Default = {};
export const WithError = { args: { error: 'Scan the tube barcode' } };
export const Disabled = { args: { isDisabled: true } };
export const ScannerOnly = { args: { allowManual: false } };
