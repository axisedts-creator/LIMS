// Negative controls for the XSD-subset validator used by export.render.test.ts: if it accepted everything, "XML validated against the XSD" would prove nothing.
import { describe, expect, it } from 'vitest';
import { compileXsd, parseXml, xsdFromDoc } from './xsdSubset.js';

const NS = 'urn:lims:billing:export:v1';
const XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="${NS}" xmlns="${NS}" elementFormDefault="qualified">
  <xs:element name="Export"><xs:complexType><xs:sequence>
    <xs:element name="Row" minOccurs="0" maxOccurs="unbounded"><xs:complexType><xs:sequence>
      <xs:element name="Sn" type="xs:positiveInteger"/>
      <xs:element name="Status"><xs:simpleType><xs:restriction base="xs:string"><xs:enumeration value="issued"/><xs:enumeration value="cancelled"/></xs:restriction></xs:simpleType></xs:element>
      <xs:element name="Pan" type="xs:string" minOccurs="0"/>
    </xs:sequence></xs:complexType></xs:element>
  </xs:sequence><xs:attribute name="kind" type="xs:string" use="required"/></xs:complexType></xs:element>
</xs:schema>`;
const ok = `<?xml version="1.0" encoding="UTF-8"?><Export xmlns="${NS}" kind="x"><Row><Sn>1</Sn><Status>issued</Status></Row><Row><Sn>2</Sn><Status>cancelled</Status><Pan>1</Pan></Row></Export>`;

describe('xsdSubset validator is not vacuous', () => {
  const v = compileXsd(XSD);
  it('accepts a valid document (also with zero rows)', () => {
    expect(v.validate(ok)).toEqual([]); expect(v.validate(`<Export xmlns="${NS}" kind="x"/>`)).toEqual([]);
  });
  it.each([
    ['wrong namespace', ok.replace(NS + '" kind', 'urn:other" kind')],
    ['no namespace', ok.replace(` xmlns="${NS}"`, '')],
    ['bad enumeration', ok.replace('cancelled', 'void')],
    ['bad integer', ok.replace('<Sn>1</Sn>', '<Sn>one</Sn>')],
    ['zero for positiveInteger', ok.replace('<Sn>1</Sn>', '<Sn>0</Sn>')],
    ['missing required child', ok.replace('<Status>issued</Status>', '')],
    ['out of order', ok.replace('<Sn>1</Sn><Status>issued</Status>', '<Status>issued</Status><Sn>1</Sn>')],
    ['unknown child', ok.replace('</Row></Export>', '<Extra>1</Extra></Row></Export>')],
    ['missing required attribute', ok.replace(' kind="x"', '')],
    ['unexpected attribute', ok.replace('kind="x"', 'kind="x" y="1"')],
    ['unknown root', ok.replace(/Export/g, 'Other')],
  ])('rejects: %s', (_n, xml) => { expect(v.validate(xml as string).length).toBeGreaterThan(0); });
  it('malformed XML throws (never "valid")', () => {
    for (const bad of ['<a><b></a>', '<a>', '<a/><b/>', '<!DOCTYPE a [<!ENTITY x "y">]><a/>', 'x<a/>', '<a b="1" b="2"/>']) expect(() => parseXml(bad), bad).toThrow();
  });
  it('entities round-trip and a construct outside the subset is loud', () => {
    expect(parseXml('<a>x &amp; &lt;y&gt; &#65;</a>').text).toBe('x & <y> A');
    expect(() => compileXsd(XSD.replaceAll('xs:sequence>', 'xs:choice>')).validate(ok)).toThrow(/XSD_SUBSET_UNSUPPORTED/);
  });
  it('xsdFromDoc takes the fenced block for the export namespace', () => {
    expect(xsdFromDoc(`# x\n\`\`\`xml\n<other/>\n\`\`\`\n\n\`\`\`xml\n${XSD}\n\`\`\`\n`)).toContain(NS);
    expect(() => xsdFromDoc('# no schema here')).toThrow();
  });
});
