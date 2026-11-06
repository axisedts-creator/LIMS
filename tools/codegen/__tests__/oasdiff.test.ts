// T0C-06 / AC-0C-2.2 — oasdiff gate (CI gate 6). Script under test: tools/codegen/oasdiff.sh
// Contract the implementation must satisfy:
//   oasdiff.sh <base.yaml> <head.yaml>   (wrong arg count -> exit 2, oasdiff never run)
//   runs exactly: oasdiff breaking <base> <head> --fail-on ERR   (02-TRD CI gate 6)
//   exit 0 when oasdiff exits 0; nonzero when oasdiff exits 1 (breaking found)
//   bypass: env PR_LABELS (comma/newline/space separated, exact token match) containing
//           `cr-approved-breaking` turns oasdiff exit 1 into exit 0 (notice mentioning the label printed).
//   fail closed: label never masks other oasdiff failures (exit >1, e.g. unparsable spec),
//           nor a missing oasdiff binary / unreadable file (nonzero).
// Stub tests use a fake `oasdiff` on PATH; real-fixture tests run only if a real oasdiff is installed.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, "../oasdiff.sh");
const FX = join(HERE, "fixtures/oasdiff");
const BASE = join(FX, "base.yaml");
const BREAKING = join(FX, "head-breaking.yaml");
const COMPATIBLE = join(FX, "head-compatible.yaml");
const LABEL = "cr-approved-breaking";

const tmp = mkdtempSync(join(tmpdir(), "oasdiff-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const posix = (p: string) => p.replace(/\\/g, "/");
const realOasdiff = spawnSync("bash", ["-c", "command -v oasdiff"]).status === 0;

// stub `oasdiff`: records argv (one per line) to $STUB_LOG, exits $STUB_EXIT
const stubDir = join(tmp, "stub");
mkdirSync(stubDir, { recursive: true });
writeFileSync(join(stubDir, "oasdiff"), '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$STUB_LOG"\nexit "${STUB_EXIT:-0}"\n');
chmodSync(join(stubDir, "oasdiff"), 0o755);

let n = 0;
function run(args: string[], opts: { exit?: number; labels?: string; stub?: boolean } = {}) {
  const log = join(tmp, `argv-${n++}.log`);
  const env: NodeJS.ProcessEnv = { ...process.env, STUB_LOG: posix(log), STUB_EXIT: String(opts.exit ?? 0) };
  delete env.PR_LABELS;
  if (opts.labels !== undefined) env.PR_LABELS = opts.labels;
  if (opts.stub !== false) env.PATH = stubDir + delimiter + (process.env.PATH ?? "");
  const r = spawnSync("bash", [posix(SCRIPT), ...args.map(posix)], { env, encoding: "utf8" });
  const argv = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : null;
  return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? ""), argv };
}

describe("oasdiff.sh — stubbed oasdiff", () => {
  it("script exists with bash shebang and strict mode", () => {
    expect(existsSync(SCRIPT)).toBe(true);
    const t = readFileSync(SCRIPT, "utf8");
    expect(t).toMatch(/^#!\/(usr\/bin\/env bash|bin\/bash)/);
    expect(t).toMatch(/set -[a-z]*e[a-z]*u|set -euo pipefail/);
  });

  it("invokes exactly `oasdiff breaking <base> <head> --fail-on ERR`", () => {
    const r = run([BASE, COMPATIBLE]);
    expect(r.argv).toEqual(["breaking", posix(BASE), posix(COMPATIBLE), "--fail-on", "ERR"]);
    expect(r.status).toBe(0);
  });

  it("no breaking change (oasdiff 0) -> exit 0 without label", () => {
    expect(run([BASE, COMPATIBLE], { exit: 0 }).status).toBe(0);
  });

  it("breaking change (oasdiff 1) without label -> nonzero  [AC-0C-2.2]", () => {
    const r = run([BASE, BREAKING], { exit: 1 });
    expect(r.status).not.toBeNull();
    expect(r.status).not.toBe(0);
  });

  it("breaking change with PR_LABELS=cr-approved-breaking -> exit 0, oasdiff still ran", () => {
    const r = run([BASE, BREAKING], { exit: 1, labels: LABEL });
    expect(r.status).toBe(0);
    expect(r.argv).not.toBeNull();
    expect(r.out).toContain(LABEL);
  });

  it.each([
    ["comma list", `bug,${LABEL},docs`],
    ["newline list", `bug\n${LABEL}\ndocs`],
    ["space list", `bug ${LABEL} docs`],
  ])("label recognised: %s", (_n, labels) => {
    expect(run([BASE, BREAKING], { exit: 1, labels }).status).toBe(0);
  });

  it.each([
    ["empty labels", ""],
    ["other labels", "bug,docs"],
    ["superstring prefix", `not-${LABEL}-x`],
    ["truncated", "cr-approved"],
    ["wrong case", "CR-Approved-Breaking"],
    ["suffix glued", `${LABEL}s`],
  ])("label NOT recognised: %s -> still fails", (_n, labels) => {
    expect(run([BASE, BREAKING], { exit: 1, labels }).status).not.toBe(0);
  });

  it("label does not mask non-breaking oasdiff failure (exit 101) — fail closed", () => {
    expect(run([BASE, BREAKING], { exit: 101, labels: LABEL }).status).not.toBe(0);
  });

  it.skipIf(realOasdiff)("oasdiff missing from PATH -> nonzero, even with label", () => {
    expect(run([BASE, BREAKING], { stub: false }).status).not.toBe(0);
    expect(run([BASE, BREAKING], { stub: false, labels: LABEL }).status).not.toBe(0);
  });

  it.each([[[]], [[BASE]], [[BASE, BREAKING, "extra"]]] as string[][][])("bad arg count %j -> exit 2, oasdiff not run", (args) => {
    const r = run(args, { exit: 0 });
    expect(r.status).toBe(2);
    expect(r.argv).toBeNull();
  });

  it("unreadable head file -> nonzero (no false pass)", () => {
    expect(run([BASE, join(tmp, "does-not-exist.yaml")], { exit: 0 }).status).not.toBe(0);
  });

  it("args with spaces/shell metachars pass through intact (no injection)", () => {
    const evil = join(tmp, "a b;touch pwned.yaml");
    writeFileSync(evil, "openapi: 3.0.3\n");
    const r = run([BASE, evil], { exit: 0 });
    expect(r.argv?.[2]).toBe(posix(evil));
    expect(existsSync(join(tmp, "pwned.yaml"))).toBe(false);
  });
});

describe.skipIf(!realOasdiff)("oasdiff.sh — real oasdiff 1.35.x on fixtures", () => {
  const real = (args: string[], labels?: string) => {
    const env = { ...process.env } as NodeJS.ProcessEnv;
    delete env.PR_LABELS;
    if (labels !== undefined) env.PR_LABELS = labels;
    return spawnSync("bash", [posix(SCRIPT), ...args.map(posix)], { env, encoding: "utf8" }).status;
  };
  it("breaking fixture fails without label", () => expect(real([BASE, BREAKING])).not.toBe(0));
  it("breaking fixture passes with cr-approved-breaking", () => expect(real([BASE, BREAKING], LABEL)).toBe(0));
  it("compatible fixture passes without label", () => expect(real([BASE, COMPATIBLE])).toBe(0));
});
