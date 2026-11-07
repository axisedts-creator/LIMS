// T0B-12: ensure the Storage buckets of 08 §4.8 (names verbatim, <owner-module>-<purpose>, exception `reports`; 08 R26), all private (REQ-SEC-034).
// LD-54 (2026-11-07, CR-C0-T0B-12 option b): SQL never touches the Storage-owned schema; buckets are ensured here through the Storage service
//   HTTP API with the server credential (08 R12b), read only from the file named by LIMS_CORE_STORAGE_KEY_FILE (C0 02-TRD §11, C1 02-TRD §8.2).
// LD-55 (2026-11-07, CR-C0-T0B-12-b): contract recorded in db/meta/decisions/SP-4.md "Provisioning contract (LD-55)": base URL env
//   LIMS_CORE_STORAGE_URL (no default), GET /bucket?limit=100&offset=N, POST /bucket, PUT /bucket/{id}; Authorization: Bearer + apikey headers.
// SP-4 api-proxied: buckets only, no end-user policies. `reporting-legacy` stays reserved (B4) and is never created.
// Idempotent: list first; a private bucket is left alone, a public one is flipped private, a missing one is created private.
// Output: only `<bucket> created|ok|flipped` lines; never the credential, URL or a response body.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const BUCKETS = [
  "reports",
  "reporting-inputs",
  "reporting-prints",
  "identity-assets",
  "identity-exports",
  "frontdesk-trf",
  "billing-exports",
  "instruments-attachments",
  "micro-imports",
  "anatomic-images",
  "partners-slips",
];

const PAGE = 100;

export const desired = (id) => ({ id, name: id, public: false });

// existing: [{ id, public }] as listed by the Storage service. Returns the requests needed, in bucket order.
export function plan(existing) {
  const byId = new Map(existing.map((b) => [b.id, b]));
  const out = [];
  for (const id of BUCKETS) {
    const b = byId.get(id);
    if (!b) out.push({ op: "create", body: desired(id) });
    else if (b.public !== false) out.push({ op: "make-private", body: desired(id) });
  }
  return out;
}

export function loadCredential(env = process.env) {
  const path = env.LIMS_CORE_STORAGE_KEY_FILE;
  if (!path) throw new Error("LIMS_CORE_STORAGE_KEY_FILE is not set");
  let value;
  try {
    value = readFileSync(path, "utf8").trim();
  } catch {
    throw new Error("file named by LIMS_CORE_STORAGE_KEY_FILE cannot be read");
  }
  if (!value) throw new Error("file named by LIMS_CORE_STORAGE_KEY_FILE is empty");
  return value;
}

// One HTTP call. Errors name only the operation, never the URL, credential or response body (LD-55 item 4).
function client(base, credential) {
  const headers = { Authorization: `Bearer ${credential}`, apikey: credential };
  return async (method, path, body, what) => {
    let res;
    try {
      res = await fetch(base + path, {
        method,
        headers: body ? { ...headers, "content-type": "application/json" } : headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new Error(`${what}: request failed`);
    }
    const text = await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, text };
  };
}

async function listAll(call) {
  const all = [];
  for (let offset = 0; ; offset += PAGE) {
    const r = await call("GET", `/bucket?limit=${PAGE}&offset=${offset}`, undefined, "list buckets");
    if (!r.ok) throw new Error(`list buckets: HTTP ${r.status}`);
    let page;
    try {
      page = JSON.parse(r.text);
    } catch {
      page = undefined;
    }
    if (!Array.isArray(page)) throw new Error("list buckets: unexpected response");
    all.push(...page);
    if (page.length < PAGE) return all;
  }
}

export async function main(env = process.env, out = process.stdout) {
  const base = (env.LIMS_CORE_STORAGE_URL ?? "").replace(/\/+$/, "");
  if (!base) throw new Error("LIMS_CORE_STORAGE_URL is not set");
  const call = client(base, loadCredential(env));
  const ops = new Map(plan(await listAll(call)).map((o) => [o.body.id, o]));
  for (const id of BUCKETS) {
    const o = ops.get(id);
    if (!o) {
      out.write(`${id} ok\n`);
    } else if (o.op === "make-private") {
      const r = await call("PUT", `/bucket/${encodeURIComponent(id)}`, { public: false }, id);
      if (!r.ok) throw new Error(`${id}: make private failed, HTTP ${r.status}`);
      out.write(`${id} flipped\n`);
    } else {
      const r = await call("POST", "/bucket", o.body, id);
      if (!r.ok) {
        // LD-55 item 4: no reliance on an 'already exists' body; accept only if a re-list shows it present and private.
        const now = (await listAll(call)).find((b) => b.id === id);
        if (!now || now.public !== false) throw new Error(`${id}: create failed, HTTP ${r.status}`);
      }
      out.write(`${id} created\n`);
    }
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  // exitCode, not process.exit(): exiting while fetch sockets close trips a libuv assertion on Windows (UV_HANDLE_CLOSING).
  main().then(
    (code) => (process.exitCode = code),
    (e) => {
      process.stderr.write(`create-storage-buckets: ${e.message}\n`);
      process.exitCode = 1;
    },
  );
}
