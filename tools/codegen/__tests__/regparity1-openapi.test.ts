// T0C-REGPARITY-1 (LD-310; founder request 2026-11-17 04:49 NPT, all ElabAssist registration fields) — contracts/openapi/frontdesk.yaml patient parity fields,
// the migration file 20261117100000_frontdesk__add_patient_parity_fields.sql (static checks; the database behaviour is db/tests/frontdesk_billing/T0C-REGPARITY-1_patient_parity.test.sql),
// generated-client freshness and the implementation notes.
// ASSUMPTIONS (brief silent; a different choice needs a ruling, not a silent test edit):
//  - Field names are exactly the brief's: title, external_patient_id, nationality, government_id_type, government_id_number, address_province, address_district, address_municipality,
//    address_ward, address_tole, address_postal_code, profile_photo_attachment_id, custom_fields. They are added to Patient, NewPatient and PatientUpdate (no new path, no new operation).
//  - "additive and nullable only": no field is required anywhere, existing required lists/properties are unchanged, Patient and PatientUpdate fields are `nullable: true`.
//  - title enum values may be the ElabAssist label or its lower snake_case code ("Baby of" / baby_of); the SET of 19 must match after that normalisation.
//  - government_id_number is full only on Patient (single read); PatientSummary (list / search / duplicates) has no government_id_number (a *_masked property is allowed).
//  - the implementer's notes are .orchestra/notes/T0C-REGPARITY-1-impl.md (convention of every earlier T0C task).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv-draft-04";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { staleFiles } from "../codegen";
import { lintRepo } from "../lint-openapi";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const FILE = join(ROOT, "contracts/openapi/frontdesk.yaml");
const MIG = "20261117100000_frontdesk__add_patient_parity_fields.sql";
const NOTES = join(ROOT, ".orchestra/notes/T0C-REGPARITY-1-impl.md");
const doc: any = parse(readFileSync(FILE, "utf8"));
const common: any = parse(readFileSync(join(ROOT, "contracts/openapi/_common.yaml"), "utf8"));
const S = doc.components.schemas as Record<string, any>;

const NEW = ["title", "external_patient_id", "nationality", "government_id_type", "government_id_number", "address_province", "address_district", "address_municipality",
  "address_ward", "address_tole", "address_postal_code", "profile_photo_attachment_id", "custom_fields"];
const TITLES = ["mr", "mrs", "miss", "ms", "master", "baby", "baby_of", "dr", "prof", "capt", "col", "major", "sri", "smt", "kumari", "late", "sister", "reverend", "other"];
const ID_TYPES = ["citizenship", "national_id", "passport", "driving_licence", "voter_id", "other"];
const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
const resolveRef = (s: any): any => (s?.$ref?.startsWith("#/components/schemas/") ? S[s.$ref.split("/").pop()!] : s);
const isNullable = (p: any) => p?.nullable === true;

const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
ajv.addSchema({ ...common, id: "_common.yaml" });
ajv.addSchema({ ...doc, id: "frontdesk.yaml" });
const validator = (name: string) => {
  const v = ajv.getSchema(`frontdesk.yaml#/components/schemas/${name}`);
  expect(v, `cannot resolve ${name}`).toBeDefined();
  return v!;
};

const CONSENTS = { processing: true, sms: true, whatsapp: false, email: false, share_with_referrer: false, consent_text_version: "v1" };
const PARITY = {
  title: "Mrs", external_patient_id: "MR-SYN-0001", nationality: "NP", government_id_type: "citizenship", government_id_number: "SYN-CIT-0000-4321",
  address_province: "Bagmati", address_district: "Kathmandu", address_municipality: "Synthetic Municipality", address_ward: "7", address_tole: "Synthetic Tole", address_postal_code: "44600",
  profile_photo_attachment_id: "0193c4a0-0000-7000-8000-0000000000aa", custom_fields: { blood_group: "O+", referral_note: "synthetic" },
};
const P = (name: string, f: string): any => S[name].properties[f] ?? {}; // a missing field fails its assertion, not with a TypeError
const titleOf = (v: string) => (P("NewPatient", "title").enum as (string | null)[])?.find((e) => e !== null && norm(e) === norm(v)) ?? v;
const newPatient = (o: object = {}) => ({ full_name: "Demo Patient A", sex: "female", consents: CONSENTS, ...PARITY, title: titleOf("Mrs"), ...o });

describe("T0C-REGPARITY-1 contract: frontdesk.yaml patient parity fields", () => {
  it("lintRepo reports no violation for frontdesk.yaml", async () => {
    const v = (await lintRepo(ROOT)).filter((x) => x.file === "frontdesk.yaml");
    expect(v, JSON.stringify(v.slice(0, 3))).toEqual([]);
  });

  it("is additive: same 26 paths and 29 operations, same required lists, old properties kept", () => {
    expect(Object.keys(doc.paths).length).toBe(26);
    let ops = 0;
    for (const item of Object.values<any>(doc.paths)) for (const m of ["get", "put", "post", "delete", "patch"]) if (item[m]) ops++;
    expect(ops).toBe(29);
    expect(S.NewPatient.required).toEqual(["full_name", "sex", "consents"]);
    expect(S.PatientUpdate.required ?? []).toEqual([]);
    expect(S.Patient.required).toEqual(["id", "patient_code", "full_name", "sex", "age_display", "phone_masked", "is_anonymised", "is_birth_on_estimated", "consents", "version"]);
    for (const n of ["full_name", "sex", "birth_on", "age", "phone_e164", "email", "address_text", "consents", "duplicate_override"]) expect(S.NewPatient.properties[n], `NewPatient.${n}`).toBeDefined();
    for (const n of ["full_name", "sex", "birth_on", "age", "phone_e164", "email", "address_text", "unset"]) expect(S.PatientUpdate.properties[n], `PatientUpdate.${n}`).toBeDefined();
    for (const n of ["birth_on", "is_birth_on_estimated", "phone_e164", "email", "address_text", "consents", "version"]) expect(S.Patient.properties[n], `Patient.${n}`).toBeDefined();
  });

  for (const name of ["Patient", "NewPatient", "PatientUpdate"]) {
    it(`${name} declares the 13 new fields, none required, closed object kept`, () => {
      expect(S[name].additionalProperties).toBe(false);
      for (const f of NEW) {
        expect(S[name].properties[f], `${name}.${f}`).toBeDefined();
        expect(S[name].required ?? [], `${name}.${f} must not be required`).not.toContain(f);
      }
    });
  }

  it("Patient and PatientUpdate new fields are nullable; address parts and external id are bounded strings", () => {
    for (const name of ["Patient", "PatientUpdate"]) for (const f of NEW) expect(isNullable(S[name].properties[f]), `${name}.${f} nullable`).toBe(true);
    for (const name of ["Patient", "NewPatient", "PatientUpdate"]) {
      for (const f of ["external_patient_id", "address_province", "address_district", "address_municipality", "address_ward", "address_tole", "address_postal_code", "government_id_number"]) {
        const p = S[name].properties[f];
        expect(p.type, `${name}.${f}`).toBe("string");
        expect(Number.isInteger(p.maxLength) && p.maxLength > 0 && p.maxLength <= 300, `${name}.${f} has a sane maxLength`).toBe(true);
      }
    }
  });

  it("title is an enum of exactly the 19 ElabAssist titles", () => {
    for (const name of ["Patient", "NewPatient", "PatientUpdate"]) {
      const e = (P(name, "title").enum as (string | null)[])?.filter((x): x is string => x !== null); // OAS 3.0.3: a nullable enum lists null
      expect(e, `${name}.title enum`).toBeDefined();
      expect(e.length).toBe(19);
      expect([...e.map(norm)].sort()).toEqual([...TITLES].sort());
      expect(new Set(e).size).toBe(19);
    }
  });

  it("nationality is ISO 3166 alpha-2, government_id_type has the six Nepal types and no India-only type", () => {
    for (const name of ["Patient", "NewPatient", "PatientUpdate"]) {
      const n = P(name, "nationality");
      expect(n.type).toBe("string");
      expect(n.maxLength).toBe(2);
      expect(new RegExp(n.pattern ?? "^$").test("NP")).toBe(true);
      for (const bad of ["np", "NPL", "N1", "", "N"]) expect(new RegExp(n.pattern ?? "^$").test(bad), `nationality pattern accepts ${JSON.stringify(bad)}`).toBe(false);
      expect([...(P(name, "government_id_type").enum ?? []).filter((x: unknown) => x !== null)].sort()).toEqual([...ID_TYPES].sort());
    }
    expect(JSON.stringify(S).toLowerCase()).not.toMatch(/aadhaar|aadhar|abha|health_id|srf/);
  });

  it("profile_photo_attachment_id is a Uuid and custom_fields a free JSON object", () => {
    for (const name of ["Patient", "NewPatient", "PatientUpdate"]) {
      expect(JSON.stringify(P(name, "profile_photo_attachment_id"))).toContain("Uuid");
      const c = P(name, "custom_fields");
      expect(c.type).toBe("object");
      expect(c.additionalProperties === undefined || c.additionalProperties === true || typeof c.additionalProperties === "object").toBe(true);
    }
  });

  it("PatientUpdate can clear every new optional field: nullable or listed in unset[]", () => {
    const unset = S.PatientUpdate.properties.unset;
    for (const f of NEW) {
      const clearable = isNullable(S.PatientUpdate.properties[f]) || (unset.items.enum as string[]).includes(f);
      expect(clearable, `${f} clearable`).toBe(true);
    }
    expect(unset.maxItems, "unset maxItems covers its enum").toBeGreaterThanOrEqual(unset.items.enum.length);
    expect(NEW.filter((f) => !isNullable(S.PatientUpdate.properties[f]) && !unset.items.enum.includes(f)), "fields that cannot be cleared").toEqual([]);
  });

  it("government_id_number is sensitive: documented, full only on Patient, never on PatientSummary", () => {
    const d = String(P("Patient", "government_id_number").description ?? "");
    expect(d).toMatch(/sensitive/i);
    expect(d).toContain("frontdesk.patient.read");
    expect(d).toMatch(/mask/i);
    expect(d).toMatch(/4/);
    expect(Object.keys(S.PatientSummary.properties)).not.toContain("government_id_number");
    for (const k of Object.keys(S.PatientSummary.properties).filter((k) => /government_id/.test(k))) expect(k).toMatch(/masked$/);
    for (const k of ["PatientSummaryList", "PatientRef"]) for (const p of Object.keys(resolveRef(S[k])?.properties ?? {})) expect(p).not.toBe("government_id_number");
  });

  it("generated clients and MSW handlers are fresh (codegen --check)", () => {
    expect(staleFiles(ROOT)).toEqual([]);
  }, 120_000);
});

describe("T0C-REGPARITY-1 contract: payloads (ajv)", () => {
  it("a full NewPatient validates; the old minimal one still does", () => {
    const v = validator("NewPatient");
    expect(v(newPatient()), JSON.stringify(v.errors?.[0])).toBe(true);
    expect(v({ full_name: "Demo Patient A", sex: "male", consents: CONSENTS }), JSON.stringify(v.errors?.[0])).toBe(true);
  });
  it("NewPatient rejects bad values", () => {
    const v = validator("NewPatient");
    for (const bad of [{ title: "Emperor" }, { nationality: "npl" }, { nationality: "np" }, { government_id_type: "aadhaar" }, { custom_fields: [] }, { custom_fields: "x" },
      { address_ward: "x".repeat(400) }, { profile_photo_attachment_id: "not-a-uuid" }, { unknown_field: 1 }]) {
      expect(v(newPatient(bad)), `accepted ${JSON.stringify(bad)}`).toBe(false);
    }
  });
  it("PatientUpdate takes the new fields, null clears, bad values rejected", () => {
    const v = validator("PatientUpdate");
    expect(v({ ...PARITY, title: titleOf("Mrs") }), JSON.stringify(v.errors?.[0])).toBe(true);
    expect(v({ address_tole: null, government_id_number: null, custom_fields: null, title: null }), JSON.stringify(v.errors?.[0])).toBe(true);
    for (const bad of [{ title: "Emperor" }, { nationality: "NPL" }, { government_id_type: "abha" }, { custom_fields: [1] }]) expect(v(bad), `accepted ${JSON.stringify(bad)}`).toBe(false);
  });
  it("Patient (single read) carries the new fields, all nullable", () => {
    const v = validator("Patient");
    const base = { id: "0193c4a0-0000-7000-8000-000000000005", patient_code: "P-000001", full_name: "Demo Patient A", sex: "female", age_display: "43 Years", phone_masked: "15xxxxxx00",
      is_anonymised: false, is_birth_on_estimated: false, consents: CONSENTS, version: 1 };
    expect(v({ ...base, ...PARITY, title: titleOf("Mrs") }), JSON.stringify(v.errors?.[0])).toBe(true);
    expect(v({ ...base, ...Object.fromEntries(NEW.map((f) => [f, null])) }), JSON.stringify(v.errors?.[0])).toBe(true);
    expect(v(base), "old payload still valid").toBe(true);
  });
  it("PatientSummary rejects government_id_number (additionalProperties false)", () => {
    const v = validator("PatientSummary");
    const base = { id: "0193c4a0-0000-7000-8000-000000000005", patient_code: "P-000001", full_name: "Demo Patient A", sex: "female", age_display: "43 Years", phone_masked: "15xxxxxx00", is_anonymised: false };
    expect(v(base)).toBe(true);
    expect(v({ ...base, government_id_number: "SYN-CIT-0000-4321" })).toBe(false);
  });
});

describe("T0C-REGPARITY-1 contract: example payloads included", () => {
  const ex = (m: any) => Object.values<any>(m.examples ?? {}).map((e) => e.value);
  const getEx = ex(doc.paths["/v1/frontdesk/patients/{patient_id}"].get.responses["200"].content["application/json"]);
  const createEx = ex(doc.paths["/v1/frontdesk/patients"].post.requestBody.content["application/json"]);
  const patch = doc.paths["/v1/frontdesk/patients/{patient_id}"].patch;
  it("getPatient 200 example shows every new field and validates", () => {
    expect(getEx.length).toBeGreaterThan(0);
    for (const e of getEx) {
      for (const f of NEW) expect(e, `getPatient example lacks ${f}`).toHaveProperty(f);
      const v = validator("Patient");
      expect(v(e), JSON.stringify(v.errors?.[0])).toBe(true);
    }
  });
  it("createPatient request example shows every new field and validates", () => {
    expect(createEx.length).toBeGreaterThan(0);
    for (const e of createEx) {
      for (const f of NEW) expect(e, `createPatient example lacks ${f}`).toHaveProperty(f);
      const v = validator("NewPatient");
      expect(v(e), JSON.stringify(v.errors?.[0])).toBe(true);
    }
  });
  it("updatePatient request example uses a new field and validates", () => {
    const ps = ex(patch.requestBody.content["application/json"]);
    expect(ps.length).toBeGreaterThan(0);
    expect(ps.some((e: any) => NEW.some((f) => f in e)), "no updatePatient example touches a new field").toBe(true);
    for (const e of ps) { const v = validator("PatientUpdate"); expect(v(e), JSON.stringify(v.errors?.[0])).toBe(true); }
  });
  it("examples are synthetic (no real-looking id, e-mail or phone)", () => {
    const blob = JSON.stringify([...getEx, ...createEx]);
    expect(blob).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
    expect(blob).not.toMatch(/(?<!\d)(?:\+?977[-\s]?)?9[678]\d{8}(?!\d)/);
    const gid = [...getEx, ...createEx].map((e: any) => String(e.government_id_number ?? ""));
    for (const g of gid) expect(g, "government id example must be visibly synthetic (contain SYN or Synthetic)").toMatch(/syn/i);
  });
});

describe("T0C-REGPARITY-1 migration file (static; behaviour in the pgTAP suite)", () => {
  const path = join(ROOT, "db/migrations", MIG);
  const text = existsSync(path) ? readFileSync(path, "utf8").replace(/\r\n/g, "\n") : "";
  const code = text.split("\n").filter((l) => !/^\s*--/.test(l)).map((l) => l.replace(/--.*$/, "")).join("\n");
  const comments = text.split("\n").filter((l) => /^\s*--/.test(l)).join("\n");

  it("exists, is the newest migration, runs as lims_owner", () => {
    expect(existsSync(path), `db/migrations/${MIG} missing`).toBe(true);
    const all = readdirSync(join(ROOT, "db/migrations")).filter((f) => f.endsWith(".sql")).sort();
    expect(all[all.length - 1] >= MIG).toBe(true);
    expect(all.filter((f) => f.startsWith("20261117100000"))).toEqual([MIG]);
    expect(code).toMatch(/SET LOCAL ROLE lims_owner/);
  });
  it("adds all 13 columns, each with ADD COLUMN IF NOT EXISTS", () => {
    for (const f of NEW) expect(code, f).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS\\s+"?${f}"?\\s`, "i"));
    expect((code.match(/ADD COLUMN/gi) ?? []).length).toBe((code.match(/ADD COLUMN IF NOT EXISTS/gi) ?? []).length);
    expect(code).toMatch(/frontdesk\.patients/);
  });
  it("is additive and rewrite-free: no DROP, no data statement, no type change, no NOT NULL, no policy change", () => {
    expect(code.length, "migration missing or empty").toBeGreaterThan(0);
    expect(code).not.toMatch(/\b(DROP|TRUNCATE|DELETE\s+FROM|INSERT\s+INTO|UPDATE\s+\S+\s+SET|REVOKE)\b/i);
    expect(code).not.toMatch(/ALTER\s+COLUMN|SET\s+NOT\s+NULL|ADD\s+COLUMN[^,;]*\bNOT\s+NULL|ADD\s+COLUMN[^,;]*\bDEFAULT\b/i);
    expect(code).not.toMatch(/CREATE\s+POLICY|ALTER\s+POLICY|DISABLE\s+ROW|NO\s+FORCE|ALTER\s+TABLE\s+\S+\s+(RENAME|OWNER)/i);
    expect(code).not.toMatch(/\bCREATE\s+TYPE\b|\bAS\s+ENUM\b/i);
  });
  it("every index is IF NOT EXISTS and every constraint is guarded or inline", () => {
    expect(code, "external_patient_id needs a unique index or constraint").toMatch(/external_patient_id/);
    expect(code).toMatch(/\bUNIQUE\b/i);
    for (const m of code.matchAll(/CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF NOT EXISTS)/gi)) throw new Error(`unguarded CREATE INDEX near ${m.index}`);
    for (const m of code.matchAll(/ADD\s+CONSTRAINT/gi)) {
      const before = code.slice(Math.max(0, m.index! - 600), m.index);
      expect(before, "ADD CONSTRAINT must sit in a DO block that checks pg_constraint first").toMatch(/DO\s+\$[a-z_]*\$[\s\S]*pg_constraint/i);
    }
  });
  it("extends the patients audit exclusion list with government_id_number and keeps the old six", () => {
    expect(code).toMatch(/CREATE\s+OR\s+REPLACE\s+TRIGGER\s+patients__audit/i); // no DROP allowed in this migration
    expect(code).toMatch(/tg_row_audit\([^)]*'government_id_number'/);
    for (const c of ["full_name", "name_search", "birth_on", "phone_e164", "email", "address_text"]) expect(code, c).toContain(`'${c}'`);
  });
  it("comments: sensitive column, Privacy Act 2018, lawyer, LD-310, down note, no data rewrite, push-cloud", () => {
    expect(comments).toMatch(/government_id_number/);
    expect(comments).toMatch(/sensitive/i);
    expect(comments).toMatch(/never[^\n]*(log|audit)/i);
    expect(comments).toMatch(/Individual Privacy Act[^\n]*2018|2018[^\n]*Individual Privacy Act/i);
    expect(comments).toMatch(/lawyer/i);
    expect(comments).toMatch(/LD-310/);
    expect(comments).toMatch(/\bdown\b/i);
    for (const f of NEW) expect(comments, `down note names ${f}`).toContain(f);
    expect(comments).toMatch(/DROP COLUMN/i);
    expect(comments).toMatch(/no data rewrite|does not rewrite|no rewrite/i);
    expect(comments).toMatch(/push-cloud/i);
  });
});

describe("T0C-REGPARITY-1 implementation notes", () => {
  const t = existsSync(NOTES) ? readFileSync(NOTES, "utf8") : "";
  it("state the cloud migration is a founder step (push-cloud) and name the file; privacy retention to confirm with the lawyer", () => {
    expect(existsSync(NOTES), ".orchestra/notes/T0C-REGPARITY-1-impl.md missing").toBe(true);
    expect(t).toMatch(/push-cloud/i);
    expect(t).toContain(MIG);
    expect(t).toMatch(/founder/i);
    expect(t).toMatch(/Individual Privacy Act/i);
    expect(t).toMatch(/lawyer/i);
    expect(t).toMatch(/not a blocker/i);
  });
});
