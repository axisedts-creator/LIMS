import { ScanPanel } from './ScanPanel';

export default { title: 'Inputs/ScanPanel', component: ScanPanel, args: { label: 'Scan tube barcode', name: 'scan', onScan: () => {} } };

export const Default = {};
export const WithResultAndQueue = {
  args: {
    result: <p>Tube ABC1234 received</p>,
    children: <table aria-label="Queue"><thead><tr><th>Tube</th><th>Received</th></tr></thead><tbody><tr><td>ABC1234</td><td>10:42</td></tr></tbody></table>,
  },
};
