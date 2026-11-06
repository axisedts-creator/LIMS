// tools/codegen/lint-openapi.ts (C0-0C, CI gate 7) — enforces 02-TRD §5.2 rules 1–8 and 07-SECURITY AB-20.
// Usage: node tools/codegen/lint-openapi.ts [repoRoot]   (exit 1 on any violation)
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv-draft-04";
import { parse, parseDocument } from "yaml";

export type Violation = { rule: string; file: string; message: string };
export type LintContext = {
  permissions: string[];
  errors: { code: string; owner: string }[];
  moduleOwners: Record<string, string>;
  portOwners: Record<string, string>;
  portConsumers: Record<string, string[]>;
};

const HERE = dirname(fileURLToPath(import.meta.url));
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
const IDEMPOTENCY = ["required", "optional", "none"];
const TIERS = ["login", "otp_request", "otp_verify", "qr_verify", "report_download", "ingest", "general"];
const HUMAN_NUMBER_PARAMS = ["barcode", "registration_no", "invoice_no", "phone"];
const FORBIDDEN_SCHEMA_KEYS = ["nullable", "const", "exclusiveMinimum", "exclusiveMaximum", "example", "not", "if", "then", "else",
  "prefixItems", "$defs", "contentMediaType", "contentEncoding"];
const SERVER_AUTHORITY_FIELDS = ["tenant_id", "created_by", "updated_by"];
const CONTEXTS = ["tenant", "platform", "identity_auth"];
// 02-TRD §11 LIMS_CORE_IDENTITY_AUTH_OPS (08 A25 D-212)
const IDENTITY_AUTH_OPS = ["loginStaff", "loginPartner", "openMobileSession", "refreshMobileSession", "logoutMobileSession",
  "confirmEmailToken", "requestPasswordRecovery", "verifyMfaChallenge", "startMfaEnrolment", "completeMfaEnrolment",
  "resolveSession", "logoutSession", "setPasswordFromSetup", "resolvePatientSession", "logoutPatientSession"];
// 02-CV §10.2 upload allowlist (08 R12b)
const UPLOAD_MIMES = ["application/pdf", "image/jpeg", "image/png", "text/csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"];
// AB-20: Nepali-mobile-shaped numbers (optional +977) and e-mail addresses in examples.
const PHI_PATTERNS: [RegExp, string][] = [
  [/(?<!\d)(?:\+?977[-\s]?)?9[678]\d{8}(?!\d)/, "Nepali-mobile-shaped number"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/, "e-mail address"],
];

// Vendored OAS 3.0 schema (OAI, see vendor/README.md), compiled once.
let oasValidate: ((d: unknown) => boolean) & { errors?: unknown[] | null };
function oas() {
  if (!oasValidate) {
    const schema = parse(readFileSync(join(HERE, "vendor/oas-3.0-schema.yaml"), "utf8"));
    const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: false });
    oasValidate = ajv.compile(schema) as typeof oasValidate;
  }
  return oasValidate;
}

const isObj = (x: unknown): x is Record<string, any> => typeof x === "object" && x !== null && !Array.isArray(x);
const nonEmptyStr = (x: unknown) => typeof x === "string" && x.trim().length > 0;

// Calls visit(schema, ptr) on every inline (non-$ref) schema node reachable from `s`.
// `deref` (optional) follows local #/components/schemas refs (rule 7 needs it; cycle-safe).
function walkSchema(s: unknown, ptr: string, visit: (s: Record<string, any>, ptr: string) => void,
  deref?: (ref: string) => unknown, seen = new Set<unknown>()) {
  if (!isObj(s) || seen.has(s)) return;
  seen.add(s);
  if (typeof s.$ref === "string") {
    if (deref) walkSchema(deref(s.$ref), s.$ref, visit, deref, seen);
    return;
  }
  visit(s, ptr);
  for (const [k, v] of Object.entries(s.properties ?? {})) walkSchema(v, `${ptr}/properties/${k}`, visit, deref, seen);
  for (const [k, v] of Object.entries(s.patternProperties ?? {})) walkSchema(v, `${ptr}/patternProperties/${k}`, visit, deref, seen);
  if (isObj(s.additionalProperties)) walkSchema(s.additionalProperties, `${ptr}/additionalProperties`, visit, deref, seen);
  const items = Array.isArray(s.items) ? s.items : [s.items];
  items.forEach((v, i) => walkSchema(v, `${ptr}/items${Array.isArray(s.items) ? `/${i}` : ""}`, visit, deref, seen));
  for (const k of ["allOf", "oneOf", "anyOf", "prefixItems"])
    if (Array.isArray(s[k])) s[k].forEach((v: unknown, i: number) => walkSchema(v, `${ptr}/${k}/${i}`, visit, deref, seen));
  for (const k of ["not", "if", "then", "else"]) walkSchema(s[k], `${ptr}/${k}`, visit, deref, seen);
  for (const [k, v] of Object.entries(isObj(s.$defs) ? s.$defs : {})) walkSchema(v, `${ptr}/$defs/${k}`, visit, deref, seen);
}

// All schema roots of a document: components + every parameter/header/media type under paths.
function schemaRoots(doc: Record<string, any>): [unknown, string][] {
  const out: [unknown, string][] = [];
  const media = (content: unknown, p: string) => {
    for (const [mt, m] of Object.entries(isObj(content) ? content : {})) if (isObj(m)) out.push([m.schema, `${p}/content/${mt}/schema`]);
  };
  const headers = (h: unknown, p: string) => {
    for (const [n, v] of Object.entries(isObj(h) ? h : {})) if (isObj(v)) { out.push([v.schema, `${p}/headers/${n}/schema`]); media(v.content, `${p}/headers/${n}`); }
  };
  const params = (ps: unknown, p: string) => {
    if (Array.isArray(ps)) ps.forEach((v, i) => { if (isObj(v)) { out.push([v.schema, `${p}/parameters/${i}/schema`]); media(v.content, `${p}/parameters/${i}`); } });
  };
  const responses = (rs: unknown, p: string) => {
    for (const [c, r] of Object.entries(isObj(rs) ? rs : {})) if (isObj(r)) { media(r.content, `${p}/responses/${c}`); headers(r.headers, `${p}/responses/${c}`); }
  };
  const c = isObj(doc.components) ? doc.components : {};
  for (const [n, s] of Object.entries(isObj(c.schemas) ? c.schemas : {})) out.push([s, `#/components/schemas/${n}`]);
  for (const [n, v] of Object.entries(isObj(c.parameters) ? c.parameters : {})) if (isObj(v)) { out.push([v.schema, `#/components/parameters/${n}/schema`]); media(v.content, `#/components/parameters/${n}`); }
  headers(c.headers, "#/components");
  responses(c.responses, "#/components");
  for (const [n, v] of Object.entries(isObj(c.requestBodies) ? c.requestBodies : {})) if (isObj(v)) media(v.content, `#/components/requestBodies/${n}`);
  for (const [path, item] of Object.entries(isObj(doc.paths) ? doc.paths : {})) {
    if (!isObj(item)) continue;
    params(item.parameters, `#/paths/${path}`);
    for (const m of METHODS) {
      const op = item[m];
      if (!isObj(op)) continue;
      const p = `#/paths/${path}/${m}`;
      params(op.parameters, p);
      if (isObj(op.requestBody)) media(op.requestBody.content, `${p}/requestBody`);
      responses(op.responses, p);
    }
  }
  return out;
}

// Generic walk over every object in the document (for $ref siblings and example scanning).
function walkAll(x: unknown, ptr: string, visit: (o: Record<string, any>, ptr: string, key: string) => void, key = "") {
  if (Array.isArray(x)) x.forEach((v, i) => walkAll(v, `${ptr}/${i}`, visit, key));
  else if (isObj(x)) {
    visit(x, ptr, key);
    for (const [k, v] of Object.entries(x)) walkAll(v, `${ptr}/${k}`, visit, k);
  }
}
function leaves(x: unknown, out: string[] = []): string[] {
  if (Array.isArray(x)) x.forEach((v) => leaves(v, out));
  else if (isObj(x)) Object.values(x).forEach((v) => leaves(v, out));
  else if (typeof x === "string" || typeof x === "number") out.push(String(x));
  return out;
}

const hasExample = (content: unknown) =>
  Object.values(isObj(content) ? content : {}).some((m) => isObj(m) && ((isObj(m.examples) && Object.keys(m.examples).length > 0) || m.example !== undefined));

// Action endpoint (CV §4.1, [CONV]): POST on `/…/{id}/<action>` or `/…/bulk-<action>`.
function isActionEndpoint(method: string, path: string) {
  if (method !== "post") return false;
  const seg = path.split("/").filter(Boolean);
  const last = seg[seg.length - 1] ?? "";
  return !last.startsWith("{") && ((seg[seg.length - 2] ?? "").startsWith("{") || last.startsWith("bulk-"));
}

function errorCodeAllowed(code: string, owner: string, module: string, ctx: LintContext) {
  if (owner === "C0" || owner === ctx.moduleOwners[module]) return true;
  if (owner === "C2" && code.startsWith("auth.")) return true;
  // port-propagated code (08 A17 P-23)
  return Object.entries(ctx.portConsumers).some(([port, consumers]) => consumers.includes(module) && ctx.portOwners[port] === owner);
}

export function lintOpenapi(files: { name: string; text: string }[], ctx: LintContext): Violation[] {
  const out: Violation[] = [];
  const permissions = new Set(ctx.permissions);
  const errors = new Map(ctx.errors.map((e) => [e.code, e.owner]));
  const opIds = new Map<string, string>();

  for (const { name, text } of files) {
    const v = (rule: string, message: string) => out.push({ rule, file: name, message });

    // ---- rule 1: parse, OAS 3.0 schema, openapi 3.0.3
    const parsed = parseDocument(text, { uniqueKeys: true, prettyErrors: false });
    if (parsed.errors.length) { v("1", `YAML: ${parsed.errors[0].message}`); continue; }
    const doc = parsed.toJS({ maxAliasCount: 100 });
    if (!isObj(doc)) { v("1", "document is not a mapping"); continue; }
    if (doc.openapi !== "3.0.3") v("1", `openapi must be 3.0.3, got ${JSON.stringify(doc.openapi)}`);
    const validate = oas();
    if (!validate(doc)) v("1", `OAS 3.0 schema: ${JSON.stringify(validate.errors?.[0])}`);

    // ---- rule 2: forbidden constructs
    if ("webhooks" in doc) v("2", "top-level webhooks is forbidden");
    walkAll(doc, "#", (o, ptr, key) => {
      if (key === "examples" || key === "example") return;
      if (typeof o.$ref === "string" && Object.keys(o).length > 1) v("2", `${ptr}: $ref with sibling keys`);
    });
    const roots = schemaRoots(doc);
    for (const [root, rptr] of roots) {
      walkSchema(root, rptr, (s, ptr) => {
        for (const k of FORBIDDEN_SCHEMA_KEYS) if (k in s) v("2", `${ptr}: '${k}' is forbidden in schemas`);
        if (Array.isArray(s.type)) v("2", `${ptr}: type arrays are forbidden`);
        // ---- rule 3: closed, bounded schemas
        if (s.type === "object" || isObj(s.properties)) {
          if (s.additionalProperties !== false) v("3", `${ptr}: object needs additionalProperties: false`);
        }
        if (s.type === "string" && typeof s.maxLength !== "number") v("3", `${ptr}: string needs maxLength`);
        if (s.type === "array" && typeof s.maxItems !== "number") v("3", `${ptr}: array needs maxItems`);
        if (s.type === "integer" && (typeof s.minimum !== "number" || typeof s.maximum !== "number"))
          v("3", `${ptr}: integer needs minimum and maximum`);
        // ---- rule 6: coded sets vs enum
        if ("x-coded-set" in s) {
          if (!nonEmptyStr(s["x-coded-set"])) v("6", `${ptr}: x-coded-set needs a coded-set name`);
          if ("enum" in s) v("6", `${ptr}: coded-set field must not also declare enum`);
        }
      });
    }

    // ---- rule 4/5/7/8: operations and paths
    const deref = (ref: string) => {
      const m = /^#\/components\/schemas\/([^/]+)$/.exec(ref);
      return m ? doc.components?.schemas?.[m[1]] : undefined;
    };
    for (const [path, item] of Object.entries(isObj(doc.paths) ? doc.paths : {})) {
      if (!path.startsWith(`/v1/${name}/`)) v("5", `${path}: path must start with /v1/${name}/`);
      for (const p of path.match(/\{[^}]+\}/g) ?? [])
        if (HUMAN_NUMBER_PARAMS.includes(p.slice(1, -1))) v("5", `${path}: human number ${p} as path parameter (REQ-SEC-098)`);
      if (!isObj(item)) continue;
      for (const method of METHODS) {
        const op = item[method];
        if (!isObj(op)) continue;
        const at = `${method.toUpperCase()} ${path}`;
        const id = op.operationId;
        // rule 4
        if (typeof id !== "string" || !/^[a-z][a-zA-Z0-9]*$/.test(id)) v("4", `${at}: operationId missing or not lowerCamel`);
        else if (opIds.has(id)) v("4", `${at}: operationId ${id} duplicates one in ${opIds.get(id)}`);
        else opIds.set(id, name);
        if (!Array.isArray(op.tags) || op.tags.length !== 1 || op.tags[0] !== name) v("4", `${at}: tags must be [${name}]`);
        if (!nonEmptyStr(op.summary)) v("4", `${at}: summary required`);
        if (!Array.isArray(op.security)) v("4", `${at}: security required`);
        const hasPerm = "x-permission" in op, hasPublic = "x-public" in op;
        if (hasPerm === hasPublic) v("4", `${at}: exactly one of x-permission / x-public`);
        if (hasPerm && !permissions.has(op["x-permission"])) v("4", `${at}: x-permission ${op["x-permission"]} not in permissions.yaml`);
        if (hasPublic && !nonEmptyStr(op["x-public"])) v("4", `${at}: x-public needs a non-empty justification`);
        if (!IDEMPOTENCY.includes(op["x-idempotency"])) v("4", `${at}: x-idempotency must be one of ${IDEMPOTENCY.join("|")}`);
        if (method === "post" && op["x-idempotency"] === "none" && !/^E[12] /.test(op["x-idempotency-justification"] ?? ""))
          v("4", `${at}: POST with x-idempotency none needs x-idempotency-justification starting 'E1 ' or 'E2 ' (P-8)`);
        if (!TIERS.includes(op["x-rate-limit-tier"])) v("4", `${at}: x-rate-limit-tier must be one of ${TIERS.join("|")}`);
        if (!Array.isArray(op["x-error-codes"])) v("4", `${at}: x-error-codes required`);
        else for (const code of op["x-error-codes"]) {
          const owner = errors.get(code);
          if (owner === undefined) v("4", `${at}: error code ${code} not in errors.yaml`);
          else if (!errorCodeAllowed(code, owner, name, ctx)) v("4", `${at}: error code ${code} (owner ${owner}) not usable by module ${name} (P-23)`);
        }
        const body = isObj(op.requestBody) && !op.requestBody.$ref ? op.requestBody : undefined;
        if (body && !hasExample(body.content)) v("4", `${at}: request body needs at least one example`);
        const inline = Object.values(isObj(op.responses) ? op.responses : {}).filter((r) => isObj(r) && !r.$ref && isObj(r.content));
        if (inline.length && !inline.some((r: any) => hasExample(r.content))) v("4", `${at}: needs at least one response example`);

        // rule 7: server-authority fields in request bodies
        if (body) {
          const action = isActionEndpoint(method, path);
          for (const m of Object.values(isObj(body.content) ? body.content : {})) {
            walkSchema(isObj(m) ? m.schema : undefined, `${at} requestBody`, (s, ptr) => {
              for (const f of Object.keys(isObj(s.properties) ? s.properties : {}))
                if (SERVER_AUTHORITY_FIELDS.includes(f) || (f === "status" && !action)) v("7", `${ptr}: request body declares ${f}`);
            }, deref);
          }
        }

        // rule 8: extensions (08 §4.11)
        const xc = op["x-context"];
        if (xc !== undefined && !CONTEXTS.includes(xc)) v("8", `${at}: x-context must be tenant|platform|identity_auth`);
        if (xc === "identity_auth") {
          if (name !== "identity") v("8", `${at}: x-context identity_auth only in identity.yaml (D-212)`);
          if (!IDENTITY_AUTH_OPS.includes(id)) v("8", `${at}: ${id} not in LIMS_CORE_IDENTITY_AUTH_OPS (D-212)`);
          if (!nonEmptyStr(op["x-public"])) v("8", `${at}: x-context identity_auth needs x-public with justification (D-212)`);
        }
        if ("x-edge-exposure" in op && !["public", "internal"].includes(op["x-edge-exposure"])) v("8", `${at}: x-edge-exposure must be public|internal`);
        if ("x-anonymous-tx" in op && (op["x-anonymous-tx"] !== true || name !== "reporting" || !hasPublic))
          v("8", `${at}: x-anonymous-tx: true only in reporting.yaml with x-public`);
        if ("x-raw-body" in op && (op["x-raw-body"] !== true || name !== "reporting")) v("8", `${at}: x-raw-body: true only in reporting.yaml`);
        const html = Object.values(isObj(op.responses) ? op.responses : {}).some((r) => isObj(r) && isObj(r.content) && "text/html" in r.content);
        const cbToken = Array.isArray(op.security) && op.security.some((s: unknown) => isObj(s) && "paymentCallbackToken" in s);
        if (html && (name !== "payments" || !(hasPublic || cbToken))) v("8", `${at}: text/html only for payments operations with x-public or paymentCallbackToken`);
        const upload = body && isObj(body.content) && "multipart/form-data" in body.content;
        if (upload && !Array.isArray(op["x-upload"])) v("8", `${at}: upload operation needs x-upload`);
        if ("x-upload" in op && (!Array.isArray(op["x-upload"]) || op["x-upload"].some((m: unknown) => !UPLOAD_MIMES.includes(m as string))))
          v("8", `${at}: x-upload must be a list within the 02-CV §10.2 allowlist`);
      }
    }

    // ---- AB-20: no PHI-shaped data in examples
    walkAll(doc, "#", (o, ptr) => {
      for (const k of ["example", "examples"]) {
        if (!(k in o)) continue;
        for (const s of leaves(o[k]))
          for (const [re, what] of PHI_PATTERNS) if (re.test(s)) v("AB-20", `${ptr}/${k}: example contains a ${what}`);
      }
    });
  }
  return out;
}

// CM §3 module → owning chunk (api modules) and 02-TRD §6.3 PORT_OWNERS (port → module).
const MODULE_OWNERS: Record<string, string> = {
  core: "C0", identity: "C2", catalog: "C3", frontdesk: "C4", billing: "C4", lab: "C5", reporting: "C6", instruments: "C7",
  analytics: "C8", quality: "C9", micro: "C10", anatomic: "C11", inventory: "C12", partners: "C13", smartreport: "C14",
  payments: "C15", engagement: "C16", homecollection: "C17",
};
const PORT_MODULES: Record<string, string> = {
  CatalogPort: "catalog", FrontdeskPort: "frontdesk", BillingPort: "billing", LabPort: "lab", ReportingPort: "reporting",
  NotificationPort: "reporting", IdentityPort: "identity", PaymentProviderPort: "payments", SmartReportPort: "smartreport",
  QualityPort: "quality", BillingCommandPort: "billing", RenderPort: "reporting", EngagementPort: "engagement",
};

export async function lintRepo(rootDir: string): Promise<Violation[]> {
  const read = (p: string) => readFileSync(join(rootDir, p), "utf8");
  const perms = parse(read("contracts/permissions.yaml"));
  const errs = parse(read("contracts/errors.yaml"));
  const ctx: LintContext = {
    permissions: perms.permissions.map((p: { code: string }) => p.code),
    errors: errs.map((e: { code: string; owner: string }) => ({ code: e.code, owner: e.owner })),
    moduleOwners: MODULE_OWNERS,
    portOwners: Object.fromEntries(Object.entries(PORT_MODULES).map(([p, m]) => [p, MODULE_OWNERS[m]])),
    // ponytail: empty until T0C-05 gen-port-consumers emits contracts/ports/generated/port-consumers.ts; wire it in then.
    portConsumers: {},
  };
  const dir = join(rootDir, "contracts/openapi");
  const files = readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort()
    .map((f) => ({ name: f.replace(/\.yaml$/, ""), text: readFileSync(join(dir, f), "utf8") }));
  return lintOpenapi(files, ctx);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const v = await lintRepo(resolve(process.argv[2] ?? join(HERE, "../..")));
  for (const x of v) console.error(`${x.file}: [rule ${x.rule}] ${x.message}`);
  process.exit(v.length ? 1 : 0);
}
