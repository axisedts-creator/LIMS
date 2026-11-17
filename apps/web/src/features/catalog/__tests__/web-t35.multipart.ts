// C3.T-35 test helper (ruling C3.T-35-ruling.md #4): environment-independent multipart parsing.
// jsdom swaps global File/FormData, so undici `request.formData()` fails there; parse the raw body text instead.
export type Part = { name: string; filename?: string; value: string };
export type ParsedForm = { get(k: string): string | { name: string; text: string } | null; has(k: string): boolean; keys(): string[] };

export const parseMultipart = (contentType: string, body: string): ParsedForm => {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const b = boundary?.[1] ?? boundary?.[2];
  const parts: Part[] = [];
  if (b) {
    for (const raw of body.split(`--${b}`)) {
      const sep = raw.indexOf('\r\n\r\n');
      if (sep < 0) continue;
      const head = raw.slice(0, sep);
      const name = /name="([^"]*)"/i.exec(head)?.[1];
      if (name === undefined) continue;
      parts.push({ name, filename: /filename="([^"]*)"/i.exec(head)?.[1], value: raw.slice(sep + 4).replace(/\r\n$/, '') });
    }
  }
  const find = (k: string) => parts.find((p) => p.name === k);
  return {
    get: (k) => { const p = find(k); return !p ? null : p.filename !== undefined ? { name: p.filename, text: p.value } : p.value; },
    has: (k) => !!find(k),
    keys: () => parts.map((p) => p.name),
  };
};
