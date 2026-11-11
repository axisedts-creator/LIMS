// Test helper (C6-T12): dependency-free synthetic PDF builder + malformed corpus for the sandbox tests.
// Output is classic-xref, uncompressed, so text is readable by ../../../__tests__/helpers/pdf-text.ts and fixtures never depend on
// the libraries under test (qpdf, @cantoo/pdf-lib). Synthetic text only.
import { createHash } from 'node:crypto';

export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

export type Hook = { catalog?: string; page?: string; objects?: string[]; trailer?: string };
export type PdfOpts = {
  /** one entry per page: the text drawn on it */
  pages: string[];
  title?: string;
  /** replaces the default `[0 0 595 842]` MediaBox of every page */
  mediaBox?: string;
  /** called with the first free object number; extra objects are numbered from there */
  hook?: (firstFree: number) => Hook;
};

const latin1 = (s: string) => Buffer.from(s, 'latin1');

/** Valid single-revision PDF 1.4 with a correct classic xref table. */
export function buildPdf(o: PdfOpts): Buffer {
  const n = o.pages.length;
  const firstFree = 5 + 2 * n;
  const h = o.hook?.(firstFree) ?? {};
  const bodies: string[] = [];
  bodies[1] = `<< /Type /Catalog /Pages 2 0 R ${h.catalog ?? ''} >>`;
  bodies[2] = `<< /Type /Pages /Count ${n} /Kids [${o.pages.map((_, i) => `${5 + 2 * i} 0 R`).join(' ')}] >>`;
  bodies[3] = `<< /Title (${o.title ?? 'synthetic'}) >>`;
  bodies[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  o.pages.forEach((text, i) => {
    const content = `BT /F1 12 Tf 72 720 Td (${text.replace(/([()\\])/g, '\\$1')}) Tj ET`;
    bodies[5 + 2 * i] =
      `<< /Type /Page /Parent 2 0 R /MediaBox ${o.mediaBox ?? '[0 0 595 842]'} /Resources << /Font << /F1 4 0 R >> >> /Contents ${6 + 2 * i} 0 R ${h.page ?? ''} >>`;
    bodies[6 + 2 * i] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });
  (h.objects ?? []).forEach((b, i) => (bodies[firstFree + i] = b));
  const size = bodies.length;
  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = [];
  for (let i = 1; i < size; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${bodies[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let i = 1; i < size; i++) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${size} /Root 1 0 R /Info 3 0 R ${h.trailer ?? ''} >>\nstartxref\n${xref}\n%%EOF\n`;
  return latin1(out);
}

/** Appends an incremental update that replaces the /Info object (obj 3). The old title stays in the file bytes. */
export function withIncrementalUpdate(pdf: Buffer, newTitle: string): Buffer {
  const s = pdf.toString('latin1');
  const prev = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(s)![1]);
  const size = Number(/\/Size (\d+)/.exec(s)![1]);
  const objOff = s.length;
  const obj = `3 0 obj\n<< /Title (${newTitle}) >>\nendobj\n`;
  const xref = objOff + obj.length;
  const tail =
    `xref\n3 1\n${String(objOff).padStart(10, '0')} 00000 n \n` +
    `trailer\n<< /Size ${size} /Root 1 0 R /Info 3 0 R /Prev ${prev} >>\nstartxref\n${xref}\n%%EOF\n`;
  return latin1(s + obj + tail);
}

export const simple = (label: string, pages = 1, extra: Partial<PdfOpts> = {}) =>
  buildPdf({ pages: Array.from({ length: pages }, (_, i) => `${label}-${i + 1}`), ...extra });

// ---- malformed / hostile corpus (02-TRD §14 "Sandbox": truncated, encrypted, huge page count, JavaScript action, embedded file) ----

/** Cut off in the middle: xref, trailer and %%EOF are gone. */
export const truncated = () => {
  const p = simple('TRUNC', 3);
  return p.subarray(0, Math.floor(p.length * 0.6));
};

/** Xref offsets point into the wrong place and the trailer has no /Root. */
export const corruptStructure = () =>
  latin1(
    simple('CORRUPT', 2)
      .toString('latin1')
      .replace(/\/Root 1 0 R/, '')
      .replace(/endobj/g, 'endob')
  );

/** Trailer carries /Encrypt (Standard handler, synthetic key material). */
export const encrypted = () =>
  buildPdf({
    pages: ['ENC-1'],
    hook: (f) => ({
      objects: [`<< /Filter /Standard /V 1 /R 2 /O <${'ab'.repeat(32)}> /U <${'cd'.repeat(32)}> /P -4 >>`],
      trailer: `/Encrypt ${f} 0 R /ID [<${'11'.repeat(16)}><${'11'.repeat(16)}>]`,
    }),
  });

export const manyPages = (n: number) => simple('BULK', n);

/** /OpenAction JavaScript + page additional-actions JavaScript. */
export const javascriptAction = () =>
  buildPdf({
    pages: ['JS-1'],
    hook: () => ({
      catalog: '/OpenAction << /S /JavaScript /JS (app.alert\\(1\\)) >>',
      page: '/AA << /O << /S /JavaScript /JS (app.alert\\(2\\)) >> >>',
    }),
  });

/** Catalog /Names /EmbeddedFiles with one attached file. */
export const embeddedFile = () =>
  buildPdf({
    pages: ['EMB-1'],
    hook: (f) => ({
      catalog: `/Names << /EmbeddedFiles << /Names [(payload.txt) ${f} 0 R] >> >>`,
      objects: [
        `<< /Type /Filespec /F (payload.txt) /EF << /F ${f + 1} 0 R >> >>`,
        '<< /Type /EmbeddedFile /Length 11 >>\nstream\nhello-embed\nendstream',
      ],
    }),
  });

const stream = (data: string) => `<< /Length ${data.length} >>\nstream\n${data}\nendstream`;

/** AcroForm whose /XFA array carries a script-bearing template packet (no /JS or /JavaScript name anywhere). 07-SECURITY A12. */
export const xfaForm = () =>
  buildPdf({
    pages: ['XFA-1'],
    hook: (f) => ({
      catalog: `/AcroForm << /Fields [] /XFA [(template) ${f} 0 R] >>`,
      objects: [stream('<template><script contentType="application/x-javascript">x</script></template>')],
    }),
  });

/** Same, with /XFA as a single stream reference instead of an array. */
export const xfaFormSingleStream = () =>
  buildPdf({
    pages: ['XFA-2'],
    hook: (f) => ({
      catalog: `/AcroForm << /Fields [] /XFA ${f} 0 R >>`,
      objects: [stream('<xdp:xdp>xfa-payload</xdp:xdp>')],
    }),
  });

/** One-page PDF whose MediaBox does not start at the origin (outsourced / scanned files do this). */
export const offsetBox = (label: string, mediaBox = '[100 100 712 892]', pageExtra = '') =>
  buildPdf({ pages: [label], mediaBox, hook: () => ({ page: pageExtra }) });

/** One-page PDF with /Rotate (and optionally an offset box). */
export const rotated = (label: string, angle: 90 | 180 | 270, mediaBox = '[0 0 595 842]') =>
  buildPdf({ pages: [label], mediaBox, hook: () => ({ page: `/Rotate ${angle}` }) });

/** /OpenAction URI + a Link annotation URI, both pointing at the canary URL. */
export const uriCanary = (url: string) =>
  buildPdf({
    pages: ['URI-1'],
    hook: () => ({
      catalog: `/OpenAction << /S /URI /URI (${url}) >>`,
      page: `/Annots [ << /Type /Annot /Subtype /Link /Rect [0 0 100 100] /A << /S /URI /URI (${url}) >> >> ]`,
    }),
  });

export const notPdf = {
  html: latin1('<html><body>hello</body></html>'),
  png: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
  empty: Buffer.alloc(0),
  /** HTML first, a PDF later in the file: magic bytes are not at offset 0 */
  polyglot: Buffer.concat([latin1('<html><script>alert(1)</script></html>\n'), simple('POLY')]),
};

/** Valid PDF followed by whitespace padding up to `bytes` (trailing data after %%EOF). */
export const padTo = (pdf: Buffer, bytes: number) => Buffer.concat([pdf, Buffer.alloc(Math.max(0, bytes - pdf.length), 0x20)]);
