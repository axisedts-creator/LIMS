// C9 T-03 fixture — copied verbatim from spec/chunks/C9-quality-engine/02-TRD.md §7.9 (mean 100.0, SD 2.0, value = 100 + 2z).
// One row per table row. `z` strings stay strings so the harness builds exact decimals (no float). Unless stated:
// twoTwoAcrossRuns = true, countAcrossMaterials = true, exclude_rejected_runs_from_history = true, meanRule = default for N (N=3: 6x, else 10x).
export type Lv = 'L1' | 'L2' | 'L3';
export type Obs = readonly [Lv, string] | readonly [Lv, string, 'excluded'];
export interface HistRun { readonly obs: readonly Obs[]; readonly outcome: 'accepted' | 'accepted_warning' | 'rejected' | 'incomplete' }
export interface VOpts { twoTwoAcrossRuns?: boolean; countAcrossMaterials?: boolean; meanRule?: '6x' | '8x' | '9x' | '10x' | '12x'; excludeRejected?: boolean }
export interface Vector {
  id: string; n: 2 | 3 | 4; mode: 'classic' | 'modern'; history: readonly HistRun[]; current: readonly Obs[];
  opts?: VOpts; outcome: 'accepted' | 'accepted_warning' | 'rejected'; fired: readonly string[]; warning: boolean;
}

const acc = (...obs: Obs[]): HistRun => ({ obs, outcome: 'accepted' });
const accW = (...obs: Obs[]): HistRun => ({ obs, outcome: 'accepted_warning' });
const rep = (n: number, r: HistRun): HistRun[] => Array.from({ length: n }, () => r);
const p2 = (a: string, b: string): Obs[] => [['L1', a], ['L2', b]];
const p3 = (a: string, b: string, c: string): Obs[] => [['L1', a], ['L2', b], ['L3', c]];

const V10H = [acc(...p2('1.5', '1.5'))];
const V12H = rep(4, acc(...p2('0.5', '0.5')));
const V15H = rep(3, acc(...p2('0.5', '0.5')));
const V19H = [acc(...p3('0.3', '0.4', '0.2'))];
const V23H = [acc(['L1', '0.5'], ['L1', '0.5'], ['L2', '0.5'], ['L2', '0.5'])];
const V26H = [acc(...p2('1.5', '1.5')), { obs: p2('-3.5', '0.2'), outcome: 'rejected' as const }];
const V31H = [acc(...p2('1.5', '0.2')), acc(...p2('1.5', '-0.3')), acc(...p2('1.5', '0.1'))];
const V08H = [accW(...p2('2.2', '0'))];

export const VECTORS: readonly Vector[] = [
  { id: 'V01', n: 2, mode: 'classic', history: [], current: p2('0.5', '-0.5'), outcome: 'accepted', fired: [], warning: false },
  { id: 'V02', n: 2, mode: 'classic', history: [], current: p2('2.1', '0'), outcome: 'accepted_warning', fired: [], warning: true },
  { id: 'V03', n: 2, mode: 'classic', history: [], current: p2('3.1', '0'), outcome: 'rejected', fired: ['1-3s'], warning: true },
  { id: 'V04', n: 2, mode: 'classic', history: [], current: p2('2.2', '2.1'), outcome: 'rejected', fired: ['2-2s'], warning: true },
  { id: 'V05', n: 2, mode: 'classic', history: [], current: p2('2.2', '-2.2'), outcome: 'rejected', fired: ['R-4s'], warning: true },
  { id: 'V06', n: 2, mode: 'classic', history: [accW(...p2('2.2', '0'))], current: p2('-2.2', '0'), outcome: 'accepted_warning', fired: [], warning: true },
  { id: 'V07', n: 2, mode: 'classic', history: [], current: p2('3.5', '-0.6'), outcome: 'rejected', fired: ['1-3s'], warning: true },
  { id: 'V08', n: 2, mode: 'classic', history: V08H, current: p2('2.1', '0'), outcome: 'rejected', fired: ['2-2s'], warning: true },
  { id: 'V08b', n: 2, mode: 'classic', history: V08H, current: p2('2.1', '0'), opts: { twoTwoAcrossRuns: false }, outcome: 'accepted_warning', fired: [], warning: true },
  { id: 'V09', n: 2, mode: 'classic', history: [accW(...p2('0', '2.2'))], current: p2('2.1', '0'), outcome: 'accepted_warning', fired: [], warning: true },
  { id: 'V10m', n: 2, mode: 'modern', history: V10H, current: p2('1.5', '1.5'), outcome: 'rejected', fired: ['4-1s'], warning: false },
  { id: 'V10c', n: 2, mode: 'classic', history: V10H, current: p2('1.5', '1.5'), outcome: 'accepted', fired: [], warning: false },
  { id: 'V11', n: 2, mode: 'classic', history: V10H, current: p2('2.1', '1.5'), outcome: 'rejected', fired: ['4-1s'], warning: true },
  { id: 'V12m', n: 2, mode: 'modern', history: V12H, current: p2('0.5', '0.5'), outcome: 'rejected', fired: ['10x'], warning: false },
  { id: 'V12c', n: 2, mode: 'classic', history: V12H, current: p2('0.5', '0.5'), outcome: 'accepted', fired: [], warning: false },
  { id: 'V13', n: 2, mode: 'modern', history: [...rep(3, acc(...p2('0.5', '0.5'))), acc(...p2('0.5', '0'))], current: p2('0.5', '0.5'), outcome: 'accepted', fired: [], warning: false },
  { id: 'V14', n: 2, mode: 'modern', history: rep(9, acc(...p2('0.5', '-0.5'))), current: p2('0.5', '-0.5'), outcome: 'rejected', fired: ['10x'], warning: false },
  { id: 'V14b', n: 2, mode: 'modern', history: rep(8, acc(...p2('0.5', '-0.5'))), current: p2('0.5', '-0.5'), outcome: 'accepted', fired: [], warning: false },
  { id: 'V15a', n: 2, mode: 'modern', history: V15H, current: p2('0.5', '0.5'), opts: { meanRule: '8x' }, outcome: 'rejected', fired: ['8x'], warning: false },
  { id: 'V15b', n: 2, mode: 'modern', history: V15H, current: p2('0.5', '0.5'), outcome: 'accepted', fired: [], warning: false },
  { id: 'V16', n: 3, mode: 'classic', history: [], current: p3('2.1', '2.2', '0'), outcome: 'rejected', fired: ['2of3-2s'], warning: true },
  { id: 'V17', n: 3, mode: 'classic', history: [], current: p3('2.1', '0', '-0.5'), outcome: 'accepted_warning', fired: [], warning: true },
  { id: 'V18m', n: 3, mode: 'modern', history: [], current: p3('1.2', '1.3', '1.1'), outcome: 'rejected', fired: ['3-1s'], warning: false },
  { id: 'V18c', n: 3, mode: 'classic', history: [], current: p3('1.2', '1.3', '1.1'), outcome: 'accepted', fired: [], warning: false },
  { id: 'V19', n: 3, mode: 'modern', history: V19H, current: p3('0.1', '0.6', '0.9'), opts: { meanRule: '6x' }, outcome: 'rejected', fired: ['6x'], warning: false },
  { id: 'V19b', n: 3, mode: 'modern', history: V19H, current: p3('0.1', '0.6', '0.9'), opts: { meanRule: '9x' }, outcome: 'accepted', fired: [], warning: false },
  { id: 'V20', n: 3, mode: 'modern', history: rep(2, acc(...p3('0.3', '0.4', '0.2'))), current: p3('0.1', '0.6', '0.9'), opts: { meanRule: '9x' }, outcome: 'rejected', fired: ['9x'], warning: false },
  { id: 'V21', n: 3, mode: 'classic', history: [], current: p3('2.1', '-2.3', '0'), outcome: 'rejected', fired: ['R-4s'], warning: true },
  { id: 'V22', n: 4, mode: 'classic', history: [], current: [['L1', '1.2'], ['L1', '1.4'], ['L2', '1.1'], ['L2', '2.1']], outcome: 'rejected', fired: ['4-1s'], warning: true },
  { id: 'V23a', n: 4, mode: 'modern', history: V23H, current: [['L1', '0.5'], ['L1', '0.5'], ['L2', '0.5'], ['L2', '0.5']], opts: { meanRule: '8x' }, outcome: 'rejected', fired: ['8x'], warning: false },
  { id: 'V23b', n: 4, mode: 'modern', history: V23H, current: [['L1', '0.5'], ['L1', '0.5'], ['L2', '0.5'], ['L2', '0.5']], outcome: 'accepted', fired: [], warning: false },
  { id: 'V24a', n: 2, mode: 'classic', history: [], current: p2('2.0', '-2.0'), outcome: 'accepted', fired: [], warning: false },
  { id: 'V24b', n: 2, mode: 'classic', history: [], current: p2('3.0', '0'), outcome: 'accepted_warning', fired: [], warning: true },
  { id: 'V25', n: 2, mode: 'modern', history: [acc(...p2('1.5', '1.5')), acc(['L1', '-0.4', 'excluded'], ['L2', '1.5'])], current: p2('1.5', '1.5'), outcome: 'rejected', fired: ['4-1s'], warning: false },
  { id: 'V26a', n: 2, mode: 'modern', history: V26H, current: p2('1.5', '1.5'), outcome: 'rejected', fired: ['4-1s'], warning: false },
  { id: 'V26b', n: 2, mode: 'modern', history: V26H, current: p2('1.5', '1.5'), opts: { excludeRejected: false }, outcome: 'accepted', fired: [], warning: false },
  { id: 'V27', n: 2, mode: 'classic', history: [], current: [['L1', '3.4']], outcome: 'rejected', fired: ['1-3s'], warning: true },
  { id: 'V30', n: 2, mode: 'classic', history: [accW(...p2('0', '-2.4'))], current: p2('0.3', '-2.05'), outcome: 'rejected', fired: ['2-2s'], warning: true },
  { id: 'V31', n: 2, mode: 'modern', history: V31H, current: p2('1.5', '0'), outcome: 'rejected', fired: ['4-1s'], warning: false },
  { id: 'V31b', n: 2, mode: 'modern', history: V31H, current: p2('1.5', '0'), opts: { countAcrossMaterials: false }, outcome: 'rejected', fired: ['4-1s'], warning: false },
  { id: 'V32', n: 2, mode: 'modern', history: [acc(...p2('1.5', '1.5'))], current: p2('1.5', '1.5'), opts: { countAcrossMaterials: false }, outcome: 'accepted', fired: [], warning: false },
];

export { p2, p3, rep, acc };
