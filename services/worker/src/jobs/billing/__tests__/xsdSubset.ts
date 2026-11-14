// Test helper (not a test file): a SMALL XSD-subset validator + XML parser, because no XSD engine (xmllint / libxmljs / Java) is installed or allowed in this repo.
// Supported XSD (the writer must stay inside it; anything else throws XSD_SUBSET_UNSUPPORTED:<construct> so the gap is loud, never a silent pass):
//   xs:schema@targetNamespace; global xs:element and named xs:complexType / xs:simpleType; element name+type | inline complexType | inline simpleType, minOccurs / maxOccurs ("unbounded");
//   complexType = sequence of elements (order enforced) + xs:attribute (use required|optional); simpleType = restriction of a built-in with enumeration / pattern / minLength / maxLength / minInclusive / maxInclusive.
//   Built-ins: string token normalizedString integer int long nonNegativeInteger positiveInteger decimal boolean date dateTime.
// Not supported: choice, all, extension, simpleContent, ref, import, key/keyref, any, mixed.
export interface XNode { name: string; ns: string | undefined; attrs: Record<string, string>; children: XNode[]; text: string }

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unesc = (s: string) => s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, e: string) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e]!));

/** Minimal well-formed-XML parser (declaration, comments, CDATA, attributes, entities, namespaces by prefix). Throws on anything malformed. */
export function parseXml(xml: string): XNode {
  let i = 0; const stack: Array<{ node: XNode; scope: Record<string, string> }> = []; let root: XNode | undefined;
  const fail = (m: string): never => { throw new Error(`XML not well-formed: ${m} at ${i}`); };
  if (xml.charCodeAt(0) === 0xfeff) i = 1;
  while (i < xml.length) {
    if (xml[i] !== '<') {
      const j = xml.indexOf('<', i); const t = xml.slice(i, j < 0 ? xml.length : j);
      if (stack.length) stack[stack.length - 1]!.node.text += unesc(t); else if (t.trim()) fail('text outside the root');
      i = j < 0 ? xml.length : j; continue;
    }
    if (xml.startsWith('<?', i)) { const j = xml.indexOf('?>', i); if (j < 0) fail('unterminated declaration'); i = j + 2; continue; }
    if (xml.startsWith('<!--', i)) { const j = xml.indexOf('-->', i); if (j < 0) fail('unterminated comment'); i = j + 3; continue; }
    if (xml.startsWith('<![CDATA[', i)) { const j = xml.indexOf(']]>', i); if (j < 0 || !stack.length) fail('bad CDATA'); stack[stack.length - 1]!.node.text += xml.slice(i + 9, j); i = j + 3; continue; }
    if (xml.startsWith('<!', i)) fail('DOCTYPE / entity declarations are not allowed in exports');
    if (xml.startsWith('</', i)) {
      const j = xml.indexOf('>', i); const n = xml.slice(i + 2, j).trim(); const top = stack.pop();
      if (!top || top.node.name !== n.replace(/^.*:/, '') || false) fail(`mismatched </${n}>`);
      i = j + 1; continue;
    }
    const m = /^<([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/.exec(xml.slice(i));
    if (!m) return fail(`bad tag ${xml.slice(i, i + 30)}`);
    const attrs: Record<string, string> = {}; const scope = { ...(stack.length ? stack[stack.length - 1]!.scope : {}) };
    for (const a of m[2]!.matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      const v = unesc(a[2] ?? a[3] ?? ''); if (a[1] in attrs) fail(`duplicate attribute ${a[1]}`); attrs[a[1]!] = v;
      if (a[1] === 'xmlns') scope[''] = v; else if (a[1]!.startsWith('xmlns:')) scope[a[1]!.slice(6)] = v;
    }
    const [prefix, local] = m[1]!.includes(':') ? m[1]!.split(':') as [string, string] : ['', m[1]!];
    const node: XNode = { name: local, ns: scope[prefix], attrs: Object.fromEntries(Object.entries(attrs).filter(([k]) => k !== 'xmlns' && !k.startsWith('xmlns:'))), children: [], text: '' };
    if (stack.length) stack[stack.length - 1]!.node.children.push(node); else if (root) fail('second root element'); else root = node;
    if (!m[3]) stack.push({ node, scope });
    i += m[0].length;
  }
  if (stack.length) fail('unclosed element');
  if (!root) fail('no root element');
  return root!;
}

const unsupported = (c: string): never => { throw new Error(`XSD_SUBSET_UNSUPPORTED:${c}`); };
const BUILTIN: Record<string, (v: string) => boolean> = {
  string: () => true, token: () => true, normalizedString: () => true,
  integer: (v) => /^[+-]?\d+$/.test(v), int: (v) => /^[+-]?\d+$/.test(v) && Math.abs(Number(v)) <= 2147483648, long: (v) => /^[+-]?\d+$/.test(v), nonNegativeInteger: (v) => /^\+?\d+$/.test(v), positiveInteger: (v) => /^\+?0*[1-9]\d*$/.test(v),
  decimal: (v) => /^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(v), boolean: (v) => ['true', 'false', '1', '0'].includes(v),
  date: (v) => /^\d{4}-\d\d-\d\d(Z|[+-]\d\d:\d\d)?$/.test(v) && !Number.isNaN(Date.parse(v.slice(0, 10))), dateTime: (v) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)?$/.test(v) && !Number.isNaN(Date.parse(v)),
};

export function compileXsd(xsdText: string) {
  const xs = parseXml(xsdText);
  if (xs.name !== 'schema') unsupported(`root ${xs.name}`);
  const tns = xs.attrs['targetNamespace'];
  const local = (t: string | undefined) => (t ?? '').replace(/^.*:/, '');
  const byName = (kind: string) => new Map(xs.children.filter((c) => c.name === kind && c.attrs['name']).map((c) => [c.attrs['name']!, c] as const));
  const ctypes = byName('complexType'), stypes = byName('simpleType'), globals = byName('element');
  for (const c of xs.children) if (!['element', 'complexType', 'simpleType', 'annotation'].includes(c.name)) unsupported(c.name);

  function checkSimple(def: XNode | string, value: string, path: string, errs: string[]) {
    if (typeof def === 'string') {
      const base = local(def);
      if (BUILTIN[base]) { if (!BUILTIN[base]!(value)) errs.push(`${path}: "${value}" is not a valid xs:${base}`); return; }
      const st = stypes.get(base); if (!st) { errs.push(`${path}: unknown type ${def}`); return; }
      return checkSimple(st, value, path, errs);
    }
    const r = def.children.find((c) => c.name === 'restriction'); if (!r) return unsupported('simpleType without restriction');
    checkSimple(r.attrs['base']!, value, path, errs);
    const enums = r.children.filter((c) => c.name === 'enumeration').map((c) => c.attrs['value']);
    if (enums.length && !enums.includes(value)) errs.push(`${path}: "${value}" not in enumeration [${enums.join(', ')}]`);
    for (const f of r.children) {
      const v = f.attrs['value']!;
      if (f.name === 'pattern' && !new RegExp(`^(?:${v})$`).test(value)) errs.push(`${path}: "${value}" does not match pattern ${v}`);
      else if (f.name === 'maxLength' && value.length > Number(v)) errs.push(`${path}: longer than ${v}`);
      else if (f.name === 'minLength' && value.length < Number(v)) errs.push(`${path}: shorter than ${v}`);
      else if (f.name === 'minInclusive' && Number(value) < Number(v)) errs.push(`${path}: below ${v}`);
      else if (f.name === 'maxInclusive' && Number(value) > Number(v)) errs.push(`${path}: above ${v}`);
      else if (!['enumeration', 'pattern', 'maxLength', 'minLength', 'minInclusive', 'maxInclusive', 'annotation'].includes(f.name)) unsupported(`facet ${f.name}`);
    }
  }
  function checkComplex(def: XNode, n: XNode, path: string, errs: string[]) {
    for (const c of def.children) if (!['sequence', 'attribute', 'annotation'].includes(c.name)) unsupported(c.name);
    const attrs = def.children.filter((c) => c.name === 'attribute');
    for (const a of attrs) {
      const v = n.attrs[a.attrs['name']!];
      if (v === undefined) { if (a.attrs['use'] === 'required') errs.push(`${path}: missing attribute ${a.attrs['name']}`); } else checkSimple(a.attrs['type'] ?? a.children.find((c) => c.name === 'simpleType') ?? 'string', v, `${path}/@${a.attrs['name']}`, errs);
    }
    for (const k of Object.keys(n.attrs)) if (!attrs.some((a) => a.attrs['name'] === k)) errs.push(`${path}: unexpected attribute ${k}`);
    const seq = def.children.find((c) => c.name === 'sequence');
    if (n.text.trim() && seq) errs.push(`${path}: text not allowed in element-only content`);
    let at = 0;
    for (const decl of seq?.children.filter((c) => c.name !== 'annotation') ?? []) {
      if (decl.name !== 'element') unsupported(`sequence/${decl.name}`);
      if (decl.attrs['ref']) unsupported('ref');
      const min = Number(decl.attrs['minOccurs'] ?? 1), max = decl.attrs['maxOccurs'] === 'unbounded' ? Infinity : Number(decl.attrs['maxOccurs'] ?? 1); let count = 0;
      while (at < n.children.length && n.children[at]!.name === decl.attrs['name'] && count < max) { checkElement(decl, n.children[at]!, `${path}/${decl.attrs['name']}[${count + 1}]`, errs); at++; count++; }
      if (count < min) errs.push(`${path}: element ${decl.attrs['name']} occurs ${count}x, minimum ${min}`);
    }
    if (at < n.children.length) errs.push(`${path}: unexpected element ${n.children[at]!.name} (or out of order)`);
  }
  function checkElement(decl: XNode, n: XNode, path: string, errs: string[]) {
    if (n.ns !== tns) errs.push(`${path}: element ${n.name} is in namespace ${n.ns ?? '(none)'}, expected ${tns}`);
    const inlineC = decl.children.find((c) => c.name === 'complexType'), inlineS = decl.children.find((c) => c.name === 'simpleType'); const t = decl.attrs['type'];
    const cdef = inlineC ?? (t ? ctypes.get(local(t)) : undefined);
    if (cdef) return checkComplex(cdef, n, path, errs);
    if (n.children.length) errs.push(`${path}: simple element ${n.name} has child elements`);
    if (Object.keys(n.attrs).length) errs.push(`${path}: simple element ${n.name} has attributes`);
    checkSimple(inlineS ?? t ?? 'string', n.text, path, errs);
  }
  return {
    targetNamespace: tns,
    /** [] when valid. Never throws for an invalid instance (throws only for an XSD construct outside the subset or malformed XML). */
    validate(xml: string): string[] {
      const errs: string[] = []; const root = parseXml(xml); const decl = globals.get(root.name);
      if (!decl) return [`root element ${root.name} is not declared by the schema`];
      checkElement(decl, root, `/${root.name}`, errs); return errs;
    },
  };
}

/** The XSD kept in docs/manual/billing/exports.md: the first ```xml (or ```xsd) fenced block that contains an xs:schema for the export namespace. */
export function xsdFromDoc(md: string): string {
  const blocks = [...md.matchAll(/```(?:xml|xsd)\s*\n([\s\S]*?)```/g)].map((m) => m[1]!);
  const hit = blocks.find((b) => /schema/.test(b) && b.includes('urn:lims:billing:export:v1'));
  if (!hit) throw new Error('docs/manual/billing/exports.md has no fenced xml block with an xs:schema for urn:lims:billing:export:v1');
  return hit;
}
