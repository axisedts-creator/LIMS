import 'server-only';
// C9 T-22 page composers (server components) for the four set-up tabs: permission -> whitelisted query -> API -> plain-JSON props for the client views.
// The token never leaves the server (REQ-SEC-068); C7 / C3 are only read through server actions, and only after the matching read permission was checked.
// LD-140: no markup of their own; the helpKey of each tab is `quality.setup_<tab>`.
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { QualityNotice } from '../components/Shared';
import { MANAGE, gated } from '../server/quality.server';
import { MapsView } from './MapsView';
import { MaterialsView } from './MaterialsView';
import { PlansView } from './PlansView';
import { TargetsView } from './TargetsView';
import type { IdMap, Material, Plan, Target } from './types';
import { PICK, UUID } from './validate';

type SP = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const notice = (gate: 'denied' | 'disabled', tab: string) => <QualityNotice kind={gate} title="QC set-up" helpKey={`quality.setup_${tab}`} />;

async function rows<T>(path: string, q: Record<string, string> = {}): Promise<T[]> {
  const r = await serverFetch<{ data?: T[] }>(`/v1/quality/${path}?${new URLSearchParams({ ...q, limit: '200' }).toString()}`);
  return Array.isArray(r?.data) ? r.data : [];
}
/** Active materials with their levels and lots: the options of every Lot / Level select. */
const activeMaterials = async () => (await rows<Material>('control-materials', { is_active: 'true' })).filter((m) => m.is_active);

export async function materialsPage(sp: SP) {
  const active = first(sp['is_active']) === 'false' ? 'false' : 'true'; // whitelist: anything else is the default
  const r = await gated(() => rows<Material>('control-materials', { is_active: active }));
  if ('gate' in r) return notice(r.gate, 'materials');
  return <MaterialsView rows={r.data} showInactive={active === 'false'} canManage={r.perms.includes(MANAGE)} />;
}

const RAW = /^[\x20-\x7e]{1,64}$/;
export async function mapsPage(sp: SP) {
  const r = await gated(async () => ({ maps: await rows<IdMap>('control-id-maps'), materials: await activeMaterials() }));
  if ('gate' in r) return notice(r.gate, 'maps');
  // the "Create control map" link of Unassigned QC pre-fills instrument + raw id / lot through the URL
  const instrument = first(sp['instrument_id']);
  const controlId = first(sp['control_id']);
  const controlLot = first(sp['control_lot']);
  const prefill = {
    ...(instrument && UUID.test(instrument) ? { instrument_id: instrument } : {}), ...(controlId && RAW.test(controlId) ? { control_id: controlId } : {}), ...(controlLot && RAW.test(controlLot) ? { control_lot: controlLot } : {}),
  };
  return <MapsView rows={r.data.maps} materials={r.data.materials} canManage={r.perms.includes(MANAGE)} pickInstruments={r.perms.includes(PICK.instruments)} prefill={Object.keys(prefill).length ? prefill : undefined} />;
}

export async function plansPage() {
  const r = await gated(async () => ({ plans: await rows<Plan>('qc-plans'), materials: await activeMaterials() }));
  if ('gate' in r) return notice(r.gate, 'plans');
  return <PlansView rows={r.data.plans} materials={r.data.materials} canManage={r.perms.includes(MANAGE)} pickInstruments={r.perms.includes(PICK.instruments)} pickTests={r.perms.includes(PICK.tests)} />;
}

export async function targetsPage(sp: SP) {
  const planId = first(sp['plan_id']);
  const id = planId && UUID.test(planId) ? planId : undefined; // malformed = no plan: nothing is requested
  const r = await gated(async () => {
    if (!id) return { plans: await rows<Plan>('qc-plans') };
    const plan = await serverFetch<Plan>(`/v1/quality/qc-plans/${id}`).catch((e: unknown) => (e instanceof ApiError && e.status === 404 ? undefined : Promise.reject(e)));
    if (!plan) return { plans: await rows<Plan>('qc-plans') };
    const [targets, materials] = await Promise.all([rows<Target>('qc-targets', { plan_id: id }), activeMaterials()]);
    return { plan, targets, materials };
  });
  if ('gate' in r) return notice(r.gate, 'targets');
  const d = r.data;
  return <TargetsView plan={'plan' in d ? d.plan : undefined} plans={'plans' in d ? d.plans : []} targets={'targets' in d ? d.targets : []} materials={'materials' in d ? d.materials : []} canManage={r.perms.includes(MANAGE)} />;
}
