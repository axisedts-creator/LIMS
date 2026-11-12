// C17 snapshot cursor (02-TRD §6.2 step 3): base64url(JSON{v:1,d,r:[[route_id,route_version]…sorted],s,w}), opaque to the device. Pure.
export interface CursorState {
  d: string; // route_date YYYY-MM-DD
  r: ReadonlyArray<readonly [string, number]>; // [route_id, route_version]
  s: number; // settings.version
  w: string; // device.status
}

export function encodeCursor(c: CursorState): string {
  const r = c.r.map(([id, v]) => [id, v] as [string, number]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return Buffer.from(JSON.stringify({ v: 1, d: c.d, r, s: c.s, w: c.w })).toString('base64url');
}

const isDate = (x: unknown): x is string =>
  typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) && new Date(`${x}T00:00:00Z`).toISOString().startsWith(x);

/** Never throws: device input is untrusted. */
export function decodeCursor(s: unknown): CursorState | null {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
  let o: unknown;
  try {
    o = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return null;
  const { v, d, r, s: sv, w } = o as Record<string, unknown>;
  if (v !== 1 || !isDate(d) || !Array.isArray(r) || !Number.isInteger(sv) || typeof w !== 'string') return null;
  const routes: Array<[string, number]> = [];
  for (const p of r) {
    if (!Array.isArray(p) || p.length !== 2 || typeof p[0] !== 'string' || !Number.isInteger(p[1])) return null;
    routes.push([p[0], p[1] as number]);
  }
  return { d, r: routes, s: sv as number, w };
}

/** The pull "unchanged" test: only a well-formed device cursor equal to the current one. */
export function cursorsEqual(deviceCursor: unknown, currentCursor: string): boolean {
  return typeof deviceCursor === 'string' && decodeCursor(deviceCursor) !== null && deviceCursor === currentCursor;
}
