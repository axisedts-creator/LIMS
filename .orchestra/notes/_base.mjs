import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const inv = JSON.parse(readFileSync("db/meta/definer-inventory.yaml", "utf8").split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join("\n")).definers;
const rep = /^app\.reporting_(verify_qr|resolve_portal_credential|ingest_provider_callback|redeem_link_for_app)$/;
const rows = Object.entries(inv).filter(([k]) => !rep.test(k)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, d]) => [k, d.owner, d.execute]);
console.log(Object.keys(inv).length, rows.length, createHash("sha256").update(JSON.stringify(rows)).digest("hex"));
