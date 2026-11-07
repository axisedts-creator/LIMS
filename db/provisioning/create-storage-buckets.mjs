// T0B-12: ensure the Storage buckets of 08 §4.8 (names verbatim, <owner-module>-<purpose>, exception `reports`; 08 R26), all private (REQ-SEC-034).
// LD-54 (2026-11-07, CR-C0-T0B-12 option b): SQL never touches the Storage-owned schema; buckets are ensured here through the Storage service
//   HTTP API with the server credential (08 R12b), read only from the file named by LIMS_CORE_STORAGE_KEY_FILE (C0 02-TRD §11, C1 02-TRD §8.2).
// SP-4 api-proxied: buckets only, no end-user policies. `reporting-legacy` stays reserved (B4) and is never created.
// Idempotent: an existing private bucket is left alone, an existing public one is flipped private, a missing one is created private.
//
// BLOCKED (CR-C0-T0B-12-b, .orchestra/cr/T0B-12.provisioning-contract.md): the Storage base-URL env name and the bucket list/create/update
//   endpoints are not recorded in db/meta/decisions/SP-4.md or the C0/C1 TRD, and LD-54 forbids guessing them. Until the lead rules, main()
//   loads the credential and the plan, then exits 2 without any network call. Then send plan(list) to the recorded endpoints.
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
  const value = readFileSync(path, "utf8").trim();
  if (!value) throw new Error("file named by LIMS_CORE_STORAGE_KEY_FILE is empty");
  return value;
}

export async function main() {
  loadCredential();
  process.stderr.write(
    "create-storage-buckets: Storage base-URL env and bucket endpoints not recorded (CR-C0-T0B-12-b); no request sent.\n",
  );
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`create-storage-buckets: ${e.message}\n`);
      process.exit(1);
    },
  );
}
