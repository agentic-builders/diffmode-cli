import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildProgram, main, getVersion } from "../src/bin";
import { buildCommandsManifest } from "../src/commands/commands";

type Captured = { stdout: string; stderr: string; exitCode?: number };

function captureStreams(): Captured {
  const captured: Captured = { stdout: "", stderr: "" };
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: any) => {
    captured.stdout += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  }) as any);
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: any) => {
    captured.stderr += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  }) as any);
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    captured.exitCode = code ?? 0;
    return undefined as never;
  }) as any);
  return captured;
}

function setIsTTY(value: boolean): void {
  Object.defineProperty(process.stdout, "isTTY", {
    value,
    configurable: true,
  });
}

describe("buildCommandsManifest", () => {
  it("emits {schema_version, version, commands[]}", () => {
    const m = buildCommandsManifest(buildProgram());
    expect(m.schema_version).toBe("1");
    expect(m.version).toBe(getVersion());
    expect(Array.isArray(m.commands)).toBe(true);
    expect(m.commands.length).toBeGreaterThan(0);
  });

  it("includes all submit commands with leaf-name semantics", () => {
    const m = buildCommandsManifest(buildProgram());
    const names = m.commands.map((c) => c.name);
    expect(names).toContain("run");
    expect(names).toContain("workflow");
    expect(names).toContain("unlock");
    expect(names).toContain("idea-eval");
    expect(names).toContain("smoke-test");
  });

  it("flattens nested subcommands with dotted/spaced names (jobs sub-tree)", () => {
    const m = buildCommandsManifest(buildProgram());
    const names = m.commands.map((c) => c.name);
    expect(names).toContain("jobs list");
    expect(names).toContain("jobs status");
    expect(names).toContain("jobs watch");
    expect(names).toContain("jobs resume");
    expect(names).toContain("jobs cancel");
  });

  it("flattens billing sub-tree (balance + history; NO topup)", () => {
    const m = buildCommandsManifest(buildProgram());
    const names = m.commands.map((c) => c.name);
    expect(names).toContain("billing balance");
    expect(names).toContain("billing history");
    expect(names).not.toContain("billing topup");
  });

  it("flattens diagnostics sub-tree", () => {
    const m = buildCommandsManifest(buildProgram());
    const names = m.commands.map((c) => c.name);
    expect(names).toContain("diagnostics from-url");
    expect(names).toContain("diagnostics validate");
  });

  it("does NOT emit parent grouping commands as leaves", () => {
    const m = buildCommandsManifest(buildProgram());
    const names = m.commands.map((c) => c.name);
    expect(names).not.toContain("jobs");
    expect(names).not.toContain("billing");
    expect(names).not.toContain("diagnostics");
  });

  it("each entry has {name, summary, args, options, exits}", () => {
    const m = buildCommandsManifest(buildProgram());
    for (const cmd of m.commands) {
      expect(cmd).toHaveProperty("name");
      expect(cmd).toHaveProperty("summary");
      expect(cmd).toHaveProperty("args");
      expect(cmd).toHaveProperty("options");
      expect(cmd).toHaveProperty("exits");
      expect(typeof cmd.name).toBe("string");
      expect(typeof cmd.summary).toBe("string");
      expect(Array.isArray(cmd.args)).toBe(true);
      expect(Array.isArray(cmd.options)).toBe(true);
      expect(Array.isArray(cmd.exits)).toBe(true);
    }
  });

  it("`run` has product arg (required) and submit-shaped exits", () => {
    const m = buildCommandsManifest(buildProgram());
    const run = m.commands.find((c) => c.name === "run");
    expect(run).toBeDefined();
    expect(run!.args).toEqual([{ name: "product", required: true }]);
    expect(run!.exits).toContain(0);
    expect(run!.exits).toContain(5); // conflict
    expect(run!.exits).toContain(7); // rate-limited
    expect(run!.exits).toContain(8); // insufficient credits
  });

  it("`jobs watch` exits include 10 (interrupted-resumable) and 130 (SIGINT)", () => {
    const m = buildCommandsManifest(buildProgram());
    const watch = m.commands.find((c) => c.name === "jobs watch");
    expect(watch).toBeDefined();
    expect(watch!.exits).toContain(10);
    expect(watch!.exits).toContain(130);
  });

  it("commands that hit /billing/balance or the cost lookup include exit 11 (pricing_unavailable)", () => {
    const m = buildCommandsManifest(buildProgram());
    // Submit commands: preflight + server-side cost lookup both surface 11.
    // Read-only billing commands: fetchBalance surfaces 11 when the pricing
    // table is unreachable. `billing history` does not touch pricing.
    for (const name of [
      "run",
      "workflow",
      "unlock",
      "idea-eval",
      "smoke-test",
      "account",
      "billing balance",
      "limits",
    ]) {
      const cmd = m.commands.find((c) => c.name === name);
      expect(cmd, name).toBeDefined();
      expect(cmd!.exits, `${name} should list exit 11`).toContain(11);
    }
    const history = m.commands.find((c) => c.name === "billing history");
    expect(history!.exits, "billing history does not touch pricing").not.toContain(11);
  });

  it("`run` --no-preflight option is classified as boolean (negate flag)", () => {
    const m = buildCommandsManifest(buildProgram());
    const run = m.commands.find((c) => c.name === "run");
    const noPre = run!.options.find((o) => o.flag === "--no-preflight");
    expect(noPre).toBeDefined();
    expect(noPre!.type).toBe("boolean");
  });

  it("`run` --input is classified as string (required argument)", () => {
    const m = buildCommandsManifest(buildProgram());
    const run = m.commands.find((c) => c.name === "run");
    const inputOpt = run!.options.find((o) => o.flag === "--input");
    expect(inputOpt).toBeDefined();
    expect(inputOpt!.type).toBe("string");
  });

  it("`commands` itself appears in the manifest as a leaf with exits [0]", () => {
    const m = buildCommandsManifest(buildProgram());
    const self = m.commands.find((c) => c.name === "commands");
    expect(self).toBeDefined();
    expect(self!.exits).toEqual([0]);
  });

  it("emits global flags via a `globals` field for agent discovery", () => {
    const m = buildCommandsManifest(buildProgram());
    expect(Array.isArray(m.globals)).toBe(true);
    const flags = m.globals.map((o) => o.flag);
    expect(flags).toContain("--json");
    expect(flags).toContain("--quiet");
    expect(flags).toContain("--verbose");
    expect(flags).toContain("--token");
    expect(flags).toContain("--timeout");
  });
});

describe("`diffmode commands` subcommand", () => {
  beforeEach(() => {
    process.exitCode = undefined;
    setIsTTY(false);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits the full manifest on stdout (with --json)", async () => {
    const cap = captureStreams();
    await main(["commands", "--json"]);
    const parsed = JSON.parse(cap.stdout);
    expect(parsed.schema_version).toBe("1");
    expect(parsed.version).toBe(getVersion());
    const names = parsed.commands.map((c: { name: string }) => c.name);
    expect(names).toContain("run");
    expect(names).toContain("jobs watch");
    expect(names).toContain("billing balance");
  });

  it("emits JSON by default (machine-readable artifact)", async () => {
    const cap = captureStreams();
    await main(["commands"]);
    const parsed = JSON.parse(cap.stdout);
    expect(parsed.schema_version).toBe("1");
    expect(Array.isArray(parsed.commands)).toBe(true);
  });
});

describe("--help footer for agents (TTY only)", () => {
  beforeEach(() => {
    process.exitCode = undefined;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("appends the agent footer when stdout is a TTY", async () => {
    setIsTTY(true);
    const cap = captureStreams();
    await main(["--help"]);
    const out = cap.stdout;
    expect(out).toContain("For agents:");
    expect(out).toContain("--json");
    expect(out).toContain("Exit codes documented at");
  });

  it("omits the agent footer when stdout is NOT a TTY", async () => {
    setIsTTY(false);
    const cap = captureStreams();
    await main(["--help"]);
    const out = cap.stdout;
    expect(out).not.toContain("For agents:");
  });
});
