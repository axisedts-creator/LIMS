// Core sample module (02-TRD §14): exercises the manifest contract in ci. Synthetic data only. Never deployed.
import type { Handler } from '../../module.js';

const listSampleItems: Handler = async () => ({ status: 200, body: { items: [{ id: 's1', label: 'sample' }] } });
const createSampleItem: Handler = async (req) => ({
  status: 201,
  body: { id: 's2', label: (req.body as { label: string }).label },
});

export const manifest = {
  name: 'sample',
  handlers: { listSampleItems, createSampleItem },
} as const;
