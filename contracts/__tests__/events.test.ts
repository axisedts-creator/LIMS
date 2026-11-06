// T0C-01 / AC-0C-1.1 — contracts/events/ holds exactly the 25 event schemas of IC §3.25 (incl. §3.26)
// plus _envelope.v1 and _defs.v1; each IC example validates; event_type pattern; strictness (REQ-SEC-080).
// Source of truth = spec/program/03-INTERFACE-CATALOG.md (IC §2.1, §2.2, §3.x, §3.25).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const contractsDir = resolve(here, "..");
const eventsDir = resolve(contractsDir, "events");
const IC_PATH = resolve(here, "../../spec/program/03-INTERFACE-CATALOG.md");
const IC = readFileSync(IC_PATH, "utf8").replace(/\r\n/g, "\n");

const EXPECTED_COUNT = 25;
const V7 = (n: string) => `01a1a98a-ac40-7000-8000-${n}`;

// ---------- IC extraction ----------
/** Text of IC "### <num> ..." up to the next "### "/"## " heading. */
function icSection(num: string): string {
  const start = IC.search(new RegExp(`^### ${num.replace(".", "\\.")} `, "m"));
  if (start < 0) throw new Error(`IC §${num} heading not found`);
  const rest = IC.slice(start + 4);
  const end = rest.search(/^#{2,3} /m);
  return IC.slice(start, end < 0 ? undefined : start + 4 + end);
}
const jsonFences = (s: string): string[] => [...s.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1]!);

interface IcEvent {
  num: string;
  type: string;
  section: string;
  aggregate: string;
  example: unknown; // payload, or full envelope when `isEnvelope`
  isEnvelope: boolean;
  defs: Record<string, any>; // fenced "Payload"/"Item"/... definitions
}

function loadIcEvents(): IcEvent[] {
  const nums = [...Array.from({ length: 24 }, (_, i) => `3.${i + 1}`), "3.26"];
  return nums.map((num) => {
    const section = icSection(num);
    const type = /^### \S+ `([a-z_.0-9]+\.v[0-9]+)`/.exec(section)?.[1];
    if (!type) throw new Error(`IC §${num}: event type not in heading`);
    const aggregate = /\|\s*Aggregate\s*\|\s*`([a-z_]+)`/.exec(section)?.[1];
    if (!aggregate) throw new Error(`IC §${num}: aggregate type not in header table`);
    // definitions: the fence that starts with `"Payload":`
    const defsFence = jsonFences(section).find((f) => f.trimStart().startsWith('"Payload"'));
    if (!defsFence) throw new Error(`IC §${num}: Payload fence not found`);
    const defs = JSON.parse(`{${defsFence}}`);
    // example: full envelope ("Example:" + fence) or payload (fence or inline backticks)
    const env = /\nExample:\n\n```json\n([\s\S]*?)\n```/.exec(section);
    const pay = /Example payload[^\n`:]*:\s*(?:```json\n([\s\S]*?)\n```|`(\{[^\n]*\})`)/.exec(section);
    const raw = env ? env[1]! : pay ? (pay[1] ?? pay[2]!) : undefined;
    if (!raw) throw new Error(`IC §${num}: example not found`);
    return { num, type, section, aggregate, example: JSON.parse(raw), isEnvelope: !!env, defs };
  });
}
const icEvents = loadIcEvents();

/** Minimal valid envelope around a payload example. */
const wrap = (e: IcEvent, payload: unknown) => ({
  event_id: V7("0000000e9001"),
  event_type: e.type,
  tenant_id: V7("00000000a001"),
  occurred_at: "2026-11-05T02:31:12.004Z",
  actor: { type: "system", id: "6f1c2d3e-4b5a-4c6d-9e8f-0a1b2c3d4e5f" },
  idempotency_key: "k:1",
  producer: e.type.split(".")[0],
  aggregate: { type: e.aggregate, id: V7("000000050001"), seq: 1 },
  request_id: V7("0000000f9001"),
  payload,
});
const envelopeOf = (e: IcEvent) => (e.isEnvelope ? (e.example as any) : wrap(e, e.example));

// ---------- schema loading ----------
const readJson = (f: string): any => JSON.parse(readFileSync(resolve(eventsDir, f), "utf8"));
const schemaFiles = (): string[] =>
  existsSync(eventsDir) ? readdirSync(eventsDir).filter((f) => f.endsWith(".schema.json")).sort() : [];
const fileOf = (type: string) => `${type}.schema.json`;

function buildAjv() {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  for (const f of schemaFiles()) ajv.addSchema(readJson(f));
  return ajv;
}
const validatorFor = (type: string) => {
  const v = buildAjv().getSchema(`urn:lims:event:${type}`);
  if (!v) throw new Error(`no schema registered under urn:lims:event:${type}`);
  return v;
};

// ---------- tests ----------
describe("T0C-01 package + file set (AC-0C-1.1)", () => {
  it("contracts/package.json is the @lims/contracts package", () => {
    const p = resolve(contractsDir, "package.json");
    expect(existsSync(p), "contracts/package.json missing").toBe(true);
    expect(JSON.parse(readFileSync(p, "utf8")).name).toBe("@lims/contracts");
  });

  it("IC §3.25 matrix lists exactly 25 events and matches the §3 headings", () => {
    const rows = [...icSection("3.25").matchAll(/^\| (\d+) \| ([a-z_.0-9]+\.v\d+)/gm)].map((m) => m[2]!);
    expect(rows).toHaveLength(EXPECTED_COUNT);
    expect(new Set(rows).size).toBe(EXPECTED_COUNT);
    expect(rows.sort()).toEqual(icEvents.map((e) => e.type).sort());
    expect(rows).toContain("instruments.calibration.received.v1");
  });

  it("contracts/events/ holds exactly 25 event schemas + _envelope.v1 + _defs.v1, nothing else", () => {
    expect(existsSync(eventsDir), "contracts/events/ missing").toBe(true);
    const expected = [
      "_defs.v1.schema.json",
      "_envelope.v1.schema.json",
      ...icEvents.map((e) => fileOf(e.type)),
    ].sort();
    expect(readdirSync(eventsDir).sort()).toEqual(expected);
    expect(expected).toHaveLength(EXPECTED_COUNT + 2);
  });
});

describe("T0C-01 shared schemas equal IC §2", () => {
  const block = (heading: string) => JSON.parse(jsonFences(IC.slice(IC.indexOf(heading)))[0]!);
  it("_defs.v1.schema.json deep-equals IC §2.1", () => {
    expect(readJson("_defs.v1.schema.json")).toEqual(block("### 2.1 "));
  });
  it("_envelope.v1.schema.json deep-equals IC §2.2", () => {
    expect(readJson("_envelope.v1.schema.json")).toEqual(block("### 2.2 "));
  });
});

describe.each(icEvents)("T0C-01 $type (IC §$num)", (e) => {
  const schema = () => readJson(fileOf(e.type));

  it("follows the IC template (id, envelope ref, consts, Payload ref)", () => {
    const s = schema();
    expect(s.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(s.$id).toBe(`urn:lims:event:${e.type}`);
    expect(s.allOf?.[0]).toEqual({ $ref: "urn:lims:event:_envelope.v1" });
    const p = s.allOf?.[1]?.properties;
    expect(p?.event_type).toEqual({ const: e.type });
    expect(p?.producer).toEqual({ const: e.type.split(".")[0] });
    expect(p?.aggregate?.properties?.type).toEqual({ const: e.aggregate });
    expect(p?.payload).toEqual({ $ref: "#/$defs/Payload" });
    expect(s.$defs?.Payload?.additionalProperties).toBe(false);
  });

  it("$defs equal the IC fenced definitions", () => {
    expect(schema().$defs).toEqual(e.defs);
  });

  it("IC example validates (full envelope)", () => {
    const v = validatorFor(e.type);
    const env = envelopeOf(e);
    expect(v(env), JSON.stringify(v.errors)).toBe(true);
  });

  it("rejects: unknown payload field, missing required payload field, wrong event_type/producer/aggregate", () => {
    const v = validatorFor(e.type);
    const env = envelopeOf(e);
    const clone = () => structuredClone(env);

    const extra = clone();
    extra.payload.__unexpected = 1;
    expect(v(extra), "unknown payload field accepted").toBe(false);

    const req: string[] = e.defs.Payload.required ?? [];
    expect(req.length).toBeGreaterThan(0);
    for (const k of req) {
      const m = clone();
      delete m.payload[k];
      expect(v(m), `payload accepted without required "${k}"`).toBe(false);
    }

    const bad = clone();
    bad.event_type = e.type.replace(/\.v1$/, ".v2");
    expect(v(bad), "wrong event_type accepted").toBe(false);

    const prod = clone();
    prod.producer = prod.producer === "lab" ? "billing" : "lab";
    expect(v(prod), "wrong producer accepted").toBe(false);

    const agg = clone();
    agg.aggregate.type = "not_" + e.aggregate;
    expect(v(agg), "wrong aggregate.type accepted").toBe(false);
  });
});

describe("T0C-01 event_type pattern + envelope strictness", () => {
  const env = () => validatorFor("frontdesk.order.created.v1");
  const base = () => structuredClone(envelopeOf(icEvents[0]!));

  // pattern tested on the envelope schema alone (payload unconstrained there)
  const envOnly = () => buildAjv().getSchema("urn:lims:event:_envelope.v1")!;
  const e0 = icEvents[0]!;
  const withType = (t: string) => ({ ...wrap(e0, {}), event_type: t });

  it.each(["frontdesk.order.created.v1", "lab.result.verified.v12", "catalog.changed.v1", "a_b.c_d.e_f.v0"])(
    "accepts %s",
    (t) => expect(envOnly()(withType(t)), JSON.stringify(envOnly().errors)).toBe(true),
  );

  it.each([
    "Frontdesk.order.created.v1", // uppercase
    "frontdesk.order.created", // no version
    "frontdesk.order.created.v", // empty version
    "frontdesk.order.created.v1x",
    "frontdesk.order.v1", // 3 segments, not catalog
    "billing.changed.v1", // two-segment form is catalog-only
    "a.b.c.d.v1", // too many segments
    "frontdesk-order.created.v1", // hyphen
    "frontdesk.order.created.v1\n", // trailing newline
    "frontdesk.order.created.v1; DROP TABLE core.event_log",
    "../frontdesk.order.created.v1",
    "",
  ])("rejects %j", (t) => expect(envOnly()(withType(t))).toBe(false));

  it("rejects non-UUIDv7 ids (v4 tenant_id, v4 event_id)", () => {
    const v4 = "6f1c2d3e-4b5a-4c6d-9e8f-0a1b2c3d4e5f";
    for (const k of ["tenant_id", "event_id", "request_id"]) {
      const m = base();
      m[k] = v4;
      expect(env()(m), `${k} v4 accepted`).toBe(false);
    }
  });

  it("rejects envelope: unknown field, missing tenant_id/idempotency_key/payload, long key, bad seq, non-UTC time", () => {
    const check = (mut: (m: any) => void, why: string) => {
      const m = base();
      mut(m);
      expect(env()(m), why).toBe(false);
    };
    check((m) => (m.extra = 1), "unknown envelope field accepted");
    check((m) => delete m.tenant_id, "missing tenant_id accepted");
    check((m) => delete m.idempotency_key, "missing idempotency_key accepted");
    check((m) => delete m.payload, "missing payload accepted");
    check((m) => (m.idempotency_key = "x".repeat(201)), "201-char idempotency_key accepted");
    check((m) => (m.idempotency_key = ""), "empty idempotency_key accepted");
    check((m) => (m.aggregate.seq = 0), "aggregate.seq 0 accepted");
    check((m) => (m.occurred_at = "2026-11-05T02:31:12+05:45"), "offset timestamp accepted");
    check((m) => (m.occurred_at = "2026-11-05T02:31:12Z"), "timestamp without ms accepted");
    check((m) => (m.actor.type = "admin"), "unknown actor.type accepted");
    check((m) => (m.actor.extra = 1), "unknown actor field accepted");
  });
});

describe("T0C-01 payload strictness + PHI hygiene (REQ-SEC-080, IC §1 PHI class)", () => {
  /** Every object schema with `properties` must say additionalProperties:false. */
  function lax(node: any, path: string, out: string[]) {
    if (Array.isArray(node)) return node.forEach((n, i) => lax(n, `${path}[${i}]`, out));
    if (!node || typeof node !== "object") return;
    if (node.properties && node.additionalProperties !== false) out.push(path);
    for (const [k, v] of Object.entries(node)) if (k !== "enum" && k !== "const" && k !== "required") lax(v, `${path}/${k}`, out);
  }
  it.each(icEvents)("$type: no payload object allows unknown fields", (e) => {
    const out: string[] = [];
    lax(readJson(fileOf(e.type)).$defs, "$defs", out);
    expect(out).toEqual([]);
  });

  const DIRECT_IDENTIFIERS = /^(patient_)?(first_|last_|full_)?name$|^phone|^mobile|^email|^dob$|^date_of_birth$|^registration_no$|^national_id$|^address$/;
  it.each(icEvents)("$type: no direct-identifier property names in payload", (e) => {
    const names: string[] = [];
    const walk = (n: any) => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== "object") return;
      if (n.properties) names.push(...Object.keys(n.properties));
      Object.values(n).forEach(walk);
    };
    walk(readJson(fileOf(e.type)).$defs);
    expect(names.filter((k) => DIRECT_IDENTIFIERS.test(k))).toEqual([]);
  });
});
