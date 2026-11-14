import { BarcodeSymbol } from './BarcodeSymbol';

export default { title: 'Data/BarcodeSymbol', component: BarcodeSymbol, args: { value: 'LAB-2026-000123', moduleWidthMm: 0.33 } };

export const Default = {};
export const WithText = { args: { showText: true, heightMm: 15 } };
export const AllDigits = { args: { value: '12345678901234567890' } };
export const Short = { args: { value: 'A', showText: true } };
